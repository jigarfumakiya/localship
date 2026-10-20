import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runInit } from "../cli/init-command.js";
import { addLocales, loadConfig } from "../core/config.js";
import { CONTEXT_FILES, writeContext } from "../core/context.js";
import { UserError } from "../core/errors.js";
import { type FileSystem, nodeFs } from "../core/fs.js";
import { plan, start } from "../core/plan.js";
import { openProject } from "../core/project.js";
import { computeStatus, ENTRY_STATES, statusNotes } from "../core/status.js";
import { buildUsageIndex } from "../core/usage.js";
import { validateProject } from "../core/validate.js";
import {
  approve,
  nextBatch,
  prune,
  removeTranslations,
  SubmissionSchema,
  submit,
} from "../core/workflow.js";
import { detect } from "../detect/detect.js";
import { hardcodedNotes } from "../detect/hardcoded.js";
import { type ReviewServer, startReview } from "../review/server.js";
import { TRANSLATION_RULES } from "../translate/prompt.js";
import { translateProject } from "../translate/translate.js";

export interface ServerOptions {
  /** Project directory used when a tool call doesn't name one. */
  cwd: string;
  version: string;
  fs?: FileSystem;
}

const cwdArg = z
  .string()
  .optional()
  .describe("Project directory (default: the directory the server was started in)");
const localesArg = z.array(z.string()).optional().describe('Locales, e.g. ["hi", "ar"]');
const targetsArg = z.array(z.string()).optional().describe("Only these target ids");
const keysArg = z.array(z.string()).optional().describe("Only these keys");
const statesArg = z.array(z.enum(ENTRY_STATES)).optional();

/** The MCP surface: thin wrappers over the same core functions the CLI uses. */
export function createServer(opts: ServerOptions): McpServer {
  const fs = opts.fs ?? nodeFs;
  const server = new McpServer(
    { name: "localship", version: opts.version },
    {
      instructions:
        "Localization for app projects (Android XML, gettext PO, Apple String Catalogs). Do what the user asked and nothing more. For a request to translate, add a language or update translations: localship_plan to see what's there, localship_start if the languages aren't set up, then localship_next_batch → localship_submit until nothing remains, then localship_validate, and report. Go by what the user means, however it's worded: wanting the app in a language ('localize the app', 'I want this in Spanish') includes moving text still in the code into string resources first (the plan's notes); keeping translations up to date doesn't; a limit they state wins. If no language was named, ask once before starting. Otherwise stop only for blockers or warnings. Don't create branches, write context files or commit unless asked. For status questions use localship_status, or localship_detect when there's no config. Never edit translation files by hand when these tools can do it.",
    },
  );
  const dir = (cwd?: string) => path.resolve(opts.cwd, cwd ?? ".");
  const project = (cwd?: string) => openProject(fs, { cwd: dir(cwd) });

  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    run: (args: z.infer<z.ZodObject<S>>, signal: AbortSignal) => Promise<unknown>,
    annotations: { readOnlyHint?: boolean; destructiveHint?: boolean } = {},
  ) =>
    server.registerTool(
      name,
      { description, inputSchema: shape, annotations },
      // biome-ignore lint/suspicious/noExplicitAny: the SDK's callback type is generic over the shape.
      (async (args: any, extra: { signal: AbortSignal }) => {
        try {
          const out = await run(args, extra.signal);
          return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
        } catch (e) {
          if (!(e instanceof UserError)) throw e;
          return { content: [{ type: "text" as const, text: e.message }], isError: true };
        }
      }) as never,
    );

  tool(
    "localship_plan",
    "Read-only look at a request (translate the app, add a language, update translations): the files, strings to translate per language, blockers, warnings (another tool manages translations: ask before writing), notes (text still in the code: move it first when the user wants the app in a language, otherwise just mention it), and what translators go by (voice per language, names kept). No confirmation needed: carry on with what the user asked unless there are blockers or warnings.",

    {
      cwd: cwdArg,
      locales: z
        .array(z.string())
        .optional()
        .describe("Languages the user asked for, as codes or names (hi, Hindi, pt-BR)"),
    },
    async ({ cwd, locales }) => plan(fs, dir(cwd), { locales }),
    { readOnlyHint: true },
  );

  tool(
    "localship_start",
    "Create .localship/config.yaml for these languages, or add them to the existing one. Writes nothing else.",
    {
      cwd: cwdArg,
      locales: z.array(z.string()).min(1).describe("Languages, as codes or names"),
    },
    async ({ cwd, ...o }) => start(fs, dir(cwd), o),
  );

  tool(
    "localship_status",
    "Translation progress per target and locale: how many strings are missing, stale, drafts, approved…, and how much UI text is still in the code. Use for status questions; for requests to translate or add languages, use localship_plan.",
    { cwd: cwdArg, locales: localesArg },
    async ({ cwd, locales }) => {
      const p = await project(cwd);
      return {
        sourceLocale: p.config.sourceLocale,
        targets: p.targets.map((t) => ({
          id: t.target.id,
          format: t.target.format,
          path: t.target.label,
        })),
        status: computeStatus(p, locales).map(({ entries: _, ...s }) => s),
        notes: statusNotes(p, locales),
        codeText: await hardcodedNotes(p),
      };
    },
    { readOnlyHint: true },
  );

  tool(
    "localship_validate",
    "Deterministic checks on source strings and translations: placeholders, plural forms, escaping, markup, glossary. Use requireApproved for a release check that also requires current, approved translations. ok is false when there are errors.",
    {
      cwd: cwdArg,
      locales: localesArg,
      strict: z
        .boolean()
        .optional()
        .describe("Missing translations, Android defaults and unsupported content are errors"),
      requireApproved: z
        .boolean()
        .optional()
        .describe(
          "Require current, approved translations for every selected locale; implies strict",
        ),
    },
    async ({ cwd, locales, strict, requireApproved }) => {
      const p = await project(cwd);
      const issues = validateProject(p, {
        locales,
        strict,
        requireApproved,
        usages: await buildUsageIndex(p),
      });
      return { ok: !issues.some((i) => i.severity === "error"), issues };
    },
    { readOnlyHint: true },
  );

  tool(
    "localship_detect",
    "Find translation files in a repo (Android res folders, .po files, String Catalogs) without writing anything.",
    { cwd: cwdArg },
    async ({ cwd }) => detect(fs, dir(cwd)),
    { readOnlyHint: true },
  );

  tool(
    "localship_init",
    "Write .localship/config.yaml from what localship_detect found. Ask the user which setups and languages they want first.",
    {
      cwd: cwdArg,
      accept: z
        .array(z.number().int().min(1))
        .optional()
        .describe("Setup numbers from localship_detect (default: the confident ones)"),
      source: z.string().optional().describe("Source language (default: detected)"),
      locales: z.array(z.string()).describe("Languages to translate into"),
      force: z.boolean().optional().describe("Replace an existing config"),
    },
    async ({ cwd, accept, source, locales, force }) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runInit(
        fs,
        { cwd: dir(cwd), yes: accept === undefined, accept, source, locales, force },
        {
          interactive: false,
          log: (l) => out.push(l),
          error: (l) => err.push(l),
          ask: async (_q, f) => f,
        },
      );
      if (code !== 0) throw new UserError(err.join("\n") || out.join("\n"));
      return { ok: true, output: out.join("\n") };
    },
  );

  tool(
    "localship_add_locales",
    "Add languages to translate into (BCP 47 codes such as hi, ar, pt-BR) to the project config.",
    { cwd: cwdArg, locales: z.array(z.string()).min(1) },
    async ({ cwd, locales }) => {
      const { file } = await loadConfig(fs, dir(cwd));
      return addLocales(fs, file, locales);
    },
  );

  tool(
    "localship_get_context",
    "The project's translation brief, voice per locale and glossary.",
    { cwd: cwdArg },
    async ({ cwd }) => {
      const p = await project(cwd);
      return { folder: path.relative(p.root, p.context.dir) || ".", ...p.context, dir: undefined };
    },
    { readOnlyHint: true },
  );

  tool(
    "localship_update_context",
    `Write the brief (${CONTEXT_FILES.brief}: what the app is, audience, tone), voice per locale (voice/<locale>.md, or voice/all.md for every locale) and/or the glossary (replaces the whole list). Use when you can't edit files directly.`,
    {
      cwd: cwdArg,
      brief: z.string().optional(),
      voice: z.record(z.string(), z.string()).optional().describe('Locale or "all" → guidance'),
      glossary: z
        .array(
          z.object({
            term: z.string(),
            translate: z.boolean().optional().describe("false: keep as written (brand names)"),
            translations: z.record(z.string(), z.string()).optional(),
            note: z.string().optional(),
            caseSensitive: z.boolean().optional(),
          }),
        )
        .optional(),
    },
    async ({ cwd, ...update }) => {
      const p = await project(cwd);
      return { written: await writeContext(fs, p.context.dir, update) };
    },
  );

  tool(
    "localship_next_batch",
    `The next strings that need translating, with everything needed to translate them well. Translate them yourself, then send them to localship_submit. Repeat until remaining is 0.

Rules:
${TRANSLATION_RULES}`,
    {
      cwd: cwdArg,
      locales: localesArg,
      targets: targetsArg,
      keys: keysArg,
      states: statesArg.describe("Which entries (default: missing, stale)"),
      limit: z.number().int().min(1).max(200).optional().describe("Default 40"),
      offset: z.number().int().min(0).optional(),
    },
    async ({ cwd, ...o }) => nextBatch(await project(cwd), o),
    { readOnlyHint: true },
  );

  tool(
    "localship_submit",
    "Check translations and write the ones without errors as drafts. Rejected ones come back with the errors to fix; resubmit just those. value is a string, an object of plural forms, or an array, matching the item's kind. Add a short note only when the source is ambiguous, saying how you read it.",
    {
      cwd: cwdArg,
      translations: z.array(SubmissionSchema),
      model: z.string().optional().describe("Your model name, kept in the lockfile"),
      force: z
        .boolean()
        .optional()
        .describe(
          "Replace hand edits and reviewed or approved translations. Only when the user asks.",
        ),
      dryRun: z.boolean().optional(),
    },
    async ({ cwd, translations, ...o }) => submit(await project(cwd), translations, o),
  );

  tool(
    "localship_approve",
    "Mark drafts approved (or reviewed). Only when the user says so, after they've seen the translations.",
    {
      cwd: cwdArg,
      locales: localesArg,
      targets: targetsArg,
      keys: keysArg,
      from: statesArg.describe(
        "Which entries (default: draft, reviewed). untracked adopts existing translations; edited accepts hand edits",
      ),
      reviewed: z.boolean().optional().describe("Mark reviewed instead of approved"),
      dryRun: z.boolean().optional(),
    },
    async ({ cwd, from, reviewed, ...o }) =>
      approve(await project(cwd), { ...o, states: from, to: reviewed ? "reviewed" : "approved" }),
  );

  const reviews = new Map<string, Promise<ReviewServer>>();
  tool(
    "localship_review",
    "Start a review page on this computer where a person reads, edits, approves or rejects translations in the browser, and return its link. Use when the user wants to review translations themselves; give them the link. It stays up while this server runs; calling again returns the same link.",
    {
      cwd: cwdArg,
      locales: localesArg,
      states: statesArg.describe("States shown at first (default: draft, edited, untracked)"),
    },
    async ({ cwd, locales, states }) => {
      const key = JSON.stringify([dir(cwd), locales, states]);
      let review = reviews.get(key);
      if (!review) {
        review = startReview({ fs, cwd: dir(cwd), locales, states });
        reviews.set(key, review);
        review.catch(() => reviews.delete(key));
      }
      return { url: (await review).url };
    },
  );

  tool(
    "localship_remove",
    "Make translations untranslated again (e.g. reject bad drafts) so they get redone. Pass keys, states, or both. Hand edits and reviewed, approved or untracked translations are kept unless force is set; set it only when the user asks.",
    {
      cwd: cwdArg,
      locales: localesArg,
      targets: targetsArg,
      keys: keysArg,
      states: statesArg.describe('Entries in these states, e.g. ["draft"]'),
      force: z.boolean().optional(),
      dryRun: z.boolean().optional(),
    },
    async ({ cwd, ...o }) => removeTranslations(await project(cwd), o),
    { destructiveHint: true },
  );

  tool(
    "localship_prune",
    "Remove translations of strings that were deleted, renamed or marked not translatable, and their lockfile records. Use dryRun first and show the user.",
    { cwd: cwdArg, targets: targetsArg, dryRun: z.boolean().optional() },
    async ({ cwd, ...o }) => prune(await project(cwd), o),
    { destructiveHint: true },
  );

  tool(
    "localship_translate",
    "Translate everything missing with a separate model API (configured under models: in .localship/config.yaml, or pass model as provider:model). Only when the user asks for it: cloud providers bill per use and need their API key in the environment.",
    {
      cwd: cwdArg,
      locales: localesArg,
      targets: targetsArg,
      keys: keysArg,
      model: z.string().optional().describe("provider:model, e.g. anthropic:claude-sonnet-5-5"),
      batchSize: z.number().int().positive().optional().describe("Entries per call (default 30)"),
      concurrency: z.number().int().positive().optional().describe("Calls at once (default 4)"),
      maxPromptBytes: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("UTF-8 prompt bytes (default 48000)"),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .max(2147483647)
        .optional()
        .describe("Request deadline in milliseconds (default 120000)"),
    },
    async ({ cwd, targets, ...o }, signal) =>
      translateProject(await project(cwd), { ...o, targets, signal }),
  );

  for (const name of [
    "localship",
    "localship-setup",
    "localship-extract",
    "localship-translate",
    "localship-review",
  ] as const) {
    const skill = readSkill(name);
    if (!skill) continue;
    server.registerPrompt(name, { description: skill.description }, () => ({
      messages: [{ role: "user", content: { type: "text", text: skill.body } }],
    }));
  }

  return server;
}

/** Skill files ship with the package; MCP prompts serve the same text to clients without skills. */
function readSkill(name: string): { description: string; body: string } | undefined {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    const file = path.join(dir, "skills", name, "SKILL.md");
    if (existsSync(file)) {
      const text = readFileSync(file, "utf8");
      const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
      const description = /^description:\s*(.+)$/m.exec(m?.[1] ?? "")?.[1]?.trim() ?? name;
      return { description, body: (m?.[2] ?? text).trim() };
    }
    dir = path.dirname(dir);
  }
  return undefined;
}

export async function runServer(opts: ServerOptions): Promise<void> {
  const server = createServer(opts);
  await server.connect(new StdioServerTransport());
}

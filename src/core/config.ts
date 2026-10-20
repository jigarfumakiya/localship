import path from "node:path";
import { parseDocument, parse as parseYaml } from "yaml";
import { z } from "zod";
import { UserError } from "./errors.js";
import type { FileSystem } from "./fs.js";
import { PLACEHOLDER_SYNTAXES } from "./placeholders.js";

/** Inside the Localship folder, so a project gains one hidden folder at its root and nothing else. */
export const CONFIG_FILE = ".localship/config.yaml";
/** Where the config lived before it moved into the folder; still read. */
export const ROOT_CONFIG_FILE = "localship.yaml";
/** Config files Localship reads, in order of preference. */
export const CONFIG_FILES = [CONFIG_FILE, ROOT_CONFIG_FILE];

/** The directory paths in a config are relative to: the repo root, not the `.localship` folder. */
export function configRoot(file: string): string {
  const dir = path.dirname(file);
  return path.basename(dir) === path.dirname(CONFIG_FILE) ? path.dirname(dir) : dir;
}

const locale = z.string().transform((s, ctx) => {
  try {
    return Intl.getCanonicalLocales(s)[0] as string;
  } catch {
    ctx.addIssue({ code: "custom", message: `Not a valid BCP 47 locale: "${s}"` });
    return z.NEVER;
  }
});

const id = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, "Use letters, digits, - and _")
  .optional();

const AndroidTargetSchema = z.strictObject({
  id,
  format: z.literal("android-xml"),
  path: z.string(),
});

const PoTargetSchema = z.strictObject({
  id,
  format: z.literal("po"),
  path: z
    .string()
    .refine((p) => p.includes("{locale}"), "Must contain {locale}, e.g. po/{locale}.po"),
  template: z.string().optional(),
  placeholders: z.enum(PLACEHOLDER_SYNTAXES).optional(),
  pluralForms: z.record(z.string(), z.string()).optional(),
});

const XcstringsTargetSchema = z.strictObject({
  id,
  format: z.literal("xcstrings"),
  path: z
    .string()
    .refine(
      (p) => p.endsWith(".xcstrings"),
      "Point at a .xcstrings file (all languages live in it)",
    ),
});

const localePattern = z
  .string()
  .refine((p) => p.includes("{locale}"), "Must contain {locale}, e.g. locales/{locale}.json");

const ArbTargetSchema = z.strictObject({
  id,
  format: z.literal("arb"),
  path: localePattern.refine(
    (p) => p.endsWith(".arb"),
    "Point at .arb files, e.g. lib/l10n/app_{locale}.arb",
  ),
});

const JsonTargetSchema = z.strictObject({
  id,
  format: z.literal("json"),
  path: localePattern,
  placeholders: z.enum(PLACEHOLDER_SYNTAXES).optional(),
});

export const ConfigSchema = z
  .strictObject({
    sourceLocale: locale.default("en"),
    locales: z.array(locale).default([]),
    targets: z
      .array(
        z.discriminatedUnion("format", [
          AndroidTargetSchema,
          PoTargetSchema,
          XcstringsTargetSchema,
          ArbTargetSchema,
          JsonTargetSchema,
        ]),
      )
      .min(1, "Add at least one target"),
    lock: z.string().default(".localship/lock.json"),
    /** Folder with brief.md, voice/<locale>.md and glossary.yaml. */
    context: z.string().default(".localship"),
    /** Models for `localship translate`, as `provider:model`: `default`, or per locale. */
    models: z.record(z.string(), z.string()).optional(),
    /** Extra OpenAI-compatible providers, by name. */
    providers: z
      .record(
        z.string(),
        z.strictObject({
          baseUrl: z.url(),
          apiKeyEnv: z.string().optional(),
        }),
      )
      .optional(),
  })
  .superRefine((c, ctx) => {
    const seen = new Set<string>();
    c.targets.forEach((t, i) => {
      const tid = targetId(t, c.targets);
      if (seen.has(tid)) {
        ctx.addIssue({
          code: "custom",
          path: ["targets", i, "id"],
          message: `Duplicate target id "${tid}"; give each target a unique id`,
        });
      }
      seen.add(tid);
    });
  });

/** A target's id: its `id`, else its format name when that format appears once. */
export function targetId(
  t: { id?: string | undefined; format: string },
  all: Array<{ format: string }>,
): string {
  if (t.id) return t.id;
  const base = t.format === "android-xml" ? "android" : t.format;
  const same = all.filter((x) => x.format === t.format);
  return same.length > 1 ? `${base}-${same.indexOf(t as never) + 1}` : base;
}

export type Config = z.infer<typeof ConfigSchema>;
export type TargetConfig = Config["targets"][number];

const KNOWN_KEYS = [
  "sourceLocale",
  "locales",
  "targets",
  "lock",
  "context",
  "models",
  "providers",
  "baseUrl",
  "apiKeyEnv",
  "id",
  "format",
  "path",
  "template",
  "placeholders",
  "pluralForms",
];

/** The known key within a couple of edits of `key`, if any. */
function closest(key: string, known: string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Math.max(2, Math.floor(key.length / 3)) + 1;
  for (const k of known) {
    const d = editDistance(key.toLowerCase(), k.toLowerCase());
    if (d < bestDistance) {
      best = k;
      bestDistance = d;
    }
  }
  return best;
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(
        (prev[j] as number) + 1,
        (cur[j - 1] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
    }
    prev = cur;
  }
  return prev[b.length] as number;
}

export class ConfigError extends UserError {}

export interface LoadedConfig {
  config: Config;
  /** Directory paths in the config are relative to. */
  root: string;
  file: string;
}

/** Finds `.localship/config.yaml` (or `localship.yaml`) in `cwd` or the nearest parent, unless a path is given. */
export async function loadConfig(
  fs: FileSystem,
  cwd: string,
  explicit?: string,
): Promise<LoadedConfig> {
  let file: string | undefined;
  if (explicit) {
    file = path.resolve(cwd, explicit);
    if (!(await fs.exists(file))) throw new ConfigError(`Config not found: ${file}`);
  } else {
    search: for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
      for (const name of CONFIG_FILES) {
        const candidate = path.join(dir, name);
        if (await fs.exists(candidate)) {
          file = candidate;
          break search;
        }
      }
      if (path.dirname(dir) === dir) break;
    }
    if (!file)
      throw new ConfigError(
        `No Localship config (${CONFIG_FILE}) found in ${cwd} or its parents, so Localship isn't set up here yet. Run \`localship detect\` to see what's in this repo, then \`localship init\` to set it up.`,
      );
  }

  let raw: unknown;
  try {
    raw = parseYaml(await fs.readFile(file));
  } catch (e) {
    throw new ConfigError(`${file}: ${(e as Error).message}`);
  }
  const parsed = ConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const details = parsed.error.issues.flatMap((i) => {
      const at = i.path.join(".") || "(root)";
      if (i.code === "unrecognized_keys") {
        return i.keys.map((k) => {
          const guess = closest(k, KNOWN_KEYS);
          return `  ${at}: unknown key "${k}"${guess ? ` (did you mean "${guess}"?)` : ""}`;
        });
      }
      return [`  ${at}: ${i.message}`];
    });
    throw new ConfigError(`${file} is invalid:\n${details.join("\n")}`);
  }
  return { config: parsed.data, root: configRoot(file), file };
}

/**
 * Adds languages to `locales:` in the config file, keeping its comments and layout.
 * Returns the locales actually added (already listed ones and the source are skipped).
 */
export async function addLocales(
  fs: FileSystem,
  file: string,
  requested: string[],
): Promise<{ added: string[]; locales: string[] }> {
  let canonical: string[];
  try {
    canonical = Intl.getCanonicalLocales(
      requested.map((l) => l.trim().replace(/_/g, "-")).filter(Boolean),
    );
  } catch {
    throw new ConfigError(`Not a valid language code in: ${requested.join(", ")}`);
  }
  const doc = parseDocument(await fs.readFile(file));
  const source = String(doc.get("sourceLocale") ?? "en");
  const current = (doc.toJS()?.locales as string[] | undefined) ?? [];
  const known = new Set(current.map((l) => Intl.getCanonicalLocales(l)[0]));
  const added = canonical.filter((l) => l !== source && !known.has(l));
  if (added.length) {
    const locales = [...current, ...added];
    const node = doc.createNode(locales);
    node.flow = true;
    doc.set("locales", node);
    await fs.writeFile(file, doc.toString({ lineWidth: 0 }));
    return { added, locales };
  }
  return { added, locales: current };
}

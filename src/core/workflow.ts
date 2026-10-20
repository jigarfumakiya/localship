import { z } from "zod";
import type { Target } from "../formats/types.js";
import { conventionalVoice, fixedTranslation, glossaryHits, voiceFor } from "./context.js";
import { UserError } from "./errors.js";
import { hashMessage } from "./hash.js";
import { getLockEntry, type Lockfile, type StoredState, setLockEntry, writeLock } from "./lock.js";
import { displayKey, type Entry, type Message, messageValues } from "./model.js";
import {
  findTarget,
  type Project,
  projectGlossary,
  projectLocales,
  reopenProject,
  withProjectWrite,
} from "./project.js";
import { roleOf, type UiRole } from "./qa.js";
import { type EntryState, editedByHand, entryState } from "./status.js";
import { buildUsageIndex, type Usage, type UsageIndex } from "./usage.js";
import { checkTranslation, type Found } from "./validate.js";

/** A message as translators see and return it: a string, plural forms, or array items. */
export type MessageValue = string | Record<string, string> | string[];

export interface BatchItem {
  target: string;
  locale: string;
  key: string;
  state: EntryState;
  kind: Message["kind"];
  source: MessageValue;
  comment?: string;
  /** Disambiguation context (gettext msgctxt). */
  context?: string;
  /** Where the string is used in code (gettext `#:` references when the code isn't found). */
  references?: string[];
  /** Code that uses the string: the file says which screen, the code what role it plays. */
  usage?: Usage[];
  /** Where the string appears, read from that code. Buttons, tabs and chips have little room. */
  role?: UiRole;
  /** The translator's note on how they read an ambiguous source. */
  note?: string;
  /** The translation on disk now, for stale or untracked entries. */
  current?: MessageValue;
  /** For stale entries: the source text `current` was translated from, when the lockfile knows it. */
  previousSource?: MessageValue;
  /**
   * A person edited `current` after the tool wrote it. Keep their wording where you can;
   * replacing it needs their confirmation (`force`).
   */
  editedByHand?: true;
  /** Plural forms this locale needs, with sample counts for each. */
  pluralForms?: Array<{ form: string; examples: string; optional?: boolean }>;
  /** Placeholders the translation must keep. */
  placeholders?: string[];
  glossary?: Array<{ term: string; keep?: true; use?: string; note?: string }>;
  /** Translations of the same source text elsewhere in the project. */
  memory?: Array<{ value: MessageValue; from: string }>;
}

export interface Batch {
  items: BatchItem[];
  /** Entries still needing work after this batch. */
  remaining: number;
  brief?: string;
  /**
   * Per locale: the project's voice, or when it has none, `defaultVoice`, the usual convention
   * for that language, so batches stay consistent until the user sets their own.
   */
  locales: Record<string, { language: string; voice?: string; defaultVoice?: string }>;
  /** How each target's values are written. */
  formats: Record<string, string>;
}

export interface BatchOptions {
  locales?: string[];
  targets?: string[];
  keys?: string[];
  /** Which entries need work. Default: missing and stale. */
  states?: EntryState[];
  limit?: number;
  offset?: number;
  /** Entries to leave out, by {@link itemId}. */
  skip?: Set<string>;
  /** Where strings are used in code; built when not given. false leaves it out. */
  usages?: UsageIndex | false;
  /** Leave out stale entries a person also edited (for unattended runs that can't ask). */
  skipHandEdited?: boolean;
}

/** Identity of an entry in one locale, for tracking across batches. */
export function itemId(item: { target: string; locale: string; key: string }): string {
  return `${item.target}\u0000${item.locale}\u0000${item.key}`;
}

const LANGUAGE = new Intl.DisplayNames(["en"], { type: "language" });
const DEFAULT_STATES: EntryState[] = ["missing", "stale"];

const FORMAT_NOTES: Record<string, string> = {
  "android-xml":
    "Android string resources. Values are resource XML: keep tags such as <b> and <xliff:g> exactly, and keep escapes like \\n. Apostrophes, quotes and & are escaped for you.",
  po: "gettext PO. Values are plain text; keep placeholders and leading or trailing newlines exactly as in the source.",
  xcstrings:
    "Apple String Catalog. Values are plain text with Apple placeholders (%@, %lld, %1$@); you may number them to reorder.",
  arb: "Flutter ARB. Values are ICU messages: keep {name} placeholders as written (never translate the name inside braces), and write the count as {count}, never #. For {x, select, …} keep the case names and translate only the text inside each case. If a check reports use-escaping, write an apostrophe as ''.",
  json: "JSON translation file. Keep placeholders such as {{name}} or {name} exactly, and never translate the name inside them. For ICU {x, select, …} keep the case names and translate only the text inside each case.",
};

export function toValue(message: Message): MessageValue {
  switch (message.kind) {
    case "text":
      return message.value;
    case "plural":
      return Object.fromEntries(messageValues(message));
    case "array":
      return [...message.items];
  }
}

/** The plain text of a message for matching: its only value, or the `other` form. */
function plainText(target: Target, entry: Entry): string {
  const values = messageValues(entry.message);
  const value =
    entry.message.kind === "plural"
      ? (entry.message.forms.other ?? values.at(-1)?.[1])
      : values.map(([, v]) => v).join("\n");
  return target.analyze(value ?? "", entry).text;
}

const normalize = (s: string) => s.trim().replace(/\s+/g, " ");

/** Source text → translations already in the project, per locale. */
function buildMemory(project: Project, locales: string[]) {
  const memory = new Map<
    string,
    Array<{ locale: string; target: string; key: string; value: MessageValue }>
  >();
  for (const { target } of project.targets) {
    for (const src of target.source.entries.values()) {
      if (!src.translatable) continue;
      const text = normalize(plainText(target, src));
      if (!text) continue;
      for (const locale of locales) {
        const tgt = target.locales.get(locale)?.entries.get(src.key);
        if (!tgt) continue;
        const state = entryState(src, tgt, getLockEntry(project.lock, target.id, locale, src.key));
        if (state === "stale") continue;
        const list = memory.get(text) ?? [];
        list.push({ locale, target: target.id, key: src.key, value: toValue(tgt.message) });
        memory.set(text, list);
      }
    }
  }
  return memory;
}

/**
 * A warning when the same source text already has a different translation in this language,
 * so the agent can reuse it, or keep its own wording on purpose when the context differs.
 */
function differentWording(
  target: Target,
  src: Entry,
  message: Message,
  locale: string,
  memory: ReturnType<typeof buildMemory>,
  thisBatch: Map<string, { key: string; value: string }>,
  note: string | undefined,
): Found | undefined {
  // gettext contexts exist to let the same text translate differently; a note says why it does.
  if (message.kind !== "text" || src.context || note) return undefined;
  const source = normalize(plainText(target, src));
  if (!source) return undefined;
  const value = normalize(message.value);
  const id = `${locale}\u0000${source}`;
  const earlier = thisBatch.get(id);
  thisBatch.set(id, earlier ?? { key: displayKey(src.key), value });
  // What the project already uses wins over what this batch chose first.
  const existing = (memory.get(source) ?? [])
    .filter(
      (m) =>
        m.locale === locale &&
        (m.target !== target.id || m.key !== src.key) &&
        typeof m.value === "string",
    )
    .map((m) => ({ key: displayKey(m.key), value: normalize(m.value as string) }))[0];
  const other = existing ?? earlier;
  if (!other || other.value === value) return undefined;
  return {
    severity: "warning",
    code: "inconsistent",
    message: `"${source}" is already translated as "${other.value}" (${other.key}). Use the same wording, or add a note saying how the context differs`,
  };
}

/** The next entries needing translation, with everything a translator needs to do them well. */
export async function nextBatch(project: Project, opts: BatchOptions = {}): Promise<Batch> {
  const usages = opts.usages === undefined ? await buildUsageIndex(project) : opts.usages;
  const locales = opts.locales ?? projectLocales(project);
  const states = opts.states ?? DEFAULT_STATES;
  const limit = opts.limit ?? 40;
  const offset = opts.offset ?? 0;
  const wanted = opts.keys ? new Set(opts.keys) : undefined;
  const memory = buildMemory(project, locales);
  const glossary = projectGlossary(project);

  const items: BatchItem[] = [];
  let matched = 0;
  for (const locale of locales) {
    for (const { target } of project.targets) {
      if (opts.targets && !opts.targets.includes(target.id)) continue;
      const catalog = target.locales.get(locale);
      const spec = target.pluralSpec(locale);
      for (const src of target.source.entries.values()) {
        if (!src.translatable) continue;
        if (wanted && !wanted.has(src.key) && !wanted.has(displayKey(src.key))) continue;
        const tgt = catalog?.entries.get(src.key);
        const lockEntry = getLockEntry(project.lock, target.id, locale, src.key);
        const state = entryState(src, tgt, lockEntry);
        if (!states.includes(state)) continue;
        const handEdited = state === "stale" && editedByHand(tgt, lockEntry);
        if (handEdited && opts.skipHandEdited) continue;
        if (opts.skip?.has(itemId({ target: target.id, locale, key: displayKey(src.key) })))
          continue;
        matched++;
        if (matched <= offset || items.length >= limit) continue;

        const text = plainText(target, src);
        const found = usages ? usages.find(target, src) : [];
        const role = roleOf(found);
        const placeholders = [
          ...new Set(
            messageValues(src.message).flatMap(([, v]) =>
              target.analyze(v, src).placeholders.map((p) => p.raw),
            ),
          ),
        ];
        const hits = glossaryHits(glossary, text);
        const matches = (memory.get(normalize(text)) ?? []).filter(
          (m) => m.locale === locale && !(m.target === target.id && m.key === src.key),
        );
        const item: BatchItem = {
          target: target.id,
          locale,
          key: displayKey(src.key),
          state,
          kind: src.message.kind,
          source: toValue(src.message),
          ...(src.comment ? { comment: src.comment } : {}),
          ...(src.context ? { context: src.context } : {}),
          ...usageFields(found, src.references),
          ...(role ? { role } : {}),
          ...(tgt && lockEntry?.note ? { note: lockEntry.note } : {}),
          ...(tgt ? { current: toValue(tgt.message) } : {}),
          ...(state === "stale" && lockEntry?.sourceText !== undefined
            ? { previousSource: lockEntry.sourceText }
            : {}),
          ...(handEdited ? { editedByHand: true as const } : {}),
          ...(src.message.kind === "plural" && spec
            ? {
                pluralForms: spec.forms
                  .filter((f) => !f.decimalOnly)
                  .map((f) => ({
                    form: f.id,
                    examples: f.examples,
                    ...(f.optional ? { optional: true } : {}),
                  })),
              }
            : {}),
          ...(placeholders.length ? { placeholders } : {}),
          ...(hits.length
            ? {
                glossary: hits.map((t) => {
                  const use = fixedTranslation(t, locale);
                  return {
                    term: t.term,
                    ...(t.translate ? {} : { keep: true as const }),
                    ...(use ? { use } : {}),
                    ...(t.note ? { note: t.note } : {}),
                  };
                }),
              }
            : {}),
          ...(matches.length
            ? {
                memory: matches.slice(0, 3).map((m) => ({
                  value: m.value,
                  from: `${m.target}:${displayKey(m.key)}`,
                })),
              }
            : {}),
        };
        items.push(item);
      }
    }
  }

  const usedLocales = [...new Set(items.map((i) => i.locale))];
  const usedFormats = [...new Set(items.map((i) => findTarget(project, i.target)?.format ?? ""))];
  return {
    items,
    remaining: Math.max(0, matched - offset - items.length),
    ...(project.context.brief ? { brief: project.context.brief } : {}),
    locales: Object.fromEntries(
      usedLocales.map((l) => {
        const voice = voiceFor(project.context, l);
        return [
          l,
          {
            language: languageName(l),
            ...(voice ? { voice } : { defaultVoice: conventionalVoice(l) }),
          },
        ];
      }),
    ),
    formats: Object.fromEntries(
      project.targets
        .filter((t) => usedFormats.includes(t.target.format))
        .map((t) => [t.target.id, FORMAT_NOTES[t.target.format] ?? t.target.format]),
    ),
  };
}

function usageFields(
  usage: Usage[],
  references?: string[],
): Pick<BatchItem, "usage" | "references"> {
  if (usage.some((u) => u.code)) return { usage };
  return references?.length ? { references: references.slice(0, 3) } : {};
}

export function languageName(locale: string): string {
  try {
    return LANGUAGE.of(locale) ?? locale;
  } catch {
    return locale;
  }
}

export interface Submission {
  target?: string;
  locale: string;
  key: string;
  /** A string for text, an object of plural forms, or an array for string arrays. */
  value: MessageValue;
  /** How you read an ambiguous source ("Open" as a button, not a status), shown at review. */
  note?: string;
}

export const MessageValueSchema = z.union([
  z.string(),
  z.array(z.string()),
  z.record(z.string(), z.string()),
]);

export const SubmissionSchema = z.object({
  target: z.string().optional(),
  locale: z.string(),
  key: z.string(),
  value: MessageValueSchema,
  note: z.string().optional(),
});

/** What `submit` reads: a list of translations, or `{ translations, model? }`. */
export const SubmitInputSchema = z.union([
  z.array(SubmissionSchema),
  z.object({ translations: z.array(SubmissionSchema), model: z.string().optional() }),
]);

export function parseSubmitInput(text: string): { translations: Submission[]; model?: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new UserError(`Submission is not valid JSON: ${(e as Error).message}`);
  }
  const parsed = SubmitInputSchema.safeParse(data);
  if (!parsed.success) {
    const details = parsed.error.issues
      .slice(0, 5)
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new UserError(
      `Submission should be {"translations": [{"locale", "key", "value", "target"?}]}:\n${details.join("\n")}`,
    );
  }
  return Array.isArray(parsed.data) ? { translations: parsed.data } : parsed.data;
}

export interface SubmitResult {
  accepted: Array<{ target: string; locale: string; key: string; warnings: Found[] }>;
  rejected: Array<{ target?: string; locale: string; key: string; errors: Found[] }>;
  files: string[];
  dryRun: boolean;
}

export interface SubmitOptions {
  /** Source snapshot used by delegated model calls, keyed by itemId. */
  expectedSources?: Map<string, MessageValue>;
  /** Recorded in the lockfile with each draft. */
  model?: string;
  /** Replace translations a person wrote, reviewed or approved. */
  force?: boolean;
  dryRun?: boolean;
  /** Where strings are used in code; found when not given, `false` to skip. */
  usages?: UsageIndex | false;
}

/** States `submit` may overwrite without `force`. */
const REPLACEABLE: EntryState[] = ["missing", "stale", "draft"];

/**
 * Checks each translation like `validate` does, writes the ones without errors as drafts
 * and records them in the lockfile. Rejected entries come back with their errors.
 */
export async function submit(
  project: Project,
  submissions: Submission[],
  opts: SubmitOptions = {},
): Promise<SubmitResult> {
  return withProjectWrite(project, opts.dryRun, (fresh) =>
    submitUnlocked(fresh, submissions, opts),
  );
}

async function submitUnlocked(
  project: Project,
  submissions: Submission[],
  opts: SubmitOptions,
): Promise<SubmitResult> {
  const result: SubmitResult = { accepted: [], rejected: [], files: [], dryRun: !!opts.dryRun };
  const configured = projectLocales(project);
  const pending = new Map<Target, Map<string, Map<string, Entry>>>();
  const seen = new Set<string>();
  // Translations already in the project, and ones accepted earlier in this batch, by source text.
  const memory = buildMemory(project, configured);
  const thisBatch = new Map<string, { key: string; value: string }>();
  const usages = opts.usages === undefined ? await buildUsageIndex(project) : opts.usages;
  const notes = new Map<string, string | null>();

  for (const sub of submissions) {
    const reject = (message: string, code = "rejected", target?: string) =>
      result.rejected.push({
        ...(target ? { target } : {}),
        locale: sub.locale,
        key: sub.key,
        errors: [{ severity: "error", code, message }],
      });

    let locale: string;
    try {
      locale = Intl.getCanonicalLocales(sub.locale)[0] as string;
    } catch {
      reject(`"${sub.locale}" is not a valid locale`, "locale-invalid");
      continue;
    }
    if (locale === project.config.sourceLocale) {
      reject(`${locale} is the source language`, "locale-invalid");
      continue;
    }
    if (project.config.locales.length > 0 && !configured.includes(locale)) {
      reject(
        `${locale} is not in the config's locales (${configured.join(", ")})`,
        "locale-invalid",
      );
      continue;
    }

    const found = resolveEntry(project, sub);
    if ("error" in found) {
      reject(found.error, "key-unknown", sub.target);
      continue;
    }
    const { target, src } = found;
    const expected = opts.expectedSources?.get(
      itemId({ target: target.id, locale, key: displayKey(src.key) }),
    );
    if (
      expected !== undefined &&
      JSON.stringify(expected) !== JSON.stringify(toValue(src.message))
    ) {
      reject(
        "The source changed while the model was translating; translate the current source",
        "source-changed",
        target.id,
      );
      continue;
    }
    const id = `${target.id}\u0000${locale}\u0000${src.key}`;
    if (seen.has(id)) {
      reject("Submitted twice in one batch", "duplicate", target.id);
      continue;
    }
    seen.add(id);

    const existing = target.locales.get(locale)?.entries.get(src.key);
    const lockEntry = getLockEntry(project.lock, target.id, locale, src.key);
    const state = entryState(src, existing, lockEntry);
    if (!opts.force && state === "stale" && editedByHand(existing, lockEntry)) {
      reject(
        "The source changed, but a person also edited this translation; ask before replacing their edit (force)",
        "state-stale-edited",
        target.id,
      );
      continue;
    }
    if (!opts.force && !REPLACEABLE.includes(state)) {
      reject(
        `Already ${state === "untracked" ? "translated (not by this tool)" : state}; pass force to replace it`,
        `state-${state}`,
        target.id,
      );
      continue;
    }

    const message = toMessage(target, src, sub.value);
    if (typeof message === "string") {
      reject(message, "kind-mismatch", target.id);
      continue;
    }
    const tgt: Entry = {
      key: src.key,
      message,
      translatable: true,
      file: existing?.file ?? "",
      line: 0,
      ...(target.marksDrafts ? { needsReview: true } : {}),
    };
    const findings = [
      ...checkTranslation(target, target.pluralSpec(locale), src, tgt, {
        locale,
        sourceLocale: project.config.sourceLocale,
        glossary: projectGlossary(project),
        role: usages ? roleOf(usages.find(target, src)) : undefined,
      }).filter((f) => f.code !== "plural-missing-category" && f.code !== "plural-extra-category"),
      ...checkPluralForms(target, locale, message),
    ];
    const errors = findings.filter((f) => f.severity === "error");
    if (errors.length) {
      result.rejected.push({ target: target.id, locale, key: displayKey(src.key), errors });
      continue;
    }
    const differs = differentWording(
      target,
      src,
      message,
      locale,
      memory,
      thisBatch,
      sub.note?.trim(),
    );
    if (differs) findings.push(differs);
    result.accepted.push({
      target: target.id,
      locale,
      key: displayKey(src.key),
      warnings: findings.filter((f) => f.severity === "warning"),
    });
    const byLocale = pending.get(target) ?? new Map<string, Map<string, Entry>>();
    const entries = byLocale.get(locale) ?? new Map<string, Entry>();
    entries.set(src.key, tgt);
    byLocale.set(locale, entries);
    pending.set(target, byLocale);
    notes.set(id, sub.note?.trim() || null);
  }

  if (opts.dryRun || pending.size === 0) return result;

  const files = new Set<string>();
  for (const [target, byLocale] of pending) {
    for (const [locale, entries] of byLocale) {
      const written = await target.writeLocale({ locale, entries });
      for (const f of written.files) files.add(f);
    }
  }
  result.files = [...files].sort();

  const keys = [...pending].flatMap(([target, byLocale]) =>
    [...byLocale].flatMap(([locale, entries]) =>
      [...entries.keys()].map((key) => ({
        target: target.id,
        locale,
        key,
        note: notes.get(`${target.id}\u0000${locale}\u0000${key}`) ?? null,
      })),
    ),
  );
  await record(project, keys, () => ({
    state: "draft",
    ...(opts.model ? { model: opts.model } : {}),
  }));
  return result;
}

function resolveEntry(
  project: Project,
  sub: Pick<Submission, "target" | "key">,
): { target: Target; src: Entry } | { error: string } {
  const lookup = (t: Target) => {
    const direct = t.source.entries.get(sub.key);
    if (direct) return direct;
    // Batches show gettext keys with a readable separator; accept them back.
    const raw = sub.key.replace(" | ", "\u0004");
    return t.source.entries.get(raw);
  };
  if (sub.target) {
    const target = findTarget(project, sub.target);
    if (!target) {
      const ids = project.targets.map((t) => t.target.id).join(", ");
      return { error: `No target "${sub.target}" (targets: ${ids})` };
    }
    const src = lookup(target);
    if (!src) return { error: `"${sub.key}" is not a source string in ${target.id}` };
    if (!src.translatable) return { error: `"${sub.key}" is marked not translatable` };
    return { target, src };
  }
  const hits = project.targets.flatMap(({ target }) => {
    const src = lookup(target);
    return src ? [{ target, src }] : [];
  });
  if (hits.length === 0) return { error: `"${sub.key}" is not a source string in any target` };
  if (hits.length > 1) {
    return {
      error: `"${sub.key}" is in ${hits.map((h) => h.target.id).join(" and ")}; say which target`,
    };
  }
  const [hit] = hits as [{ target: Target; src: Entry }];
  if (!hit.src.translatable) return { error: `"${sub.key}" is marked not translatable` };
  return hit;
}

function toMessage(target: Target, src: Entry, value: MessageValue): Message | string {
  const prepare = (v: string) => (target.prepareValue ? target.prepareValue(v, src) : v);
  const kind = src.message.kind;
  if (kind === "text") {
    if (typeof value !== "string") return "The source is a single string; send a string";
    return { kind: "text", value: prepare(value) };
  }
  if (kind === "array") {
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
      return "The source is a string array; send an array of strings";
    }
    return { kind: "array", items: value.map(prepare) };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return "The source is a plural; send an object of plural forms";
  }
  return {
    kind: "plural",
    forms: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, prepare(String(v))])),
  };
}

/** Every form the locale uses must be there, and no others: a draft shouldn't fall back to `other`. */
function checkPluralForms(target: Target, locale: string, message: Message): Found[] {
  if (message.kind !== "plural") return [];
  const spec = target.pluralSpec(locale);
  if (!spec) return [];
  const out: Found[] = [];
  const missing = spec.forms.filter(
    (f) => !f.optional && !f.decimalOnly && message.forms[f.id] === undefined,
  );
  if (missing.length) {
    out.push({
      severity: "error",
      code: "plural-missing-category",
      message: `Send every plural form ${locale} uses: missing ${missing.map((f) => `${f.id} (n = ${f.examples})`).join(", ")}`,
    });
  }
  const known = new Set(spec.forms.map((f) => f.id));
  for (const id of Object.keys(message.forms)) {
    if (!known.has(id)) {
      out.push({
        severity: "error",
        code: "plural-extra-category",
        message: `${locale} has no "${id}" form; use ${[...known].join(", ")}`,
        form: id,
      });
    }
  }
  return out;
}

/**
 * Records entries in the lockfile as they now are on disk, so later edits and source
 * changes can be told apart from the tool's own writes.
 */
async function record(
  project: Project,
  /** `note`: the translator's note for a new translation, `null` to drop the old one. */
  keys: Array<{ target: string; locale: string; key: string; note?: string | null }>,
  entry: (previous: { model?: string } | undefined) => { state: StoredState; model?: string },
): Promise<void> {
  const fresh = await reopenProject(project);
  const lock = fresh.lock;
  for (const k of keys) {
    const target = findTarget(fresh, k.target);
    const src = target?.source.entries.get(k.key);
    const tgt = target?.locales.get(k.locale)?.entries.get(k.key);
    if (!src || !tgt) continue;
    const previous = getLockEntry(lock, k.target, k.locale, k.key);
    // A note belongs to a translation: kept while it stays, replaced with a new one.
    const note = k.note === undefined ? previous?.note : (k.note ?? undefined);
    setLockEntry(lock, k.target, k.locale, k.key, {
      source: hashMessage(src.message),
      sourceText: toValue(src.message),
      target: hashMessage(tgt.message),
      ...entry(previous),
      ...(note ? { note } : {}),
    });
  }
  pruneLock(fresh, lock);
  await writeLock(project.fs, project.lockFile, lock);
  project.lock = lock;
}

/** Drops lock entries for targets and source strings that no longer exist. */
export function pruneLock(project: Project, lock: Lockfile): void {
  for (const id of Object.keys(lock.targets)) {
    const target = findTarget(project, id);
    if (!target) {
      delete lock.targets[id];
      continue;
    }
    for (const byKey of Object.values(lock.targets[id] ?? {})) {
      for (const key of Object.keys(byKey)) {
        if (!target.source.entries.has(key)) delete byKey[key];
      }
    }
  }
}

export interface ApproveOptions {
  locales?: string[];
  targets?: string[];
  keys?: string[];
  /** Which entries to approve. Default: drafts and reviewed entries. */
  states?: EntryState[];
  /** The state to set. Default: approved. */
  to?: "reviewed" | "approved";
  dryRun?: boolean;
}

export interface ApproveResult {
  changed: Array<{ target: string; locale: string; key: string; from: EntryState }>;
  files: string[];
  dryRun: boolean;
}

/**
 * Marks entries reviewed or approved. Also accepts hand edits (`edited`) and translations
 * made before the tool (`untracked`) when asked for those states. Clears the format's own
 * unreviewed flag (gettext fuzzy, String Catalog needs_review) on approval.
 */
export async function approve(project: Project, opts: ApproveOptions = {}): Promise<ApproveResult> {
  return withProjectWrite(project, opts.dryRun, (fresh) => approveUnlocked(fresh, opts));
}

async function approveUnlocked(project: Project, opts: ApproveOptions): Promise<ApproveResult> {
  const locales = opts.locales ?? projectLocales(project);
  const states = opts.states ?? ["draft", "reviewed"];
  const to = opts.to ?? "approved";
  const wanted = opts.keys ? new Set(opts.keys) : undefined;
  const result: ApproveResult = { changed: [], files: [], dryRun: !!opts.dryRun };
  const unflag = new Map<Target, Map<string, Map<string, Entry>>>();

  for (const { target } of project.targets) {
    if (opts.targets && !opts.targets.includes(target.id)) continue;
    for (const locale of locales) {
      const catalog = target.locales.get(locale);
      if (!catalog) continue;
      for (const src of target.source.entries.values()) {
        if (!src.translatable) continue;
        if (wanted && !wanted.has(src.key) && !wanted.has(displayKey(src.key))) continue;
        const tgt = catalog.entries.get(src.key);
        const state = entryState(src, tgt, getLockEntry(project.lock, target.id, locale, src.key));
        if (!tgt || !states.includes(state) || state === to) continue;
        result.changed.push({ target: target.id, locale, key: src.key, from: state });
        if (to === "approved" && tgt.needsReview) {
          const byLocale = unflag.get(target) ?? new Map<string, Map<string, Entry>>();
          const entries = byLocale.get(locale) ?? new Map<string, Entry>();
          entries.set(src.key, { ...tgt, needsReview: false });
          byLocale.set(locale, entries);
          unflag.set(target, byLocale);
        }
      }
    }
  }
  if (opts.dryRun || result.changed.length === 0) {
    result.changed = result.changed.map((c) => ({ ...c, key: displayKey(c.key) }));
    return result;
  }

  const files = new Set<string>();
  for (const [target, byLocale] of unflag) {
    for (const [locale, entries] of byLocale) {
      for (const f of (await target.writeLocale({ locale, entries })).files) files.add(f);
    }
  }
  result.files = [...files].sort();
  await record(project, result.changed, (previous) => ({
    state: to,
    ...(previous?.model ? { model: previous.model } : {}),
  }));
  result.changed = result.changed.map((c) => ({ ...c, key: displayKey(c.key) }));
  return result;
}

export interface RemoveOptions {
  locales?: string[];
  targets?: string[];
  keys?: string[];
  /** Which entries; at least one of keys or states is required. */
  states?: EntryState[];
  /** Also remove translations a person wrote, reviewed or approved. */
  force?: boolean;
  dryRun?: boolean;
}

export interface RemoveResult {
  removed: Array<{ target: string; locale: string; key: string; from: EntryState }>;
  refused: Array<{ target: string; locale: string; key: string; state: EntryState }>;
  files: string[];
  dryRun: boolean;
}

/** States `remove` may clear without `force`: the tool's own unreviewed work. */
const DISPOSABLE: EntryState[] = ["draft", "stale"];

/**
 * Makes translations untranslated again, so they show up as missing and get redone. Use it
 * to reject bad drafts. Never clears a person's work without `force`.
 */
export async function removeTranslations(
  project: Project,
  opts: RemoveOptions,
): Promise<RemoveResult> {
  return withProjectWrite(project, opts.dryRun, (fresh) => removeUnlocked(fresh, opts));
}

async function removeUnlocked(project: Project, opts: RemoveOptions): Promise<RemoveResult> {
  if (!opts.keys?.length && !opts.states?.length) {
    throw new UserError("Say which translations to remove: keys, states (e.g. draft), or both");
  }
  const locales = opts.locales ?? projectLocales(project);
  const wanted = opts.keys ? new Set(opts.keys) : undefined;
  const result: RemoveResult = { removed: [], refused: [], files: [], dryRun: !!opts.dryRun };
  const plan = new Map<Target, Map<string, string[]>>();

  for (const { target } of project.targets) {
    if (opts.targets && !opts.targets.includes(target.id)) continue;
    for (const locale of locales) {
      const catalog = target.locales.get(locale);
      if (!catalog) continue;
      for (const src of target.source.entries.values()) {
        if (wanted && !wanted.has(src.key) && !wanted.has(displayKey(src.key))) continue;
        const tgt = catalog.entries.get(src.key);
        if (!tgt) continue;
        const lockEntry = getLockEntry(project.lock, target.id, locale, src.key);
        const state = entryState(src, tgt, lockEntry);
        if (opts.states && !opts.states.includes(state)) continue;
        const at = { target: target.id, locale, key: displayKey(src.key) };
        const protectedEdit = state === "stale" && editedByHand(tgt, lockEntry);
        if (!opts.force && (protectedEdit || !DISPOSABLE.includes(state))) {
          result.refused.push({ ...at, state });
          continue;
        }
        result.removed.push({ ...at, from: state });
        const byLocale = plan.get(target) ?? new Map<string, string[]>();
        byLocale.set(locale, [...(byLocale.get(locale) ?? []), src.key]);
        plan.set(target, byLocale);
      }
    }
  }
  if (opts.dryRun || plan.size === 0) return result;

  const files = new Set<string>();
  for (const [target, byLocale] of plan) {
    for (const [locale, keys] of byLocale) {
      for (const f of (await target.removeTranslations(locale, keys)).files) files.add(f);
      for (const key of keys) delete project.lock.targets[target.id]?.[locale]?.[key];
    }
  }
  result.files = [...files].sort();
  await writeLock(project.fs, project.lockFile, project.lock);
  return result;
}

export interface PruneResult {
  removed: Array<{
    target: string;
    locale: string;
    key: string;
    reason: "orphan" | "not-translatable";
  }>;
  /** Lockfile records dropped for strings or targets that no longer exist. */
  lockEntries: number;
  files: string[];
  dryRun: boolean;
}

/**
 * Cleans up what source changes leave behind: translations of strings that were deleted or
 * renamed, translations of strings now marked not translatable, and their lockfile records.
 */
export async function prune(
  project: Project,
  opts: { targets?: string[]; dryRun?: boolean } = {},
): Promise<PruneResult> {
  return withProjectWrite(project, opts.dryRun, (fresh) => pruneUnlocked(fresh, opts));
}

async function pruneUnlocked(
  project: Project,
  opts: { targets?: string[]; dryRun?: boolean },
): Promise<PruneResult> {
  const result: PruneResult = { removed: [], lockEntries: 0, files: [], dryRun: !!opts.dryRun };
  const plan = new Map<Target, Map<string, string[]>>();
  for (const { target } of project.targets) {
    if (opts.targets && !opts.targets.includes(target.id)) continue;
    for (const [locale, catalog] of target.locales) {
      for (const tgt of catalog.entries.values()) {
        const src = target.source.entries.get(tgt.key);
        const reason = !src
          ? "orphan"
          : !src.translatable && hashMessage(src.message) !== hashMessage(tgt.message)
            ? "not-translatable"
            : undefined;
        if (!reason) continue;
        result.removed.push({ target: target.id, locale, key: displayKey(tgt.key), reason });
        const byLocale = plan.get(target) ?? new Map<string, string[]>();
        byLocale.set(locale, [...(byLocale.get(locale) ?? []), tgt.key]);
        plan.set(target, byLocale);
      }
    }
  }

  const lock = structuredClone(project.lock);
  const count = (l: Lockfile) =>
    Object.values(l.targets).reduce(
      (n, byLocale) =>
        n + Object.values(byLocale).reduce((m, keys) => m + Object.keys(keys).length, 0),
      0,
    );
  const before = count(lock);
  pruneLock(project, lock);
  result.lockEntries = before - count(lock);
  if (opts.dryRun) return result;

  const files = new Set<string>();
  for (const [target, byLocale] of plan) {
    for (const [locale, keys] of byLocale) {
      for (const f of (await target.removeTranslations(locale, keys)).files) files.add(f);
    }
  }
  result.files = [...files].sort();
  if (result.lockEntries > 0) {
    await writeLock(project.fs, project.lockFile, lock);
    project.lock = lock;
  }
  return result;
}

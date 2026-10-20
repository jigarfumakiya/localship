import path from "node:path";
import { type IcuDialect, joinIcuPlural, scanIcu, splitIcuPlural } from "../../core/icu.js";
import {
  type Catalog,
  type Entry,
  type Issue,
  type Message,
  PLURAL_CATEGORIES,
  type PluralSpec,
  sortPluralKeys,
  type ValueAnalysis,
} from "../../core/model.js";
import {
  expandPattern,
  formatLocaleSegment,
  type LocaleStyle,
  matchPattern,
  relativePath,
} from "../../core/paths.js";
import { findPlaceholders, type PlaceholderSyntax } from "../../core/placeholders.js";
import { cldrPluralSpec } from "../../core/plurals.js";
import {
  child,
  deletePath,
  detectStyle,
  fromJs,
  type JNode,
  type JObject,
  JsonError,
  type JsonStyle,
  lineIndex,
  parseJson,
  setPath,
  stringifyJson,
  toJs,
} from "../json-tree.js";
import type { FormatAdapter, Target, WriteResult } from "../types.js";

export interface ArbTarget {
  id?: string;
  format: "arb";
  /** Pattern with `{locale}`, e.g. `lib/l10n/app_{locale}.arb`. */
  path: string;
}

export interface JsonTarget {
  id?: string;
  format: "json";
  /** Pattern with `{locale}`, e.g. `locales/{locale}.json` or `public/locales/{locale}/common.json`. */
  path: string;
  /**
   * `i18next` (default): `{{name}}`, plurals as `key_one`/`key_other`. `icu` (format.js, next-intl):
   * `{name}`, plurals as `{count, plural, …}`. Others only change which placeholders are checked.
   */
  placeholders?: PlaceholderSyntax;
}

/** How one kind of JSON file spells things. */
interface Dialect {
  format: "arb" | "json";
  syntax: PlaceholderSyntax;
  /** Plurals are one ICU message; otherwise one key per form, i18next style. */
  icuPlurals: boolean;
  icu: IcuDialect;
  /** ARB: flat, with `@key` metadata and `@@locale`. */
  arb: boolean;
}

/** One translatable unit: a string, an array, or every key of an i18next plural. */
interface Unit {
  key: string;
  message: Message;
  /** Where its values live: one path, or one per plural form for i18next. */
  paths: string[][];
  offset?: number;
  /** ICU plural argument (`count`). */
  arg?: string;
}

interface LocaleFile {
  abs: string;
  rel: string;
  doc: JObject;
  style: JsonStyle;
  units: Map<string, Unit>;
}

const SUFFIX = new RegExp(`^(.+)_(${PLURAL_CATEGORIES.join("|")})$`);
const EXACT_FORMS = ["=0", "=1"];
/** Flutter fills one slot for both spellings: `=1{…}` is `one{…}` (intl tries 0, 1, 2 exactly first). */
const FLUTTER_EXACT: Record<string, string> = { "=0": "zero", "=1": "one", "=2": "two" };

export const arbAdapter: FormatAdapter<ArbTarget> = {
  format: "arb",
  open: async (config, ctx) =>
    openJson(config, ctx, {
      format: "arb",
      syntax: "icu",
      icuPlurals: true,
      arb: true,
      // gen-l10n prints `#` as is; apostrophes quote only with `use-escaping: true`.
      icu: { pound: false, escaping: await flutterEscaping(ctx.fs, ctx.root, config.path) },
    }),
};

/** `use-escaping: true` in the l10n.yaml nearest the ARB folder (Flutter reads it from the package root). */
async function flutterEscaping(
  fs: Parameters<FormatAdapter<unknown>["open"]>[1]["fs"],
  root: string,
  pattern: string,
): Promise<boolean> {
  let dir = path.resolve(root, path.dirname(pattern));
  for (;;) {
    const file = path.join(dir, "l10n.yaml");
    if (await fs.exists(file)) {
      return /^use-escaping:\s*true\b/m.test(await fs.readFile(file));
    }
    if (dir === root || path.dirname(dir) === dir || !dir.startsWith(root)) return false;
    dir = path.dirname(dir);
  }
}

export const jsonAdapter: FormatAdapter<JsonTarget> = {
  format: "json",
  open: (config, ctx) => {
    const syntax = config.placeholders ?? "i18next";
    return openJson(config, ctx, {
      format: "json",
      syntax,
      icuPlurals: syntax === "icu",
      arb: false,
      icu: { pound: true },
    });
  },
};

async function openJson(
  config: { path: string },
  { fs, root, sourceLocale, id }: Parameters<FormatAdapter<unknown>["open"]>[1],
  dialect: Dialect,
): Promise<Target> {
  const issues: Issue[] = [];
  const source: Catalog = { locale: sourceLocale, entries: new Map() };
  const locales = new Map<string, Catalog>();
  const files = new Map<string, LocaleFile>();

  const target: Target = {
    id,
    format: dialect.format,
    label: config.path,
    source,
    locales,
    issues,
    analyze: (value, entry) => {
      if (dialect.syntax !== "icu") {
        // i18next always passes the plural count as `count`.
        const placeholders = findPlaceholders(value, dialect.syntax).map((p) =>
          dialect.syntax === "i18next" && p.id === "count" ? { ...p, type: "d" } : p,
        );
        return { text: value, placeholders, tags: [], lints: [] };
      }
      const scan = scanIcu(value, dialect.icu, entry.attrs?.icuArg);
      const lints: ValueAnalysis["lints"] = scan.error
        ? [{ severity: "error", code: "icu-malformed", message: scan.error }]
        : [];
      if (!dialect.icu.pound && entry.message.kind === "plural" && value.includes("#")) {
        lints.push({
          severity: "warning",
          code: "icu-pound",
          message: `Flutter shows # as it is; write {${entry.attrs?.icuArg ?? "count"}} for the number`,
        });
      }
      return { text: value, placeholders: scan.placeholders, tags: [], lints };
    },
    pluralSpec: (locale) => pluralSpec(locale, dialect),
    writeLocale: (catalog) => writeLocale(catalog),
    removeTranslations: (locale, keys) => removeTranslations(locale, keys),
  };

  const matches = await matchPattern(fs, root, config.path);
  const localeStyle: LocaleStyle = matches.some((m) => m.segment.includes("_"))
    ? "underscore"
    : matches.some((m) => m.segment.includes("-")) || !dialect.arb
      ? "bcp47"
      : "underscore";

  for (const m of matches) {
    const rel = relativePath(root, m.file);
    const text = await fs.readFile(m.file);
    let doc: JObject;
    try {
      const parsed = parseJson(text);
      if (parsed.kind !== "object") throw new JsonError("Expected an object at the top", 1);
      doc = parsed;
    } catch (e) {
      if (!(e instanceof JsonError)) throw e;
      issues.push({
        severity: "error",
        code: "json-malformed",
        message: e.message.replace(/ \(line \d+\)$/, ""),
        target: id,
        locale: m.locale,
        file: rel,
        line: e.line,
      });
      continue;
    }
    const lineOf = lineIndex(text);
    const duplicate = (key: string, offset?: number) =>
      issues.push({
        severity: "error",
        code: "duplicate-key",
        message: `${key} is defined more than once`,
        target: id,
        locale: m.locale,
        key,
        file: rel,
        line: lineOf(offset),
      });
    const { leaves, meta } = readLeaves(doc, dialect, duplicate);
    const units = toUnits(leaves, dialect, duplicate);
    files.set(m.locale, { abs: m.file, rel, doc, style: detectStyle(text), units });

    const isSource = m.locale === sourceLocale;
    const catalog: Catalog = isSource ? source : { locale: m.locale, entries: new Map() };
    for (const u of units.values()) {
      const entry: Entry = {
        key: u.key,
        message: u.message,
        translatable: hasText(u.message),
        file: rel,
        line: lineOf(u.offset),
        ...(u.arg ? { attrs: { icuArg: u.arg } } : {}),
      };
      const comment = isSource ? describe(meta.get(u.key)) : undefined;
      if (comment) entry.comment = comment;
      catalog.entries.set(u.key, entry);
    }
    if (!isSource) locales.set(m.locale, catalog);
  }

  const sourceFile = files.get(sourceLocale);
  if (!sourceFile && !issues.some((i) => i.locale === sourceLocale)) {
    issues.push({
      severity: "error",
      code: "target-missing",
      message: `Source file not found: ${expandPattern(config.path, sourceLocale, localeStyle)}`,
      target: id,
    });
  }
  // Translations of strings no longer in the source stay readable (for prune), but untranslatable.
  for (const catalog of locales.values()) {
    for (const entry of catalog.entries.values()) {
      const src = source.entries.get(entry.key);
      if (!src) entry.translatable = false;
      else if (src.attrs) entry.attrs = src.attrs;
    }
  }

  // New keys go where the source has them, so translation files read in the same order.
  const ranks = new Map<string, number>();
  /** i18next plurals: where the first form of each group is, so every form sorts next to it. */
  const groupRanks = new Map<string, number>();
  for (const u of sourceFile?.units.values() ?? []) {
    for (const p of u.paths) {
      for (let d = 1; d <= p.length; d++) {
        const k = p.slice(0, d).join("\u0000");
        if (!ranks.has(k)) ranks.set(k, ranks.size);
      }
      const m = u.message.kind === "plural" && SUFFIX.exec(p.at(-1) as string);
      const group = m && [...p.slice(0, -1), m[1]].join("\u0000");
      if (group && !groupRanks.has(group)) groupRanks.set(group, ranks.get(p.join("\u0000")) ?? 0);
    }
  }
  const order = (a: string, b: string, parent: string[]) => rank(parent, a) - rank(parent, b) || 0;
  const rank = (parent: string[], key: string): number => {
    if (key === "@@locale") return -1;
    // Plural forms, including ones the source language lacks (Arabic `few`), in CLDR order.
    const m = SUFFIX.exec(key);
    const group = m && groupRanks.get([...parent, m[1]].join("\u0000"));
    if (m && group !== undefined && group !== null) {
      return group + PLURAL_CATEGORIES.indexOf(m[2] as never) * 0.01;
    }
    const exact = ranks.get([...parent, key].join("\u0000"));
    if (exact !== undefined) return exact;
    if (dialect.arb && key.startsWith("@")) return rank(parent, key.slice(1)) + 0.5;
    return Number.POSITIVE_INFINITY;
  };

  function fileFor(locale: string): LocaleFile {
    const existing = files.get(locale);
    if (existing) return existing;
    if (!sourceFile) throw new Error(`${config.path}: no source file, so nothing can be written`);
    const abs = path.resolve(root, expandPattern(config.path, locale, localeStyle));
    const doc: JObject = { kind: "object", entries: [] };
    if (dialect.arb) {
      const value = formatLocaleSegment(locale, "underscore");
      doc.entries.push({ key: "@@locale", value: { kind: "value", value } });
    }
    const style = { ...sourceFile.style, emptyObject: "compact" as const };
    const file = { abs, rel: relativePath(root, abs), doc, style, units: new Map() };
    files.set(locale, file);
    return file;
  }

  async function writeLocale(catalog: Catalog): Promise<WriteResult> {
    const file = fileFor(catalog.locale);
    const sourceUnits = sourceFile?.units ?? new Map<string, Unit>();
    for (const entry of catalog.entries.values()) {
      const src = sourceUnits.get(entry.key);
      if (!src) continue;
      const m = entry.message;
      const at = src.paths[0] as string[];
      if (m.kind === "plural" && !dialect.icuPlurals) {
        // One key per form, named after the source's: items_other → items_few.
        const parent = at.slice(0, -1);
        const base = (SUFFIX.exec(at.at(-1) as string)?.[1] ?? at.at(-1)) as string;
        const written = new Set<string>();
        for (const form of sortPluralKeys(Object.keys(m.forms))) {
          const p = [...parent, `${base}_${form}`];
          written.add(p.join("\u0000"));
          setPath(file.doc, p, str(m.forms[form] as string), order);
        }
        for (const p of file.units.get(entry.key)?.paths ?? []) {
          if (!written.has(p.join("\u0000"))) deleteAndPrune(file.doc, p);
        }
        continue;
      }
      const value: JNode =
        m.kind === "plural"
          ? str(joinIcuPlural(src.arg ?? "count", m.forms, sortPluralKeys(Object.keys(m.forms))))
          : m.kind === "array"
            ? fromJs(m.items, () => 0)
            : str(m.value);
      setPath(file.doc, at, value, order);
    }
    await fs.writeFile(file.abs, stringifyJson(file.doc, file.style));
    return { files: [file.rel] };
  }

  async function removeTranslations(locale: string, keys: string[]): Promise<WriteResult> {
    const file = files.get(locale);
    if (!file) return { files: [] };
    let changed = false;
    for (const key of keys) {
      for (const p of file.units.get(key)?.paths ?? [])
        changed = deleteAndPrune(file.doc, p) || changed;
      if (dialect.arb) changed = deletePath(file.doc, [`@${key}`]) || changed;
    }
    if (!changed) return { files: [] };
    await fs.writeFile(file.abs, stringifyJson(file.doc, file.style));
    return { files: [file.rel] };
  }

  return target;
}

const str = (value: string): JNode => ({ kind: "value", value });

interface Leaf {
  path: string[];
  value: string | string[];
  offset?: number;
}

/** Every string (and array of strings) in the file, with its path. ARB keeps only the top level. */
function readLeaves(
  doc: JObject,
  dialect: Dialect,
  duplicate: (key: string, offset?: number) => void,
): { leaves: Leaf[]; meta: Map<string, unknown> } {
  const leaves: Leaf[] = [];
  const meta = new Map<string, unknown>();
  const walk = (node: JObject, at: string[]) => {
    const seen = new Set<string>();
    for (const e of node.entries) {
      const p = [...at, e.key];
      if (seen.has(e.key)) duplicate(p.join("."), e.offset);
      seen.add(e.key);
      if (dialect.arb) {
        if (e.key.startsWith("@@")) continue;
        if (e.key.startsWith("@")) {
          meta.set(e.key.slice(1), toJs(e.value));
          continue;
        }
      }
      const v = e.value;
      if (v.kind === "value" && typeof v.value === "string") {
        leaves.push({ path: p, value: v.value, offset: e.offset });
      } else if (
        v.kind === "array" &&
        v.items.length > 0 &&
        v.items.every((i) => i.kind === "value" && typeof i.value === "string")
      ) {
        leaves.push({ path: p, value: toJs(v) as string[], offset: e.offset });
      } else if (v.kind === "object" && !dialect.arb) {
        walk(v, p);
      }
      // Numbers, booleans and nulls aren't text; they stay as they are.
    }
  };
  walk(doc, []);
  return { leaves, meta };
}

function toUnits(
  leaves: Leaf[],
  dialect: Dialect,
  duplicate: (key: string, offset?: number) => void,
): Map<string, Unit> {
  const units = new Map<string, Unit>();
  const add = (u: Unit) => {
    if (units.has(u.key)) duplicate(u.key, u.offset);
    else units.set(u.key, u);
  };

  // i18next plurals: sibling keys `items_one`, `items_other`… form one unit when `other` is there.
  const groups = new Map<string, Leaf[]>();
  if (!dialect.icuPlurals) {
    for (const leaf of leaves) {
      const m = typeof leaf.value === "string" ? SUFFIX.exec(leaf.path.at(-1) as string) : null;
      if (!m || (m[1] as string).endsWith("_ordinal")) continue;
      const base = [...leaf.path.slice(0, -1), m[1] as string].join("\u0000");
      groups.set(base, [...(groups.get(base) ?? []), leaf]);
    }
    for (const [base, list] of groups) {
      if (!list.some((l) => (l.path.at(-1) as string).endsWith("_other"))) groups.delete(base);
    }
  }

  const done = new Set<string>();
  for (const leaf of leaves) {
    const m = SUFFIX.exec(leaf.path.at(-1) as string);
    const base = m ? [...leaf.path.slice(0, -1), m[1] as string] : undefined;
    const group = base && groups.get(base.join("\u0000"));
    if (base && group) {
      if (done.has(base.join("\u0000"))) continue;
      done.add(base.join("\u0000"));
      const forms: Record<string, string> = {};
      for (const l of group)
        forms[SUFFIX.exec(l.path.at(-1) as string)?.[2] as string] = l.value as string;
      add({
        key: base.join("."),
        message: { kind: "plural", forms },
        paths: group.map((l) => l.path),
        offset: leaf.offset,
      });
      continue;
    }
    const key = leaf.path.join(".");
    if (Array.isArray(leaf.value)) {
      add({
        key,
        message: { kind: "array", items: leaf.value },
        paths: [leaf.path],
        offset: leaf.offset,
      });
      continue;
    }
    const plural = dialect.icuPlurals ? splitIcuPlural(leaf.value, dialect.icu) : undefined;
    if (plural && dialect.arb) {
      // In file order, so a later spelling of the same slot wins, as gen-l10n does.
      const forms: Record<string, string> = {};
      for (const [k, v] of Object.entries(plural.forms)) forms[FLUTTER_EXACT[k] ?? k] = v;
      plural.forms = forms;
    }
    add({
      key,
      message: plural
        ? { kind: "plural", forms: plural.forms }
        : { kind: "text", value: leaf.value },
      paths: [leaf.path],
      offset: leaf.offset,
      ...(plural ? { arg: plural.arg } : {}),
    });
  }
  return units;
}

function pluralSpec(locale: string, dialect: Dialect): PluralSpec {
  const spec = cldrPluralSpec(locale);
  if (dialect.arb) {
    // intl uses zero, one and two for exactly 0, 1 and 2 in any language, before CLDR's rule.
    const exact = ["zero", "one", "two"].filter((id) => !spec.forms.some((f) => f.id === id));
    spec.forms.unshift(
      ...exact.map((id) => ({
        id,
        examples: String(["zero", "one", "two"].indexOf(id)),
        countImplied: true,
        optional: true,
      })),
    );
    spec.forms.sort(
      (a, b) => PLURAL_CATEGORIES.indexOf(a.id as never) - PLURAL_CATEGORIES.indexOf(b.id as never),
    );
    if (exact.length) spec.source = "CLDR + Flutter exact 0, 1, 2";
  } else if (dialect.icuPlurals) {
    // ICU lets any language give exact counts their own text: =0{No notes}.
    spec.forms.unshift(
      ...EXACT_FORMS.map((id) => ({
        id,
        examples: id.slice(1),
        countImplied: true,
        optional: true,
      })),
    );
    spec.source = "CLDR + ICU exact counts";
  } else if (!spec.forms.some((f) => f.id === "zero")) {
    // i18next uses `_zero` for a count of 0 in every language when it's there.
    spec.forms.unshift({ id: "zero", examples: "0", countImplied: true, optional: true });
    spec.source = "CLDR + i18next zero";
  }
  return spec;
}

/** Deletes a value and any objects it leaves empty. */
function deleteAndPrune(doc: JObject, p: string[]): boolean {
  if (!deletePath(doc, p)) return false;
  for (let d = p.length - 1; d > 0; d--) {
    let node: JNode | undefined = doc;
    for (const k of p.slice(0, d)) node = child(node, k);
    if (node?.kind !== "object" || node.entries.length > 0) break;
    deletePath(doc, p.slice(0, d));
  }
  return true;
}

function hasText(message: Message): boolean {
  const values =
    message.kind === "text"
      ? [message.value]
      : message.kind === "plural"
        ? Object.values(message.forms)
        : message.items;
  return values.some((v) => v.trim() !== "");
}

/** The ARB `@key` description, plus placeholder examples, as the comment translators see. */
function describe(meta: unknown): string | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  const { description, placeholders } = meta as {
    description?: unknown;
    placeholders?: Record<string, { type?: unknown; example?: unknown }>;
  };
  const parts: string[] = [];
  if (typeof description === "string" && description.trim()) parts.push(description.trim());
  const args = Object.entries(placeholders ?? {}).map(([name, p]) => {
    const extra = [p?.type, p?.example !== undefined ? `e.g. ${String(p.example)}` : undefined]
      .filter((x) => x !== undefined && x !== "")
      .join(", ");
    return extra ? `{${name}} (${extra})` : `{${name}}`;
  });
  if (args.length) parts.push(`Placeholders: ${args.join(", ")}`);
  return parts.length ? parts.join(". ") : undefined;
}

/** CLDR plural categories, in CLDR order. */
export const PLURAL_CATEGORIES = ["zero", "one", "two", "few", "many", "other"] as const;
export type PluralCategory = (typeof PLURAL_CATEGORIES)[number];

/**
 * A localizable message.
 *
 * Plural forms are keyed by CLDR category (`one`, `few`, …) for formats that use CLDR,
 * or by index (`"0"`, `"1"`, …) for gettext, whose forms are numbered by the file's
 * `Plural-Forms` formula. The format's {@link PluralSpec} says which keys a locale needs.
 *
 * Values are whatever the format adapter finds most faithful: Android keeps the raw inner
 * XML (escapes included); gettext keeps the decoded string.
 */
export type Message =
  | { kind: "text"; value: string }
  | { kind: "plural"; forms: Record<string, string> }
  | { kind: "array"; items: string[] };

export interface Entry {
  /** Identity within the catalog. For gettext: `msgctxt` + U+0004 + `msgid`. */
  key: string;
  message: Message;
  /** Developer comment for translators (XML comment, gettext `#.`). */
  comment?: string;
  /** Disambiguation context shown to translators (gettext `msgctxt`). */
  context?: string;
  /** Where the string is used in code (gettext `#:`), as `path:line`. */
  references?: string[];
  /** Format flags (gettext `c-format`, `fuzzy`, …). */
  flags?: string[];
  /** The format itself marks this translation as unreviewed (gettext `fuzzy`, xcstrings `needs_review`). */
  needsReview?: boolean;
  translatable: boolean;
  /** Path of the file the entry lives in, relative to the project root. */
  file: string;
  line: number;
  /** Format-specific attributes that must survive a round trip (e.g. Android `formatted`). */
  attrs?: Record<string, string>;
}

export interface Catalog {
  locale: string;
  /** Insertion order is file order, which writers preserve. */
  entries: Map<string, Entry>;
}

export type Severity = "error" | "warning" | "info";

export interface Issue {
  severity: Severity;
  /** Content could not be checked; strict validation must not claim completeness. */
  blocksCompleteness?: boolean;
  /** Stable, machine-readable code, e.g. `placeholder-missing`. */
  code: string;
  message: string;
  target?: string;
  locale?: string;
  key?: string;
  /** Plural form or array index the issue is about. */
  form?: string;
  file?: string;
  line?: number;
}

export interface Placeholder {
  /** Argument identity: `"1"`, `"2"` … for numbered or ordinal arguments, or a name (`user`). */
  id: string;
  /** Conversion when the syntax has one (`s`, `d`, `f`, …), lower-cased. */
  type?: string;
  raw: string;
  /** True when the argument is addressed explicitly (`%1$s`, `{name}`), so it may be reordered. */
  positional: boolean;
}

/** A single value as the format sees it, ready for checks. */
export interface ValueAnalysis {
  /** What the user sees: escapes and markup resolved. */
  text: string;
  placeholders: Placeholder[];
  /** Markup tags inside the value, e.g. `b`, `xliff:g`. */
  tags: string[];
  /** Problems with the value on its own, independent of the source. */
  lints: Array<Pick<Issue, "severity" | "code" | "message">>;
}

/** The plural forms a locale needs in a given format, with what each one is for. */
export interface PluralSpec {
  scheme: "cldr" | "gettext";
  forms: PluralFormSpec[];
  /** Where the rule came from, for messages (e.g. `CLDR`, `Plural-Forms header`). */
  source: string;
}

export interface PluralFormSpec {
  /** Key in {@link Message} plural forms: a CLDR category or a gettext index. */
  id: string;
  /** Sample counts that select this form, e.g. `1, 21, 31, 41…`. */
  examples: string;
  /** Only ever one number (like 1), so the form may spell it out instead of using a placeholder. */
  countImplied: boolean;
  /** Allowed but never required (Apple's `zero`, usable in any language). */
  optional?: boolean;
  /** Only fractional counts select it (Czech `many`), so integer counts never reach it. */
  decimalOnly?: boolean;
}

/** Plural form keys in their natural order: ICU exact counts (`=0`), CLDR order, then numeric. */
export function sortPluralKeys(keys: string[]): string[] {
  const rank = (k: string) => {
    if (k.startsWith("=")) return -100 + Number(k.slice(1));
    const c = PLURAL_CATEGORIES.indexOf(k as PluralCategory);
    return c >= 0 ? c : 100 + Number(k);
  };
  return [...keys].sort((a, b) => rank(a) - rank(b));
}

export function messageValues(message: Message): Array<[form: string, value: string]> {
  switch (message.kind) {
    case "text":
      return [["", message.value]];
    case "plural":
      return sortPluralKeys(Object.keys(message.forms)).map((k) => [k, message.forms[k] as string]);
    case "array":
      return message.items.map((v, i) => [String(i), v]);
  }
}

/** Human-readable key: gettext context and message id joined with a bar. */
export function displayKey(key: string): string {
  return key.replace("\u0004", " | ");
}

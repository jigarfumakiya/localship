import type { FileSystem } from "../core/fs.js";
import type { Catalog, Entry, Issue, PluralSpec, ValueAnalysis } from "../core/model.js";

export interface OpenContext {
  fs: FileSystem;
  /** Directory the config's paths are relative to. */
  root: string;
  sourceLocale: string;
  /** Target id from the config, unique within the project. */
  id: string;
}

/**
 * A target after loading: the source catalog, every locale found on disk, and the
 * format-specific operations checks and writers need.
 */
export interface Target {
  readonly id: string;
  readonly format: string;
  /** Human label, e.g. the resource directory or path pattern. */
  readonly label: string;
  readonly source: Catalog;
  readonly locales: Map<string, Catalog>;
  /** File-level problems: parse errors, duplicate keys, broken headers. */
  readonly issues: Issue[];
  /**
   * Translations may number unnumbered source placeholders themselves (Apple: `%@` → `%1$@`),
   * so the source needn't. Xcode generates source keys from code, where they can't be numbered.
   */
  readonly translationsMayReorder?: boolean;
  /**
   * A leading or trailing newline must match the source exactly (gettext: `msgfmt --check`
   * rejects the file otherwise). Elsewhere it is only a whitespace warning.
   */
  readonly strictNewlines?: boolean;
  /** Resolves a raw value so generic checks can compare source and translation. */
  analyze(value: string, entry: Entry): ValueAnalysis;
  /**
   * Turns a translation written as plain text into the file's own syntax (Android escapes
   * apostrophes, quotes and `&`). Formats that store plain text don't need it.
   */
  prepareValue?(value: string, source: Entry): string;
  /**
   * The format can flag a translation as unreviewed without hiding it (String Catalog
   * `needs_review`). gettext `fuzzy` stops a translation from being used, so drafts there
   * are tracked only in the lockfile.
   */
  readonly marksDrafts?: boolean;
  /** What translators must know about this target beyond its format (e.g. Flutter `use-escaping`). */
  readonly formatNote?: string;
  /**
   * Plural forms this locale needs in this format; undefined when it can't be known. `message`
   * says which forms one message fills and its source entry, for formats where that changes what
   * each form covers (Flutter: a filled `zero` takes the count 0 away from French `one`).
   */
  pluralSpec(locale: string, message?: { forms: string[]; source: Entry }): PluralSpec | undefined;
  /** Writes one locale. Entries absent from `catalog` are left as they are on disk. */
  writeLocale(catalog: Catalog): Promise<WriteResult>;
  /**
   * Makes these keys untranslated in one locale, the way the format spells it: Android drops
   * the element, gettext empties `msgstr` (or drops the entry if the source no longer has it),
   * String Catalogs drop the localization.
   */
  removeTranslations(locale: string, keys: string[]): Promise<WriteResult>;
}

export interface WriteResult {
  files: string[];
}

export interface FormatAdapter<TConfig> {
  readonly format: string;
  open(config: TConfig, ctx: OpenContext): Promise<Target>;
}

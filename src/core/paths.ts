import path from "node:path";
import type { FileSystem } from "./fs.js";

/**
 * How a format spells locales in file and folder names.
 * - bcp47: `pt-BR`, `sr-Latn`
 * - gettext: `pt_BR`, `sr@latin`
 * - underscore: `pt_BR`, `zh_Hant` (Flutter)
 */
/** `abs` relative to `root` with forward slashes on every OS, as reports and the lockfile show it. */
export function relativePath(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/");
}

export type LocaleStyle = "bcp47" | "gettext" | "underscore";

const LANGUAGE_NAMES = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });
const GETTEXT_SCRIPTS: Record<string, string> = { latin: "Latn", cyrillic: "Cyrl" };
const SCRIPT_MODIFIERS: Record<string, string> = { Latn: "latin", Cyrl: "cyrillic" };

/** Reads a locale as written in a path (`pt_BR`, `sr@latin`, `zh-Hans`) into canonical BCP 47, or undefined. */
export function parseLocaleSegment(segment: string): string | undefined {
  let tag = segment;
  const at = tag.indexOf("@");
  if (at >= 0) {
    const script = GETTEXT_SCRIPTS[tag.slice(at + 1).toLowerCase()];
    if (!script) return undefined;
    tag = `${tag.slice(0, at)}-${script}`;
  }
  tag = tag.replace(/_/g, "-");
  // language, optional script, optional region. Variants never show up in locale paths.
  if (!/^[A-Za-z]{2,3}(-[A-Za-z]{4})?(-([A-Za-z]{2}|\d{3}))?$/.test(tag)) return undefined;
  try {
    const [canonical] = Intl.getCanonicalLocales(tag);
    const lang = canonical?.split("-")[0] ?? "";
    // `LC_MESSAGES`, `res`, `src` … are shaped like locales but name no language.
    if (!LANGUAGE_NAMES.of(lang)) return undefined;
    // A three-letter name that turns into another code is a word (`src` → Sardinian), not a locale.
    const written = (tag.split("-")[0] ?? "").toLowerCase();
    if (written.length === 3 && written !== lang) return undefined;
    return canonical;
  } catch {
    return undefined;
  }
}

/** Writes a canonical locale in a path style. */
export function formatLocaleSegment(locale: string, style: LocaleStyle): string {
  if (style === "bcp47") return locale;
  // Flutter and Java: pt_BR, zh_Hant, sr_Latn_RS.
  if (style === "underscore") return locale.replace(/-/g, "_");
  const parts = locale.split("-");
  const lang = parts[0] ?? locale;
  const script = parts.find((p) => p.length === 4);
  const region = parts.find((p) => /^([A-Z]{2}|\d{3})$/.test(p));
  const modifier = script ? SCRIPT_MODIFIERS[script] : undefined;
  let out = region ? `${lang}_${region}` : lang;
  if (script && modifier) out += `@${modifier}`;
  else if (script) out = region ? `${lang}_${script}_${region}` : `${lang}_${script}`;
  return out;
}

export const LOCALE_TOKEN = "{locale}";

export function expandPattern(pattern: string, locale: string, style: LocaleStyle): string {
  return pattern.split(LOCALE_TOKEN).join(formatLocaleSegment(locale, style));
}

export interface PatternMatch {
  locale: string;
  /** The locale exactly as spelled in the path. */
  segment: string;
  file: string;
}

/**
 * Finds every file matching a pattern like `locale/{locale}/LC_MESSAGES/django.po` or
 * `po/{locale}.po` under `root`. `{locale}` may appear in one path segment, alongside other text.
 */
export async function matchPattern(
  fs: FileSystem,
  root: string,
  pattern: string,
): Promise<PatternMatch[]> {
  const parts = pattern.split("/").filter((p) => p !== "" && p !== ".");
  const tokenIndex = parts.findIndex((p) => p.includes(LOCALE_TOKEN));
  if (tokenIndex < 0) throw new Error(`Path pattern needs ${LOCALE_TOKEN}: ${pattern}`);
  const before = parts.slice(0, tokenIndex);
  const segmentPattern = parts[tokenIndex] as string;
  const after = parts.slice(tokenIndex + 1);

  const dir = path.resolve(root, ...before);
  if (!(await fs.exists(dir))) return [];
  const [prefix, suffix] = segmentPattern.split(LOCALE_TOKEN) as [string, string];
  const isLast = after.length === 0;
  const out: PatternMatch[] = [];
  for (const entry of await fs.listDir(dir)) {
    if (isLast === entry.isDirectory) continue;
    const name = entry.name;
    if (
      !name.startsWith(prefix) ||
      !name.endsWith(suffix) ||
      name.length <= prefix.length + suffix.length
    )
      continue;
    const segment = name.slice(prefix.length, name.length - suffix.length);
    const locale = parseLocaleSegment(segment);
    if (!locale) continue;
    const file = path.join(dir, name, ...after);
    if (isLast || (await fs.exists(file))) out.push({ locale, segment, file });
  }
  return out.sort((a, b) => a.locale.localeCompare(b.locale));
}

/** The style used by files already on disk, so new files match their neighbors. */
export function inferLocaleStyle(matches: PatternMatch[], fallback: LocaleStyle): LocaleStyle {
  for (const m of matches) {
    if (/[_@]/.test(m.segment)) return "gettext";
    if (m.segment.includes("-")) return "bcp47";
  }
  return fallback;
}

import { scanIcu } from "./icu.js";
import type { Placeholder } from "./model.js";

/**
 * Placeholder syntaxes. Each one finds the arguments a string expects, so a translation
 * can be checked against its source. Names follow gettext's `*-format` flags where one exists.
 */
export const PLACEHOLDER_SYNTAXES = [
  "java", // java.util.Formatter, as used by Android: %s %1$s %.2f
  "c", // C printf, also PHP and JavaScript sprintf: %s %1$s %lu %zu
  "apple", // Foundation String(format:): %@ %lld %1$@, and %#@name@ substitutions
  "python", // Python %-formatting: %(name)s %s
  "python-brace", // str.format: {name} {0} {}
  "java-message", // java.text.MessageFormat: {0} {1,number}
  "qt", // Qt: %1 … %99
  "ruby", // Ruby / Rails: %{name}
  "i18next", // {{name}}
  "icu", // ICU MessageFormat: {name}, {count, plural, …}, as Flutter ARB and format.js use
  "none",
] as const;
export type PlaceholderSyntax = (typeof PLACEHOLDER_SYNTAXES)[number];

export function findPlaceholders(text: string, syntax: PlaceholderSyntax): Placeholder[] {
  switch (syntax) {
    case "java":
      return printf(text, JAVA);
    case "c":
      return printf(text, C);
    case "apple": {
      const subs = [...text.matchAll(/%#@([A-Za-z_]\w*)@/g)].map((m) => ({
        id: `@${m[1]}`,
        raw: m[0],
        positional: true,
      }));
      return [...subs, ...printf(text.replace(/%#@[A-Za-z_]\w*@/g, ""), APPLE)];
    }
    case "python":
      return python(text);
    case "python-brace":
      return brace(text);
    case "java-message":
      return [...text.matchAll(/\{(\d+)(?:,[^{}]*)?\}/g)].map((m) => ({
        id: String(Number(m[1]) + 1),
        raw: m[0],
        positional: true,
      }));
    case "qt":
      return [...text.matchAll(/%(\d{1,2})(?!\d)/g)].map((m) => ({
        id: String(Number(m[1])),
        raw: m[0],
        positional: true,
      }));
    case "ruby":
      return [...text.matchAll(/%\{([A-Za-z_]\w*)\}/g)].map((m) => ({
        id: m[1] as string,
        raw: m[0],
        positional: true,
      }));
    case "i18next":
      return [...text.matchAll(/\{\{-?\s*([\w.]+)(?:\s*,[^}]*)?\s*\}\}/g)].map((m) => ({
        id: m[1] as string,
        raw: m[0],
        positional: true,
      }));
    case "icu":
      return scanIcu(text).placeholders;
    case "none":
      return [];
  }
}

const JAVA = /%(?:(\d+)\$)?([-#+ 0,(<]*)(\d+)?(?:\.\d+)?([tT][a-zA-Z]|[a-zA-Z%])/g;
const C =
  /%(?:(\d+)\$)?([-#+ 0']*)(\d+|\*)?(?:\.(?:\d+|\*))?(hh|h|ll|l|L|q|j|z|Z|t|I64|I32|I)?([diouxXeEfFgGaAcspn%])/g;

const APPLE =
  /%(?:(\d+)\$)?([-#+ 0']*)(\d+|\*)?(?:\.(?:\d+|\*))?(hh|h|ll|l|q|L|z|t|j)?([@diouxXeEfFgGaAcCsSp%])/g;

/** Length modifiers don't change what the argument is: `%lu` and `%u` both take an unsigned number. */
function printf(text: string, re: RegExp): Placeholder[] {
  const found: Placeholder[] = [];
  let ordinal = 0;
  for (const m of text.matchAll(re)) {
    const raw = m[0];
    const index = m[1];
    const flags = m[2] ?? "";
    const conv = (re === JAVA ? m[4] : m[5]) ?? "";
    if (conv === "%" || conv === "n") continue;
    // "50% off" reads as `% o` with a space flag; treat as prose.
    if (flags.includes(" ")) continue;
    const positional = index !== undefined;
    found.push({
      id: String(positional ? Number(index) : ++ordinal),
      type: conv.toLowerCase().replace("i", "d"),
      raw,
      positional,
    });
  }
  return found;
}

function python(text: string): Placeholder[] {
  const found: Placeholder[] = [];
  let ordinal = 0;
  for (const m of text.matchAll(
    /%(?:\(([^)]+)\))?([-#0 +]*)(\d+|\*)?(?:\.(?:\d+|\*))?[hlL]?([diouxXeEfFgGcrsa%])/g,
  )) {
    const [raw, name, flags = "", , conv = ""] = m;
    if (conv === "%") continue;
    if (flags.includes(" ") && !name) continue;
    found.push({
      id: name ?? String(++ordinal),
      type: conv.toLowerCase().replace("i", "d"),
      raw,
      positional: name !== undefined,
    });
  }
  return found;
}

function brace(text: string): Placeholder[] {
  const found: Placeholder[] = [];
  let auto = 0;
  // `{{` and `}}` are literal braces.
  const stripped = text.replace(/\{\{|\}\}/g, "  ");
  for (const m of stripped.matchAll(
    /\{([A-Za-z_]\w*|\d+)?(?:[.[][^{}:!]*)?(?:![rsa])?(?::[^{}]*)?\}/g,
  )) {
    const field = m[1];
    if (field === undefined) {
      found.push({ id: String(++auto), raw: m[0], positional: false });
    } else {
      found.push({
        id: /^\d+$/.test(field) ? String(Number(field) + 1) : field,
        raw: m[0],
        positional: true,
      });
    }
  }
  return found;
}

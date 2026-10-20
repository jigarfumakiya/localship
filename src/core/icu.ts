import type { Placeholder } from "./model.js";

/**
 * ICU MessageFormat, as Flutter ARB files, format.js and next-intl write it:
 * `Hi {name}`, `{count, plural, =0{No notes} one{# note} other{# notes}}`, `{sex, select, …}`.
 * The dialects differ: Flutter prints `#` as is, and quotes with apostrophes only when the
 * project turns on `use-escaping` (then every `'` quotes, and `''` is an apostrophe).
 */
export interface IcuDialect {
  /** `#` in a plural stands for the count (format.js), rather than being text (Flutter). */
  pound?: boolean;
  /** Flutter `use-escaping`: `'…'` is literal text, `''` an apostrophe, a lone `'` an error. */
  escaping?: boolean;
}

const COMPLEX = new Set(["plural", "select", "selectordinal"]);
const PLURAL_SELECTOR = /^(=\d+|zero|one|two|few|many|other)$/;

export interface IcuScan {
  placeholders: Placeholder[];
  /** Set when braces don't balance or a plural/select is malformed. */
  error?: string;
}

/**
 * The arguments a message uses. Plural arguments get type `d`, so plural checks know they hold
 * the count; `count` names that argument for a single plural form read on its own.
 */
export function scanIcu(text: string, dialect: IcuDialect = {}, count?: string): IcuScan {
  const placeholders: Placeholder[] = [];
  let i = 0;

  const fail = (message: string): never => {
    throw new IcuError(message);
  };
  const skipSpace = () => {
    while (i < text.length && /\s/.test(text[i] as string)) i++;
  };
  const word = () => {
    const start = i;
    while (i < text.length && !/[\s,{}]/.test(text[i] as string)) i++;
    return text.slice(start, i);
  };
  /** Skips a quoted run at `i` (on a `'`), when escaping is on. */
  const quote = () => {
    if (text[i + 1] === "'") {
      i += 2;
      return;
    }
    const end = text.indexOf("'", i + 1);
    if (end < 0) fail("Unmatched apostrophe: this project uses use-escaping, so write '' for one");
    // Quoting is for literal braces. Quoted plain text means apostrophes that would vanish:
    // "c'est l'heure" shows as "cest lheure".
    if (!/[{}]/.test(text.slice(i + 1, end))) {
      fail(
        `Apostrophes quote text under use-escaping, so "${text.slice(i, end + 1)}" loses them; write '' for each`,
      );
    }
    i = end + 1;
  };

  // Reads message text until an unmatched `}` (or the end at the top level).
  const message = (top: boolean, countArg: string | undefined) => {
    while (i < text.length) {
      const c = text[i];
      if (c === "}") {
        if (top) fail("Unmatched }");
        return;
      }
      if (c === "'" && dialect.escaping) {
        quote();
        continue;
      }
      if (c === "#" && countArg && dialect.pound) {
        placeholders.push({ id: countArg, type: "d", raw: "#", positional: true });
        i++;
        continue;
      }
      if (c === "{") {
        argument(countArg);
        continue;
      }
      i++;
    }
    if (!top) fail("Missing }");
  };

  const argument = (countArg: string | undefined) => {
    const start = i;
    i++;
    skipSpace();
    const name = word();
    if (!name) fail("Empty {}");
    skipSpace();
    if (text[i] === "}") {
      i++;
      // `{count}` inside its own plural is the count.
      placeholders.push({
        id: name,
        ...(name === countArg ? { type: "d" } : {}),
        raw: text.slice(start, i),
        positional: true,
      });
      return;
    }
    if (text[i] !== ",") fail(`Expected , or } after {${name}`);
    i++;
    skipSpace();
    const type = word();
    skipSpace();
    if (!COMPLEX.has(type)) {
      // {when, date, short}, {n, number, ::currency/EUR}: skip the style, braces balanced.
      let depth = 1;
      while (i < text.length && depth > 0) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}") depth--;
        i++;
      }
      if (depth > 0) fail("Missing }");
      placeholders.push({ id: name, raw: text.slice(start, i), positional: true });
      return;
    }
    placeholders.push({
      id: name,
      ...(type === "select" ? {} : { type: "d" }),
      raw: `{${name}, ${type}}`,
      positional: true,
    });
    if (text[i] !== ",") fail(`Expected , after {${name}, ${type}`);
    i++;
    const cases: string[] = [];
    for (;;) {
      skipSpace();
      if (text[i] === "}") {
        i++;
        break;
      }
      const selector = word();
      if (!selector) fail(`Expected a case in {${name}, ${type}}`);
      if (selector.startsWith("offset:")) continue;
      if (type !== "select" && !PLURAL_SELECTOR.test(selector)) {
        fail(`"${selector}" isn't a plural case; use =0, =1, zero, one, two, few, many or other`);
      }
      skipSpace();
      if (text[i] !== "{") fail(`Expected { after ${selector}`);
      i++;
      message(false, type === "select" ? undefined : name);
      i++;
      cases.push(selector);
    }
    if (!cases.includes("other")) fail(`{${name}, ${type}} needs an "other" case`);
  };

  try {
    message(true, count);
    return { placeholders };
  } catch (e) {
    if (!(e instanceof IcuError)) throw e;
    return { placeholders, error: e.message };
  }
}

class IcuError extends Error {}

/**
 * A message that is exactly one plural (`{count, plural, one{…} other{…}}`), split into its
 * forms. Anything around or beside it, or an offset, keeps the message whole.
 */
export function splitIcuPlural(
  text: string,
  dialect: IcuDialect = {},
): { arg: string; forms: Record<string, string> } | undefined {
  const head = /^\s*\{\s*([^\s,{}]+)\s*,\s*plural\s*,/.exec(text);
  if (!head) return undefined;
  const arg = head[1] as string;
  let i = head[0].length;
  const forms: Record<string, string> = {};
  for (;;) {
    while (i < text.length && /\s/.test(text[i] as string)) i++;
    if (text[i] === "}") {
      i++;
      break;
    }
    const selector = /^(=\d+|zero|one|two|few|many|other)\s*\{/.exec(text.slice(i));
    if (!selector) return undefined;
    i += selector[0].length;
    const start = i;
    let depth = 1;
    while (i < text.length && depth > 0) {
      if (text[i] === "'" && dialect.escaping) {
        const end = text[i + 1] === "'" ? i + 1 : text.indexOf("'", i + 1);
        if (end < 0) return undefined;
        i = end + 1;
        continue;
      }
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
      i++;
    }
    if (depth > 0) return undefined;
    forms[selector[1] as string] = text.slice(start, i - 1);
  }
  if (text.slice(i).trim() !== "" || forms.other === undefined) return undefined;
  return { arg, forms };
}

/** Writes plural forms back as one ICU plural, in the order given. */
export function joinIcuPlural(arg: string, forms: Record<string, string>, order: string[]): string {
  return `{${arg}, plural, ${order.map((k) => `${k}{${forms[k]}}`).join(" ")}}`;
}

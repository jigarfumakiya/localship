import type { Placeholder } from "./model.js";

/**
 * ICU MessageFormat, as Flutter ARB files, format.js and next-intl write it:
 * `Hi {name}`, `{count, plural, =0{No notes} one{# note} other{# notes}}`, `{sex, select, …}`.
 * Apostrophe quoting (`'{'`) is not modeled; braces must balance.
 */

const COMPLEX = new Set(["plural", "select", "selectordinal"]);

export interface IcuScan {
  placeholders: Placeholder[];
  /** Set when braces don't balance or a plural/select is malformed. */
  error?: string;
}

/**
 * The arguments a message uses. `#` inside a plural counts as that plural's argument; `pound`
 * names it for a single plural form read on its own. Plural arguments get type `d`, so plural
 * checks know they hold the count.
 */
export function scanIcu(text: string, pound?: string): IcuScan {
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

  // Reads message text until an unmatched `}` (or the end at the top level).
  const message = (top: boolean, poundArg: string | undefined) => {
    while (i < text.length) {
      const c = text[i];
      if (c === "}") {
        if (top) fail("Unmatched }");
        return;
      }
      if (c === "#" && poundArg) {
        placeholders.push({ id: poundArg, type: "d", raw: "#", positional: true });
        i++;
        continue;
      }
      if (c === "{") {
        argument(poundArg);
        continue;
      }
      i++;
    }
    if (!top) fail("Missing }");
  };

  const argument = (poundArg: string | undefined) => {
    const start = i;
    i++;
    skipSpace();
    const name = word();
    if (!name) fail("Empty {}");
    skipSpace();
    if (text[i] === "}") {
      i++;
      // `{count}` inside its own plural is the count, the same as `#`.
      placeholders.push({
        id: name,
        ...(name === poundArg ? { type: "d" } : {}),
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
    let cases = 0;
    for (;;) {
      skipSpace();
      if (text[i] === "}") {
        i++;
        break;
      }
      const selector = word();
      if (!selector) fail(`Expected a case in {${name}, ${type}}`);
      if (selector.startsWith("offset:")) continue;
      skipSpace();
      if (text[i] !== "{") fail(`Expected { after ${selector}`);
      i++;
      message(false, type === "select" ? undefined : name);
      i++;
      cases++;
    }
    if (!cases) fail(`{${name}, ${type}} has no cases`);
  };

  try {
    message(true, pound);
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

/** Writes plural forms back as one ICU plural, exact counts first, then CLDR order. */
export function joinIcuPlural(arg: string, forms: Record<string, string>, order: string[]): string {
  return `{${arg}, plural, ${order.map((k) => `${k}{${forms[k]}}`).join(" ")}}`;
}

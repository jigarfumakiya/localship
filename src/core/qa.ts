import { getLockEntry } from "./lock.js";
import { displayKey, type Entry, type Issue, type ValueAnalysis } from "./model.js";
import type { Project } from "./project.js";
import type { Found } from "./validate.js";

/**
 * Checks that read the visible text the way a reviewer would: numbers, the closing punctuation,
 * all-caps labels, and links, emails and emoji that must come through unchanged. All are
 * warnings: each catches a common slip, and each has languages where the difference is right.
 */
export function textChecks(
  s: ValueAnalysis,
  t: ValueAnalysis,
  opts: { countImplied?: boolean; locale?: string } = {},
): Found[] {
  const out: Found[] = [];
  const source = visible(s);
  const target = visible(t);
  const language = opts.locale?.split("-")[0] ?? "";

  // A form used for one number only may spell it out ("one note", "ملاحظتان"). A translation
  // that shows the count where the source wrote the number ("{count} tâche" for "1 task", as
  // French `one` also covers 0) shows it too.
  const isCount = (p: { type?: string }) => /^l{0,2}[diu]$/.test(p.type ?? "");
  const showsCount = t.placeholders.some(isCount) && !s.placeholders.some(isCount);
  if (!opts.countImplied && !showsCount) {
    const have = numbers(target);
    for (const n of numbers(source)) {
      // Arabic and Hebrew say "two weeks" with one word, the dual, and "a week" without a 1.
      if (DUAL.has(language) && (n === "1" || n === "2")) continue;
      const i = have.indexOf(n);
      if (i >= 0) have.splice(i, 1);
      else
        out.push({
          severity: "warning",
          code: "number-mismatch",
          message: `The number ${n} from the source is missing`,
        });
    }
  }

  const ending = closing(source);
  if (ending && !NO_QUESTION_MARK.has(language) && !ending.marks.some((m) => endsWith(target, m))) {
    out.push({
      severity: "warning",
      code: "punctuation-end",
      message: `The source ends with "${ending.shown}"; the translation doesn't`,
    });
  }

  if (isAllCaps(source) && readsLowercase(withoutKeptWords(target, source))) {
    out.push({
      severity: "warning",
      code: "case-mismatch",
      message: "The source is in capitals (a label or heading); the translation isn't",
    });
  }

  for (const token of [...matches(source, URL), ...matches(source, EMAIL)]) {
    if (!target.includes(token))
      out.push({
        severity: "warning",
        code: "token-missing",
        message: `${token} from the source is missing or changed`,
      });
  }
  const emoji = matches(target, EMOJI);
  for (const e of matches(source, EMOJI)) {
    const i = emoji.indexOf(e);
    if (i >= 0) emoji.splice(i, 1);
    else
      out.push({
        severity: "warning",
        code: "token-missing",
        message: `The emoji ${e} from the source is missing`,
      });
  }
  return out;
}

/** The text a user reads, without placeholders, whose digits and letters aren't the user's. */
function visible(a: ValueAnalysis): string {
  let text = a.text;
  for (const p of a.placeholders) text = text.split(p.raw).join(" ");
  return text;
}

/** Digits in any script, each run read as one number: "1,385" and "१,३८५" are both 1385. */
function numbers(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\p{Nd}+(?:[.,  '’]\p{Nd}+)*/gu)) {
    const digits = [...m[0]].filter((c) => /\p{Nd}/u.test(c)).map(digitValue);
    out.push(digits.join(""));
  }
  return out;
}

/** Where each script's 0 sits; Unicode keeps every script's ten digits in a row. */
const ZEROS = [
  0x30, 0x660, 0x6f0, 0x7c0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6, 0xd66, 0xde6,
  0xe50, 0xed0, 0xf20, 0x1040, 0x1090, 0x17e0, 0x1810, 0x1946, 0x19d0, 0xa8d0, 0xa900, 0xff10,
];
function digitValue(c: string): string {
  const cp = c.codePointAt(0) ?? 0;
  const zero = ZEROS.find((z) => cp >= z && cp <= z + 9);
  return zero === undefined ? c : String(cp - zero);
}

/** Closing marks a translation should keep, with the forms other scripts write them in. */
const ENDINGS = [
  { shown: "?", marks: ["?", "？", "؟", ";"] },
  { shown: "!", marks: ["!", "！"] },
  { shown: ":", marks: [":", "：", "﹕"] },
  { shown: "…", marks: ["…", "...", "⋯", "‥"] },
];
/** Languages with a dual form, which replaces the numbers 1 and 2. */
const DUAL = new Set(["ar", "he", "iw"]);
/** Languages whose questions and exclamations usually go without a mark. */
const NO_QUESTION_MARK = new Set(["th", "lo", "km", "my"]);

function closing(text: string): { shown: string; marks: string[] } | undefined {
  const end = trimEnd(text);
  if (end.endsWith("...")) return ENDINGS[3];
  return ENDINGS.find((e) => end.endsWith(e.shown));
}
function endsWith(text: string, mark: string): boolean {
  return trimEnd(text).endsWith(mark);
}
/** Without trailing spaces, quotes and brackets, which close after the mark ("Done?"). */
function trimEnd(text: string): string {
  return text.replace(/[\s"'”’»)\]}」』]+$/u, "");
}

/** Without words also in the source, such as brand names kept as written ("LUME" → "Lume"). */
function withoutKeptWords(text: string, source: string): string {
  const kept = new Set(source.toLowerCase().match(/\p{L}+/gu) ?? []);
  return text.replace(/\p{L}+/gu, (w) => (kept.has(w.toLowerCase()) ? " " : w));
}

function isAllCaps(text: string): boolean {
  const cased = [...text].filter(hasCase);
  return cased.length >= 2 && cased.every((c) => c === c.toUpperCase());
}
/**
 * Mostly lowercase, in a script that has case. A Hindi or Arabic translation with a Latin brand
 * name in it ("Pro") isn't judged by those few letters.
 */
function readsLowercase(text: string): boolean {
  const letters = [...text].filter((c) => /\p{L}/u.test(c));
  const cased = letters.filter(hasCase);
  if (cased.length < 2 || cased.length * 2 < letters.length) return false;
  const lower = cased.filter((c) => c !== c.toUpperCase()).length;
  return lower > cased.length - lower;
}
function hasCase(c: string): boolean {
  return c.toLowerCase() !== c.toUpperCase();
}

const URL = /https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]/gu;
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
const EMOJI = /\p{Extended_Pictographic}/gu;
function matches(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((m) => m[0]);
}

/**
 * The same source text translated more than one way in a language, across every target (so an
 * iOS and an Android app are compared too). Often a slip; sometimes right, when the context
 * differs ("Open" as a button and as a status). A translation with a note says why it differs,
 * so it isn't counted.
 */
export function inconsistencies(project: Project, locales: string[]): Issue[] {
  const out: Issue[] = [];
  for (const locale of locales) {
    const bySource = new Map<string, Map<string, Array<{ target: string; entry: Entry }>>>();
    for (const { target } of project.targets) {
      const catalog = target.locales.get(locale);
      if (!catalog) continue;
      for (const src of target.source.entries.values()) {
        if (!src.translatable || src.message.kind !== "text") continue;
        const tgt = catalog.entries.get(src.key);
        if (tgt?.message.kind !== "text") continue;
        if (getLockEntry(project.lock, target.id, locale, src.key)?.note) continue;
        const source = normalize(target.analyze(src.message.value, src).text);
        // gettext contexts (msgctxt) exist to let the same text translate differently.
        const group = `${src.context ?? ""}\u0004${source}`;
        const translation = normalize(target.analyze(tgt.message.value, src).text);
        if (!source || !translation) continue;
        const ways = bySource.get(group) ?? new Map();
        const list = ways.get(translation) ?? [];
        list.push({ target: target.id, entry: tgt });
        ways.set(translation, list);
        bySource.set(group, ways);
      }
    }
    for (const [group, ways] of bySource) {
      if (ways.size < 2) continue;
      const source = group.slice(group.indexOf("\u0004") + 1);
      // Point at the least used wording, the likelier slip.
      const sorted = [...ways].sort((a, b) => b[1].length - a[1].length);
      const odd = sorted.at(-1)?.[1][0];
      const listed = sorted
        .slice(0, 3)
        .map(
          ([text, at]) => `"${short(text)}" (${at.map((x) => displayKey(x.entry.key)).join(", ")})`,
        )
        .join(", ");
      out.push({
        severity: "warning",
        code: "inconsistent",
        message: `"${short(source)}" is translated ${ways.size} ways: ${listed}. If the context differs, add a note to the translation saying how`,
        locale,
        ...(odd
          ? { target: odd.target, key: odd.entry.key, file: odd.entry.file, line: odd.entry.line }
          : {}),
      });
    }
  }
  return out;
}

const normalize = (text: string) => text.trim().replace(/\s+/g, " ");
const short = (text: string) => (text.length > 40 ? `${text.slice(0, 39)}…` : text);

/** Where a string appears, read from the code that uses it. */
export type UiRole =
  | "button"
  | "tab"
  | "chip"
  | "menu item"
  | "app name"
  | "title"
  | "toast"
  | "notification"
  | "placeholder"
  | "accessibility label";

/** Most specific first: an icon button's `contentDescription` is an accessibility label. */
const ROLES: Array<[UiRole, RegExp]> = [
  [
    "accessibility label",
    /contentDescription|accessibility(?:Label|Hint)|aria-label|semanticsLabel/,
  ],
  ["placeholder", /\bplaceholder\b|android:hint|\bhint\s*=|\bhintText:|\b(?:Secure)?TextField\(/],
  // Design systems wrap these (`AppButton`, `SmChip`), so any name ending in the kind counts.
  ["tab", /\b\w*Tab\s*\(|Navigation(?:Bar|Rail)Item|BottomNavigationItem|\.tabItem\b/],
  ["chip", /\b\w*Chip\s*\(/],
  [
    "button",
    /\b\w*Button\s*[({]|<(?:\w+\.)*\w*Button\b|<button\b|(?:confirm|dismiss)Button|set(?:Positive|Negative|Neutral)Button/,
  ],
  ["menu item", /DropdownMenuItem|<item\b[^>]*android:title|\bMenu\s*\{/],
  ["toast", /Toast\.makeText|showSnackbar|Snack[bB]ar(?:\.make)?\(/],
  ["notification", /setContent(?:Title|Text)|NotificationCompat|UNMutableNotificationContent/],
  ["app name", /android:label=/],
  [
    "title",
    /TopAppBar|\bAppBar\(|\btitle\s*[=:]|\.navigationTitle\(|setTitle\(|\.alert\(|<h[1-3]\b/,
  ],
];

/** The role most of a string's usages agree on. */
export function roleOf(usages: Array<{ code: string }>): UiRole | undefined {
  const counts = new Map<UiRole, number>();
  for (const u of usages) {
    // The line with the string decides; the line before it only when that line says nothing.
    const lines = u.code.split("\n").reverse();
    const role = lines
      .map((line) => ROLES.find(([, pattern]) => pattern.test(line))?.[0])
      .find((r) => r !== undefined);
    if (role) counts.set(role, (counts.get(role) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/** Roles with a fixed amount of room, where a much longer translation gets cut off or wraps. */
const TIGHT = new Set<UiRole>(["button", "tab", "chip", "menu item", "app name"]);

/** A translation much wider than its source, in a place with little room. */
export function lengthCheck(
  role: UiRole | undefined,
  s: ValueAnalysis,
  t: ValueAnalysis,
): Found | undefined {
  if (!role || !TIGHT.has(role)) return undefined;
  const source = width(visible(s).trim());
  const target = width(visible(t).trim());
  // Widths are estimates (Arabic letters join and run narrow), so only a clear overflow counts.
  if (source === 0 || target <= source * 2 || target - source < 6) return undefined;
  return {
    severity: "warning",
    code: "too-long",
    message: `Used as a ${role}: about ${target} characters wide against ${source} in the source, so it may not fit`,
  };
}

/** How wide text reads: combining marks take no room, Chinese, Japanese and Korean take two. */
function width(text: string): number {
  let w = 0;
  for (const c of text) {
    if (/\p{M}|​|‌|‍/u.test(c)) continue;
    w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|\p{Extended_Pictographic}/u.test(c) ? 2 : 1;
  }
  return w;
}

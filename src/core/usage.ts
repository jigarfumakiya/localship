import path from "node:path";
import { walk } from "../detect/walk.js";
import type { Target } from "../formats/types.js";
import type { Entry } from "./model.js";
import type { Project } from "./project.js";

/** Where a string is used in code: `file:line` and the code around it. */
export interface Usage {
  at: string;
  code: string;
}

export interface UsageIndex {
  find(target: Target, entry: Entry): Usage[];
}

const MAX_USAGES = 3;
const MAX_FILE_BYTES = 512 * 1024;
const ANDROID_CODE = /\.(kt|kts|java|xml)$/;
const SWIFT_CODE = /\.(swift|m|mm)$/;

/** `R.string.save`, `R.plurals.days_left`, `@string/save` (layouts, manifests, menus). */
const ANDROID_REF = /\bR\.(?:string|plurals|array)\.(\w+)|@(?:string|plurals|array)\/(\w+)/g;
/** Swift and Objective-C string literals, with escapes. */
const STRING_LITERAL = /@?"((?:[^"\\\n]|\\.)*)"/g;
/** Apple format specifiers as they appear in catalog keys (`%@`, `%lld`, `%1$@`). */
const APPLE_SPEC =
  /%%|%(?:\d+\$)?[-+ #0]*\d*(?:\.\d+)?(?:hh|h|ll|l|q|z|t|j)?[@dDuUxXoOfeEgGcCsSaAp]/g;
const SLOT = "\u0001";
const DART_CODE = /\.dart$/;
/** `AppLocalizations.of(context)!.save`, `S.of(context).save`, `S.current.save`, `context.l10n.save`. */
const DART_REF =
  /(?:AppLocalizations\.of\(\s*\w+\s*\)!?|S\.of\(\s*\w+\s*\)|S\.current|\bl10n|\bloc)\??\.([A-Za-z_]\w*)/g;
const JS_CODE = /\.(m?[jt]sx?|vue|svelte|astro)$/;
/** `t("nav.home")`, `i18n.t('x')`, `$t('x')`, `i18nKey="x"`; an i18next namespace (`common:`) is dropped. */
const JS_REF = /(?:\$?\bt\(\s*|i18nKey=\{?\s*)(["'`])(?:[\w-]+:)?([\w.-]+)\1/g;

/**
 * Finds where source strings are used, so translators see the screen (from the file path)
 * and the role (button, title, label…) from the code itself. One walk over the repo;
 * files are read only for formats the project has.
 */
export async function buildUsageIndex(project: Project): Promise<UsageIndex> {
  const formats = new Set(project.targets.map((t) => t.target.format));
  const needsCode = [...formats].some((f) => f !== "po");
  const files = needsCode ? (await walk(project.fs, project.root)).files : [];
  const lines = new Map<string, string[]>();
  const read = async (rel: string) => {
    let cached = lines.get(rel);
    if (!cached) {
      try {
        const text = await project.fs.readFile(path.join(project.root, rel));
        cached = text.length > MAX_FILE_BYTES ? [] : text.split(/\r?\n/);
      } catch {
        cached = [];
      }
      lines.set(rel, cached);
    }
    return cached;
  };

  const android = new Map<string, Usage[]>();
  if (formats.has("android-xml")) {
    for (const rel of files) {
      // Resource definitions aren't usages.
      if (!ANDROID_CODE.test(rel) || /(^|\/)res\/values[^/]*\//.test(rel)) continue;
      const text = await read(rel);
      text.forEach((line, i) => {
        for (const m of line.matchAll(ANDROID_REF)) {
          const key = (m[1] ?? m[2]) as string;
          add(android, key, rel, text, i);
        }
      });
    }
  }

  const apple = new Map<string, Usage[]>();
  if (formats.has("xcstrings")) {
    for (const rel of files) {
      if (!SWIFT_CODE.test(rel)) continue;
      const text = await read(rel);
      text.forEach((line, i) => {
        for (const m of line.matchAll(STRING_LITERAL)) {
          add(apple, normalizeSwiftLiteral(m[1] as string), rel, text, i);
        }
      });
    }
  }

  const dart = new Map<string, Usage[]>();
  const js = new Map<string, Usage[]>();
  for (const [format, code, ref, group, index] of [
    ["arb", DART_CODE, DART_REF, 1, dart],
    ["json", JS_CODE, JS_REF, 2, js],
  ] as const) {
    if (!formats.has(format)) continue;
    for (const rel of files) {
      if (!code.test(rel)) continue;
      const text = await read(rel);
      text.forEach((line, i) => {
        for (const m of line.matchAll(ref)) add(index, m[group] as string, rel, text, i);
      });
    }
  }

  // gettext files already say where each string is used (`#: app/views.py:12`).
  const po = new Map<string, Usage[]>();
  for (const { target } of project.targets) {
    if (target.format !== "po") continue;
    for (const entry of target.source.entries.values()) {
      const found: Usage[] = [];
      for (const ref of entry.references ?? []) {
        if (found.length >= MAX_USAGES) break;
        const m = /^(.+?):(\d+)$/.exec(ref);
        const rel = m?.[1] ?? ref;
        const text = m ? await read(rel) : [];
        const i = Number(m?.[2] ?? 0) - 1;
        found.push(text[i] !== undefined ? usageAt(rel, text, i) : { at: ref, code: "" });
      }
      if (found.length) po.set(`${target.id}\u0000${entry.key}`, found);
    }
  }

  return {
    find(target, entry) {
      switch (target.format) {
        case "android-xml":
          return android.get(entry.key) ?? [];
        case "xcstrings":
          return apple.get(normalizeCatalogKey(entry.key)) ?? [];
        case "po":
          return po.get(`${target.id}\u0000${entry.key}`) ?? [];
        case "arb":
          return dart.get(entry.key) ?? [];
        case "json":
          return js.get(entry.key) ?? [];
        default:
          return [];
      }
    },
  };
}

function add(index: Map<string, Usage[]>, key: string, rel: string, text: string[], i: number) {
  const list = index.get(key) ?? [];
  if (list.length >= MAX_USAGES) return;
  // One usage per file: usages in different files say more about where the text appears.
  if (list.some((u) => u.at.startsWith(`${rel}:`))) return;
  list.push(usageAt(rel, text, i));
  index.set(key, list);
}

/** The line, with the line before it when that adds context (`Button(…) {` around `Text(…)`). */
function usageAt(rel: string, text: string[], i: number): Usage {
  const line = text[i] ?? "";
  let previous: string | undefined;
  for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
    const candidate = text[j] as string;
    if (candidate.trim() === "") continue;
    if (/^\s*(\/\/|\*|\/\*|#)/.test(candidate)) break;
    previous = candidate;
    break;
  }
  const picked = previous !== undefined ? [previous, line] : [line];
  const indent = Math.min(...picked.map((l) => /^\s*/.exec(l)?.[0].length ?? 0));
  const code = picked
    .map((l) => l.slice(indent).trimEnd())
    .join("\n")
    .slice(0, 240);
  return { at: `${rel}:${i + 1}`, code };
}

/** `Hi \(name), you have \(count) alerts` → the same shape as its catalog key. */
export function normalizeSwiftLiteral(literal: string): string {
  let out = "";
  for (let i = 0; i < literal.length; i++) {
    const c = literal[i];
    if (c === "\\" && literal[i + 1] === "(") {
      let depth = 0;
      let j = i + 1;
      for (; j < literal.length; j++) {
        if (literal[j] === "(") depth++;
        else if (literal[j] === ")" && --depth === 0) break;
      }
      out += SLOT;
      i = j;
    } else if (c === "\\" && i + 1 < literal.length) {
      const n = literal[++i] as string;
      out += n === "n" ? "\n" : n === "t" ? "\t" : n;
    } else {
      out += c;
    }
  }
  return out;
}

/** `Hi %@, you have %lld alerts` → placeholders as slots, `%%` as `%`. */
export function normalizeCatalogKey(key: string): string {
  // One pass, so the `% d` after an escaped `%%` isn't read as a placeholder.
  return key.replace(APPLE_SPEC, (m) => (m === "%%" ? "%" : SLOT));
}

import path from "node:path";
import type { TargetConfig } from "../core/config.js";
import type { FileSystem } from "../core/fs.js";
import { LOCALE_TOKEN, parseLocaleSegment } from "../core/paths.js";
import { openTarget } from "../core/project.js";
import { estimateHardcoded, type HardcodedText, literalsForResDir } from "./hardcoded.js";
import { findOtherSystems, type OtherSystem } from "./others.js";
import { walk } from "./walk.js";

export type Confidence = "high" | "medium" | "low";

export interface Candidate {
  /** Ready to go into `targets:` in the config (without an id; init assigns ids). */
  target: TargetConfig;
  confidence: Confidence;
  /** Why this was picked, in plain words. */
  evidence: string[];
  /** Translatable source strings, counted by the format's own reader. */
  strings: number;
  /** Locales with translations on disk (source excluded). */
  locales: string[];
  /** Source language the files declare, when they do (String Catalog `sourceLanguage`). */
  sourceLocale?: string;
  /** Things a person should confirm before this goes in the config. */
  questions: string[];
  /** User-facing text still written in this module's code, estimated (Android). */
  codeLiterals?: number;
}

export interface UnsupportedFind {
  format: string;
  files: number;
  examples: string[];
}

export interface DetectResult {
  root: string;
  candidates: Candidate[];
  /** Localization files found in formats that aren't supported yet. */
  unsupported: UnsupportedFind[];
  sourceLocale: { value: string; confident: boolean; reason: string };
  /** Every locale with translations, across candidates. */
  locales: string[];
  /** Suggestions when a project looks localizable but has no translation files yet. */
  hints: string[];
  /** Estimated user-facing text still hardcoded in code, per platform. */
  hardcoded: HardcodedText[];
  /** Other localization tools already in use (platforms, runtime SDKs, libraries). */
  otherSystems: OtherSystem[];
  truncated: boolean;
}

const RANK: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };

export async function detect(fs: FileSystem, root: string): Promise<DetectResult> {
  const { files, truncated } = await walk(fs, root);
  const found: Candidate[] = [
    ...(await detectAndroid(fs, root, files)),
    ...(await detectPo(fs, root, files)),
    ...(await detectXcstrings(fs, root, files)),
    ...(await detectArb(fs, root, files)),
    ...(await detectJson(fs, root, files)),
  ];
  const hardcoded = await estimateHardcoded(fs, root, files);
  const otherSystems = await findOtherSystems(fs, root, files);
  flagHardcoded(found, hardcoded);
  const candidates = found.sort(
    (a, b) => RANK[a.confidence] - RANK[b.confidence] || b.strings - a.strings,
  );

  const declared = [
    ...new Set(candidates.flatMap((c) => (c.sourceLocale ? [c.sourceLocale] : []))),
  ];
  const where = [
    ...new Set(
      candidates.flatMap((c) =>
        c.sourceLocale ? [c.target.format === "arb" ? "l10n.yaml" : "the String Catalog"] : [],
      ),
    ),
  ].join(" and ");
  const sourceLocale =
    declared.length === 1
      ? { value: declared[0] as string, confident: true, reason: `declared in ${where}` }
      : declared.length > 1
        ? {
            value: declared[0] as string,
            confident: false,
            reason: `catalogs disagree: ${declared.join(", ")}`,
          }
        : { value: "en", confident: false, reason: "assumed; the files don't say" };

  const locales = [...new Set(candidates.flatMap((c) => c.locales))]
    .filter((l) => l !== sourceLocale.value)
    .sort();
  const unsupported = detectUnsupported(files);
  return {
    root,
    candidates,
    unsupported,
    sourceLocale,
    locales,
    hints: [
      ...otherSystems.map((o) => o.message),
      ...hints(files, candidates, unsupported, hardcoded),
    ],
    hardcoded,
    otherSystems,
    truncated,
  };
}

// ── Android ──────────────────────────────────────────────────────────────────

async function detectAndroid(fs: FileSystem, root: string, files: string[]): Promise<Candidate[]> {
  const resDirs = new Set<string>();
  for (const f of files) {
    const m = /^(.*\/)?res\/values\/[^/]+\.xml$/.exec(f);
    if (m) resDirs.add(`${m[1] ?? ""}res`);
  }
  const out: Candidate[] = [];
  for (const res of [...resDirs].sort()) {
    const target: TargetConfig = { format: "android-xml", path: res };
    const t = await openTarget(fs, root, target, "en", "android");
    const strings = [...t.source.entries.values()].filter((e) => e.translatable).length;
    if (strings === 0 && t.locales.size === 0) continue; // colors, dimens, themes only
    const evidence = [`${res}/values has ${strings} string${strings === 1 ? "" : "s"}`];
    const variant = /(^|\/)src\/([^/]+)\/res$/.exec(res)?.[2];
    let confidence: Confidence = "high";
    const questions: string[] = [];
    if (variant && /test/i.test(variant)) continue;
    if (variant && variant !== "main") {
      confidence = "medium";
      questions.push(`Strings for the "${variant}" build variant; include them?`);
    }
    if (strings === 0) confidence = "low";
    if (t.locales.size)
      evidence.push(
        `translations in ${t.locales.size} locale folder${t.locales.size === 1 ? "" : "s"}`,
      );
    out.push({
      target,
      confidence,
      evidence,
      strings,
      locales: [...t.locales.keys()].sort(),
      questions,
    });
  }
  return out;
}

// ── gettext ──────────────────────────────────────────────────────────────────

/** `locale/de/LC_MESSAGES/django.po` → `locale/{locale}/LC_MESSAGES/django.po`. */
export function poPattern(
  file: string,
): { pattern: string; locale: string; domain: string } | undefined {
  const parts = file.split("/");
  const name = parts.at(-1) as string;
  const stem = name.replace(/\.po$/, "");
  const whole = parseLocaleSegment(stem);
  if (whole) {
    return {
      pattern: [...parts.slice(0, -1), `${LOCALE_TOKEN}.po`].join("/"),
      locale: whole,
      domain: parts.at(-2) ?? stem,
    };
  }
  // WordPress style: `my-plugin-de_DE.po`
  const dash = stem.lastIndexOf("-");
  if (dash > 0) {
    const tail = parseLocaleSegment(stem.slice(dash + 1));
    if (tail) {
      return {
        pattern: [...parts.slice(0, -1), `${stem.slice(0, dash + 1)}${LOCALE_TOKEN}.po`].join("/"),
        locale: tail,
        domain: stem.slice(0, dash),
      };
    }
  }
  for (let i = parts.length - 2; i >= 0; i--) {
    const locale = parseLocaleSegment(parts[i] as string);
    if (locale) {
      const pattern = [...parts.slice(0, i), LOCALE_TOKEN, ...parts.slice(i + 1)].join("/");
      return { pattern, locale, domain: stem };
    }
  }
  return undefined;
}

async function detectPo(fs: FileSystem, root: string, files: string[]): Promise<Candidate[]> {
  const groups = new Map<string, { domain: string; locales: string[] }>();
  for (const f of files.filter((x) => x.endsWith(".po"))) {
    const p = poPattern(f);
    if (!p) continue;
    const g = groups.get(p.pattern) ?? { domain: p.domain, locales: [] };
    g.locales.push(p.locale);
    groups.set(p.pattern, g);
  }
  const pots = files.filter((x) => x.endsWith(".pot"));
  const out: Candidate[] = [];
  for (const [pattern, g] of groups) {
    const base = pattern.slice(0, pattern.indexOf(LOCALE_TOKEN)).replace(/\/$/, "");
    const near = (pot: string) => {
      const dir = path.posix.dirname(pot);
      return (
        base === "" ||
        dir === base ||
        dir.startsWith(`${base}/`) ||
        base.startsWith(`${dir}/`) ||
        dir === "."
      );
    };
    const named = pots.filter((pot) => path.posix.basename(pot, ".pot") === g.domain);
    const candidates = named.length ? named : pots.filter(near);
    const questions: string[] = [];
    let template: string | undefined;
    if (candidates.length === 1) template = candidates[0];
    else if (candidates.length > 1) {
      template = candidates.filter(near)[0] ?? candidates[0];
      questions.push(
        `Several templates could be the source: ${candidates.join(", ")}. Using ${template}.`,
      );
    }
    const target: TargetConfig = { format: "po", path: pattern, ...(template ? { template } : {}) };
    const t = await openTarget(fs, root, target, "en", "po");
    const strings = t.source.entries.size;
    if (strings === 0) continue;
    const evidence = [
      `${g.locales.length} .po file${g.locales.length === 1 ? "" : "s"} matching ${pattern}`,
    ];
    if (template) evidence.push(`template ${template}`);
    const confidence: Confidence = g.locales.length >= 2 || template ? "high" : "medium";
    if (confidence === "medium")
      questions.push("Only one .po file and no template; is this the app's translations?");
    out.push({
      target,
      confidence,
      evidence,
      strings,
      locales: [...t.locales.keys()].sort(),
      questions,
    });
  }

  // A template with no translations yet: how every gettext project starts.
  const used = new Set(
    out.flatMap((c) => (c.target.format === "po" && c.target.template ? [c.target.template] : [])),
  );
  for (const pot of pots) {
    if (used.has(pot)) continue;
    const pattern = newPoPattern(pot);
    const target: TargetConfig = { format: "po", path: pattern, template: pot };
    const t = await openTarget(fs, root, target, "en", "po");
    const strings = t.source.entries.size;
    if (strings === 0) continue;
    out.push({
      target,
      confidence: "medium",
      evidence: [
        `template ${pot} with ${strings} string${strings === 1 ? "" : "s"}, no translations yet`,
      ],
      strings,
      locales: [],
      questions: [
        `New translations will be written as ${pattern}. Change the path if your project expects another layout.`,
      ],
    });
  }
  return out;
}

/** Where translations for a lone template usually go, by ecosystem convention. */
export function newPoPattern(pot: string): string {
  const dir = path.posix.dirname(pot);
  const domain = path.posix.basename(pot, ".pot");
  const prefix = dir === "." ? "" : `${dir}/`;
  // Django and Babel: locale/django.pot → locale/{locale}/LC_MESSAGES/django.po
  if (/(^|\/)(locale|locales)$/.test(dir))
    return `${prefix}${LOCALE_TOKEN}/LC_MESSAGES/${domain}.po`;
  // WordPress: languages/my-plugin.pot → languages/my-plugin-{locale}.po
  if (/(^|\/)languages$/.test(dir)) return `${prefix}${domain}-${LOCALE_TOKEN}.po`;
  // GNU projects and most others: po/app.pot → po/{locale}.po
  return `${prefix}${LOCALE_TOKEN}.po`;
}

// ── Apple String Catalogs ────────────────────────────────────────────────────

async function detectXcstrings(
  fs: FileSystem,
  root: string,
  files: string[],
): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const f of files.filter((x) => x.endsWith(".xcstrings"))) {
    const target: TargetConfig = { format: "xcstrings", path: f };
    let declared: string | undefined;
    try {
      const doc = JSON.parse(await fs.readFile(path.join(root, f))) as { sourceLanguage?: unknown };
      if (typeof doc.sourceLanguage === "string") declared = doc.sourceLanguage;
    } catch {
      // Reported below by the format's own reader, with a line number.
    }
    const t = await openTarget(fs, root, target, declared ?? "en", "xcstrings");
    const error = t.issues.find((i) => i.severity === "error");
    if (error) {
      out.push({
        target,
        confidence: "low",
        evidence: [
          `${f} could not be read: ${error.message}${error.line ? ` (line ${error.line})` : ""}`,
        ],
        strings: 0,
        locales: [],
        questions: ["Fix the file, or leave it out"],
      });
      continue;
    }
    const strings = [...t.source.entries.values()].filter((e) => e.translatable).length;
    out.push({
      target,
      confidence: strings === 0 ? "medium" : "high",
      evidence: [`String Catalog with ${strings} string${strings === 1 ? "" : "s"}`],
      strings,
      locales: [...t.locales.keys()].sort(),
      ...(declared ? { sourceLocale: declared } : {}),
      questions:
        strings === 0
          ? [
              "The catalog is empty. Build the targets that use it, then fill it: Xcode's catalog editor does this with the project open; from the command line, run `xcrun xcstringstool sync <catalog> --stringsdata <each target's .stringsdata in DerivedData>`, since a command-line build alone leaves the catalog unchanged. Then run detect again.",
            ]
          : [],
    });
  }
  return out;
}

// ── Flutter ARB and JSON ─────────────────────────────────────────────────────

/** `lib/l10n/app_en.arb`, `app_pt_BR.arb` → `lib/l10n/app_{locale}.arb`, by folder. */
async function detectArb(fs: FileSystem, root: string, files: string[]): Promise<Candidate[]> {
  const byDir = new Map<string, string[]>();
  for (const f of files.filter((x) => x.endsWith(".arb"))) {
    const dir = path.posix.dirname(f);
    byDir.set(dir, [...(byDir.get(dir) ?? []), path.posix.basename(f, ".arb")]);
  }
  // Flutter's l10n.yaml names the template, whose locale is the source language.
  const l10n = files.find((f) => /(^|\/)l10n\.yaml$/.test(f));
  let template: string | undefined;
  if (l10n) {
    const text = await fs.readFile(path.join(root, l10n)).catch(() => "");
    template = /^template-arb-file:\s*["']?([^"'\s#]+)/m.exec(text)?.[1];
  }
  const out: Candidate[] = [];
  for (const [dir, stems] of byDir) {
    // The shared prefix, cut back to an underscore so `app_en` and `app_es` give `app_`.
    let prefix = stems.reduce((a, b) => {
      let i = 0;
      while (i < a.length && a[i] === b[i]) i++;
      return a.slice(0, i);
    });
    if (
      stems.length === 1 ||
      parseLocaleSegment(stems[0]?.slice(prefix.length) ?? "") === undefined
    )
      prefix = prefix.slice(0, prefix.lastIndexOf("_") + 1);
    const found = stems.flatMap((s) => {
      const locale = parseLocaleSegment(s.slice(prefix.length));
      return locale ? [locale] : [];
    });
    if (!found.length) continue;
    const pattern = `${dir === "." ? "" : `${dir}/`}${prefix}${LOCALE_TOKEN}.arb`;
    const declared = template
      ? parseLocaleSegment(path.posix.basename(template, ".arb").slice(prefix.length))
      : undefined;
    out.push(
      await jsonCandidate(fs, root, { format: "arb", path: pattern }, found, declared, [
        `Flutter ARB files (${found.length})${declared ? `; ${template} is the template` : ""}`,
      ]),
    );
  }
  return out;
}

/** `locales/en.json` or `locales/en/common.json` in a translations folder, by path pattern. */
async function detectJson(fs: FileSystem, root: string, files: string[]): Promise<Candidate[]> {
  const patterns = new Map<string, string[]>();
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const parts = f.split("/");
    if (!parts.slice(0, -1).some((p) => I18N_DIR.test(p))) continue;
    const stem = path.posix.basename(f, ".json");
    let pattern: string | undefined;
    let locale = parseLocaleSegment(stem);
    if (locale) {
      pattern = [...parts.slice(0, -1), `${LOCALE_TOKEN}.json`].join("/");
    } else {
      const at = parts.findLastIndex((p, i) => i < parts.length - 1 && parseLocaleSegment(p));
      if (at >= 0) {
        locale = parseLocaleSegment(parts[at] as string);
        pattern = parts.map((p, i) => (i === at ? LOCALE_TOKEN : p)).join("/");
      }
    }
    if (pattern && locale) patterns.set(pattern, [...(patterns.get(pattern) ?? []), locale]);
  }
  const out: Candidate[] = [];
  for (const [pattern, found] of patterns) {
    const source = found.includes("en") ? "en" : (found[0] as string);
    const sample = await fs
      .readFile(path.join(root, pattern.replace(LOCALE_TOKEN, source)))
      .catch(() => "");
    // {{name}} is i18next; {name} and {n, plural, …} are ICU (format.js, next-intl).
    const icu = !/\{\{/.test(sample) && /\{\s*[A-Za-z_]\w*\s*(,\s*(plural|select)|\})/.test(sample);
    const target: TargetConfig = {
      format: "json",
      path: pattern,
      ...(icu ? { placeholders: "icu" as const } : {}),
    };
    out.push(
      await jsonCandidate(fs, root, target, found, undefined, [
        `JSON translation files (${found.length}), ${icu ? "ICU messages" : "i18next style"}`,
      ]),
    );
  }
  return out;
}

async function jsonCandidate(
  fs: FileSystem,
  root: string,
  target: TargetConfig,
  found: string[],
  declared: string | undefined,
  evidence: string[],
): Promise<Candidate> {
  const source = declared ?? (found.includes("en") ? "en" : (found[0] as string));
  const t = await openTarget(fs, root, target, source, target.format);
  const error = t.issues.find((i) => i.severity === "error");
  const strings = [...t.source.entries.values()].filter((e) => e.translatable).length;
  return {
    target,
    confidence: error ? "low" : strings === 0 || found.length === 1 ? "medium" : "high",
    evidence: error
      ? [...evidence, `${error.file ?? target.path} could not be read: ${error.message}`]
      : [...evidence, `${strings} string${strings === 1 ? "" : "s"} in ${source}`],
    strings,
    locales: [...t.locales.keys()].sort(),
    ...(declared ? { sourceLocale: declared } : {}),
    questions: error ? ["Fix the file, or leave it out"] : [],
  };
}

// ── Hints ────────────────────────────────────────────────────────────────────

/** More text in the code than in the resources means the app isn't localizable yet. */
export function mostlyHardcoded(codeLiterals: number, resourceStrings: number): boolean {
  return codeLiterals >= 10 && codeLiterals > resourceStrings;
}

function flagHardcoded(candidates: Candidate[], hardcoded: HardcodedText[]) {
  const android = hardcoded.find((h) => h.platform === "android");
  for (const c of candidates) {
    if (c.target.format !== "android-xml") continue;
    const literals = literalsForResDir(android, c.target.path);
    if (literals === 0) continue;
    c.codeLiterals = literals;
    c.evidence.push(`about ${literals} pieces of UI text still in the code`);
    if (!mostlyHardcoded(literals, c.strings)) continue;
    if (c.confidence === "high") c.confidence = "medium";
    c.questions.unshift(
      `About ${literals} pieces of UI text are still written in the code, more than the ${c.strings} string${c.strings === 1 ? "" : "s"} in resources. Translating now would cover only part of the app: make it localizable first (the localship-extract skill).`,
    );
  }
}

function hardcodedSummary(h: HardcodedText): string {
  const example = h.examples[0];
  return `about ${h.literals} pieces of UI text in ${h.files} file${h.files === 1 ? "" : "s"}${example ? ` (e.g. "${example.text}" in ${example.at})` : ""}`;
}

function hints(
  files: string[],
  candidates: Candidate[],
  unsupported: UnsupportedFind[],
  hardcoded: HardcodedText[],
): string[] {
  const out: string[] = [];
  const androidCode = hardcoded.find((h) => h.platform === "android");
  const iosCode = hardcoded.find((h) => h.platform === "ios");
  const flagged = candidates.filter(
    (c) => c.codeLiterals !== undefined && mostlyHardcoded(c.codeLiterals, c.strings),
  );
  if (androidCode && flagged.length) {
    out.push(
      `Most of this app's text is still in the code: ${hardcodedSummary(androidCode)}. Make it localizable first (the localship-extract skill moves it into strings.xml), then set up translation.`,
    );
  }
  const has = (format: string) => candidates.some((c) => c.target.format === format);
  const appleLegacy = unsupported.some((u) => u.format.startsWith("Apple"));
  const generator = files.some((f) => /(^|\/)project\.yml$/.test(f))
    ? "XcodeGen (project.yml)"
    : files.some((f) => /(^|\/)Project\.swift$/.test(f))
      ? "Tuist (Project.swift)"
      : undefined;
  const xcode = !!generator || files.some((f) => f.endsWith(".xcodeproj/project.pbxproj"));
  if (xcode && !has("xcstrings") && !appleLegacy) {
    const add = generator
      ? `The project is generated by ${generator}: put a Localizable.xcstrings in each target's sources and set SWIFT_EMIT_LOC_STRINGS there, then regenerate; changes made in Xcode are lost when the project is regenerated`
      : "Add one in Xcode (File › New › File › String Catalog, named Localizable) to each target that shows text";
    out.push(
      `This looks like an Xcode project without a String Catalog. ${add}. Build, and fill the catalog from the build: Xcode's catalog editor does this; from the command line use \`xcrun xcstringstool sync\`. Text built from variables needs moving to String(localized:) first (the localship-extract skill helps)${iosCode ? `; UIKit code also has ${hardcodedSummary(iosCode)}` : ""}. Then run detect again.`,
    );
  }
  const gradle = files.some((f) => /(^|\/)build\.gradle(\.kts)?$/.test(f));
  if (
    gradle &&
    !has("android-xml") &&
    files.some((f) => /\/src\/main\/AndroidManifest\.xml$/.test(f))
  ) {
    out.push(
      `This looks like an Android project with no strings in res/values yet: the UI text is ${androidCode ? `in the code, ${hardcodedSummary(androidCode)}` : "probably written in the code"}. Move it into res/values/strings.xml first (the localship-extract skill does this with your agent), then run detect again.`,
    );
  }
  return out;
}

// ── Recognized but not supported yet ─────────────────────────────────────────

const I18N_DIR = /^(locales?|i18n|l10n|lang|langs|languages|translations|messages|intl)$/i;

function detectUnsupported(files: string[]): UnsupportedFind[] {
  const kinds = new Map<string, string[]>();
  const add = (kind: string, f: string) => kinds.set(kind, [...(kinds.get(kind) ?? []), f]);
  for (const f of files) {
    const parts = f.split("/");
    const name = parts.at(-1) as string;
    const ext = path.posix.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    const inI18nDir = parts.slice(0, -1).some((p) => I18N_DIR.test(p));
    const localeNamed =
      parseLocaleSegment(stem) !== undefined ||
      parts.slice(0, -1).some((p) => parseLocaleSegment(p) !== undefined);
    if (ext === ".strings" && parts.some((p) => p.endsWith(".lproj"))) add("Apple .strings", f);
    else if (ext === ".stringsdict") add("Apple .stringsdict", f);
    else if ((ext === ".yml" || ext === ".yaml") && inI18nDir && localeNamed)
      add("YAML (Rails)", f);
    else if (ext === ".resx") add(".NET .resx", f);
    else if (ext === ".properties" && /_[a-z]{2}(_[A-Z]{2})?$/.test(stem))
      add("Java .properties", f);
    else if (ext === ".xlf" || ext === ".xliff") add("XLIFF", f);
  }
  return [...kinds].map(([format, list]) => ({
    format,
    files: list.length,
    examples: list.slice(0, 3),
  }));
}

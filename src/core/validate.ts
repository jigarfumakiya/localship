import type { Target } from "../formats/types.js";
import { checkGlossary, type GlossaryTerm, onlyKeptTerms } from "./context.js";
import { hashMessage } from "./hash.js";
import { getLockEntry } from "./lock.js";
import {
  type Entry,
  type Issue,
  messageValues,
  type PluralSpec,
  type ValueAnalysis,
} from "./model.js";
import { type Project, projectGlossary, projectLocales } from "./project.js";
import { inconsistencies, lengthCheck, roleOf, textChecks, type UiRole } from "./qa.js";
import { entryState } from "./status.js";
import type { UsageIndex } from "./usage.js";

export interface ValidateOptions {
  locales?: string[];
  /** Treat missing translations, unverifiable defaults and skipped content as errors. */
  strict?: boolean;
  /** Require current, approved translations for every selected locale. Implies strict. */
  requireApproved?: boolean;
  /** Where strings are used in code, so a string's role (button, tab…) can be checked. */
  usages?: UsageIndex;
}

/** Deterministic checks for every target, its source strings and each locale. */
export function validateProject(project: Project, opts: ValidateOptions = {}): Issue[] {
  const locales = opts.locales ?? projectLocales(project);
  const strict = opts.strict || opts.requireApproved;
  const issues: Issue[] = [];
  if (opts.requireApproved && locales.length === 0) {
    issues.push({
      severity: "error",
      code: "locales-empty",
      message: "No target locales to check; configure locales or select them with --locale",
    });
  }
  for (const { target: loaded } of project.targets) {
    issues.push(
      ...loaded.issues.map((issue) =>
        strict && issue.blocksCompleteness ? { ...issue, severity: "error" as const } : issue,
      ),
    );
    const at = (e: Entry, locale: string) => ({
      target: loaded.id,
      locale,
      key: e.key,
      file: e.file,
      line: e.line,
    });

    for (const src of loaded.source.entries.values()) {
      if (!src.translatable) continue;
      issues.push(
        ...checkSource(loaded, src).map((i) => ({ ...at(src, loaded.source.locale), ...i })),
      );
    }

    for (const locale of locales) {
      const catalog = loaded.locales.get(locale);
      if (!catalog) {
        issues.push({
          severity: strict ? "error" : "info",
          code: "locale-missing",
          message: `No ${locale} translations yet`,
          target: loaded.id,
          locale,
        });
        continue;
      }
      const spec = loaded.pluralSpec(locale);
      const hasPlurals = [...catalog.entries.values()].some((e) => e.message.kind === "plural");
      if (!spec && hasPlurals) {
        issues.push({
          severity: "warning",
          code: "plural-forms-unknown",
          message: `Plural rules for ${locale} are unknown, so plural forms were not checked`,
          target: loaded.id,
          locale,
        });
      }
      let missing = 0;
      for (const src of loaded.source.entries.values()) {
        if (src.translatable && !catalog.entries.has(src.key)) {
          missing++;
          if (strict) {
            issues.push({
              ...at(src, locale),
              severity: "error",
              code: "missing",
              message: "Not translated",
            });
          }
        }
      }
      if (missing > 0 && !strict) {
        issues.push({
          severity: "info",
          code: "missing",
          message: `${missing} string${missing === 1 ? "" : "s"} not translated yet`,
          target: loaded.id,
          locale,
        });
      }
      for (const tgt of catalog.entries.values()) {
        const src = loaded.source.entries.get(tgt.key);
        const where = at(tgt, locale);
        if (!src) {
          issues.push({
            ...where,
            severity: strict && loaded.format === "android-xml" ? "error" : "warning",
            code: "orphan",
            message:
              loaded.format === "android-xml"
                ? "No matching default resource in this target's values folder; restore the default, or remove this translation only if the key is no longer used. Check merged resources with Android lint."
                : "Not in the source strings any more",
          });
          continue;
        }
        // A copy of an untranslatable value (often an alias) is harmless.
        if (!src.translatable && hashMessage(src.message) !== hashMessage(tgt.message)) {
          issues.push({
            ...where,
            severity: "warning",
            code: "not-translatable",
            message: 'Source is marked translatable="false"; remove this translation',
          });
          continue;
        }
        if (!src.translatable) continue;
        if (opts.requireApproved) {
          const state = entryState(
            src,
            tgt,
            getLockEntry(project.lock, loaded.id, locale, src.key),
          );
          if (state !== "approved") {
            const reason =
              state === "stale"
                ? "Source changed since this translation was recorded"
                : state === "edited"
                  ? "Translation was edited since it was recorded"
                  : `Translation is ${state}`;
            issues.push({
              ...where,
              severity: "error",
              code: "not-approved",
              message: `${reason}; review it against the current source and approve it`,
            });
          }
        }
        issues.push(
          ...checkTranslation(
            loaded,
            tgt.message.kind === "plural"
              ? loaded.pluralSpec(locale, { forms: Object.keys(tgt.message.forms), source: src })
              : spec,
            src,
            tgt,
            {
              locale,
              sourceLocale: project.config.sourceLocale,
              glossary: projectGlossary(project),
              role: opts.usages ? roleOf(opts.usages.find(loaded, src)) : undefined,
            },
          ).map((i) => ({ ...where, ...i })),
        );
      }
    }
  }
  issues.push(...inconsistencies(project, locales));
  return issues;
}

export type Found = Pick<Issue, "severity" | "code" | "message"> & { form?: string };

function checkSource(target: Target, src: Entry): Found[] {
  const out: Found[] = [];
  const each = (value: string, form?: string) => {
    const a = target.analyze(value, src);
    for (const l of a.lints) out.push({ ...l, ...(form ? { form } : {}) });
    const loose = a.placeholders.filter((p) => !p.positional);
    if (loose.length > 1 && !target.translationsMayReorder) {
      const printf = loose.every((p) => p.raw.startsWith("%") && p.type);
      out.push({
        severity: "warning",
        code: "placeholder-not-positional",
        message: printf
          ? `Use numbered placeholders (${loose.map((p, i) => `%${i + 1}$${p.type}`).join(", ")}) so translators can reorder them`
          : `${loose.map((p) => p.raw).join(", ")} can't be reordered; name or number them so translators can`,
        ...(form ? { form } : {}),
      });
    }
  };
  const m = src.message;
  if (m.kind === "text") each(m.value);
  else if (m.kind === "array") {
    for (const [i, v] of m.items.entries()) each(v, String(i));
  } else {
    if (m.forms.other === undefined && Object.keys(m.forms).some((k) => !/^\d+$/.test(k))) {
      out.push({
        severity: "error",
        code: "plural-missing-category",
        message: 'Plural has no "other" form',
      });
    }
    for (const [c, v] of Object.entries(m.forms)) each(v, c);
  }
  return out;
}

/** Checks one translation against its source: placeholders, plurals, markup, glossary. */
export function checkTranslation(
  target: Target,
  spec: PluralSpec | undefined,
  src: Entry,
  tgt: Entry,
  opts: { locale: string; sourceLocale: string; glossary?: GlossaryTerm[]; role?: UiRole },
): Found[] {
  const { locale, sourceLocale } = opts;
  const t = tgt.message;
  // A String Catalog may vary a translation by plural even when the source doesn't.
  const s =
    src.message.kind === "text" && t.kind === "plural"
      ? { kind: "plural" as const, forms: { other: src.message.value } }
      : src.message;
  if (s.kind !== t.kind) {
    return [
      {
        severity: "error",
        code: "kind-mismatch",
        message: `Source is a ${s.kind}, translation is a ${t.kind}`,
      },
    ];
  }
  const sameLanguage = locale.split("-")[0] === sourceLocale.split("-")[0];
  // Both sides are read with the source entry's metadata (format flags, `formatted`).
  const compare = (
    sv: string,
    tv: string,
    form?: string,
    countImplied = false,
    allowed?: Set<string>,
  ) =>
    compareValues(target.analyze(sv, src), target.analyze(tv, src), {
      countImplied,
      sameLanguage,
      allowed,
      strictNewlines: target.strictNewlines,
      glossary: opts.glossary,
      locale,
      role: opts.role,
    }).map((f) => (form ? { ...f, form } : f));

  if (s.kind === "text" && t.kind === "text") return compare(s.value, t.value);

  if (s.kind === "array" && t.kind === "array") {
    const out: Found[] = [];
    if (s.items.length !== t.items.length) {
      out.push({
        severity: "error",
        code: "array-length",
        message: `Source has ${s.items.length} items, translation has ${t.items.length}`,
      });
    }
    t.items.forEach((tv, i) => {
      const sv = s.items[i];
      if (sv !== undefined) out.push(...compare(sv, tv, String(i)));
    });
    return out;
  }

  if (s.kind === "plural" && t.kind === "plural") {
    const out: Found[] = [];
    const sourceValues = messageValues(s);
    const singular = sourceValues[0]?.[1];
    const pluralValue = sourceValues.at(-1)?.[1];
    const label = (id: string) => {
      const f = spec?.forms.find((x) => x.id === id);
      if (!f) return id;
      return spec?.scheme === "gettext"
        ? `form ${id} (n = ${f.examples})`
        : `${id} (n = ${f.examples})`;
    };
    if (spec) {
      const known = spec.forms.map((f) => f.id);
      const required = spec.forms.filter((f) => !f.optional);
      const missing = required.filter((f) => t.forms[f.id] === undefined);
      // gettext needs every form (msgfmt rejects the file). CLDR formats fall back to
      // `other` at runtime, so only a missing `other` breaks; the rest read awkwardly.
      const breaking = missing.filter((f) => spec.scheme === "gettext" || f.id === "other");
      const fallback = missing.filter((f) => !breaking.includes(f) && !f.decimalOnly);
      const fractional = missing.filter((f) => !breaking.includes(f) && f.decimalOnly);
      const needs = `${locale} needs ${required.length} plural forms (${spec.source})`;
      if (breaking.length) {
        out.push({
          severity: "error",
          code: "plural-missing-category",
          message: `${needs}; missing ${breaking.map((f) => label(f.id)).join(", ")}`,
        });
      }
      if (fallback.length) {
        out.push({
          severity: "warning",
          code: "plural-missing-category",
          message: `${needs}; missing ${fallback.map((f) => label(f.id)).join(", ")}, which will show the "other" form`,
        });
      }
      if (fractional.length) {
        out.push({
          severity: "warning",
          code: "plural-missing-category",
          message: `Missing ${fractional.map((f) => label(f.id)).join(", ")}, used only for fractional counts`,
        });
      }
      for (const id of Object.keys(t.forms)) {
        if (known.includes(id)) continue;
        out.push({
          // msgfmt rejects extra gettext forms; Android and iOS just never use an extra category.
          severity: spec.scheme === "gettext" ? "error" : "warning",
          code: "plural-extra-category",
          message:
            spec.scheme === "gettext"
              ? `${locale} has ${required.length} plural forms; form ${id} is one too many`
              : `${locale} never uses the "${id}" form`,
          form: id,
        });
      }
    }
    // Any placeholder some source form uses may appear in any translated form: English
    // "one match" drops the count, but Russian `one` also covers 21, 31… and needs it.
    const allowed = new Set(
      Object.values(s.forms).flatMap((v) => target.analyze(v, src).placeholders.map((p) => p.id)),
    );
    // Numbers the source's last form shows ("%d notes"): a form covering several counts needs them.
    const counts =
      pluralValue === undefined
        ? []
        : target
            .analyze(pluralValue, src)
            .placeholders.filter((p) => /^l{0,2}[diu]$/.test(p.type ?? ""));
    for (const [id, tv] of Object.entries(t.forms)) {
      const form = spec?.forms.find((f) => f.id === id);
      const countImplied = form?.countImplied ?? false;
      const sv = s.forms[id] ?? (countImplied ? singular : pluralValue);
      if (sv !== undefined) out.push(...compare(sv, tv, id, countImplied, allowed));
      // English "one" may drop the number because it only means 1, but Hindi or French "one"
      // also covers 0, so a copied "one day" would show for zero days too.
      if (!form || countImplied || form.decimalOnly || sv === undefined) continue;
      const inSource = new Set(target.analyze(sv, src).placeholders.map((p) => p.id));
      const inTarget = new Set(target.analyze(tv, src).placeholders.map((p) => p.id));
      for (const p of counts) {
        if (inSource.has(p.id) || inTarget.has(p.id)) continue;
        out.push({
          severity: "error",
          code: "plural-count-missing",
          message: `${locale} uses this form for ${form.examples}, so it needs ${p.raw} to show which`,
          form: id,
        });
      }
    }
    return out;
  }
  return [];
}

export function compareValues(
  s: ValueAnalysis,
  t: ValueAnalysis,
  opts: {
    countImplied?: boolean;
    sameLanguage?: boolean;
    allowed?: Set<string>;
    strictNewlines?: boolean;
    glossary?: GlossaryTerm[];
    locale?: string;
    role?: UiRole;
  } = {},
): Found[] {
  const out: Found[] = [...t.lints];

  const sp = new Map(s.placeholders.map((p) => [p.id, p]));
  const tp = new Map(t.placeholders.map((p) => [p.id, p]));
  for (const [i, p] of sp) {
    const other = tp.get(i);
    if (!other) {
      const missing = `Missing ${p.raw}${p.positional || !/^\d+$/.test(i) ? "" : ` (argument ${i})`}`;
      // A form only ever used for one number may spell it out ("one note", "ملاحظتان").
      const spelledOut = opts.countImplied && /^l{0,2}[diu]$/.test(p.type ?? "");
      out.push(
        spelledOut
          ? {
              severity: "info",
              code: "placeholder-implied",
              message: `${missing}: fine if the number is written out, as this form is used for one number only`,
            }
          : {
              severity: opts.countImplied ? "warning" : "error",
              code: "placeholder-missing",
              message: missing,
            },
      );
    } else if (other.type !== p.type) {
      out.push({
        severity: "error",
        code: "placeholder-type",
        message: `${other.raw} should be ${p.raw}`,
      });
    }
  }
  for (const [i, p] of tp) {
    if (!sp.has(i) && !opts.allowed?.has(i))
      out.push({
        severity: "error",
        code: "placeholder-extra",
        message: `${p.raw} is not in the source`,
      });
  }

  const sx = s.tags
    .filter((x) => x.startsWith("xliff:g"))
    .sort()
    .join(",");
  const tx = t.tags
    .filter((x) => x.startsWith("xliff:g"))
    .sort()
    .join(",");
  if (sx !== tx)
    out.push({
      severity: "error",
      code: "xliff-mismatch",
      message: "<xliff:g> tags differ from the source",
    });
  const sm = s.tags
    .filter((x) => !x.startsWith("xliff:g"))
    .sort()
    .join(",");
  const tm = t.tags
    .filter((x) => !x.startsWith("xliff:g"))
    .sort()
    .join(",");
  if (sm !== tm) {
    out.push({
      severity: "warning",
      code: "markup-mismatch",
      message: `Markup differs: source has [${sm || "none"}], translation has [${tm || "none"}]`,
    });
  }

  if (t.text.trim() === "" && s.text.trim() !== "") {
    out.push({ severity: "error", code: "empty", message: "Translation is empty" });
  } else if (
    !opts.sameLanguage &&
    t.text === s.text &&
    !onlyKeptTerms(opts.glossary ?? [], s.text) &&
    // Single words ("Minute", "Dialog", "OK") are often the same across languages.
    /\p{L}+\s+\p{L}+/u.test(s.text)
  ) {
    out.push({ severity: "warning", code: "untranslated", message: "Same as the source text" });
  }
  if (opts.glossary?.length && opts.locale && t.text.trim() !== "") {
    out.push(...checkGlossary(opts.glossary, opts.locale, s.text, t.text));
  }
  if (t.text.trim() !== "") {
    out.push(...textChecks(s, t, { countImplied: opts.countImplied, locale: opts.locale }));
    const long = lengthCheck(opts.role, s, t);
    if (long) out.push(long);
  }
  const edge = (x: string) => [/^\s*/.exec(x)?.[0] ?? "", /\s*$/.exec(x)?.[0] ?? ""];
  const [sl, st] = edge(s.text);
  const [tl, tt] = edge(t.text);
  const newlineMismatch =
    opts.strictNewlines &&
    t.text !== "" &&
    (s.text.startsWith("\n") !== t.text.startsWith("\n") ||
      s.text.endsWith("\n") !== t.text.endsWith("\n"));
  if (newlineMismatch) {
    out.push({
      severity: "error",
      code: "newline-mismatch",
      message: `The source ${describeNewlines(s.text)}; the translation must too (msgfmt rejects it otherwise)`,
    });
  } else if (s.text.trim() !== "" && (sl !== tl || st !== tt)) {
    out.push({
      severity: "warning",
      code: "whitespace",
      message: "Leading or trailing whitespace differs from the source",
    });
  }
  return out;
}

function describeNewlines(text: string): string {
  const start = text.startsWith("\n");
  const end = text.endsWith("\n");
  if (start && end) return "starts and ends with a newline";
  if (start) return "starts with a newline and doesn't end with one";
  if (end) return "ends with a newline and doesn't start with one";
  return "has no newline at either end";
}

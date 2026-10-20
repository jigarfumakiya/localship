import path from "node:path";
import { Document } from "yaml";
import { CONFIG_FILE, type TargetConfig } from "../core/config.js";
import type { Candidate, DetectResult } from "./detect.js";

export interface InitChoices {
  /** 1-based indexes into `result.candidates`. */
  accept: number[];
  sourceLocale: string;
  locales: string[];
}

export class InitError extends Error {}

/** Candidates `--yes` takes: everything but low confidence, unless that's all there is. */
export function defaultSelection(result: DetectResult): number[] {
  const sure = result.candidates.flatMap((c, i) => (c.confidence === "low" ? [] : [i + 1]));
  return sure.length ? sure : result.candidates.map((_, i) => i + 1);
}

export function canonicalLocales(list: string[]): string[] {
  try {
    return Intl.getCanonicalLocales(list.map((l) => l.trim()).filter(Boolean));
  } catch {
    throw new InitError(`Not a valid language code in: ${list.join(", ")}`);
  }
}

/** The config `init` writes: chosen targets, with ids only where two share a format. */
export function buildConfig(
  result: DetectResult,
  choices: InitChoices,
): {
  sourceLocale: string;
  locales: string[];
  targets: TargetConfig[];
} {
  if (choices.accept.length === 0) throw new InitError("Pick at least one setup");
  const picked: Candidate[] = choices.accept.map((n) => {
    const c = result.candidates[n - 1];
    if (!c)
      throw new InitError(`There is no setup ${n}; choose from 1 to ${result.candidates.length}`);
    return c;
  });
  const [sourceLocale] = canonicalLocales([choices.sourceLocale]);
  const locales = canonicalLocales(choices.locales).filter((l) => l !== sourceLocale);
  const counts = new Map<string, number>();
  for (const c of picked) counts.set(c.target.format, (counts.get(c.target.format) ?? 0) + 1);
  const used = new Set<string>();
  const targets = picked.map((c) => {
    if ((counts.get(c.target.format) ?? 0) < 2) return c.target;
    let id = suggestId(c.target);
    for (let n = 2; used.has(id); n++) id = `${suggestId(c.target)}-${n}`;
    used.add(id);
    return { id, ...c.target } as TargetConfig;
  });
  return { sourceLocale: sourceLocale as string, locales, targets };
}

function suggestId(t: TargetConfig): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "main";
  switch (t.format) {
    case "android-xml": {
      const module = t.path.replace(/\/?src\/[^/]+\/res$/, "").replace(/\/?res$/, "");
      return `android-${slug(module || "app")}`;
    }
    case "po": {
      const file = path.posix.basename(t.path, ".po").replace("{locale}", "");
      const domain =
        file.replace(/[-_.]$/, "") || path.posix.basename(t.template ?? "", ".pot") || "messages";
      return `po-${slug(domain)}`;
    }
    case "xcstrings":
      return `xcstrings-${slug(path.posix.basename(t.path, ".xcstrings"))}`;
    case "arb":
    case "json": {
      // lib/l10n/app_{locale}.arb → arb-app; locales/{locale}/common.json → json-common.
      const name = path.posix
        .basename(t.path)
        .replace(/\.(arb|json)$/, "")
        .replace("{locale}", "")
        .replace(/^[-_.]+|[-_.]+$/g, "");
      return `${t.format}-${slug(name || "messages")}`;
    }
  }
}

export function renderConfig(config: ReturnType<typeof buildConfig>): string {
  const doc = new Document(config);
  doc.commentBefore = ` localship configuration, written by \`localship init\`.\n Docs: https://github.com/jigarfumakiya/localship/blob/main/docs/reference.md#configuration`;
  return doc.toString({ lineWidth: 0 });
}

export { CONFIG_FILE };

import { displayKey, type Issue } from "../core/model.js";
import type { Plan } from "../core/plan.js";
import type { Project } from "../core/project.js";
import { ENTRY_STATES, type LocaleStatus, type StatusNote } from "../core/status.js";
import type { ApproveResult, SubmitResult } from "../core/workflow.js";
import type { DetectResult } from "../detect/detect.js";

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const red = paint(31);
const yellow = paint(33);
const green = paint(32);
const dim = paint(2);
const bold = paint(1);

function table(rows: string[][]): string {
  const widths = rows[0]?.map((_, c) => Math.max(...rows.map((r) => (r[c] ?? "").length))) ?? [];
  return rows
    .map((r) =>
      r
        .map((cell, c) => (c === 0 ? cell.padEnd(widths[c] ?? 0) : cell.padStart(widths[c] ?? 0)))
        .join("  "),
    )
    .join("\n");
}

export function printStatus(project: Project, status: LocaleStatus[]): void {
  for (const t of project.targets) {
    const rows = status.filter((s) => s.target === t.target.id);
    const total =
      rows[0]?.total ?? [...t.target.source.entries.values()].filter((e) => e.translatable).length;
    console.log(bold(`${t.target.id}`) + dim(` · ${t.target.label} · ${total} source strings`));
    if (rows.length === 0) {
      console.log(dim("  No target locales. Add `locales:` to the config.\n"));
      continue;
    }
    const header = ["locale", "done", ...ENTRY_STATES];
    const body = rows.map((s) => {
      const done =
        s.counts.draft +
        s.counts.reviewed +
        s.counts.approved +
        s.counts.untracked +
        s.counts.edited;
      const pct = s.total === 0 ? 100 : Math.floor((done / s.total) * 100);
      return [s.locale, `${pct}%`, ...ENTRY_STATES.map((k) => String(s.counts[k]))];
    });
    console.log(
      table([header, ...body])
        .split("\n")
        .map((l, i) => `  ${i === 0 ? dim(l) : l}`)
        .join("\n"),
    );
    console.log();
  }
}

export function printStatusNotes(notes: StatusNote[]): void {
  for (const n of notes) {
    const mark = n.severity === "error" ? red("✖") : yellow("▲");
    console.log(`${mark} ${[n.target, n.locale].filter(Boolean).join(" ")}: ${n.message}`);
  }
}

const INFO_NOTES: Record<string, string> = {
  "placeholder-implied": "plural forms spell out their only number instead of a placeholder",
};

export function printIssues(issues: Issue[]): void {
  const shown = issues.filter((i) => i.severity !== "info");
  const infos = issues.filter((i) => i.severity === "info");
  for (const i of shown) {
    const mark = i.severity === "error" ? red("✖") : yellow("▲");
    const key = i.key === undefined ? undefined : truncate(displayKey(i.key), 48);
    const where = [i.locale, key && (i.form ? `${key}[${i.form}]` : key)].filter(Boolean).join(" ");
    const loc = i.file ? dim(` ${i.file}${i.line ? `:${i.line}` : ""}`) : "";
    console.log(`${mark} ${bold(where)} ${dim(i.code)} ${i.message}${loc}`);
  }
  // Locale-level notes print as they are; notes about single strings are counted.
  for (const i of infos.filter((x) => x.key === undefined))
    console.log(`${dim("·")} ${i.locale ? `${i.locale} ` : ""}${dim(i.message)}`);
  const perString = new Map<string, number>();
  for (const i of infos)
    if (i.key !== undefined) perString.set(i.code, (perString.get(i.code) ?? 0) + 1);
  for (const [code, n] of perString) {
    const note = INFO_NOTES[code] ?? code;
    console.log(dim(`· ${n} ${note} (--json lists them)`));
  }
  const errors = shown.filter((i) => i.severity === "error").length;
  const warnings = shown.length - errors;
  const summary = `${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}`;
  console.log(errors > 0 ? red(summary) : warnings > 0 ? yellow(summary) : green(`✔ ${summary}`));
}

function truncate(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ");
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

const FORMAT_LABEL: Record<string, string> = {
  "android-xml": "Android resources",
  po: "gettext PO",
  xcstrings: "String Catalog",
  arb: "Flutter ARB",
  json: "JSON",
};

/** Human summary of `detect`, as lines. */
export function describeDetect(result: DetectResult): string[] {
  const n = result.candidates.length;
  const lines = [
    bold(`Found ${n} localization setup${n === 1 ? "" : "s"}`) + dim(` in ${result.root}`),
    "",
  ];
  const rows = result.candidates.map((c, i) => [
    `${i + 1}.`,
    FORMAT_LABEL[c.target.format] ?? c.target.format,
    c.target.path,
    `${c.strings} string${c.strings === 1 ? "" : "s"}`,
    c.locales.length ? c.locales.join(", ") : "no translations",
    c.confidence,
  ]);
  const widths = [0, 1, 2, 3, 4].map((col) => Math.max(...rows.map((r) => (r[col] ?? "").length)));
  result.candidates.forEach((c, i) => {
    const r = rows[i] as string[];
    const conf =
      c.confidence === "high"
        ? green(c.confidence)
        : c.confidence === "medium"
          ? yellow(c.confidence)
          : red(c.confidence);
    lines.push(
      `  ${r
        .slice(0, 5)
        .map((cell, col) => cell.padEnd(widths[col] ?? 0))
        .join("  ")}  ${conf}`,
    );
    const indent = " ".repeat((widths[0] ?? 2) + 4);
    lines.push(dim(`${indent}${c.evidence.join(" · ")}`));
    if (c.target.format === "po" && c.target.template === undefined)
      lines.push(dim(`${indent}no .pot template; msgids are the source`));
    for (const q of c.questions) lines.push(`${indent}${yellow("?")} ${q}`);
  });
  for (const h of result.hints) lines.push("", yellow(h));
  const s = result.sourceLocale;
  lines.push("", `Source language: ${bold(s.value)}${dim(` (${s.reason})`)}`);
  if (result.unsupported.length) {
    lines.push("", dim("Also found, not supported yet:"));
    for (const u of result.unsupported) {
      lines.push(
        dim(
          `  · ${u.format}: ${u.files} file${u.files === 1 ? "" : "s"} (${u.examples.join(", ")}${u.files > u.examples.length ? ", …" : ""})`,
        ),
      );
    }
  }
  if (result.truncated)
    lines.push(
      "",
      yellow("Stopped after 50,000 files; run in a narrower folder with --cwd to see everything."),
    );
  return lines;
}

/** What `detect` and `init` say when nothing supported is found. */
export function describeNone(result: DetectResult): string[] {
  const lines = [
    `No supported translation files found in ${result.root}.`,
    dim("Supported: Android res/values*/strings.xml, gettext .po/.pot, Apple .xcstrings."),
  ];
  for (const h of result.hints) lines.push("", h);
  if (result.unsupported.length) {
    lines.push("", "Found, but not supported yet:");
    for (const u of result.unsupported) {
      lines.push(
        `  · ${u.format}: ${u.files} file${u.files === 1 ? "" : "s"} (${u.examples.join(", ")})`,
      );
    }
  }
  lines.push(
    "",
    dim(
      "You can also write .localship/config.yaml by hand: https://github.com/jigarfumakiya/localship/blob/main/docs/reference.md#configuration",
    ),
  );
  return lines;
}

export function printSubmit(r: SubmitResult): void {
  const verb = r.dryRun ? "would be written" : "written as drafts";
  console.log(
    `${green(String(r.accepted.length))} ${verb}, ${r.rejected.length ? red(String(r.rejected.length)) : "0"} rejected`,
  );
  for (const a of r.accepted) {
    for (const w of a.warnings) {
      console.log(
        `  ${yellow("▲")} ${a.locale} ${a.key}${w.form ? ` [${w.form}]` : ""}: ${w.message}`,
      );
    }
  }
  for (const x of r.rejected) {
    for (const e of x.errors) {
      console.log(
        `  ${red("✖")} ${x.locale} ${x.key}${e.form ? ` [${e.form}]` : ""}: ${e.message}`,
      );
    }
  }
  for (const f of r.files) console.log(dim(`  ${f}`));
}

export function printApprove(r: ApproveResult, to: string): void {
  if (r.changed.length === 0) {
    console.log("Nothing to change.");
    return;
  }
  const counts = new Map<string, number>();
  for (const c of r.changed) counts.set(c.locale, (counts.get(c.locale) ?? 0) + 1);
  const each = [...counts].map(([l, n]) => `${l} ${n}`).join(", ");
  console.log(`${r.dryRun ? "Would mark" : "Marked"} ${r.changed.length} ${to} (${each})`);
  for (const f of r.files) console.log(dim(`  ${f}`));
}

export function printPlan(p: Plan): void {
  const where =
    p.targets.map((t) => `${t.path} (${t.strings} strings)`).join(", ") ||
    "no translation files yet";
  console.log(
    bold(p.configured ? "Localship is set up" : "Localship isn't set up yet") + dim(` · ${where}`),
  );
  if (p.locales.length) {
    const per = Math.max(0, ...Object.values(p.work));
    const total = Object.values(p.work).reduce((a, b) => a + b, 0);
    const count = p.locales.length > 1 ? `${per} strings, ${total} translations` : `${per} strings`;
    console.log(
      `Languages: ${p.locales.map((l) => `${l.name} (${l.code}${l.isNew ? ", new" : ""})`).join(", ")} · ${count}`,
    );
  }
  for (const w of p.warnings) console.log(`${yellow("▲")} ${w}`);
  for (const b of p.blockers) console.log(`${yellow("▲")} ${b.message} ${dim(b.fix)}`);
  for (const n of p.notes) console.log(`${dim("·")} ${n}`);
  if (p.locales.length) {
    console.log();
    console.log(bold("Translators go by"));
    for (const [l, v] of Object.entries(p.voice)) {
      console.log(`  ${l}: ${v.text}${v.fromProject ? "" : dim(" (usual convention)")}`);
    }
    if (p.keepAsWritten.length) console.log(`  Kept as written: ${p.keepAsWritten.join(", ")}`);
    if (!p.brief)
      console.log(
        dim("  No brief yet (.localship/brief.md); translators go by comments and the code."),
      );
  }
  console.log();
  const codes = p.locales.map((l) => l.code).join(",");
  console.log(
    p.ready
      ? green(
          p.configured
            ? `Ready. An agent translates with next-batch and submit. Without one, \`localship translate --model …\` uses a model API (billed per use).`
            : `Ready. An agent sets up with \`localship start ${codes}\`, then translates with next-batch and submit. Without one, \`localship start ${codes} --model …\` translates through a model API (billed per use).`,
        )
      : yellow("Sort out the item above first."),
  );
}

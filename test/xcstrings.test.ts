import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type FileSystem, memoryFs, nodeFs } from "../src/core/fs.js";
import { findPlaceholders } from "../src/core/placeholders.js";
import { openProject } from "../src/core/project.js";
import { computeStatus } from "../src/core/status.js";
import { validateProject } from "../src/core/validate.js";
import {
  detectStyle,
  type JNode,
  parseJson,
  stringifyJson,
  XCODE_STYLE,
} from "../src/formats/json-tree.js";
import { fixture } from "./helpers.js";

const ROOT = fixture("xcstrings/app");
const FILE = path.join(ROOT, "App/Localizable.xcstrings");
const original = readFileSync(FILE, "utf8");

function sandbox(): FileSystem & { files: Map<string, string> } {
  const mem = memoryFs();
  return {
    ...nodeFs,
    files: mem.files,
    readFile: async (f) => mem.files.get(f) ?? nodeFs.readFile(f),
    writeFile: async (f, c) => {
      mem.files.set(f, c);
    },
  };
}

function stripRaw(n: JNode): void {
  n.raw = undefined;
  if (n.kind === "object") for (const e of n.entries) stripRaw(e.value);
  if (n.kind === "array") for (const i of n.items) stripRaw(i);
}

describe("String Catalog JSON", () => {
  it("round-trips byte for byte", () => {
    expect(stringifyJson(parseJson(original), detectStyle(original))).toBe(original);
  });

  it("re-renders every node exactly as Xcode writes it", () => {
    const node = parseJson(original);
    stripRaw(node);
    expect(detectStyle(original)).toEqual(XCODE_STYLE);
    expect(stringifyJson(node, XCODE_STYLE)).toBe(original);
  });

  it("reports the line of a syntax error", () => {
    expect(() => parseJson('{\n  "a" : 1,\n  "b" 2\n}')).toThrow(/line 3/);
  });
});

describe("apple placeholders", () => {
  it("treats %lld and %d as the same argument kind and reads substitutions", () => {
    expect(
      findPlaceholders("%@ has %lld, %1$@ %2$d %.1f%% %#@items@", "apple").map(
        (p) => `${p.id}:${p.type ?? ""}`,
      ),
    ).toEqual(["@items:", "1:@", "2:d", "1:@", "2:d", "3:f"]);
  });
});

describe("xcstrings adapter", async () => {
  const project = await openProject(nodeFs, { cwd: ROOT });
  const target = project.targets[0]?.target;
  if (!target) throw new Error("no target");

  it("reads keys, comments and source values", () => {
    const keys = [...target.source.entries.values()].map((e) => [e.key, e.translatable]);
    expect(keys).toEqual([
      ["", false],
      ["%lld days left", true],
      ["Hi %@, you have %lld new alerts", true],
      ["Old string", false],
      ["Photos", false],
      ["Safe to spend today", true],
      ["Sample", false],
      ["Unlock Pro", true],
    ]);
    expect(target.source.entries.get("%lld days left")?.message).toEqual({
      kind: "plural",
      forms: { one: "%lld day left", other: "%lld days left" },
    });
    expect(target.source.entries.get("Safe to spend today")?.message).toEqual({
      kind: "text",
      value: "Safe to spend today",
    });
    expect(target.source.entries.get("Unlock Pro")?.comment).toBe("Paywall button. Keep it short.");
    expect(target.source.entries.get("Hi %@, you have %lld new alerts")?.line).toBe(90);
    expect(target.locales.get("hi")?.entries.has("Old string")).toBe(false);
  });

  it("finds exactly the planted problems", () => {
    const found = validateProject(project)
      .filter((i) => i.severity !== "info")
      .map((i) => `${i.severity} ${i.locale} ${i.code}${i.form ? `[${i.form}]` : ""}`)
      .sort();
    expect(found).toEqual(
      [
        "error hi placeholder-missing",
        "error ar plural-missing-category",
        "warning undefined variation-unsupported",
      ].sort(),
    );
  });

  it("counts needs_review as a draft", () => {
    const hi = computeStatus(project).find((s) => s.locale === "hi");
    expect(hi?.counts).toMatchObject({ draft: 1, untracked: 2, missing: 1 });
  });

  it("writes nothing new for unchanged translations", async () => {
    const fs = sandbox();
    const t = (await openProject(fs, { cwd: ROOT })).targets[0]?.target;
    for (const locale of ["hi", "ar"]) {
      const catalog = t?.locales.get(locale);
      if (catalog) await t?.writeLocale(catalog);
    }
    expect(fs.files.get(FILE)).toBe(original);
  });

  it("adds a language in sorted position and touches nothing else", async () => {
    const fs = sandbox();
    const t = (await openProject(fs, { cwd: ROOT })).targets[0]?.target;
    const safe = t?.source.entries.get("Safe to spend today");
    const days = t?.source.entries.get("%lld days left");
    if (!t || !safe || !days) throw new Error("missing");
    await t.writeLocale({
      locale: "de",
      entries: new Map([
        [safe.key, { ...safe, message: { kind: "text", value: "Heute sicher ausgebbar" } }],
        [
          days.key,
          {
            ...days,
            message: { kind: "plural", forms: { other: "Noch %lld Tage", one: "Noch %lld Tag" } },
            needsReview: true,
          },
        ],
      ]),
    });
    const out = fs.files.get(FILE) ?? "";
    expect(out).toContain(
      '        "ar" : {\n          "stringUnit" : {\n            "state" : "translated",\n            "value" : "آمن للإنفاق اليوم"\n          }\n        },\n        "de" : {\n          "stringUnit" : {\n            "state" : "translated",\n            "value" : "Heute sicher ausgebbar"\n          }\n        },\n        "hi" : {',
    );
    expect(out).toContain(
      '        "de" : {\n          "variations" : {\n            "plural" : {\n              "one" : {\n                "stringUnit" : {\n                  "state" : "needs_review",\n                  "value" : "Noch %lld Tag"\n                }\n              },\n              "other" : {',
    );
    // Only lines for the two new localizations were added.
    const before = original.split("\n");
    const after = out.split("\n");
    expect(after.length - before.length).toBe(6 + 18);
    expect(out.endsWith('"version" : "1.0"\n}')).toBe(true);
  });

  it("skips keys with no words, from text built in pieces", async () => {
    const keys = [" ", "·", "%@%@", " %@ ", "—", "%lld", "%lld items", "Done"];
    const fs = memoryFs({
      "/a/localship.yaml": "targets:\n  - format: xcstrings\n    path: L.xcstrings\n",
      "/a/L.xcstrings": JSON.stringify({
        sourceLanguage: "en",
        strings: Object.fromEntries(keys.map((k) => [k, {}])),
        version: "1.0",
      }),
    });
    const t = (await openProject(fs, { cwd: "/a" })).targets[0]?.target;
    const translatable = [...(t?.source.entries.values() ?? [])]
      .filter((e) => e.translatable)
      .map((e) => e.key);
    expect(translatable).toEqual(["%lld items", "Done"]);
  });

  it("adds localizations to an entry that had none", async () => {
    const fs = memoryFs({
      "/a/localship.yaml": "targets:\n  - format: xcstrings\n    path: L.xcstrings\n",
      "/a/L.xcstrings":
        '{\n  "sourceLanguage" : "en",\n  "strings" : {\n    "Done" : {\n\n    }\n  },\n  "version" : "1.0"\n}',
    });
    const t = (await openProject(fs, { cwd: "/a" })).targets[0]?.target;
    const done = t?.source.entries.get("Done");
    if (!t || !done) throw new Error("missing");
    await t.writeLocale({
      locale: "hi",
      entries: new Map([["Done", { ...done, message: { kind: "text", value: "हो गया" } }]]),
    });
    expect(fs.files.get("/a/L.xcstrings")).toBe(
      '{\n  "sourceLanguage" : "en",\n  "strings" : {\n    "Done" : {\n      "localizations" : {\n        "hi" : {\n          "stringUnit" : {\n            "state" : "translated",\n            "value" : "हो गया"\n          }\n        }\n      }\n    }\n  },\n  "version" : "1.0"\n}',
    );
  });
});

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { type Io, runInit } from "../src/cli/init-command.js";
import { memoryFs } from "../src/core/fs.js";
import { openProject } from "../src/core/project.js";
import { detect, newPoPattern, poPattern } from "../src/detect/detect.js";

const strings = (...names: string[]) =>
  `<resources>${names.map((n) => `<string name="${n}">${n}</string>`).join("")}</resources>`;
const po = (pairs: Record<string, string>) =>
  Object.entries(pairs)
    .map(([id, str]) => `msgid "${id}"\nmsgstr "${str}"\n`)
    .join("\n");
const catalog = (source: string, keys: string[]) =>
  JSON.stringify({
    sourceLanguage: source,
    strings: Object.fromEntries(keys.map((k) => [k, {}])),
    version: "1.0",
  });

describe("poPattern", () => {
  it.each([
    ["locale/de/LC_MESSAGES/django.po", "locale/{locale}/LC_MESSAGES/django.po", "de"],
    ["po/pt_BR.po", "po/{locale}.po", "pt-BR"],
    ["languages/my-plugin-de_DE.po", "languages/my-plugin-{locale}.po", "de-DE"],
    ["app/i18n/sr@latin/messages.po", "app/i18n/{locale}/messages.po", "sr-Latn"],
  ])("%s → %s", (file, pattern, locale) => {
    expect(poPattern(file)).toMatchObject({ pattern, locale });
  });

  it("ignores .po files with no locale in the path", () => {
    expect(poPattern("docs/notes.po")).toBeUndefined();
  });
});

describe("newPoPattern", () => {
  it.each([
    ["po/app.pot", "po/{locale}.po"],
    ["locale/django.pot", "locale/{locale}/LC_MESSAGES/django.po"],
    ["languages/my-plugin.pot", "languages/my-plugin-{locale}.po"],
    ["messages.pot", "{locale}.po"],
  ])("%s → %s", (pot, pattern) => {
    expect(newPoPattern(pot)).toBe(pattern);
  });
});

describe("detect", () => {
  it("offers a template with no translations yet, and flags an empty String Catalog", async () => {
    const fs = memoryFs({
      "/r/po/app.pot": po({ Hello: "", Bye: "" }),
      "/r/App/Localizable.xcstrings": catalog("en", []),
    });
    const r = await detect(fs, "/r");
    expect(r.candidates.map((c) => [c.target, c.confidence, c.strings])).toEqual([
      [{ format: "po", path: "po/{locale}.po", template: "po/app.pot" }, "medium", 2],
      [{ format: "xcstrings", path: "App/Localizable.xcstrings" }, "medium", 0],
    ]);
    expect(r.candidates[1]?.questions[0]).toMatch(/xcstringstool sync/);
  });

  it("finds Android modules and skips tests, build output and resource-only folders", async () => {
    const fs = memoryFs({
      "/r/app/src/main/res/values/strings.xml": strings("a", "b", "c"),
      "/r/app/src/main/res/values-hi/strings.xml": strings("a"),
      "/r/app/src/debug/res/values/strings.xml": strings("debug_banner"),
      "/r/app/src/test/res/values/strings.xml": strings("t"),
      "/r/app/build/intermediates/res/values/strings.xml": strings("gen"),
      "/r/feature/budget/src/main/res/values/strings.xml": strings("x"),
      "/r/lib/src/main/res/values/colors.xml":
        '<resources><color name="c">#fff</color></resources>',
      "/r/node_modules/pkg/res/values/strings.xml": strings("dep"),
    });
    const r = await detect(fs, "/r");
    expect(r.candidates.map((c) => [c.target.path, c.confidence, c.strings, c.locales])).toEqual([
      ["app/src/main/res", "high", 3, ["hi"]],
      ["feature/budget/src/main/res", "high", 1, []],
      ["app/src/debug/res", "medium", 1, []],
    ]);
    expect(r.candidates[2]?.questions[0]).toMatch(/debug/);
    expect(r.sourceLocale).toMatchObject({ value: "en", confident: false });
  });

  it("groups gettext files by pattern and finds their templates", async () => {
    const fs = memoryFs({
      "/r/locale/de/LC_MESSAGES/django.po": po({ Hello: "Hallo" }),
      "/r/locale/fr/LC_MESSAGES/django.po": po({ Hello: "Bonjour" }),
      "/r/locale/de/LC_MESSAGES/djangojs.po": po({ Close: "Schließen" }),
      "/r/languages/my-plugin.pot": po({ Save: "" }),
      "/r/languages/my-plugin-de_DE.po": po({ Save: "Speichern" }),
      "/r/languages/my-plugin-fr_FR.po": po({ Save: "Enregistrer" }),
      "/r/docs/notes.po": po({ x: "y" }),
    });
    const r = await detect(fs, "/r");
    const byPath = Object.fromEntries(r.candidates.map((c) => [c.target.path, c]));
    expect(Object.keys(byPath).sort()).toEqual([
      "languages/my-plugin-{locale}.po",
      "locale/{locale}/LC_MESSAGES/django.po",
      "locale/{locale}/LC_MESSAGES/djangojs.po",
    ]);
    expect(byPath["languages/my-plugin-{locale}.po"]?.target).toMatchObject({
      template: "languages/my-plugin.pot",
    });
    expect(byPath["languages/my-plugin-{locale}.po"]?.locales).toEqual(["de-DE", "fr-FR"]);
    expect(byPath["locale/{locale}/LC_MESSAGES/django.po"]?.confidence).toBe("high");
    expect(byPath["locale/{locale}/LC_MESSAGES/djangojs.po"]?.confidence).toBe("medium");
    expect(r.locales).toEqual(["de", "de-DE", "fr", "fr-FR"]);
  });

  it("finds a po/ folder with its template", async () => {
    const fs = memoryFs({
      "/r/po/messages.pot": po({ Hi: "" }),
      "/r/po/es.po": po({ Hi: "Hola" }),
    });
    const [c] = (await detect(fs, "/r")).candidates;
    expect(c?.target).toEqual({
      format: "po",
      path: "po/{locale}.po",
      template: "po/messages.pot",
    });
    expect(c?.confidence).toBe("high");
  });

  it("reads the source language from String Catalogs and lists unsupported formats", async () => {
    const fs = memoryFs({
      "/r/.gitignore": "generated/\n",
      "/r/App/Localizable.xcstrings": catalog("de", ["Hallo", "Tschüss"]),
      "/r/generated/Other.xcstrings": catalog("en", ["x"]),
      "/r/App/en.lproj/InfoPlist.strings": '"CFBundleName" = "App";',
      "/r/config/locales/de.yml": "de:\n  hi: Hallo\n",
      "/r/config/locales/en.yml": "en:\n  hi: Hi\n",
    });
    const r = await detect(fs, "/r");
    expect(r.candidates.map((c) => c.target.path)).toEqual(["App/Localizable.xcstrings"]);
    expect(r.sourceLocale).toEqual({
      value: "de",
      confident: true,
      reason: "declared in the String Catalog",
    });
    expect(r.unsupported).toEqual([
      { format: "Apple .strings", files: 1, examples: ["App/en.lproj/InfoPlist.strings"] },
      {
        format: "YAML (Rails)",
        files: 2,
        examples: ["config/locales/de.yml", "config/locales/en.yml"],
      },
    ]);
  });

  it("finds Flutter ARB files, taking the source language from l10n.yaml", async () => {
    const fs = memoryFs({
      "/r/l10n.yaml": "arb-dir: lib/l10n\ntemplate-arb-file: app_de.arb\n",
      "/r/lib/l10n/app_de.arb": '{"hello": "Hallo", "bye": "Tschüss"}',
      "/r/lib/l10n/app_pt_BR.arb": '{"hello": "Olá"}',
    });
    const r = await detect(fs, "/r");
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({
      target: { format: "arb", path: "lib/l10n/app_{locale}.arb" },
      confidence: "high",
      strings: 2,
      locales: ["pt-BR"],
      sourceLocale: "de",
    });
    expect(r.unsupported).toEqual([]);
  });

  it("finds JSON translation files, flat or by folder, and tells i18next from ICU", async () => {
    const fs = memoryFs({
      "/r/web/locales/en.json": '{"hi": "Hi {{name}}"}',
      "/r/web/locales/fr.json": '{"hi": "Salut {{name}}"}',
      "/r/app/messages/en/common.json":
        '{"items": "{count, plural, one {# item} other {# items}}"}',
      "/r/app/messages/de/common.json": "{}",
      "/r/web/data/en.json": '{"not": "translations"}',
    });
    const r = await detect(fs, "/r");
    expect(r.candidates.map((c) => c.target)).toEqual([
      { format: "json", path: "app/messages/{locale}/common.json", placeholders: "icu" },
      { format: "json", path: "web/locales/{locale}.json" },
    ]);
    expect(r.candidates.map((c) => c.locales)).toEqual([["de"], ["fr"]]);
  });

  it("suggests adding a String Catalog to an Xcode project that has none", async () => {
    const fs = memoryFs({
      "/r/App.xcodeproj/project.pbxproj": "// !$*UTF8*$!",
      "/r/App/ContentView.swift": "",
    });
    const r = await detect(fs, "/r");
    expect(r.candidates).toEqual([]);
    expect(r.hints[0]).toMatch(/String Catalog/);
    expect(r.hints[0]).toMatch(/Add one in Xcode/);
  });

  it("says where the catalog goes when XcodeGen generates the project", async () => {
    const fs = memoryFs({
      "/r/project.yml": "name: App",
      "/r/App/ContentView.swift": "",
    });
    const r = await detect(fs, "/r");
    expect(r.hints[0]).toMatch(/XcodeGen \(project\.yml\).*each target's sources.*regenerate/);
    expect(r.hints[0]).not.toMatch(/Add one in Xcode/);
  });
});

function io(answers: string[] = [], interactive = false): Io & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    interactive,
    log: (l) => out.push(l),
    error: (l) => err.push(l),
    ask: async (_q, fallback) => answers.shift() || fallback,
  };
}

describe("init", () => {
  const repo = () =>
    memoryFs({
      "/r/app/src/main/res/values/strings.xml": strings("a", "b"),
      "/r/app/src/main/res/values-ar/strings.xml": strings("a"),
      "/r/wear/src/main/res/values/strings.xml": strings("w"),
      "/r/locale/hi/LC_MESSAGES/django.po": po({ Hello: "नमस्ते" }),
      "/r/locale/ar/LC_MESSAGES/django.po": po({ Hello: "مرحبا" }),
    });

  it("--yes writes a config the project can open, with ids where formats repeat", async () => {
    const fs = repo();
    const code = await runInit(fs, { cwd: "/r", yes: true }, io());
    expect(code).toBe(0);
    const config = parseYaml(fs.files.get("/r/.localship/config.yaml") ?? "");
    expect(config).toEqual({
      sourceLocale: "en",
      locales: ["ar", "hi"],
      targets: [
        { id: "android-app", format: "android-xml", path: "app/src/main/res" },
        { id: "android-wear", format: "android-xml", path: "wear/src/main/res" },
        { format: "po", path: "locale/{locale}/LC_MESSAGES/django.po" },
      ],
    });
    const project = await openProject(fs, { cwd: "/r" });
    expect(project.targets.map((t) => t.target.id)).toEqual(["android-app", "android-wear", "po"]);
  });

  it("--accept and --locales pick exactly what's asked", async () => {
    const fs = repo();
    expect(await runInit(fs, { cwd: "/r", accept: [3], locales: ["hi"], source: "en" }, io())).toBe(
      0,
    );
    expect(parseYaml(fs.files.get("/r/.localship/config.yaml") ?? "")).toEqual({
      sourceLocale: "en",
      locales: ["hi"],
      targets: [{ format: "po", path: "locale/{locale}/LC_MESSAGES/django.po" }],
    });
  });

  it("asks in a terminal", async () => {
    const fs = repo();
    const terminal = io(["1", "", "hi, ar"], true);
    expect(await runInit(fs, { cwd: "/r" }, terminal)).toBe(0);
    expect(parseYaml(fs.files.get("/r/.localship/config.yaml") ?? "")).toMatchObject({
      locales: ["hi", "ar"],
      targets: [{ format: "android-xml", path: "app/src/main/res" }],
    });
    expect(terminal.out.join("\n")).toContain("Found 3 localization setups");
  });

  it("won't write without consent when not in a terminal", async () => {
    const fs = repo();
    const quiet = io();
    expect(await runInit(fs, { cwd: "/r" }, quiet)).toBe(2);
    expect(fs.files.has("/r/.localship/config.yaml")).toBe(false);
    expect(quiet.err[0]).toMatch(/--yes/);
  });

  it("never overwrites a config unless forced", async () => {
    const fs = repo();
    fs.files.set("/r/.localship/config.yaml", "mine");
    expect(await runInit(fs, { cwd: "/r", yes: true }, io())).toBe(2);
    expect(fs.files.get("/r/.localship/config.yaml")).toBe("mine");
    expect(await runInit(fs, { cwd: "/r", yes: true, force: true }, io())).toBe(0);
  });

  it("rejects bad answers without writing", async () => {
    const fs = repo();
    const bad = io();
    expect(await runInit(fs, { cwd: "/r", accept: [9] }, bad)).toBe(2);
    expect(bad.err[0]).toMatch(/no setup 9/);
    expect(await runInit(fs, { cwd: "/r", yes: true, locales: ["not a locale"] }, bad)).toBe(2);
    expect(fs.files.has("/r/.localship/config.yaml")).toBe(false);
  });

  it("explains what to do when nothing is found", async () => {
    const fs = memoryFs({
      "/r/App.xcodeproj/project.pbxproj": "",
      "/r/App/Strings.resx": "<root/>",
    });
    const none = io();
    expect(await runInit(fs, { cwd: "/r", yes: true }, none)).toBe(1);
    expect(none.err[0]).toMatch(/String Catalog[\s\S]*\.resx/);
  });
});

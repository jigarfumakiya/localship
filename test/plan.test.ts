import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { memoryFs } from "../src/core/fs.js";
import { plan, resolveLocale, start } from "../src/core/plan.js";

const STRINGS = `<resources>
    <string name="app_name">Jotter</string>
    <string name="save">Save</string>
    <string name="cancel">Cancel</string>
</resources>`;

const app = (extra: Record<string, string> = {}) =>
  memoryFs({
    "/a/build.gradle.kts": "",
    "/a/app/src/main/AndroidManifest.xml": "<manifest/>",
    "/a/app/src/main/res/values/strings.xml": STRINGS,
    ...extra,
  });

describe("resolveLocale", () => {
  it.each([
    ["Hindi", "hi"],
    ["arabic", "ar"],
    ["pt_BR", "pt-BR"],
    ["Brazilian Portuguese", "pt-BR"],
    ["zh-Hant", "zh-Hant"],
  ])("%s → %s", (input, code) => {
    expect(resolveLocale(input)).toBe(code);
  });
  it("rejects what isn't a language", () => {
    expect(() => resolveLocale("Klingon please")).toThrow(/language name or code/);
  });
});

describe("plan", () => {
  it("is ready for an app with strings and no translations, deciding nothing for the user", async () => {
    const p = await plan(app(), "/a", { locales: ["Hindi"] });
    expect(p).toMatchObject({
      ready: true,
      configured: false,
      locales: [{ code: "hi", name: "Hindi", isNew: true }],
      targets: [{ format: "android-xml", path: "app/src/main/res", strings: 3 }],
      work: { hi: 3 },
      blockers: [],
      notes: [],
      keepAsWritten: ["Jotter"],
      brief: false,
    });
    expect(p.voice.hi).toMatchObject({ fromProject: false, text: expect.stringMatching(/आप/) });
  });

  it("notes text still in the code without making it a step or a blocker", async () => {
    const code = Array.from({ length: 15 }, (_, i) => `Text("Line number ${i}")`).join("\n");
    const p = await plan(app({ "/a/app/src/main/java/Main.kt": code }), "/a", { locales: ["hi"] });
    expect(p.ready).toBe(true);
    expect(p.blockers).toEqual([]);
    expect(p.notes[0]).toMatch(/still in the code.*when the user asks/);
    expect(p.notes.join(" ")).not.toMatch(/branch/);
    expect(p.work.hi).toBe(3);
  });

  it("asks for languages, and stops at formats it can't handle", async () => {
    const noLang = await plan(app(), "/a");
    expect(noLang.ready).toBe(false);
    expect(noLang.blockers.map((b) => b.kind)).toEqual(["no-locales"]);
    const dotnet = await plan(memoryFs({ "/f/App/Strings.resx": "<root/>" }), "/f", {
      locales: ["hi"],
    });
    expect(dotnet.ready).toBe(false);
    expect(dotnet.blockers[0]?.message).toMatch(/\.resx/);
  });

  it("counts only what's left in a set-up project, and all of a new language", async () => {
    const fs = app({
      "/a/localship.yaml":
        "locales: [hi]\ntargets:\n  - format: android-xml\n    path: app/src/main/res\n",
      "/a/app/src/main/res/values-hi/strings.xml":
        '<resources><string name="save">सहेजें</string></resources>',
      "/a/.localship/voice/hi.md": "Use तुम.",
    });
    const p = await plan(fs, "/a", { locales: ["hi", "French"] });
    expect(p.configured).toBe(true);
    expect(p.work).toEqual({ hi: 2, fr: 3 });
    expect(p.locales.map((l) => [l.code, l.isNew])).toEqual([
      ["hi", false],
      ["fr", true],
    ]);
    expect(p.voice.hi).toEqual({ text: "Use तुम.", fromProject: true });
    expect(p.voice.fr?.fromProject).toBe(false);
    expect(p.keepAsWritten).toEqual(["Jotter"]);
  });

  it("suggests Brazilian conventions only for Brazilian Portuguese", async () => {
    const p = await plan(app(), "/a", { locales: ["pt-PT", "pt-BR"] });
    expect(p.voice["pt-PT"]?.text).not.toMatch(/Brazilian Portuguese conventions/);
    expect(p.voice["pt-BR"]?.text).toMatch(/você/);
  });
});

describe("start", () => {
  it("writes the config and nothing else", async () => {
    const fs = app();
    const before = new Set(fs.files.keys());
    const r = await start(fs, "/a", { locales: ["Hindi", "ar"] });
    expect(r).toMatchObject({ createdConfig: true, addedLocales: ["hi", "ar"], warnings: [] });
    const written = [...fs.files.keys()].filter((f) => !before.has(f));
    expect(written).toEqual(["/a/.localship/config.yaml"]);
    expect(parseYaml(fs.files.get("/a/.localship/config.yaml") ?? "")).toMatchObject({
      locales: ["hi", "ar"],
    });
  });

  it("adds languages to an existing setup", async () => {
    const fs = app();
    await start(fs, "/a", { locales: ["hi"] });
    const r = await start(fs, "/a", { locales: ["hi", "de"] });
    expect(r).toMatchObject({ createdConfig: false, addedLocales: ["de"] });
  });
});

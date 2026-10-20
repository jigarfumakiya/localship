import { describe, expect, it } from "vitest";
import { memoryFs } from "../src/core/fs.js";
import { scanIcu, splitIcuPlural } from "../src/core/icu.js";
import { openProject } from "../src/core/project.js";
import { computeStatus } from "../src/core/status.js";
import { buildUsageIndex } from "../src/core/usage.js";
import { validateProject } from "../src/core/validate.js";
import { nextBatch, prune, removeTranslations, submit } from "../src/core/workflow.js";

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

const ARB_EN = json({
  "@@locale": "en",
  hello: "Hello {name}!",
  "@hello": {
    description: "Greeting on the home screen",
    placeholders: { name: { type: "String", example: "Bob" } },
  },
  notes: "{count, plural, =0{No notes} one{One note} other{{count} notes}}",
  greeting: "{sex, select, male{He} female{She} other{They}} replied",
  empty: "",
});

function flutter(files: Record<string, string> = {}) {
  return memoryFs({
    "/p/localship.yaml":
      "locales: [ar, pt-BR]\ntargets:\n  - format: arb\n    path: lib/l10n/app_{locale}.arb\n",
    "/p/lib/l10n/app_en.arb": ARB_EN,
    ...files,
  });
}

const JSON_EN = json({
  nav: { home: "Home", settings: "Settings" },
  welcome: "Welcome, {{name}}",
  items_one: "{{count}} item",
  items_other: "{{count}} items",
  tips: ["Swipe to delete", "Tap to edit"],
  version: 3,
});

function web(files: Record<string, string> = {}, extra = "") {
  return memoryFs({
    "/w/localship.yaml": `locales: [ar, de]\ntargets:\n  - format: json\n    path: locales/{locale}/common.json\n${extra}`,
    "/w/locales/en/common.json": JSON_EN,
    ...files,
  });
}

const open = (fs: ReturnType<typeof memoryFs>, cwd: string) => openProject(fs, { cwd });

describe("ICU messages", () => {
  it("finds arguments, counting # (where the dialect has it) and {count} as the count", () => {
    const { placeholders } = scanIcu(
      "{n, plural, one{# file in {dir}} other{{n} files in {dir}}}",
      { pound: true },
    );
    expect(placeholders.map((p) => [p.id, p.raw, p.type])).toEqual([
      ["n", "{n, plural}", "d"],
      ["n", "#", "d"],
      ["dir", "{dir}", undefined],
      ["n", "{n}", "d"],
      ["dir", "{dir}", undefined],
    ]);
    expect(scanIcu("Hi {name").error).toMatch(/\{name/);
    expect(scanIcu("Hi name}").error).toBe("Unmatched }");
    // Flutter prints # as is.
    expect(
      scanIcu("{n, plural, one{# file} other{# files}}").placeholders.map((p) => p.raw),
    ).toEqual(["{n, plural}"]);
  });

  it("checks plural cases and other, as gen-l10n and format.js do", () => {
    expect(scanIcu("{n, plural, single{x} other{y}}").error).toMatch(
      /"single" isn't a plural case/,
    );
    expect(scanIcu("{n, plural, one{x}}").error).toMatch(/needs an "other" case/);
    expect(scanIcu("{g, select, male{He}}").error).toMatch(/needs an "other" case/);
    expect(scanIcu("{g, select, male{He} other{They}}").error).toBeUndefined();
  });

  it("reads apostrophes as quotes only with Flutter's use-escaping", () => {
    expect(scanIcu("Ouvrir l'application").error).toBeUndefined();
    const escaping = { escaping: true };
    expect(scanIcu("Ouvrir l'application", escaping).error).toMatch(/write '' for one/);
    expect(scanIcu("Ouvrir l''application {app}", escaping).placeholders).toHaveLength(1);
    // Two apostrophes pair up and vanish: Flutter would show "cest lheure".
    expect(scanIcu("c'est l'heure", escaping).error).toMatch(/"'est l'" loses them/);
    expect(scanIcu("Use '{braces}' as is", escaping).placeholders).toEqual([]);
  });

  it("splits a message that is one plural, and leaves anything else whole", () => {
    expect(splitIcuPlural("{count, plural, =0{None} one{One} other{{count} more}}")).toEqual({
      arg: "count",
      forms: { "=0": "None", one: "One", other: "{count} more" },
    });
    expect(splitIcuPlural("You have {count, plural, one{one} other{#}}")).toBeUndefined();
    expect(splitIcuPlural("{count, plural, offset:1 one{x} other{y}}")).toBeUndefined();
    expect(splitIcuPlural("{count, plural, one{x}}")).toBeUndefined();
  });
});

describe("Flutter ARB", () => {
  it("reads strings, descriptions and plurals from the template", async () => {
    const p = await open(flutter(), "/p");
    const batch = await nextBatch(p, { locales: ["ar"], usages: false });
    expect(batch.items.map((i) => [i.key, i.kind])).toEqual([
      ["hello", "text"],
      ["notes", "plural"],
      ["greeting", "text"],
    ]);
    const [hello, notes, greeting] = batch.items;
    expect(hello?.comment).toBe(
      "Greeting on the home screen. Placeholders: {name} (String, e.g. Bob)",
    );
    // gen-l10n fills one slot for =0 and zero, so Localship reads them as one form.
    expect(notes?.source).toEqual({ zero: "No notes", one: "One note", other: "{count} notes" });
    expect(notes?.pluralForms?.map((f) => f.form)).toEqual([
      "zero",
      "one",
      "two",
      "few",
      "many",
      "other",
    ]);
    // Japanese has only `other`, but intl still uses zero, one and two for exactly 0, 1 and 2.
    const ja = p.targets[0]?.target.pluralSpec("ja");
    expect(ja?.forms.map((f) => [f.id, f.optional ?? false])).toEqual([
      ["zero", true],
      ["one", true],
      ["two", true],
      ["other", false],
    ]);
    expect(greeting?.placeholders).toEqual(["{sex, select}"]);
  });

  it("writes a new language next to the template, in its order, and checks ICU", async () => {
    const fs = flutter();
    const result = await submit(
      await open(fs, "/p"),
      [
        {
          locale: "ar",
          key: "notes",
          value: {
            zero: "لا ملاحظات",
            one: "ملاحظة واحدة",
            two: "ملاحظتان",
            few: "{count} ملاحظات",
            many: "{count} ملاحظة",
            other: "{count} ملاحظة",
          },
        },
        { locale: "ar", key: "hello", value: "مرحبًا {name}!" },
        { locale: "ar", key: "greeting", value: "رد {gender, select, other{هم}}" },
        { locale: "pt-BR", key: "hello", value: "Olá {nome}!" },
        {
          locale: "pt-BR",
          key: "greeting",
          value: "{sex, select, male{Ele} other{Eles} respondeu",
        },
      ],
      { usages: false },
    );
    expect(result.accepted.map((a) => `${a.locale}:${a.key}`)).toEqual(["ar:notes", "ar:hello"]);
    expect(result.rejected.map((r) => [r.key, r.errors[0]?.code])).toEqual([
      ["greeting", "placeholder-missing"],
      ["hello", "placeholder-missing"],
      ["greeting", "icu-malformed"],
    ]);
    expect(await fs.readFile("/p/lib/l10n/app_ar.arb")).toBe(
      json({
        "@@locale": "ar",
        hello: "مرحبًا {name}!",
        notes:
          "{count, plural, zero{لا ملاحظات} one{ملاحظة واحدة} two{ملاحظتان} few{{count} ملاحظات} many{{count} ملاحظة} other{{count} ملاحظة}}",
      }),
    );
    expect(
      validateProject(await open(fs, "/p"), { locales: ["ar"] }).filter(
        (i) => i.severity === "error",
      ),
    ).toEqual([]);
  });

  it("treats # as text and follows use-escaping from l10n.yaml", async () => {
    const fs = flutter({ "/p/l10n.yaml": "arb-dir: lib/l10n\nuse-escaping: true\n" });
    fs.files.set(
      "/p/localship.yaml",
      fs.files.get("/p/localship.yaml")?.replace("ar, pt-BR", "fr") ?? "",
    );
    const result = await submit(
      await open(fs, "/p"),
      [
        {
          locale: "fr",
          key: "notes",
          value: { zero: "Aucune note", one: "# note", other: "# notes" },
        },
        { locale: "fr", key: "hello", value: "Bonjour {name}, c'est l'heure" },
      ],
      { usages: false, dryRun: true },
    );
    const codes = Object.fromEntries(
      result.rejected.map((r) => [r.key, r.errors.map((e) => e.code)]),
    );
    expect(codes.notes).toContain("plural-count-missing");
    expect(codes.hello).toEqual(["icu-malformed"]);
    const fixed = await submit(
      await open(fs, "/p"),
      [
        {
          locale: "fr",
          key: "notes",
          value: {
            zero: "Aucune note",
            one: "{count} note",
            many: "{count} de notes",
            other: "{count} notes",
          },
        },
        { locale: "fr", key: "hello", value: "Bonjour {name}, c''est l''heure !" },
      ],
      { usages: false, dryRun: true },
    );
    expect(fixed.rejected).toEqual([]);
  });

  it("tells translators about use-escaping, and accepts {count} where the source wrote 1", async () => {
    const fs = flutter({
      "/p/l10n.yaml": "use-escaping: true\n",
      "/p/lib/l10n/app_en.arb": json({
        notes: "{count, plural, =0{No notes} =1{1 note} other{{count} notes}}",
      }),
    });
    const p = await open(fs, "/p");
    const batch = await nextBatch(p, { locales: ["ar"], usages: false });
    expect(batch.formats.arb).toMatch(
      /uses use-escaping \(l10n\.yaml\): write every apostrophe as ''/,
    );
    expect(
      (await nextBatch(await open(flutter(), "/p"), { usages: false })).formats.arb,
    ).not.toMatch(/uses use-escaping/);
    // French `one` covers 0 and 1, so "{count} note" is right for the source's "One note".
    const fr = await submit(
      p,
      [
        {
          locale: "pt-BR",
          key: "notes",
          value: {
            zero: "Nenhuma nota",
            one: "{count} nota",
            many: "{count} de notas",
            other: "{count} notas",
          },
        },
      ],
      { usages: false, dryRun: true },
    );
    expect(fr.rejected).toEqual([]);
    expect(fr.accepted[0]?.warnings.map((w) => w.code)).not.toContain("number-mismatch");
  });

  it("knows a filled zero takes 0 from French one, as intl does", async () => {
    const fs = flutter({
      "/p/lib/l10n/app_en.arb": json({
        left: "{count, plural, =0{All done} =1{1 task left} other{{count} tasks left}}",
        "@left": { placeholders: { count: { type: "int" } } },
      }),
    });
    const p = await open(fs, "/p");
    const [item] = (await nextBatch(p, { locales: ["pt-BR"], usages: false })).items;
    // pt-BR `one` is 0 and 1 by CLDR; with zero filled it is only ever 1.
    expect(item?.pluralForms?.find((f) => f.form === "one")?.examples).toBe("1");
    const ok = await submit(
      p,
      [
        {
          locale: "pt-BR",
          key: "left",
          value: {
            zero: "Tudo pronto",
            one: "1 tarefa restante",
            many: "{count} de tarefas",
            other: "{count} tarefas restantes",
          },
        },
      ],
      { usages: false, dryRun: true },
    );
    expect(ok.rejected).toEqual([]);
    // Without zero, 0 reaches `one`, so it must show the count.
    const bad = await submit(
      p,
      [
        {
          locale: "pt-BR",
          key: "left",
          value: {
            one: "1 tarefa restante",
            many: "{count} de tarefas",
            other: "{count} tarefas restantes",
          },
        },
      ],
      { usages: false, dryRun: true },
    );
    expect(bad.rejected[0]?.errors.map((e) => e.code)).toContain("plural-count-missing");
  });

  it("reads =1 in a translation as Flutter's one, and writes it back as one", async () => {
    const fs = flutter({
      "/p/lib/l10n/app_ar.arb": json({
        notes: "{count, plural, =0{صفر} zero{لا شيء} =1{واحدة} other{{count}}}",
      }),
    });
    const p = await open(fs, "/p");
    expect(p.targets[0]?.target.locales.get("ar")?.entries.get("notes")?.message).toEqual({
      kind: "plural",
      forms: { zero: "لا شيء", one: "واحدة", other: "{count}" },
    });
  });

  it("names new files the Flutter way and keeps an existing file's other keys", async () => {
    const fs = flutter({
      "/p/lib/l10n/app_ar.arb": json({ "@@locale": "ar", custom: "يبقى", hello: "قديم {name}" }),
    });
    await submit(
      await open(fs, "/p"),
      [
        { locale: "pt-BR", key: "hello", value: "Olá {name}!" },
        { locale: "ar", key: "hello", value: "أهلًا {name}!" },
      ],
      { usages: false, force: true },
    );
    expect(JSON.parse(await fs.readFile("/p/lib/l10n/app_pt_BR.arb"))).toEqual({
      "@@locale": "pt_BR",
      hello: "Olá {name}!",
    });
    expect(Object.keys(JSON.parse(await fs.readFile("/p/lib/l10n/app_ar.arb")))).toEqual([
      "@@locale",
      "custom",
      "hello",
    ]);
  });

  it("removes a translation with its metadata, and prunes deleted strings", async () => {
    const fs = flutter({
      "/p/lib/l10n/app_ar.arb": json({
        "@@locale": "ar",
        hello: "مرحبًا {name}!",
        "@hello": { description: "x" },
        gone: "قديم",
      }),
    });
    const p = await open(fs, "/p");
    expect((await prune(p, {})).removed.map((r) => r.key)).toEqual(["gone"]);
    await removeTranslations(await open(fs, "/p"), {
      locales: ["ar"],
      keys: ["hello"],
      force: true,
    });
    expect(JSON.parse(await fs.readFile("/p/lib/l10n/app_ar.arb"))).toEqual({ "@@locale": "ar" });
  });
});

describe("JSON", () => {
  it("reads nested keys, i18next plurals and arrays, and skips numbers", async () => {
    const p = await open(web(), "/w");
    const batch = await nextBatch(p, { locales: ["ar"], usages: false });
    expect(batch.items.map((i) => [i.key, i.kind, i.source])).toEqual([
      ["nav.home", "text", "Home"],
      ["nav.settings", "text", "Settings"],
      ["welcome", "text", "Welcome, {{name}}"],
      ["items", "plural", { one: "{{count}} item", other: "{{count}} items" }],
      ["tips", "array", ["Swipe to delete", "Tap to edit"]],
    ]);
    expect(batch.items[2]?.placeholders).toEqual(["{{name}}"]);
  });

  it("writes nested objects in the source's order, with every plural form together", async () => {
    const fs = web({ "/w/locales/ar/common.json": json({ items_zero: "لا عناصر", extra: "x" }) });
    const result = await submit(
      await open(fs, "/w"),
      [
        { locale: "ar", key: "tips", value: ["اسحب للحذف", "انقر للتعديل"] },
        { locale: "ar", key: "nav.settings", value: "الإعدادات" },
        {
          locale: "ar",
          key: "items",
          value: {
            zero: "{{count}} عناصر",
            one: "عنصر واحد",
            two: "عنصران",
            few: "{{count}} عناصر",
            many: "{{count}} عنصرًا",
            other: "{{count}} عنصر",
          },
        },
        { locale: "ar", key: "nav.home", value: "الرئيسية" },
      ],
      { usages: false },
    );
    expect(result.rejected).toEqual([]);
    // Arabic `one` and `two` mean exactly 1 and 2, so they may leave out {{count}}.
    expect(result.accepted.find((a) => a.key === "items")?.warnings).toEqual([]);
    expect(await fs.readFile("/w/locales/ar/common.json")).toBe(
      json({
        nav: { home: "الرئيسية", settings: "الإعدادات" },
        items_zero: "{{count}} عناصر",
        items_one: "عنصر واحد",
        items_two: "عنصران",
        items_few: "{{count}} عناصر",
        items_many: "{{count}} عنصرًا",
        items_other: "{{count}} عنصر",
        tips: ["اسحب للحذف", "انقر للتعديل"],
        extra: "x",
      }),
    );

    // Fewer forms the next time: the dropped one goes. German's zero is optional.
    fs.files.set(
      "/w/locales/de/common.json",
      json({ items_zero: "Keine", items_one: "Ein", items_other: "{{count}}" }),
    );
    await submit(
      await open(fs, "/w"),
      [
        {
          locale: "de",
          key: "items",
          value: { one: "{{count}} Eintrag", other: "{{count}} Einträge" },
        },
      ],
      { usages: false, force: true },
    );
    expect(JSON.parse(await fs.readFile("/w/locales/de/common.json"))).toEqual({
      items_one: "{{count}} Eintrag",
      items_other: "{{count}} Einträge",
    });
    // Removing the last keys of an object removes the object too.
    await removeTranslations(await open(fs, "/w"), {
      keys: ["nav.home", "nav.settings"],
      force: true,
    });
    expect(JSON.parse(await fs.readFile("/w/locales/ar/common.json")).nav).toBeUndefined();
  });

  it("checks i18next placeholders and plural forms", async () => {
    const p = await open(web(), "/w");
    const result = await submit(
      p,
      [
        { locale: "ar", key: "welcome", value: "أهلًا" },
        { locale: "ar", key: "items", value: { one: "عنصر", other: "{{count}} عنصر" } },
      ],
      { usages: false, dryRun: true },
    );
    expect(result.rejected.map((r) => [r.key, r.errors[0]?.code])).toEqual([
      ["welcome", "placeholder-missing"],
      ["items", "plural-missing-category"],
    ]);
  });

  it("reads ICU messages when told to, counting # as the count", async () => {
    const fs = memoryFs({
      "/n/localship.yaml":
        "locales: [de]\ntargets:\n  - format: json\n    path: messages/{locale}.json\n    placeholders: icu\n",
      "/n/messages/en.json": json({ Cart: { items: "{n, plural, one {# item} other {# items}}" } }),
    });
    const p = await open(fs, "/n");
    const [item] = (await nextBatch(p, { usages: false })).items;
    expect(item).toMatchObject({ key: "Cart.items", kind: "plural", placeholders: ["#"] });
    const result = await submit(
      p,
      [{ locale: "de", key: "Cart.items", value: { one: "{n} Artikel", other: "# Artikel" } }],
      { usages: false },
    );
    expect(result.rejected).toEqual([]);
    expect(JSON.parse(await fs.readFile("/n/messages/de.json"))).toEqual({
      Cart: { items: "{n, plural, one{{n} Artikel} other{# Artikel}}" },
    });
  });

  it("reports broken files and duplicate keys", async () => {
    const p = await open(
      web({
        "/w/locales/ar/common.json": '{"a": "x",',
        "/w/locales/en/common.json": '{"nav": {"home": "Home"}, "nav.home": "Again"}',
      }),
      "/w",
    );
    expect(p.targets[0]?.target.issues.map((i) => [i.code, i.locale])).toEqual([
      ["json-malformed", "ar"],
      ["duplicate-key", "en"],
    ]);
  });

  it("tracks state like every other format", async () => {
    const fs = web({ "/w/locales/ar/common.json": json({ welcome: "أهلًا {{name}}" }) });
    const status = computeStatus(await open(fs, "/w"));
    expect(JSON.stringify(status)).toContain('"untracked":1');
  });
});

describe("code usage", () => {
  it("finds ARB keys in Dart and JSON keys in JavaScript, with their role", async () => {
    const fs = web(
      {
        "/w/src/Nav.tsx":
          "export const Nav = () => (\n  <button>{t('common:nav.home')}</button>\n);\n",
      },
      "  - format: arb\n    path: lib/l10n/app_{locale}.arb\n",
    );
    fs.files.set("/w/lib/l10n/app_en.arb", ARB_EN);
    fs.files.set(
      "/w/lib/home.dart",
      "AppBar(\n  title: Text(AppLocalizations.of(context)!.hello),\n);\n",
    );
    const p = await open(fs, "/w");
    const batch = await nextBatch(p, {
      locales: ["ar"],
      usages: await buildUsageIndex(p),
      keys: ["nav.home", "hello"],
    });
    expect(batch.items.map((i) => [i.key, i.usage?.[0]?.at, i.role])).toEqual([
      ["nav.home", "src/Nav.tsx:2", "button"],
      ["hello", "lib/home.dart:2", "title"],
    ]);
  });
});

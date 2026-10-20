---
name: localship-setup
description: Set up localization for an app repo with Localship — whether it already has translations, has string resources but no translations, or has its text hardcoded. Finds the translation files, writes .localship/config.yaml, and drafts the brief, voice and glossary translators need. Use when a project has no .localship/config.yaml yet, or the user asks to add languages or set up translation.
---

# Set up localization with Localship

Localship keeps translations in the repo's own files (Android `res/values-*/strings.xml`,
gettext `.po`, Apple `.xcstrings`, Flutter `.arb`, JSON) and checks every translation in code. You do the parts
that need judgment: choosing what to set up, and writing the context translators use.

> For a direct request ("translate this app to Hindi"), start with the `localship` skill instead:
> it sets up only the config and translates.

## Running the tool

- If `localship_*` MCP tools are available, use them (`localship_detect`, `localship_init`, …).
- Otherwise run the CLI: `localship <command>`. If `localship` isn't installed, ask to install it once with
  `npm install -g localship` (running it through `npx` every time is slow).
- Add `--json` when you need to read the output.

## 1. Find out where the project stands

Run `localship status`. If it works, the project is already set up (if it warns that most text is still in the code, go to case C): go to step 5 (context) if
`.localship/brief.md` is missing, or to **Adding languages** below. Otherwise run `localship detect` and
pick the case that fits:

| What detect shows | Case |
|---|---|
| A warning that most of the app's text is still in the code (more UI text in code than strings in resources) | **C. Text is hardcoded**, even if a few strings exist: tell the user how much is in code; translations cover only what's in resources until it's moved (the `localship-extract` skill, if they ask) |
| Setups with existing languages (`hi, ar` …) | **A. Already localized** |
| Setups with strings but no languages | **B. Ready to translate** |
| An empty String Catalog (0 strings) | Check compiler extraction and target membership, build the relevant targets and platforms, and sync the catalog from the build (`xcrun xcstringstool sync`; a command-line build alone leaves it empty, see `localship-extract`), then detect again |
| A gettext template with no translations | **B**, after confirming where new `.po` files go (detect suggests a path) |
| Nothing, with a hint about Android or Xcode | **C. Text is hardcoded**: nothing to set up until the text is in resources; the `localship-extract` skill moves it, if the user asks |
| Only formats listed as "not supported yet" (Flutter ARB, JSON, `.strings` …) | Say so plainly; Localship can't translate those yet |

## 2. Init

Include every setup detect found except debug, test and sample folders, unless the user said
otherwise. Languages: the ones the user named, plus (case A) the ones already there. If the user
named none and there are none, ask which; that's the one thing setup can't guess.

Then run `localship init --accept <numbers> --locales <list>` (add `--source <locale>` if the detected
source language is wrong). Language codes are BCP 47 (`hi`, `ar`, `pt-BR`, `zh-Hans`). Never pass
`--force` unless the user asked to replace their config.

## 3. Existing translations (case A)

They show as `untracked`: made before Localship, so the tool doesn't know if they're good. Leave
them as they are; they're never overwritten without the user's say-so. In your report, mention
that the user can approve them (`localship approve --from untracked`) or have them reviewed (the
`localship-review` skill). Run `localship validate`: existing files often have real problems
(missing placeholders, broken plurals). Report the errors; fix them if the user asks.

## 4. Platform setup the tool can't do (mention what applies)

- Android: inspect AGP, compileSdk and any existing language configuration first. Automatic
  `androidResources { generateLocaleConfig = true }` needs AGP 8.1+ and compileSdk 33+.
  Set `unqualifiedResLocale` in the app module's `res/resources.properties` to the actual
  default locale, not an assumed `en-US`. Do not combine a manual LocaleConfig with generation;
  reconcile the existing setup. Check the generated supported-language list, including library
  resources, and restrict it to languages ready for release using the installed AGP's supported
  locale-filter configuration.
- Android in-app selection: integrate platform `LocaleManager` on Android 13+ or compatible
  AndroidX `AppCompatDelegate.setApplicationLocales`; consider the Activity/context requirements
  on older devices, persisted preferences and migration from any existing picker. Test system
  settings, app settings, restart and configuration changes together. Generating LocaleConfig
  alone does not implement a backward-compatible picker.
- iOS: add languages through the catalog/project localization settings or available Xcode
  preparation tools. Check the development language, resource bundles, compiler extraction and
  all relevant targets/platforms, as described in `localship-extract`. Xcode 27's native agent
  tools can assist preparation; use them when available, with the project's glossary and voice.

Read [platform verification](../localship-extract/references/platform-localization.md) for the
official references. Report unsupported catalog/resource configurations before translating;
strict validation blocks them even when supported strings are all complete.

## 5. Write the context

The user asked for setup, so write these in `.localship/` (the `context` folder in the config).
Draft them from the README, store listing, website copy and the strings themselves, and show the
user what you wrote. Don't overwrite files that already exist.

- `brief.md`: what the app does, who uses it, the tone of its copy (calm, playful, formal…), and
  anything translators get wrong without context (e.g. "a 'notebook' is a group of notes, not
  a paper notebook"). Half a page at most.
- `voice/all.md`: voice rules for every language. `voice/<locale>.md`: per language, e.g. formality
  (German du vs Sie, Hindi तुम vs आप), English loanwords, number and date conventions. Use what the
  user said; otherwise the usual convention for consumer apps in that language, and name the choice
  in your summary so they can change it.
- `glossary.yaml`: brand and product names to keep (`translate: false`), and product terms that
  must be translated consistently:
  ```yaml
  terms:
    - term: Jotter
      translate: false
    - term: notebook
      note: A named group of notes, not a paper notebook
      translations: { hi: नोटबुक }
  ```
  Keep it short: names, and terms that appear in many strings or carry product meaning.

Without file access, use `localship_update_context` instead.

## Cleaning up

After strings are deleted or renamed, `localship prune --dry-run` shows leftover translations; show
the user, then run `localship prune`. First verify that the source keys were actually removed:
a missing Android default can look like a leftover translation, and should be restored instead.

## Adding languages later

`localship add-locale fr,de` (or `localship_add_locales`), then translate with `localship-translate`.

## Finish

Run `localship validate` and `localship status`, and tell the user the next step: translating (the
`localship-translate` skill). Commit nothing unless the user asks.

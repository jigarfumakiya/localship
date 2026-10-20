---
name: localship
description: Use whenever the user wants their app in other languages, its translations updated, or its text made ready for translation, however they phrase it ("localize the app", "I want this in Spanish", "support Hindi users", "add French", "update the translations"). Works out what they mean, does it end to end and reports, stopping only when something is in the way. Use this first; the other localship-* skills are the detailed playbooks it follows.
---

# Localize an app with Localship

Do what the user asked, all of it, and nothing they didn't ask for. Don't ask for a go-ahead
on a normal request; stop only when something is genuinely in the way.

## What the user wants

Go by what the user means, not the words they use. Requests come in many forms; these are
examples, not phrases to match.

| What they want | Sounds like | Do |
|---|---|---|
| **The app in a language**, all of it | "localize the app", "I want this in Spanish", "support Hindi users", "add French", "make it work in Arabic", "go international" | Move text still in the code into string resources (the whole app), then translate |
| **Translations kept up to date** | "update the translations", "I changed some copy", "translate the new strings", "sync Hindi" | Translate what's missing or changed in the string resources; mention text still in the code |
| **Text ready for translation**, nothing translated | "make the app localizable", "find hardcoded strings", "move the text into strings.xml", "prepare for translation" | Move the text only (the `localship-extract` skill) |

A limit the user states wins: "just translate the strings file" or "don't touch the code" means
translate only. If you can't tell which they mean and the plan has `notes` (text still in the
code), ask once, together with the languages if those are missing too.

## Tools

Use the `localship_*` MCP tools when available. Otherwise the CLI: `localship plan`,
`localship start`, `localship next-batch`, `localship submit`, from the project folder or with
`-C <folder>` (install once with `npm install -g localship` if it's missing).

## 1. Look

Call `localship_plan` with the languages from the request, as names or
codes (`["Hindi"]`, `["hi", "ar"]`). It writes nothing.

If no language was named, ask which ones now, once, before any work, so the rest runs without
stopping. Otherwise stop and ask only when:
- **`blockers`**: a format Localship can't translate, or an empty String Catalog. "No
  translation files" blocks keeping translations up to date, but not wanting the app in a
  language: moving the text creates them. Say what's in the way and what would get past it.
- **`warnings`**: another tool (Crowdin, an over-the-air SDK…) already manages translations.
  Writing files could clash with it; ask whether to go ahead.

Otherwise carry on, and tell the user in one line what you're about to do, e.g. "Moving about
300 pieces of text into string resources, then translating into Hindi." When only updating
translations, mention the plan's `notes` (text still in the code) in that line instead: those
strings won't be translated unless the user asks you to move them.

## 2. Do it

1. **Move the text** (when they want the app in a language and the plan has `notes` or no
   translation files): follow the `localship-extract` skill for the whole app, building as you go, with a
   short progress update after each part. Then run `localship_plan` again for the new counts.
2. **Set up:** if the languages aren't configured yet, `localship_start` with them. It writes
   only the config.
3. **Translate:** follow the `localship-translate` skill's loop (`localship_next_batch` →
   translate → `localship_submit`, fix rejections) until `remaining` is 0 for every language.
4. **Check:** `localship_validate` must show no errors.

## 3. Report

In a few lines:
- text moved into resources, and any naming convention you had to pick;
- strings translated per language, and anything that failed or was held for review;
- what translators went by: each language's voice (the project's, or the usual convention the
  batch gave as `defaultVoice`, e.g. "addressed the user as आप") and names kept as written, so
  the user can correct them;
- text still in the code that wasn't moved (when only updating translations);
- next step: review the drafts (the `localship-review` skill), then approve.

If the user asks for something different (another formality, a brief, a glossary term), write it
with `localship_update_context` or the files in `.localship/`, and redo what it affects.

## Only when the user asks

- moving hardcoded text into resources, unless they want the app in a language;
- creating a branch, committing or pushing;
- writing a brief, voice notes or glossary;
- translating through a model API (`localship_translate`): cloud providers bill per use;
- approving drafts, pruning, removing or `--force` (these change or delete people's work).

## Other requests

Again by meaning, however it's worded:
- **Progress:** `localship_status` (or `localship_detect` without a config).
- **Checking or approving translations:** the `localship-review` skill.
- **Setting up Localship itself** (config, brief, voice, glossary): the `localship-setup` skill.

Hand-edited translations are always held for review, never replaced.

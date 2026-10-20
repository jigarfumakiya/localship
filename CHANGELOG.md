# Changelog

## Unreleased

- Flutter ARB follows gen-l10n: `=0`/`=1`/`=2` are read as `zero`/`one`/`two` (one slot in
  Flutter), so Arabic is no longer asked for both; `zero`, `one` and `two` are optional in any
  language, as `intl` uses them for exactly 0, 1 and 2. `#` is text in Flutter, so a form using it
  instead of `{count}` is flagged. With `use-escaping: true` in `l10n.yaml`, apostrophes that would
  break the build or vanish ("c'est l'heure") are errors. ICU plurals and selects need `other`,
  and plural cases must be known keywords.
- Flutter ARB and JSON translation files. `format: arb` reads the template's descriptions and
  placeholder examples as translator context and turns a message that is one ICU plural into
  plural forms, so Arabic gets all six. `format: json` reads nested or flat files, string arrays
  and i18next plurals (`key_one`, `key_other`), or ICU messages with `placeholders: icu`.
  `detect` finds both, and code usage is read from Dart (`AppLocalizations.of(context)!.key`)
  and JavaScript (`t("key")`). New keys are written in the source's order.
- `localship review` (and the `localship_review` MCP tool) opens a review page on this computer:
  source and translation side by side, plural forms with sample counts, right-to-left languages
  shown right-to-left, with comments, glossary and code usage. Edits go through the same checks as
  `submit`; Approve, Mark reviewed and Reject use `approve` and `remove`. Localhost only, with a
  random token in the link.
- The pre-release config name `l10n.config.yaml` (with its `.l10n` folder) is no longer read;
  use `.localship/config.yaml`.

## 0.3.0

- Agents do what was asked and nothing more. `plan` is now a read-only look with no confirm
  phrase; agents stop only for blockers or another tool managing translations. Text still in
  the code is a note, not a blocker. No branches, commits,
  or brief, voice and glossary files unless asked; `start` writes only the config. The model API
  (`translate --model`) is used only when the user asks for it.
- Agents go by what the user means, however it's worded: wanting the app in a language moves
  text still in the code into string resources and then translates; keeping translations up to
  date translates only; a limit the user states wins. A missing language is asked once, before
  any work. Skills no longer run `git status`.
- iOS extraction: the skill covers XcodeGen/Tuist projects, filling catalogs after a
  command-line build (`xcrun xcstringstool sync`), a catalog per target, sentences built from
  English grammar, text that doubles as data, plural keys and a scripted leftover-English check.
  `detect` names the project generator and says how to fill an empty catalog. Catalog keys with
  no words (`" "`, `"·"`, `"%@%@"`) are skipped instead of sent for translation.
- Extraction: a seeded name translated for display is never saved back; records, defaults and
  exports keep the stored value.
- Batches carry `defaultVoice`, the usual formality for a language with no voice file, and keep
  the Android app name as written when the glossary doesn't mention it, without writing either
  to a file. European Portuguese no longer gets Brazilian conventions.

- Add model request deadlines and cancellation through the CLI and MCP, including response-body
  reads and retry waits. Bound complete prompts by UTF-8 size, including context and retry feedback.
- Coordinate submit/approve/remove/prune writes across processes and reload inside the project
  lock; use unique atomic-write temporary files. Reject delegated responses if their source changed.
- Cache plural-rule samples with bounded storage and isolated copies for format-specific changes.
  Add `npm run benchmark -- [strings-per-target]` for synthetic Android and Apple catalogs.
- Reuse the source-code usage index during delegated translation submissions, avoiding a
  repository rescan for every batch and retry. Do not select completed entries again when
  requested states include drafts, preventing repeated model calls for the same translation.
- Strict/release validation now fails on unsupported Apple variations/substitutions and Android
  configuration-specific string resources. Diagnostics include locations; status also warns that
  these strings are excluded from progress counts. Non-string Android resources do not trigger this.
- Detect Android targets with localized strings but no defaults. In strict/release checks,
  language-only keys without a matching default also fail; verify usage before pruning them.
- Update agent guidance for bidi-safe formatting, per-app Android languages, Xcode extraction,
  target/bundle selection, generated symbols and Xcode 27 agent workflows. Add a platform
  verification guide with official references and native build/device checks.
- Release check: `validate --require-approved` (MCP: `requireApproved`) requires complete,
  current, approved translations, with actionable errors for drafts, hand edits and changed sources.
  Runs locally without model calls; includes CI setup instructions.
- Review flags added in Xcode or gettext after approval now reopen the translation as a draft,
  even when the text is unchanged.
- Clarify that cloud coding agents may send translation content to their model providers.

- Consistency: a translation with a note is worded differently on purpose ("Delete account" for
  a sign-in account and for a budget), so `validate` and `submit` no longer flag it.
- Windows: atomic writes retry briefly when the target file is busy.

## 0.2.0

- New checks: numbers that went missing, a lost closing `?`, `!`, `:` or `…`, all-caps labels not
  in capitals, and links, emails or emoji that changed.
- Consistency: the same text translated different ways in a language is flagged by `validate`,
  across all targets, and `submit` warns the agent while it translates.
- Roles: each string's place in the UI (button, tab, title, toast…) is read from the code that
  uses it and sent with the batch, and a translation that clearly won't fit a button, tab, chip
  or menu item is flagged.
- Notes: the agent can add a short note to a translation of an ambiguous string ("Open" as a
  button), kept in the lockfile and shown at review.

## 0.1.0

The first release.

### Formats

- Android `strings.xml`: strings, string arrays and plurals, with Android escaping and markup.
- Apple String Catalogs (`.xcstrings`), with plural variations.
- gettext `.po` / `.pot`, with plural forms and fuzzy entries.
- Files are written back the way Android Studio, Xcode and gettext tools write them.

### Translation

- Strings go to the AI in batches with their context: the code that uses them, comments, a
  brief, voice notes per language, a glossary and earlier translations of the same text.
- Every translation is checked before it's written: placeholders, plural forms for each language
  (from Unicode CLDR), escaping, markup and the glossary. Failures go back to the AI with the reason.
- Translations are written as drafts. Approve them after review; hand edits and approved
  translations are never replaced unless you ask.
- A lockfile in `.localship/` tracks what was translated from which text, so updates only redo
  what changed.
- Translate with your coding agent's own model, or without an agent through Anthropic, OpenAI,
  Gemini, OpenRouter or Ollama.

### Setup and upkeep

- `plan` explains what it takes to translate an app before anything changes; `start` sets it up.
- `detect` finds translation files and other localization tools in a repo, and estimates how much
  text is still written in the code.
- `status`, `validate`, `approve`, `remove` and `prune` for progress, checks, review and cleanup.

### Agents

- An MCP server with 15 tools, for Claude Code, Cursor, VS Code, Codex, Gemini CLI and Claude Desktop.
- Agent skills to set up, make an app localizable, translate and review.
- A Claude Code plugin with the server and the skills.

# Localship reference

Everything the tool does, in detail. For getting started, see the [README](../README.md).

- [Commands](#commands)
- [MCP tools](#mcp-tools)
- [Release checks in CI](#release-checks-in-ci)
- [Translation workflow](#translation-workflow)
- [Context files](#context-files)
- [Configuration](#configuration)
- [Detection](#detection)
- [Status states](#status-states)
- [Formats](#formats)
- [Checks](#checks)

## Commands

| Command | What it does |
|---|---|
| `localship plan [languages…]` | What a request involves: the files, strings to translate, blockers and their fix, notes (text still in the code), and what translators go by (voice per language, names kept). Writes nothing and decides nothing. Languages can be names (`hindi`) or codes |
| `localship start <languages…>` | Writes the config (or adds the languages to it) and nothing else. With `--model` (or `models.default` in the config) it then translates |
| `localship detect` | Lists the translation files in the repo, with evidence and confidence. Writes nothing |
| `localship init` | Detects, asks, and writes `.localship/config.yaml` |
| `localship status` | Progress per target and locale, plus duplicate keys and translations of deleted strings |
| `localship add-locale fr,de` | Adds languages to `locales:` in the config, keeping its comments |
| `localship validate` | Runs every check. Exit code 1 if there are errors |
| `localship next-batch` | The next strings needing translation, with context, as JSON |
| `localship submit [file]` | Checks translations (JSON from a file or stdin) and writes the good ones as drafts. Exit code 1 if any are rejected |
| `localship translate` | Translates with a model API, through the same checks |
| `localship approve` | Marks drafts approved (or `--reviewed`) |
| `localship review` | Opens a review page on this computer to edit, approve or reject translations. `--locale`, `--states` (shown at first), `--port`, `--no-open` |
| `localship remove` | Makes translations untranslated again (`--keys`, `--states draft`), e.g. to reject bad drafts. A person's work needs `--force` |
| `localship prune` | Removes translations of strings that were deleted, renamed or marked not translatable, and their lockfile records |
| `localship mcp` | Runs the MCP server over stdio |

Options:

| Option | Applies to | Meaning |
|---|---|---|
| `--json` | most | Machine-readable output for agents and scripts |
| `-l, --locale hi,ar` | `status`, `validate`, `next-batch`, `translate`, `approve` | Only these locales |
| `-t, --target <ids>`, `-k, --keys <keys>` | `next-batch`, `translate`, `approve` | Only these targets or keys |
| `--states missing,stale` | `next-batch`, `translate` | Which entries to work on (default `missing,stale`) |
| `-n, --limit`, `--offset` | `next-batch` | Batch size (default 40) and paging |
| `-m, --model <provider:model>` | `submit`, `translate` | Model to record, or to translate with |
| `-n, --batch-size`, `-p, --parallel` | `translate` | Strings per call (30) and calls at once (4) |
| `--max-prompt-bytes <n>` | `translate` | Maximum UTF-8 bytes of system and user prompts (48,000), including context and retry feedback |
| `--timeout-ms <n>` | `translate` | Deadline per model request, including response-body reading (120,000 ms) |
| `--from draft,reviewed` | `approve` | Which entries to approve. Add `untracked` or `edited` to adopt or accept |
| `--force` | `submit`, `translate`, `init` | Replace hand edits and reviewed or approved translations; for `init`, replace the config |
| `--dry-run` | `submit`, `approve` | Check without writing |
| `--strict` | `validate` | Missing translations/locales, Android keys without defaults, and unsupported content count as errors |
| `--require-approved` | `validate` | Require current, approved translations in every selected locale; implies `--strict` |
| `-y, --yes`, `--accept 1,2` | `init` | Accept the detected setups, or only these |
| `--source en`, `-l, --locales hi,ar` | `init` | Source language and languages to translate into |
| `-c, --config <file>` | all | Config file (default: the nearest `.localship/config.yaml`) |
| `-C, --cwd <dir>` | all | Directory to run in |

## MCP tools

`localship_plan`, `localship_start`, `localship_status`, `localship_validate`, `localship_detect`, `localship_init`, `localship_add_locales`, `localship_get_context`,
`localship_update_context`, `localship_next_batch`, `localship_submit`, `localship_approve`, `localship_remove`, `localship_prune`,
`localship_translate`, `localship_review`.
The skills are also served as MCP prompts (`localship`, `localship-setup`, `localship-extract`, `localship-translate`, `localship-review`) for
clients that don't read skills. Every tool takes an optional `cwd`. Without one, the server works in the project Claude Code
names in `CLAUDE_PROJECT_DIR`, else the directory it was started in (or `-C <dir>`).

## Release checks in CI

`validate --strict` checks translation content and completeness. To also enforce the review
workflow before release, run:

```sh
localship validate --require-approved
localship validate --require-approved --locale hi,ar --json
```

The release check exits 1 for missing translations or locales, drafts, reviewed-but-not-approved
translations, untracked translations, source changes since approval, and hand edits since approval.
It also honors gettext `fuzzy` and Xcode `needs_review` / `new` flags, even if the text is unchanged.
An empty locale selection is an error. All normal content checks still run. Coverage warnings
(`variation-unsupported`, `resource-configuration-unsupported`) and Android keys without matching
defaults become errors; other warnings remain warnings.
This checks recorded approval and mechanical correctness, not linguistic quality or runtime layout.

Coverage diagnostics carry `blocksCompleteness: true` in JSON and point to the skipped content.
They apply to the configured target as a whole, even with a locale filter: these structures are
not modeled as independent locale entries. Unsupported content stays untouched. A native review
does not make it supported by Localship; the target continues to fail strict checks until the
content can be checked. Do not remove variants or mark them non-translatable to bypass the gate.

Commit `.localship/lock.json` with your translations: approval is tied to the source and translation
hashes in that file. Review existing translations before adopting them with `approve --from untracked`;
review hand edits before accepting them with `approve --from edited`. Do not auto-approve in CI.

The check only reads files and needs no model, network request or API key. For GitHub Actions,
install a Localship version supporting this flag as a dev dependency and commit the npm lockfile,
then add a workflow like this:

```yaml
name: Translation checks
on: [pull_request, push]
permissions:
  contents: read
jobs:
  translations:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npx --no-install localship validate --require-approved
```

Through MCP, call `localship_validate` with `{"requireApproved": true}` and optionally `locales`.
The result has `ok: false` and actionable issues when the release check fails. Omitting this option
keeps normal validation suitable for checking drafts during translation.

## Translation workflow

Every translation, from any source, goes through the same loop:

```
next-batch → translate → submit (checked; good ones written as drafts) → review → approve
```

**With your coding agent.** The `localship-translate` skill (or the `localship_next_batch` and
`localship_submit` MCP tools) has the agent's own model do the translating. Each batch item comes
with what a translator needs:

```json
{
  "target": "android", "locale": "ar", "key": "trash_deleted", "state": "missing",
  "kind": "plural",
  "source": { "one": "Moved %d note to the trash", "other": "Moved %d notes to the trash" },
  "pluralForms": [{ "form": "zero", "examples": "0" }, { "form": "one", "examples": "1" },
                  { "form": "two", "examples": "2" }, { "form": "few", "examples": "3, 4, 5, 6, 7…" },
                  { "form": "many", "examples": "11, 12, 13, 14, 15…" }, { "form": "other", "examples": "100, 101, 102, 200, 201…" }],
  "placeholders": ["%d"],
  "glossary": [{ "term": "trash", "use": "سلة المهملات" }],
  "memory": [{ "value": "…", "from": "ios:Trash" }]
}
```

Items also carry `usage`: up to three places in the code that show the string, with the file and
line and the code around it, so the model can tell a button from a title. It's found from
`R.string.*` and `@string/*` (Android), Swift string literals matched to catalog keys,
interpolations included (String Catalogs), and `#:` references (gettext). From that code an
item may also carry `role` (button, tab, chip, menu item, title, toast, notification,
placeholder, accessibility label), so the model keeps buttons and tabs short. A stale item also
carries `previousSource`, the text the old translation was made from, so only the change is
retranslated.

`submit` runs the same checks as `validate`. Translations with errors come back with the
reasons and are not written. The agent fixes those and resubmits. Accepted ones become drafts,
recorded in `.localship/lock.json` with the model that made them. An entry may add a short
`note` saying how the agent read an ambiguous source ("Open" as a button); it's kept with the
translation and shown when the drafts are reviewed. Android apostrophes, quotes and `&`
are escaped for you. A finished example, translated into Hindi and Arabic this way, is in
[examples/android-notes](../examples/android-notes).

**With a model API** (large catalogs, CI, or no agent):

```sh
export ANTHROPIC_API_KEY=…
localship translate --model anthropic:claude-sonnet-5-5
```

| Provider | Model spec | Key |
|---|---|---|
| Anthropic | `anthropic:<model>` | `ANTHROPIC_API_KEY` |
| OpenAI | `openai:<model>` | `OPENAI_API_KEY` |
| Google Gemini | `gemini:<model>` | `GEMINI_API_KEY` |
| OpenRouter | `openrouter:<vendor/model>` | `OPENROUTER_API_KEY` |
| Ollama, LM Studio (local) | `ollama:<model>`, `lmstudio:<model>` | none |
| Anything OpenAI-compatible | `<name>:<model>`, with the name under `providers:` in the config | your choice |

Batches run in parallel (`-p`, default 4) and writes happen one at a time. A rejected string goes
back to the model once with its errors; strings that still fail are listed at the end.
Set models per locale in the config to route hard languages to a stronger model.

Batches also respect a UTF-8 prompt-size budget. This is a text-size bound, not an exact token
count or a guarantee about a model's context/output limits. If one entry plus its context exceeds
the budget, Localship stops with that key and sends no oversized request; shorten the context or
increase `--max-prompt-bytes`. Retry feedback counts toward the same budget.

Requests have a two-minute deadline, configurable with `--timeout-ms`. Timeouts stop the run
without automatic retries; HTTP 429 and server errors still receive bounded retries. Ctrl+C or
SIGTERM cancels model requests and retry waits. Already saved drafts remain, and an active file
write finishes before shutdown. MCP `localship_translate` accepts `batchSize`, `concurrency`,
`maxPromptBytes`, and `timeoutMs`, and forwards client cancellation. Delegated submissions reject
responses based on source text that changed while the model was working.

`submit`, `approve`, `remove`, `prune`, and delegated submissions use a cooperative project lock
at `.localship/write.lock`, then reload the project before checking and writing. A competing
Localship writer receives a retryable-by-the-user error rather than overwriting stale data.
The lock covers resource files and translation-state updates; model calls do not hold it.
Dry runs do not acquire it. Locks are released on ordinary errors. After a crash, inspect the
lock's PID/host metadata and verify that no writer is running before removing the file.
This coordinates these commands within the same project root on a local filesystem. It does
not lock external editors, setup/context edits, or different projects sharing resource files,
and it does not make a multi-file update a crash-atomic transaction. Review the diff and rerun
validation after an interrupted disk write. Temporary output filenames are unique per write.

**Review and approve.** Drafts already ship in Android and gettext files (String Catalogs mark
them `needs_review`). Review them with the `localship-review` skill, on the page `localship review` opens, or by hand, then
`localship approve --locale hi`. On the review page, edits go through the same checks as
`submit` and are saved as drafts; Reject only clears drafts and stale translations. To adopt translations made before Localship, run
`localship approve --from untracked`. To accept edits made by hand, use `--from edited`.

## Context files

Translations are only as good as the context. These live next to your config in `.localship/`, in git:

| File | What it holds |
|---|---|
| `brief.md` | What the app does, who it's for, the tone of its copy |
| `voice/all.md`, `voice/<locale>.md` | Voice rules for every locale, and per locale (formality, loanwords, numbers) |
| `glossary.yaml` | Names to keep as written, and terms with fixed translations |

Localship writes these only when you ask (the setup skill, `localship_update_context`, or by
hand). Until then, batches carry two fallbacks so translations stay consistent: `defaultVoice`,
the usual formality for each language that has no voice file, and the Android `app_name` kept as
written when the glossary doesn't mention it. Neither is written to a file; agents name them in
their report so you can change them.

```yaml
# .localship/glossary.yaml
terms:
  - term: Jotter
    translate: false          # brand: keep as written in every language
  - term: trash
    note: Where deleted notes go before they are removed for good
    translations: { hi: ट्रैश, ar: سلة المهملات }
```

The `localship-setup` skill drafts these from your README and strings. Glossary terms are matched as
whole words in the source. In translations, fixed terms are matched inside words too, since
Arabic and Hindi attach particles.

## Configuration

Everything Localship keeps in your repo is in one hidden folder at its root:

```
.localship/
  config.yaml     languages and translation files (below)
  brief.md        what the app is, who it's for, its tone
  voice/          <locale>.md: formality and style per language
  glossary.yaml   names to keep, and fixed translations of terms
  lock.json       what was translated from which source text, and its review state
```

Commit all of it: the lockfile is how teammates and CI know what's new, changed or edited by
hand. Paths in the config are relative to the repo root. A `localship.yaml` at the root (the
older location) is still read.

| Key | Default | Meaning |
|---|---|---|
| `sourceLocale` | `en` | Language the source strings are written in |
| `locales` | locales found on disk | Languages to work on (BCP 47: `hi`, `pt-BR`, `zh-Hans`) |
| `targets` | required | List of translation file sets, see below |
| `lock` | `.localship/lock.json` | Where translation state is recorded |
| `context` | `.localship` | Folder with `brief.md`, `voice/` and `glossary.yaml` |
| `models` | none | Models for `localship translate`: `default`, and per locale or language, e.g. `ar: anthropic:claude-opus-5-5` |
| `providers` | none | Extra OpenAI-compatible providers: `name: { baseUrl, apiKeyEnv }` |

Every target has a `format` and a `path`, plus an optional `id` (needed when two targets share a format).

| Format | `path` | Extra options |
|---|---|---|
| `android-xml` | The `res` directory | none |
| `po` | Pattern with `{locale}`, e.g. `po/{locale}.po` | `template` (a `.pot`), `placeholders` (syntax for entries with no format flag), `pluralForms` (per-locale `Plural-Forms` when a file has none) |
| `xcstrings` | The `.xcstrings` file | none |
| `arb` | Pattern with `{locale}`, e.g. `lib/l10n/app_{locale}.arb` | none |
| `json` | Pattern with `{locale}`, e.g. `locales/{locale}.json` | `placeholders`: `i18next` (default) or `icu`, or any `po` syntax |

## Detection

- **What it finds:** Android `res` folders with strings, groups of `.po` files sharing a path
  pattern (with their `.pot` template), `.xcstrings` catalogs, Flutter `.arb` files (the source
  language from `l10n.yaml`'s `template-arb-file`), and JSON files in a translations folder
  (`locales/`, `i18n/`, `messages/`…), telling i18next from ICU by their placeholders.
- **Real counts:** each candidate is loaded with the same reader `status` uses, so its string
  count and languages are real.
- **Confidence:** each candidate is `high`, `medium` (for example a build-variant folder, or a
  single `.po` file with no template) or `low`. Doubts are listed as questions.
- **Starting points:** a gettext `.pot` template with no translations yet is offered with the
  path new `.po` files will get, following the ecosystem's layout (Django `locale/{locale}/LC_MESSAGES/`,
  WordPress `languages/<domain>-{locale}.po`, otherwise `po/{locale}.po`). An empty String Catalog
  is offered with a reminder to build in Xcode first.
- **Unsupported formats:** files it recognizes but can't read yet (`.strings`, YAML,
  `.resx`, `.properties`, XLIFF) are listed, so nothing is ignored silently.
- **Hints:** an Xcode project without a String Catalog gets told how to add one.
- **In agents and CI:** without a terminal, `init` writes only with `--yes` or `--accept`. An
  agent can run `localship detect --json`, show the user the options, then run
  `localship init --accept 1 --locales hi,ar`.

## Status states

| State | Meaning |
|---|---|
| `missing` | No translation yet |
| `untracked` | A translation exists that Localship didn't record (written before you adopted it) |
| `stale` | The source text changed after the translation was made. If a person had also edited the translation, it is marked `editedByHand` in batches and is never replaced or removed without `--force`; `translate` holds it for review |
| `edited` | The translation was changed outside Localship; it is kept and never overwritten |
| `draft` | Not reviewed yet, including gettext `fuzzy` and Xcode `needs_review` |
| `reviewed`, `approved` | Checked by an AI reviewer or a person |

States come from the files plus `.localship/lock.json`, which records a hash of each source and
translation.

## Formats

| Format | Status |
|---|---|
| Android `res/values*/strings.xml` | ✅ Supported |
| gettext `.po` / `.pot` | ✅ Supported |
| Apple String Catalog `.xcstrings` | ✅ Strings and simple plurals (advanced variants/substitutions block strict checks) |
| Flutter ARB `.arb` | ✅ Strings, ICU plurals; `select` and other ICU messages are translated whole |
| JSON (flat, nested, i18next, ICU) | ✅ Strings, arrays, i18next and ICU plurals |
| Apple `.strings` / `.stringsdict` | Planned |

### Android

- Strings, `plurals` and `string-array`. Skips `translatable="false"` strings and aliases (`@string/other`).
- Keeps `formatted`, `product` and `<xliff:g>` spans.
- Checks Android escaping: `\'`, `\"`, a leading `\@` or `\?`, and unknown escapes.
- Locale folders follow Android naming, including `values-b+sr+Latn` and the legacy `values-iw` and `values-in`.

### gettext PO

- **Strings:** reads `msgctxt` and plurals. Extracted comments (`#.`) and code references (`#:`) are kept as context for translators.
- **Placeholders** follow each entry's format flag: `c-format`, `python-format` (`%(name)s`),
  `python-brace-format` (`{name}`), `php-format`, `java-format`, `qt-format`, `ruby-format`.
  Flags are read from the source entry, so a translation file that lost its flags is still checked.
- **Plurals** use the file's `Plural-Forms` header. A small built-in parser evaluates the
  formula, so nothing in the file is ever executed. Each form is described by the counts that
  select it (Russian form 1 = 2, 3, 4, 22, 23…). The header itself is checked against the
  language's standard rule.
- **Writing:** untouched entries are written back byte for byte. Changed entries are wrapped
  exactly as `msgcat` does, measured in display columns so Devanagari and CJK wrap correctly.
  Files that use `--no-wrap` stay unwrapped. New locale files are created from the template with
  the right `Language` and `Plural-Forms`.

### Apple String Catalog

- Strings and plural variations, including Apple's optional `zero` form in any language. A
  translation may vary by plural even when the source doesn't, as Xcode allows.
- **States:** `needs_review` and `new` count as drafts. `shouldTranslate: false` and stale entries are skipped.
- **Placeholders:** `%@`, `%lld`, `%1$@`, `%#@name@`. `%d` and `%lld` count as the same kind of argument.
- **Coverage:** device variations, substitutions, nested variations and unknown variation axes
  are preserved and reported per key with file/line locations. The entire affected key is excluded
  from batches and counts. Normal validation and status warn; strict and release checks fail.
  Intentionally non-translatable and stale extraction entries do not block completeness.
- **Writing:** untouched parts are written back byte for byte. Changed parts use the file's own
  style. For Xcode files that means 2-space indent, `" : "`, sorted keys, blank-line empty
  objects and no final newline, so Xcode reopens the file without a diff.

### Flutter ARB

- **Files:** `path: lib/l10n/app_{locale}.arb`. The source language's file is the template.
  New files are named the Flutter way (`app_pt_BR.arb`) and start with `@@locale`.
- **Context:** the template's `@key` description and placeholder types and examples become the
  comment translators see. Translation files get only the messages, not the metadata.
- **ICU, as gen-l10n reads it:** a message that is exactly one `{count, plural, …}` becomes
  plural forms, so every form the language needs is asked for and checked. Flutter fills one
  slot for `=0` and `zero` (and `=1`/`one`, `=2`/`two`), and `intl` uses them for exactly 0, 1
  and 2 in any language. So Localship reads `=N` as the keyword, offers `zero`, `one` and `two`
  as optional where CLDR doesn't need them, and writes the keyword. Messages with text around a
  plural, `select` or nested plurals are translated whole, with their arguments checked.
- **Checks:** braces must balance, plural cases must be `=0`–`=2` or a CLDR keyword, and plurals
  and selects need `other` (`icu-malformed`). `#` is plain text in Flutter, so a form that uses it
  instead of `{count}` is flagged. With `use-escaping: true` in `l10n.yaml`, apostrophes quote
  text: a lone `'`, or quoted text with no braces in it ("c'est l'heure" would show as
  "cest lheure"), is an error, and `''` is an apostrophe.

### JSON

- **Files:** `path: locales/{locale}.json` or `public/locales/{locale}/common.json` (one target
  per namespace). Locales in paths may be `pt-BR` or `pt_BR`; new files follow the existing ones.
- **Keys:** nested objects become dotted keys (`nav.home`); flat files with dotted keys work too.
  Arrays of strings are arrays; numbers, booleans and `null` are left alone.
- **`placeholders: i18next`** (default): `{{name}}`, and plurals as sibling keys `items_one`,
  `items_other`, with `_zero` optional in any language. Ordinal plurals (`_ordinal_one`) are
  plain strings.
- **`placeholders: icu`** (format.js, next-intl, vue-i18n with ICU): `{name}`, and plurals as
  `{count, plural, …}` like ARB, where `#` and `{count}` are the same argument.
- **Writing:** new keys go where the source has them and plural forms stay together in CLDR
  order. Removing the last key of an object removes the object. Untouched parts keep their text;
  changed objects use the file's indent.

## Checks

Errors identify mechanical failures or unmet validation policy. Warnings identify potential quality
problems, source mismatches and coverage limits. `submit` refuses translation-content errors and
asks for every required plural form. Project coverage and approval policies are checked by `validate`.

| Code | Severity | What |
|---|---|---|
| `placeholder-missing`, `placeholder-extra`, `placeholder-type` | error | Placeholders must match the source. In a plural form used for a single number (Arabic `two`), writing the number out instead is fine (`placeholder-implied`, info) |
| `plural-count-missing` | error | A plural form used for more than one count must show the number, even when the source's form of the same name doesn't. English `one` only means 1, but Hindi and French `one` also cover 0, so "last month" copied from English would show for zero months |
| `plural-missing-category` | error / warning | Every plural form the locale needs. Error for gettext and for a missing `other`. Warning when the app would fall back to `other`, or the form is only used for fractions |
| `plural-extra-category` | warning / error | A form the locale never uses (error for gettext, which rejects it) |
| `escape-apostrophe`, `escape-quote`, `escape-leading-reference`, `escape-invalid` | error | Android escaping |
| `xliff-mismatch` | error | `<xliff:g>` protected spans kept |
| `array-length`, `kind-mismatch`, `empty` | error | The translation has the same shape as the source |
| `xml-malformed`, `po-malformed`, `json-malformed`, `duplicate-key`, `name-missing` | error | File problems, with line numbers |
| `plural-forms-invalid`, `plural-forms-missing` | error | Broken or missing gettext `Plural-Forms` header |
| `target-missing` | error | A configured path doesn't exist |
| `default-resources-missing` | error | Android has qualified string resources but no default strings in the configured target's `values` folder |
| `variation-unsupported`, `resource-configuration-unsupported` | warning / error | Content is preserved but cannot be checked; errors with `--strict` or `--require-approved` |
| `not-approved` | error with `--require-approved` | Translation is a draft, reviewed, untracked, stale or edited; review against the current source and approve |
| `locales-empty` | error with `--require-approved` | No target locales selected, configured or discovered |
| `placeholder-not-positional` | warning | A source with several unnumbered placeholders should number them so translators can reorder |
| `markup-mismatch`, `whitespace`, `untranslated`, `escape-unknown` | warning | Markup or edge whitespace changed, or text left in the source language (names the glossary keeps don't count) |
| `glossary-keep`, `glossary-term` | warning | A kept name was changed, or a fixed term wasn't used |
| `number-mismatch` | warning | A number in the source is missing from the translation. Digits in any script count ("१,३८५" is 1385); Arabic and Hebrew may write 1 and 2 as words |
| `punctuation-end` | warning | The source ends with `?`, `!`, `:` or `…` and the translation doesn't, in any script's form (`؟`, `？`) |
| `case-mismatch` | warning | An all-caps label isn't in capitals, in a script that has case. Names kept from the source don't count |
| `token-missing` | warning | A link, email address or emoji from the source is missing or changed |
| `inconsistent` | warning | The same source text is translated more than one way in a language, across all targets. Fine when the context differs; gettext contexts count as different, and a translation with a note is left out |
| `too-long` | warning | A button, tab, chip, menu item or app name translated more than twice as wide as the source (at least 6 characters more). The role comes from the code that uses the string; Chinese, Japanese and Korean characters count double |
| `orphan` | warning / error | Translation has no matching source. For Android this may be a missing default, so strict/release checks fail. Restore the default or verify the key is unused before pruning |
| `not-translatable` | warning | Translation differs from a source marked not translatable |
| `plural-forms-unexpected`, `plural-forms-unknown`, `language-mismatch`, `source-language-mismatch` | warning | Header or config disagrees with the language or file |
| `missing`, `locale-missing` | info / error | Untranslated strings and missing locales (errors with `--strict` or `--require-approved`) |

Localship checks configured resource directories, not Android's merged resource graph. Confirm
defaults supplied by dependencies/flavors with native build and lint checks. Other Android
configuration folders are inspected for string resources, then reported as unsupported; unrelated
colors and dimensions do not create coverage warnings. See the
[platform verification guide](../skills/localship-extract/references/platform-localization.md) for
Android and Apple setup, runtime testing and official references.

Checks are tested on real data: AndroidX and RevenueCat resources (207 locale folders), Django
admin's PO files in 11 languages, and 9 real String Catalogs. On that data they found genuine
upstream bugs, including a Python placeholder in Django's Irish translation that `msgfmt --check` misses.

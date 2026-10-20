# Example: Flutter app

A small task-list app, translated into Arabic, French, Hindi and Japanese by a coding agent
using Localship. The agent was given only the request "Translate this app into Arabic, French,
Hindi and Japanese", the `localship` CLI and the skills. A follow-up, "I reworded the empty-state
message and added a 'Clear finished' button string", updated just those two strings.

- `lib/l10n/app_en.arb`: the English template. It has a placeholder, a plural with `=0` and
  `=1`, a `select`, a date, descriptions for translators, and an apostrophe written `''`
  because `l10n.yaml` turns on `use-escaping`.
- `lib/l10n/app_ar.arb`, `app_fr.arb`, `app_hi.arb`, `app_ja.arb`: what `localship submit`
  wrote. Arabic has all six plural forms; French apostrophes are escaped.
- `.localship/`: the config and the lockfile, with every translation recorded as a draft and
  the agent's notes on wording choices.
- `test/`: Flutter tests that hold for any correct translation. Every language loads, counts
  show the number, no ICU syntax or `#` leaks into the UI, Arabic lays out right to left, and
  adding, finishing and clearing tasks works.

Run it from this folder (Flutter 3.32 or newer):

```sh
flutter test                         # generates the localizations, then tests every language
flutter create . && flutter run      # adds platform folders once, then runs the app
localship status                     # 11 drafts per language
localship review --locale ar         # read and approve them in your browser
```

From the repository root, `scripts/flutter-e2e.sh` runs Localship's strict check,
`flutter gen-l10n` (failing on any warning or untranslated message), `flutter analyze` and the
tests. CI runs it on every push.

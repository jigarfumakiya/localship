import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:localship_flutter_example/l10n/app_localizations.dart';

/// Checks that hold for any correct translation, so they test whatever an agent wrote:
/// every language loads, plural forms show the number, and no ICU syntax leaks into the UI.
void main() {
  final locales = AppLocalizations.supportedLocales;

  Future<AppLocalizations> load(Locale l) => AppLocalizations.delegate.load(l);

  // The app's localization delegates load date formats; outside the app, load them here.
  setUpAll(initializeDateFormatting);

  List<String> everything(AppLocalizations t) => [
        t.appTitle,
        t.greeting('Asha'),
        t.newTaskHint,
        t.addTask,
        t.deleteTask,
        t.clearFinished,
        t.emptyState,
        for (final n in [0, 1, 2, 3, 5, 11, 21, 100, 1000]) t.tasksLeft(n),
        for (final g in ['female', 'male', 'other']) t.finishedBy(g),
        t.lastSynced(DateTime(2026, 10, 20)),
        t.syncReminder,
      ];

  test('there are translations besides English', () {
    expect(locales.length, greaterThan(1));
  });

  for (final locale in locales) {
    group('$locale', () {
      test('every message is filled in, with no ICU syntax left over', () async {
        for (final text in everything(await load(locale))) {
          expect(text.trim(), isNotEmpty);
          expect(text, isNot(contains('{')), reason: text);
          expect(text, isNot(contains('}')), reason: text);
          expect(text, isNot(contains('#')), reason: '# is literal in Flutter: $text');
          expect(text, isNot(contains("''")), reason: 'escaped apostrophe shown: $text');
        }
      });

      test('the name and the date reach the text', () async {
        final t = await load(locale);
        expect(t.greeting('Asha'), contains('Asha'));
        expect(t.lastSynced(DateTime(2026, 10, 20)), contains('2026'));
      });

      test('counts that need a number show it', () async {
        final t = await load(locale);
        // From 3 up, every language's form covers more than one count, so it must show which.
        for (final n in [3, 5, 11, 21, 100, 1000]) {
          expect(t.tasksLeft(n), contains('$n'), reason: t.tasksLeft(n));
        }
      });

      if (locale.languageCode != 'en') {
        test('is translated, not a copy of English', () async {
          final t = await load(locale);
          final en = await load(const Locale('en'));
          expect(t.newTaskHint, isNot(en.newTaskHint));
          expect(t.emptyState, isNot(en.emptyState));
          expect(t.syncReminder, isNot(en.syncReminder));
          expect(t.clearFinished, isNot(en.clearFinished));
        });
      }
    });
  }
}

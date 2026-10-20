import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:localship_flutter_example/l10n/app_localizations.dart';
import 'package:localship_flutter_example/main.dart';

void main() {
  testWidgets('adding, finishing and clearing tasks (English)', (tester) async {
    await tester.pumpWidget(const TasksApp(locale: Locale('en')));
    await tester.pumpAndSettle();
    expect(find.text('All done'), findsOneWidget);
    expect(find.text("You're all caught up. Enjoy your day!"), findsOneWidget);

    for (final task in ['Buy milk', 'Call Ravi']) {
      await tester.enterText(find.byKey(const Key('new-task')), task);
      await tester.tap(find.text('Add'));
      await tester.pumpAndSettle();
    }
    expect(find.text('2 tasks left'), findsOneWidget);

    await tester.tap(find.byType(Checkbox).first);
    await tester.pumpAndSettle();
    expect(find.text('1 task left'), findsOneWidget);

    await tester.tap(find.text('Clear finished'));
    await tester.pumpAndSettle();
    expect(find.text('Buy milk'), findsNothing);
    expect(find.text('Call Ravi'), findsOneWidget);
  });

  for (final locale in AppLocalizations.supportedLocales) {
    testWidgets('runs in $locale, in its reading direction', (tester) async {
      await tester.pumpWidget(TasksApp(locale: locale));
      await tester.pumpAndSettle();
      final t = await AppLocalizations.delegate.load(locale);
      expect(find.text(t.appTitle), findsWidgets);
      expect(find.text(t.tasksLeft(0)), findsOneWidget);
      final rtl = const {'ar', 'fa', 'he', 'ur'}.contains(locale.languageCode);
      expect(
        Directionality.of(tester.element(find.byType(Scaffold))),
        rtl ? TextDirection.rtl : TextDirection.ltr,
      );
      expect(tester.takeException(), isNull);
    });
  }
}

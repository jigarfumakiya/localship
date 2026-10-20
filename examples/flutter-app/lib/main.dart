import 'package:flutter/material.dart';

import 'l10n/app_localizations.dart';

void main() => runApp(const TasksApp());

class TasksApp extends StatelessWidget {
  const TasksApp({super.key, this.locale});

  /// Forces a language (tests); otherwise the device's language is used.
  final Locale? locale;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      locale: locale,
      onGenerateTitle: (context) => AppLocalizations.of(context)!.appTitle,
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      theme: ThemeData(colorSchemeSeed: Colors.teal),
      home: const TasksPage(name: 'Asha'),
    );
  }
}

class TasksPage extends StatefulWidget {
  const TasksPage({super.key, required this.name});

  final String name;

  @override
  State<TasksPage> createState() => _TasksPageState();
}

class Task {
  Task(this.title);

  final String title;
  bool done = false;
}

class _TasksPageState extends State<TasksPage> {
  final _tasks = <Task>[];
  final _field = TextEditingController();

  void _add() {
    final text = _field.text.trim();
    if (text.isEmpty) return;
    setState(() => _tasks.add(Task(text)));
    _field.clear();
  }

  @override
  void dispose() {
    _field.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return Scaffold(
      appBar: AppBar(title: Text(l10n.appTitle)),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(l10n.greeting(widget.name), style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 8),
            MaterialBanner(
              content: Text(l10n.syncReminder),
              actions: [Text(l10n.lastSynced(DateTime(2026, 10, 20)))],
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    key: const Key('new-task'),
                    controller: _field,
                    decoration: InputDecoration(hintText: l10n.newTaskHint),
                    onSubmitted: (_) => _add(),
                  ),
                ),
                const SizedBox(width: 8),
                FilledButton(onPressed: _add, child: Text(l10n.addTask)),
              ],
            ),
            const SizedBox(height: 16),
            Row(
              children: [
                Expanded(
                  child: Text(
                    l10n.tasksLeft(_tasks.where((t) => !t.done).length),
                    key: const Key('tasks-left'),
                  ),
                ),
                TextButton(
                  onPressed: _tasks.any((t) => t.done)
                      ? () => setState(() => _tasks.removeWhere((t) => t.done))
                      : null,
                  child: Text(l10n.clearFinished),
                ),
              ],
            ),
            Expanded(
              child: _tasks.isEmpty
                  ? Center(child: Text(l10n.emptyState))
                  : ListView(
                      children: [
                        for (final (i, task) in _tasks.indexed)
                          CheckboxListTile(
                            key: Key('task-$i'),
                            controlAffinity: ListTileControlAffinity.leading,
                            value: task.done,
                            onChanged: (done) => setState(() => task.done = done ?? false),
                            title: Text(task.title),
                            secondary: IconButton(
                              icon: const Icon(Icons.delete_outline),
                              tooltip: l10n.deleteTask,
                              onPressed: () => setState(() => _tasks.removeAt(i)),
                            ),
                          ),
                      ],
                    ),
            ),
            Text(l10n.finishedBy('female'), style: Theme.of(context).textTheme.bodySmall),
          ],
        ),
      ),
    );
  }
}

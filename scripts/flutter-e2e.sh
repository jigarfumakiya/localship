#!/usr/bin/env bash
# Checks the Flutter example with the real Flutter toolchain: Localship's own checks, then
# gen-l10n (which must accept every .arb file without a warning), analysis and the app's tests.
# Run from anywhere after `npm run build`; needs `flutter` on PATH.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
app="$root/examples/flutter-app"

node "$root/dist/cli.js" -C "$app" validate --strict

cd "$app"
flutter pub get >/dev/null
# gen-l10n exits 0 even when it overrides a plural case or finds untranslated messages, and
# says so in its output, so any output beyond its l10n.yaml notice is a failure.
out="$(flutter gen-l10n 2>&1)"
if grep -v -e '^[[:space:]]*$' -e 'l10n.yaml exists' -e 'command line arguments' <<<"$out" | grep -q .; then
  echo "$out"
  echo "flutter gen-l10n reported problems with the .arb files" >&2
  exit 1
fi
flutter analyze
flutter test

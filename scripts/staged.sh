#!/bin/bash
# Runs the built app for a scripted check (the --snapshot mode in the README) — as an app of
# another name.
#
#   scripts/staged.sh examples/tour.ipynb --size 1100x800 --snapshot /tmp/sumi.png
#
# macOS remembers every application bundle it sees launched, and prefers the one launched
# last. Run build/Sumi.app itself and "Sumi" — in Spotlight, for `open -a`, for a
# double-clicked notebook — becomes this folder's copy, which the next build deletes, instead
# of the one in /Applications. So checks run a twin, build/SumiStage.app: the same executable
# and the same web UI under another identifier and another name, claiming no documents. The
# system may remember that one as much as it likes.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/build/Sumi.app"
STAGE="$ROOT/build/SumiStage.app"

[ -x "$APP/Contents/MacOS/Sumi" ] || { echo "error: build the app first (scripts/build-app.sh)" >&2; exit 1; }

if [ ! -x "$STAGE/Contents/MacOS/Sumi" ] || [ "$APP" -nt "$STAGE/Contents/Info.plist" ]; then
  rm -rf "$STAGE"
  ditto "$APP" "$STAGE"
  PLIST="$STAGE/Contents/Info.plist"
  /usr/libexec/PlistBuddy \
    -c 'Set :CFBundleIdentifier app.sumi.notebook.stage' \
    -c 'Set :CFBundleName SumiStage' \
    -c 'Set :CFBundleDisplayName SumiStage' \
    -c 'Delete :CFBundleDocumentTypes' \
    -c 'Delete :UTImportedTypeDeclarations' "$PLIST"
  codesign --force --sign - --timestamp=none "$STAGE" >/dev/null 2>&1
fi

exec "$STAGE/Contents/MacOS/Sumi" "$@"

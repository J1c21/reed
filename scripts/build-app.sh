#!/bin/bash
# Builds Sumi.app into ./build.
#
#   scripts/build-app.sh            release build
#   scripts/build-app.sh --debug    debug build of the Swift side (faster to compile)
#   scripts/build-app.sh --skip-web reuse web/dist from a previous run
#
# To try the result without installing it, run it through scripts/staged.sh — not by opening
# build/Sumi.app, which would make macOS take this folder's copy for "Sumi" from then on.

set -euo pipefail
cd "$(dirname "$0")/.."

CONFIG=release
SKIP_WEB=0
for arg in "$@"; do
  case "$arg" in
    --debug) CONFIG=debug ;;
    --skip-web) SKIP_WEB=1 ;;
  esac
done

APP=build/Sumi.app

if [ "$SKIP_WEB" -eq 0 ] || [ ! -d web/dist ]; then
  echo "▸ Building the web UI"
  [ -d web/node_modules ] || npm --prefix web install --no-fund --no-audit
  npm --prefix web run build --silent
  # KaTeX ships each font in three formats; WebKit only ever asks for woff2.
  find web/dist/assets -name 'KaTeX_*.woff' -delete -o -name 'KaTeX_*.ttf' -delete
fi

echo "▸ Building the app ($CONFIG)"
swift build -c "$CONFIG" --product Sumi 2>&1 | grep -E "error|warning: unre|Compiling|Build complete" | grep -v "warning:" || true
BIN="$(swift build -c "$CONFIG" --show-bin-path)/Sumi"
[ -x "$BIN" ] || { echo "error: build failed"; exit 1; }

echo "▸ Assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Sumi"
cp scripts/Info.plist "$APP/Contents/Info.plist"
cp -R web/dist "$APP/Contents/Resources/web"

if [ ! -f build/AppIcon.icns ] || [ scripts/make-icon.swift -nt build/AppIcon.icns ]; then
  echo "▸ Drawing the icon"
  swift scripts/make-icon.swift build/AppIcon.iconset >/dev/null
  iconutil -c icns build/AppIcon.iconset -o build/AppIcon.icns
fi
cp build/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"

# Ad-hoc signature: enough to run locally, and keeps macOS from treating the app as damaged.
codesign --force --sign - --timestamp=none "$APP" >/dev/null 2>&1
touch "$APP"

# This copy is for installing (and for scripts/staged.sh to make its twin from), not for
# launching: the system must go on taking "Sumi" to mean the one in /Applications. Spotlight is
# kept out of the folder, and Launch Services is told to forget this bundle if it knows it.
touch build/.metadata_never_index
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u "$PWD/$APP" >/dev/null 2>&1 || true

SIZE=$(du -sh "$APP" | cut -f1)
echo "✓ $APP ($SIZE)"

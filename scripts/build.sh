#!/usr/bin/env bash
# Builds the shipping artifact: one folder the teacher can copy anywhere.
# Both architectures are built because a classroom Mac may be Intel or Apple
# Silicon and we do not want to ask which.
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf dist
mkdir -p dist

echo "building apple silicon..."
bun build src/server/main.ts --compile --target=bun-darwin-arm64 --outfile dist/polypong-arm64

echo "building intel..."
bun build src/server/main.ts --compile --target=bun-darwin-x64 --outfile dist/polypong-x64

cp scripts/PolyPong.command dist/PolyPong.command
chmod +x dist/PolyPong.command dist/polypong-arm64 dist/polypong-x64

# Ad-hoc signature. Does NOT get past Gatekeeper on its own -- the teacher still
# right-click-Opens once (see README) -- but it stops macOS killing the binary
# outright on Apple Silicon, which it does to unsigned arm64 executables.
codesign --force --sign - dist/polypong-arm64 2>/dev/null || echo "  ! codesign skipped"

# Assemble the double-clickable .app as well. The bundle is self-contained:
# both binaries live inside it, so it does not depend on this repo staying put.
APP="dist/Polypong.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp scripts/app-launcher.sh "$APP/Contents/MacOS/Polypong"
chmod +x "$APP/Contents/MacOS/Polypong"
cp dist/polypong-arm64 dist/polypong-x64 "$APP/Contents/Resources/"
[ -f scripts/polypong.icns ] && cp scripts/polypong.icns "$APP/Contents/Resources/"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Polypong</string>
  <key>CFBundleDisplayName</key><string>Polypong</string>
  <key>CFBundleIdentifier</key><string>com.vinjones.polypong</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleExecutable</key><string>Polypong</string>
  <key>CFBundleIconFile</key><string>polypong</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
</dict>
</plist>
PLIST

echo
echo "dist/ is ready:"
echo "  dist/Polypong.app     <- double-click this"
echo "  dist/PolyPong.command <- terminal alternative"

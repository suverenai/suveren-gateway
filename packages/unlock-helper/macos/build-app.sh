#!/bin/sh
# Builds the release helper into an ad-hoc signed Suveren.app and writes the list of file hashes the
# gateway checks before it starts the helper (DESIGN.md sections 7 and 10).
#   ./build-app.sh [output folder]      default: ./dist
#   CONFIG=debug ./build-app.sh dist-debug   the DEBUG helper (software backend, any caller) in the same bundle, for the
#                                            hand checks of DESIGN.md section 9 only; never shipped
# Makes <out>/Suveren.app and <out>/helper-manifest.json. No Apple Developer ID: the signature is ad hoc
# (`codesign -s -`), which this Mac's Secure Enclave accepts (DESIGN.md section 7, measured).
set -e
cd "$(dirname "$0")"
OUT="${1:-dist}"
CONFIG="${CONFIG:-release}"
swift build -c "$CONFIG"
rm -rf "$OUT"
APP="$OUT/Suveren.app"
mkdir -p "$APP/Contents/MacOS"
cp ".build/$CONFIG/suveren-unlock-helper" "$APP/Contents/MacOS/suveren-unlock-helper"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>ai.suveren.unlock-helper</string>
<key>CFBundleName</key><string>Suveren</string>
<key>CFBundleExecutable</key><string>suveren-unlock-helper</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>0.1.0</string>
<key>LSUIElement</key><true/>
</dict></plist>
PLIST
codesign --force -s - "$APP"
codesign --verify --strict "$APP"
# The hashes of every file of the bundle. The gateway carries this list itself (bundle/build.mjs puts it
# into the control plane's folder, not beside the helper) and refuses a file that does not match.
node -e '
const { createHash } = require("node:crypto");
const { readdirSync, readFileSync, writeFileSync, statSync } = require("node:fs");
const { join, relative } = require("node:path");
const app = process.argv[1];
const files = {};
(function walk(d) { for (const n of readdirSync(d).sort()) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else files[relative(app, p)] = createHash("sha256").update(readFileSync(p)).digest("hex"); } })(app);
writeFileSync(join(app, "..", "helper-manifest.json"), JSON.stringify({ v: 1, files }, null, 2) + "\n");
console.log(Object.keys(files).length + " files hashed");
' "$APP"
echo "built $APP"

#!/usr/bin/env bash
# Builds Essence Protocol for Android: dist/EssenceProtocol.apk, the game and its content editor
# inside a full-screen WebView, offline. Uses the Android SDK's command-line tools (no Gradle).
#   platforms/android/build.sh [OUT]      OUT defaults to essence-protocol/dist
# Needs ANDROID_HOME (or ANDROID_SDK_ROOT) with build-tools and a platform, and a JDK (javac).
# Any tool can be swapped with AAPT2, D8, ZIPALIGN, APKSIGNER or ANDROID_JAR.
# Signing: ANDROID_KEYSTORE / ANDROID_KEYSTORE_PASS / ANDROID_KEY_ALIAS, or the sideload key here.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="${1:-$ROOT/dist}"
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [ -n "$SDK" ] && [ -d "$SDK/build-tools" ]; then
  BT="$SDK/build-tools/$(ls "$SDK/build-tools" | sort -V | tail -1)"
  PLATFORM="$(ls -d "$SDK"/platforms/android-* | sort -V | tail -1)"
fi
AAPT2="${AAPT2:-$BT/aapt2}"
D8="${D8:-$BT/d8}"
ZIPALIGN="${ZIPALIGN:-$BT/zipalign}"
APKSIGNER="${APKSIGNER:-$BT/apksigner}"
ANDROID_JAR="${ANDROID_JAR:-$PLATFORM/android.jar}"
KEYSTORE="${ANDROID_KEYSTORE:-$HERE/sideload.keystore}"
PASS="${ANDROID_KEYSTORE_PASS:-essence-protocol}"
ALIAS="${ANDROID_KEY_ALIAS:-essence}"
VERSION_CODE="${VERSION_CODE:-$(git -C "$ROOT" rev-list --count HEAD 2>/dev/null || echo 1)}"
VERSION_NAME="${VERSION_NAME:-1.$VERSION_CODE}"

B="$HERE/build"
rm -rf "$B"; mkdir -p "$B/assets/game/editor" "$B/classes" "$B/dex" "$B/gen"
# the game as it is served, with the content editor beside it
( cd "$ROOT" && cp -r index.html style.css build.css manifest.json icon.svg sw.js icons js db "$B/assets/game/" )
( cd "$ROOT/editor" && cp index.html editor.css app.js views.js views-content.js bake-worker.js "$B/assets/game/editor/" )

"$AAPT2" compile --dir "$HERE/res" -o "$B/res.zip"
"$AAPT2" link -o "$B/base.apk" -I "$ANDROID_JAR" --manifest "$HERE/AndroidManifest.xml" -A "$B/assets" \
  --min-sdk-version 24 --target-sdk-version 34 --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" \
  --java "$B/gen" "$B/res.zip"
javac --release 8 -Xlint:-options -classpath "$ANDROID_JAR" -encoding UTF-8 -d "$B/classes" \
  $(find "$HERE/src" "$B/gen" -name '*.java')
"$D8" --release --min-api 24 --lib "$ANDROID_JAR" --output "$B/dex" $(find "$B/classes" -name '*.class')
cp "$B/base.apk" "$B/unsigned.apk"
( cd "$B/dex" && zip -q -X "$B/unsigned.apk" classes.dex )
"$ZIPALIGN" -f -p 4 "$B/unsigned.apk" "$B/aligned.apk"
"$APKSIGNER" sign --ks "$KEYSTORE" --ks-pass "pass:$PASS" --key-pass "pass:$PASS" --ks-key-alias "$ALIAS" \
  --out "$OUT/EssenceProtocol.apk" "$B/aligned.apk"
"$APKSIGNER" verify "$OUT/EssenceProtocol.apk"
"$AAPT2" dump badging "$OUT/EssenceProtocol.apk" | head -4
echo "built EssenceProtocol.apk $VERSION_NAME ($(du -h "$OUT/EssenceProtocol.apk" | cut -f1))"

#!/usr/bin/env bash
# CI: install the APK on a running emulator, start it, and check that the game loaded its merge
# database (the app logs the title screen's status line 15 seconds after the page loads).
set -uo pipefail
APK="${1:-dist/EssenceProtocol.apk}"
adb install -r "$APK" || exit 1
adb logcat -c
adb shell am start -W -n com.essenceprotocol.game/.MainActivity
ok=0
for i in $(seq 1 40); do
  sleep 3
  if adb logcat -d -s EssenceProtocol | grep -q "merges pre-baked"; then ok=1; break; fi
done
adb logcat -d -s EssenceProtocol AndroidRuntime:E | tail -40
adb exec-out screencap -p > android-title.png || true
if [ "$ok" != 1 ]; then echo "The game did not finish loading on the emulator."; exit 1; fi
if adb logcat -d -s EssenceProtocol:E | grep -q "console:"; then echo "The page logged errors (above)."; exit 1; fi
echo "Essence Protocol loaded on the emulator."

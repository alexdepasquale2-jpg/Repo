# Essence Protocol apps

The game is plain web files, so every app here is a thin shell around the same `index.html`, `js/`,
`db/` and the content editor (`editor/`). Nothing is rewritten per platform.

- `desktop/`: one Go program for Windows, Linux and macOS. It embeds the game, serves it on
  `127.0.0.1:47823` (saves belong to that address, so the port stays fixed) and opens it in a
  Chromium-based browser as an app window with its own profile, falling back to the default browser.
  `--lan` also serves other devices on the network; `--no-open` only serves. `desktop/build.sh [OUT]`
  builds all six binaries (Go 1.22+; the Windows icon comes from go-winres).
- `android/`: a single-activity app with a full-screen WebView that serves the game from the APK's
  assets on `https://appassets.androidplatform.net/` (a private address, so storage and fetch work as on
  the web) without the internet permission. Back closes menus and panels (`window.epBack`), exports use
  the share sheet (`window.EPAndroid.share`), file pickers open documents. `android/build.sh [OUT]`
  builds and signs `EssenceProtocol.apk` with the SDK's aapt2, javac, d8, zipalign and apksigner (no
  Gradle); any tool can be swapped with an environment variable. `android/smoke.sh` checks it on an
  emulator.
- `sideload.keystore` signs the APK so newer builds install over older ones and keep their saves. It is
  a sideload key, not a secret: for a store release set `ANDROID_KEYSTORE`, `ANDROID_KEYSTORE_PASS`
  and `ANDROID_KEY_ALIAS` to your own key.

`.github/workflows/essence-apps.yml` builds all of them on every push that touches the game, runs the
Linux build and the APK (on an emulator), and on `main` replaces the release `essence-protocol-latest`
with the new files and the notes in `RELEASE.md`.

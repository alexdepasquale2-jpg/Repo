#!/usr/bin/env bash
# Builds Essence Protocol for Windows, Linux and macOS: one file each, with the whole game inside.
#   platforms/desktop/build.sh [OUT]     OUT defaults to essence-protocol/dist
# Needs Go 1.22+. The Windows icon comes from go-winres (fetched by `go run`).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="${1:-$ROOT/dist}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

# the game as it is served: the page, its code, the merge database and the content editor
rm -rf "$HERE/game"
mkdir -p "$HERE/game"
( cd "$ROOT" && cp -r index.html style.css build.css manifest.json icon.svg sw.js icons js db "$HERE/game/" )
mkdir -p "$HERE/game/editor"
( cd "$ROOT/editor" && cp index.html editor.css app.js views.js views-content.js bake-worker.js "$HERE/game/editor/" )

cd "$HERE"
# the Windows icon and manifest (a .syso the Go linker picks up)
if [ ! -f rsrc_windows_amd64.syso ]; then
  GOFLAGS=-mod=mod go run github.com/tc-hib/go-winres@v0.3.3 simply --icon "$ROOT/icons/icon-512.png" --manifest gui \
    --product-name "Essence Protocol" --file-description "Essence Protocol" --arch amd64,arm64 >/dev/null
fi
export CGO_ENABLED=0
build() { # os arch output [ldflags]
  GOOS="$1" GOARCH="$2" go build -trimpath -ldflags "-s -w ${4:-}" -o "$OUT/$3" .
  echo "built $3 ($(du -h "$OUT/$3" | cut -f1))"
}
build windows amd64 EssenceProtocol-windows-x64.exe "-H windowsgui"
build windows arm64 EssenceProtocol-windows-arm64.exe "-H windowsgui"
build linux amd64 EssenceProtocol-linux-x64
build linux arm64 EssenceProtocol-linux-arm64
build darwin arm64 EssenceProtocol-macos-arm64
build darwin amd64 EssenceProtocol-macos-x64
chmod +x "$OUT"/EssenceProtocol-linux-* "$OUT"/EssenceProtocol-macos-*

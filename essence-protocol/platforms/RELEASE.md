Essence Protocol on your own device: the whole game (and its world builder and content editor) in one file, offline, nothing sent anywhere.

| Device | File | How to start |
|---|---|---|
| Android phone or tablet | `EssenceProtocol.apk` | Download it on the phone and open it. Android asks to allow installs from your browser or files app once; allow it and tap Install. |
| Windows 10 or 11 | `EssenceProtocol-windows-x64.exe` (`-arm64` for ARM PCs) | Double-click it. It opens the game in its own window. The first time, Windows SmartScreen may say it doesn't know the app: More info, then Run anyway. |
| Linux | `EssenceProtocol-linux-x64` (`-arm64` for ARM) | `chmod +x EssenceProtocol-linux-x64 && ./EssenceProtocol-linux-x64`. Add `--lan` to host it for phones and tablets on the same Wi-Fi (it prints the address), or `--no-open` to only serve it. |
| macOS | `EssenceProtocol-macos-arm64` (Apple silicon) or `-macos-x64` (Intel) | `chmod +x` it, then right-click it, Open (it isn't notarized). |

Saves stay on the device. The desktop builds open the game in Edge, Chrome, Chromium or Brave as an app window with a profile of their own, or in your default browser if none is installed; keep the default port so your saves stay with it. Built automatically from the main branch.

# Installation

ULog Studio ships three ways from the same code. Pick whichever suits you; they show the same pages.

## Windows app (recommended)

1. Download `ULog-Studio_<version>_x64-setup.exe` from the [latest release](https://github.com/MrScothh/ulog-studio/releases/latest).
2. Run it. The installer is per-user: no administrator rights are needed.
3. `.ulg` files now open in ULog Studio on double-click.

**Updates.** The app checks this repository's releases at start-up and offers the new version. Updates are signed: an installer that is not signed with the project key is refused. You can also check manually with the update button in the title bar (*Check for updates*).

Requirements: Windows 10 or 11, 64-bit. The app uses the Microsoft Edge WebView2 runtime that ships with Windows 10 and 11; the installer downloads it if it is missing.

## Web app

Open **<https://mrscothh.github.io/ulog-studio/>** in Chrome or Edge.

- After the first visit the app is cached and works **fully offline**.
- Use the browser's *Install app* button to get a window and a Start-menu entry.
- Files you open are read by your browser and analysed locally; nothing is uploaded.
- A new version is picked up on the next reload.

## Single HTML file

`ULog-Studio-<version>.html` from the releases is the whole app in one file. Open it from disk or from a USB stick in Chrome or Edge; no network and no installation needed. Handy on a field laptop or on a locked-down PC.

## Which one?

| | Windows app | Web app | Single file |
|---|---|---|---|
| Works offline | yes | after the first visit | yes |
| Double-click on `.ulg` | yes | no | no |
| Automatic updates | yes (signed) | on reload | no (download the new file) |
| Install rights | per-user | none | none |
| Very large logs | best | good | good |

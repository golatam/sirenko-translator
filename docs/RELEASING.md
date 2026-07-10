# Releasing & auto-update internals

Maintainer documentation. Users don't need anything from this file.

## Auto-update overview

The app updates itself without a reinstall. On startup (after a 30 s delay) and every 6 hours it fetches `latest.json` from this repository (`raw.githubusercontent.com`, `main` branch) and compares versions. A manual check is available from the tray menu → **Check for Updates...**

Release binaries are assets of GitHub Releases in this same repo.

### Two kinds of updates

| Kind | What changes | Size | When to use |
|---|---|---|---|
| `js` | Only our JS/HTML/CSS inside `Contents/Resources/app/` | ~hundreds of KB | Logic, UI, prompt tweaks. Doesn't touch Electron, native modules, or ML models. |
| `full` | The whole `.app`, swapped by a detached helper script | ~hundreds of MB | Electron bumps, native dependency changes, model updates. |

A `js` manifest carries `minBaseVersion` — the client refuses to apply a JS patch onto an older base; ship a `full` update first.

## How to cut a release

1. Bump `version` in `package.json` (semver `x.y.z`).
2. Build the artifact:
   - JS update: `npm run build:update:js` → `releases/translator-X.Y.Z-js.zip`
   - Full update: `npm run build:update:full` → `releases/translator-X.Y.Z-full.zip`

   The script prints the sha256 and a ready-to-paste `latest.json` block.
3. Create GitHub Release `vX.Y.Z` and upload the zip as a release asset.
4. Commit the updated `latest.json` to `main`. Clients fetch it as a raw file, so `git push` *is* the deployment of the update.

## Why updates work without code signing

`electron-updater` + Squirrel.Mac require a valid Developer ID because macOS refuses to launch a re-signed bundle. This app is **not signed at all** (`identity: null`) — Gatekeeper marks it "approved by user" once, on first launch. When we swap the contents of `Resources/app/` (or the whole `.app` via the helper script) without involving `codesign`, that user-approval marker survives and macOS shows no second dialog.

If codesigning is ever added: the `xattr -dr com.apple.quarantine` call in the helper script becomes unnecessary, and migrating to `electron-updater` becomes an option. The current update scheme and signing are mutually exclusive — don't sign without rethinking the updater.

## The ASAR workaround

`package.json` sets `"asar": false` **deliberately**. On `electron-builder 25.1.8` with the current dependency set, the build crashes in `readAsarHeader` with `RangeError: offset out of range -118883576` while computing the integrity hash. With ASAR disabled, app code lives in `Contents/Resources/app/` as plain files; the ML dependencies (`@xenova/transformers`, `onnxruntime-node`) were in `asarUnpack` anyway, so the on-disk layout barely changes — and the JS-only update mechanism actually depends on this layout. If you bump `electron-builder` and want ASAR back: first verify the build passes, then rework `applyJsUpdate()` in `updater.js`, which copies files directly into `Resources/app/`.

## Double-Cmd+C detection notes

macOS doesn't allow intercepting `Cmd+C` globally without Accessibility/CGEventTap, so the watcher polls `NSPasteboard.changeCount` every 150 ms via `osascript`. Each `Cmd+C` increments the counter even if the text is identical. A double copy is detected either as two adjacent events within 1 second with matching text, or as `delta >= 2` in a single poll with matching text (both presses landed in one poll window). The text-match requirement exists because some apps bump `changeCount` twice for a single copy (`clearContents` + `writeObjects`).

## Spaces / fullscreen

The popup is flagged `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` so a hotkey shows the window on the currently active Space instead of teleporting the user to the Space where the popup last lived.

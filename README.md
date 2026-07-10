# Translator — double Cmd+C popup translator for macOS

<p align="center">
  <b>Select text anywhere. Press <code>Cmd+C</code> twice. Get an instant AI translation right at your cursor.</b>
</p>

<p align="center">
  <a href="https://github.com/golatam/sirenko-translator/releases/latest"><img src="https://img.shields.io/github/v/release/golatam/sirenko-translator?label=download" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/golatam/sirenko-translator" alt="License"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20(Apple%20Silicon)-blue" alt="Platform">
  <a href="https://github.com/golatam/sirenko-translator/stargazers"><img src="https://img.shields.io/github/stars/golatam/sirenko-translator?style=social" alt="GitHub stars"></a>
</p>

<!-- TODO: add demo GIF here — a 5–10s screen recording of select → double Cmd+C → popup -->
<!-- <p align="center"><img src="docs/demo.gif" width="600" alt="Demo"></p> -->

[Русская версия](README.ru.md)

## Why

Switching to a browser tab just to translate a sentence breaks your flow. Translator lives in the menu bar and turns translation into a reflex: copy twice, read, keep working. No windows, no tabs, no app switching.

## Features

- **Double `Cmd+C` trigger** — works in any app, no Accessibility permissions required
- **Popup at your cursor** — appears where you're looking, follows you across Spaces and fullscreen apps
- **Streaming output** — translation appears word by word, like in a chat
- **Three translation backends:**
  - **Claude API** — best quality (API key, or reuse your Claude Code sign-in)
  - **ChatGPT** — reuse your existing ChatGPT Plus subscription via Codex CLI sign-in
  - **Local (offline)** — OPUS-MT models on-device, free and private, no internet needed
- **Replace in place** — one click pastes the translation back over the selected text
- **Configurable global hotkeys** — translate the clipboard into a specific language instantly
- **Model choice** — pick the Claude model (Haiku for speed, Sonnet for quality) in Settings
- **Auto-update** — the app keeps itself up to date from GitHub Releases

## Install

1. Download the latest `Translator.app` from [Releases](https://github.com/golatam/sirenko-translator/releases/latest).
2. Move it to `/Applications`.
3. The app is not code-signed (no $99/year Apple certificate), so on first launch macOS will complain. Either right-click → **Open** → **Open**, or run:

   ```bash
   xattr -dr com.apple.quarantine /Applications/Translator.app
   ```

4. Launch it — a **T** icon appears in the menu bar.

Or build from source — see below.

## Usage

1. Select text in any app.
2. Press `Cmd+C` twice within ~1 second.
3. A popup appears near the cursor: source language is auto-detected, translation streams in.
4. Change the target language right in the popup — your choice is remembered.
5. **Copy** puts the translation on the clipboard; **Replace** pastes it over the original selection.

Global hotkeys translate the current clipboard into a fixed language. Defaults (change or clear them in Settings → Global Shortcuts):

| Hotkey | Target |
|---|---|
| `Ctrl+Cmd+E` | English |
| `Ctrl+Cmd+R` | Russian |
| `Ctrl+Cmd+S` | Spanish |

The menu-bar icon opens Settings, toggles the watcher on/off, and checks for updates.

## Translation backends

Pick one in **Settings → Translation Mode**.

| Mode | What it uses | When to pick it |
|---|---|---|
| **Cloud → Claude** | Claude API with your API key from [platform.claude.com](https://platform.claude.com). If you use [Claude Code](https://claude.com/claude-code), the app can reuse its sign-in automatically. Model is selectable in Settings (Haiku 4.5 by default; Sonnet for higher quality). | Best quality. |
| **Cloud → ChatGPT** | Your ChatGPT Plus subscription, via the [Codex CLI](https://github.com/openai/codex) sign-in (`codex login`). | You already pay for Plus and don't want a separate API key. |
| **Local** | [OPUS-MT](https://github.com/Helsinki-NLP/Opus-MT) models via `@xenova/transformers`, running in a worker thread. One-time download of ~50 MB per language pair. | Offline, free, fully private. Slightly lower quality. |

> **Note on subscription sign-in reuse.** Reusing Claude Code / Codex CLI credentials is an unofficial mechanism and is not endorsed by Anthropic or OpenAI — it may stop working at any time. The officially supported path is a Claude API key or local mode.

## Privacy

- In cloud mode, the text you translate is sent to Anthropic or OpenAI. Nothing else leaves your machine.
- In local mode, nothing leaves your machine at all.
- No analytics, no telemetry, no accounts.
- Credentials are stored in the macOS Keychain (Claude) or read from Codex CLI's own auth file (ChatGPT); the app never sends them anywhere except the respective provider.

## Build from source

Requires Node.js 18+ and macOS on Apple Silicon.

```bash
git clone https://github.com/golatam/sirenko-translator.git
cd sirenko-translator
npm install
npm start          # run in dev mode
```

Package a `.app`:

```bash
npm run dist       # → dist/mac-arm64/Translator.app (Apple Silicon)
npm run dist:x64   # → dist/mac/Translator.app (Intel)
npm run deploy     # build + install into /Applications
npm run dmg        # build a .dmg installer (add :x64 for Intel)
npm run icon       # regenerate build/icon.icns
```

Maintainer docs — release process, auto-update internals, and the ASAR workaround — live in [docs/RELEASING.md](docs/RELEASING.md).

## How it works

- `main.js` — Electron main process: tray, popup and settings windows, clipboard watcher, global shortcuts.
- `translate.js` — cloud backends (Claude via the official SDK, ChatGPT via SSE streaming) with OAuth token auto-refresh.
- `translate-local.js` + `translate-local-worker.js` — offline translation in a worker thread so the UI never blocks.
- `lang-detect.js` — supported languages and source-language auto-detection heuristics.
- `updater.js` — self-update from GitHub Releases: lightweight JS-only patches (~KBs) or full-app swaps.

The double-`Cmd+C` detection is the fun part: macOS doesn't let you intercept `Cmd+C` globally without Accessibility permissions, so the app polls `NSPasteboard.changeCount` every 150 ms instead. Every `Cmd+C` bumps the counter even when the copied text is identical — two bumps with matching text within a second means "translate this".

## Limitations

- macOS only (relies on `NSPasteboard`, Keychain, and AppleScript). Apple Silicon builds are provided; Intel builds can be made from source with `npm run dist:x64`.
- Language list is currently English / Russian / Spanish — extending it is straightforward, PRs welcome.

## Contributing

Bug reports and PRs are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Good first issue: adding languages.

If Translator saves you time, **star the repo** ⭐ — it helps other people find it.

## License

[MIT](LICENSE)

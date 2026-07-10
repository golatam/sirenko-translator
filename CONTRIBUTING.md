# Contributing

Thanks for your interest! This is a small, focused app — contributions that keep it small and focused are the most welcome.

## Getting started

```bash
git clone https://github.com/golatam/sirenko-translator.git
cd sirenko-translator
npm install
npm start
```

You need macOS (the clipboard watcher, Keychain access, and paste simulation are all macOS-specific) and Node.js 18+.

## Good first contributions

- **More languages** — add entries to `LANGUAGES` and detection heuristics in `lang-detect.js` (cloud backends need only the language name; local mode also needs an OPUS-MT model pair in `translate-local.js`).
- **Configurable hotkeys** — the global shortcuts in `main.js` are currently hardcoded.
- **Intel (x64) build** — the release is arm64-only; a universal or x64 build target would help.
- Bug fixes with a clear reproduction.

## Guidelines

- Keep dependencies to a minimum — the app deliberately has only three runtime deps.
- Match the existing code style (plain CommonJS, no build step for app code).
- One logical change per PR; describe *why*, not just *what*.
- Test on a packaged build (`npm run dist`) when your change touches the updater, clipboard watcher, or anything path-related — dev mode and the packaged app behave differently.

## Reporting bugs

Use the bug report template. Always include your macOS version, the app version (tray → About / `package.json` if from source), and the translation mode (Claude / ChatGPT / Local).

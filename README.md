# Translator

Лёгкий popup-переводчик для macOS. Выделяешь текст, дважды жмёшь `Cmd+C` — над курсором появляется окно с переводом. Без окон, без вкладок, без переключений между приложениями.

## Как пользоваться

1. Выделить текст в любом приложении.
2. Нажать `Cmd+C` дважды подряд (в пределах ~1 секунды).
3. Над курсором появляется popup с переводом — он сам определяет язык-источник и переводит на язык, выбранный в настройках.
4. Целевой язык можно сменить прямо в popup; последний выбор запоминается.
5. Также есть пользовательские глобальные хоткеи (Settings → Shortcuts) для быстрого перевода буфера в конкретный язык.

Иконка живёт в системном трее — оттуда же открываются настройки и тогл «Enabled».

## Бэкенды перевода

Выбираются в Settings → Translation Mode.

| Режим | Что использует | Когда полезно |
|---|---|---|
| **Cloud → Claude** | Claude API. Можно через личный API-ключ или через OAuth-логин (`platform.claude.com`) — токен хранится в macOS Keychain и автоматически рефрешится. | Лучшее качество, нужен интернет. |
| **Cloud → ChatGPT** | ChatGPT Plus подписка через `chatgpt.com/backend-api/codex` (не `api.openai.com`). | Если уже есть Plus и не хочется отдельного API-ключа. |
| **Local** | OPUS-MT через `@xenova/transformers` в worker thread. Модели качаются один раз на ~50 МБ за пару. | Без интернета, бесплатно, чуть хуже качество. |

## Запуск из исходников

```bash
npm install
npm start
```

## Сборка `.app`

```bash
npm run dist     # собрать в dist/mac-arm64/Translator.app
npm run deploy   # собрать + поставить в /Applications/Translator.app
npm run dmg      # собрать .dmg-инсталлятор
```

Сборка идёт через `electron-builder`, без подписи (`identity: null`) — для личного использования этого достаточно. При первом запуске macOS попросит «Открыть всё равно» в System Settings → Privacy & Security.

В `package.json` стоит `"asar": false` — это **намеренный workaround**, а не упущение. На `electron-builder 25.1.8` с текущим набором зависимостей сборка падает на `readAsarHeader` с `RangeError: offset out of range -118883576` при вычислении integrity hash. С отключённым ASAR код приложения лежит в `Contents/Resources/app/` обычными файлами; ML-зависимости (`@xenova/transformers`, `onnxruntime-node`) и так были в `asarUnpack`, поэтому on-disk layout почти не меняется. Если в будущем поменять версию `electron-builder` и захочется вернуть ASAR — сначала убедись, что сборка проходит, а не наоборот.

## Архитектура (кратко)

- `main.js` — главный процесс Electron: tray, popup window, settings window, clipboard watcher, регистрация global shortcuts.
- `preload.js` — bridge между main и renderer через `contextBridge`.
- `renderer/` — popup UI и settings UI (vanilla JS + HTML).
- `translate.js` — облачные бэкенды (Claude, ChatGPT) с потоковой выдачей через SSE.
- `translate-local.js` + `translate-local-worker.js` — локальный перевод в отдельном worker thread, чтобы не блокировать main.
- `lang-detect.js` — список поддерживаемых языков и эвристики автодетекта.

### Detection двойного `Cmd+C`

macOS не даёт перехватывать `Cmd+C` глобально без Accessibility/CGEventTap, поэтому watcher опрашивает `NSPasteboard.changeCount` каждые 300 мс через `osascript`. На каждый `Cmd+C` счётчик инкрементится на 1. Двойное копирование детектится либо как два соседних события в пределах 1 секунды, либо как `delta >= 2` в одном опросе (когда пользователь жмёт быстро и оба нажатия попадают в одно окно).

### Spaces / fullscreen

Popup помечен `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`, чтобы хоткей показывал окно на текущем активном Space, а не телепортировал пользователя на тот, где popup был последний раз.

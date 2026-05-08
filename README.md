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

## Auto-update

Приложение умеет обновляться без переустановки `.app`. При старте (с задержкой 30 с) и далее раз в 6 часов оно тянет `latest.json` из этого репозитория и сравнивает версии. Также обновление можно запустить вручную из трея → **Check for Updates...**

Источник манифеста: `https://raw.githubusercontent.com/golatam/sirenko-translator/main/latest.json`. Бинарники — assets GitHub-релизов того же репо.

### Два типа обновлений

| Тип | Что меняется | Размер | Когда использовать |
|---|---|---|---|
| `js` | Только наши JS/HTML/CSS файлы внутри `Contents/Resources/app/` | ~сотни КБ | Правки логики, UI, промптов. Не трогает Electron, native-модули, ML-модели. |
| `full` | Всё `.app` целиком, swap через детач-скрипт | ~сотни МБ | Бамп Electron, замена native-зависимостей, обновление моделей. |

JS-апдейт хранит в манифесте `minBaseVersion` — клиент откажется применять `js`-патч, если его база старее: значит, нужно сначала прокатить `full`-обновление.

### Как выпустить релиз

1. Подними `version` в `package.json` (semver `x.y.z`).
2. Собери артефакт:
   - JS-обновление: `npm run build:update:js` → `releases/translator-X.Y.Z-js.zip`
   - Full-обновление: `npm run build:update:full` → `releases/translator-X.Y.Z-full.zip`
   Скрипт напечатает sha256 и готовый блок `latest.json`.
3. Создай GitHub Release `vX.Y.Z`, загрузи zip как release asset.
4. Закоммить `latest.json` в `main`. Клиенты тянут его как сырой файл с `raw.githubusercontent.com`, поэтому `git push` — это и есть «деплой» обновления.

### Почему это работает без подписи

`electron-updater` + Squirrel.Mac требуют валидный Developer ID, потому что macOS откажется запускать переподписанный bundle. У нас приложение **не подписано вообще** (`identity: null`) — Gatekeeper уже отметил его как «approved by user» один раз. Когда мы swap-аем содержимое `Resources/app/` (или весь `.app` через скрипт-хвост) без участия `codesign`, маркер user-approval сохраняется, и macOS не показывает повторного диалога.

Если когда-нибудь добавишь codesign — `xattr -dr com.apple.quarantine` в helper-скрипте перестанет быть нужен, и можно будет смотреть в сторону `electron-updater`.

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

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  clipboard,
  screen,
  nativeImage,
} = require("electron");
const path = require("path");
const Store = require("electron-store");
const { translate, getKeychainToken, LANGUAGES } = require("./translate");
const { translateLocal } = require("./translate-local");

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

const store = new Store({
  defaults: {
    apiKey: "",
    defaultTargetLang: "en",
    enabled: true,
    translationMode: "cloud", // "cloud" or "local"
  },
});

let tray = null;
let popupWindow = null;
let settingsWindow = null;

// Clipboard watcher state
let lastCopyTime = 0;
let clipboardWatcherProcess = null;
let ignoreClipboardUntil = 0; // suppress own clipboard writes

// ─── Tray Icon ──────────────────────────────────────────────────────────────

function createTrayIcon() {
  const width = 16;
  const height = 16;

  const pixels = [
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,1,1,1,1,1,1,1,1,1,1,1,1,0,0],
    [0,0,1,1,1,1,1,1,1,1,1,1,1,1,0,0],
    [0,0,0,0,0,0,1,1,1,1,0,0,0,0,0,0],
    [0,0,0,0,0,0,1,1,1,1,0,0,0,0,0,0],
    [0,0,0,0,0,0,1,1,1,1,0,0,0,0,0,0],
    [0,0,0,0,0,0,1,1,1,1,0,0,0,0,0,0],
    [0,0,0,0,0,0,1,1,1,1,0,0,0,0,0,0],
    [0,0,0,0,0,0,1,1,1,1,0,0,0,0,0,0],
    [0,0,0,0,0,0,1,1,1,1,0,0,0,0,0,0],
    [0,0,0,0,0,0,1,1,1,1,0,0,0,0,0,0],
    [0,0,0,0,0,0,1,1,1,1,0,0,0,0,0,0],
    [0,0,0,0,0,0,1,1,1,1,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  ];

  const rawData = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      rawData[idx + 3] = pixels[y][x] ? 255 : 0;
    }
  }

  const img = nativeImage.createFromBitmap(rawData, { width, height });
  img.setTemplateImage(true);
  return img;
}

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip("Translator");

  const contextMenu = Menu.buildFromTemplate([
    { label: "Translator", enabled: false },
    { type: "separator" },
    {
      label: "Enabled",
      type: "checkbox",
      checked: store.get("enabled"),
      click: (item) => {
        store.set("enabled", item.checked);
        item.checked ? startClipboardWatcher() : stopClipboardWatcher();
      },
    },
    { label: "Settings...", click: () => openSettings() },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);

  tray.setContextMenu(contextMenu);
}

// ─── Clipboard Watcher ──────────────────────────────────────────────────────

function markOwnClipboardWrite() {
  ignoreClipboardUntil = Date.now() + 500;
}

function startClipboardWatcher() {
  if (clipboardWatcherProcess) return;

  const { spawn } = require("child_process");
  const watcherBin = path.join(__dirname, "clipboard-watcher");
  clipboardWatcherProcess = spawn(watcherBin);

  clipboardWatcherProcess.stdout.on("data", (data) => {
    // Ignore own clipboard writes
    if (Date.now() < ignoreClipboardUntil) return;

    const lines = data.toString().trim().split("\n");
    for (const line of lines) {
      if (line === "copy") {
        const now = Date.now();
        const timeSinceLastCopy = now - lastCopyTime;
        lastCopyTime = now;

        if (timeSinceLastCopy < 1000 && timeSinceLastCopy > 50) {
          onDoubleCopy(clipboard.readText());
        }
      }
    }
  });

  clipboardWatcherProcess.on("error", (err) => {
    console.error("[watcher] failed to start:", err.message);
    clipboardWatcherProcess = null;
  });

  clipboardWatcherProcess.on("exit", (code) => {
    if (code !== null && code !== 0) {
      console.error("[watcher] exited with code", code);
    }
    clipboardWatcherProcess = null;
  });
}

function stopClipboardWatcher() {
  if (clipboardWatcherProcess) {
    clipboardWatcherProcess.kill();
    clipboardWatcherProcess = null;
  }
}

function onDoubleCopy(text) {
  if (!text || !text.trim()) return;

  // Local mode doesn't need an API key
  const mode = store.get("translationMode");
  if (mode !== "local") {
    const apiKey = store.get("apiKey");
    if (!apiKey && !getKeychainToken()) {
      openSettings();
      return;
    }
  }

  showPopup(text);
}

// ─── Popup Window ───────────────────────────────────────────────────────────

function createPopupWindow() {
  popupWindow = new BrowserWindow({
    width: 420,
    height: 320,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    vibrancy: "popover",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  popupWindow.loadFile(path.join(__dirname, "renderer", "popup.html"));

  popupWindow.on("blur", () => {
    if (popupWindow && !popupWindow.isDestroyed()) {
      popupWindow.hide();
    }
  });
}

function showPopup(text) {
  const cursorPoint = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursorPoint);
  const { workArea } = display;

  const popupWidth = 420;
  const popupHeight = 320;

  let x = cursorPoint.x - popupWidth / 2;
  let y = cursorPoint.y + 20;
  x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - popupWidth));
  y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - popupHeight));

  if (!popupWindow || popupWindow.isDestroyed()) {
    createPopupWindow();
  }

  popupWindow.setPosition(Math.round(x), Math.round(y));

  const sendRequest = () => {
    popupWindow.webContents.send("translation-request", {
      text,
      targetLang: store.get("defaultTargetLang"),
      languages: LANGUAGES,
    });
  };

  if (popupWindow.webContents.isLoading()) {
    popupWindow.webContents.once("did-finish-load", () => {
      popupWindow.show();
      sendRequest();
    });
  } else {
    popupWindow.show();
    sendRequest();
  }
}

// ─── Settings Window ────────────────────────────────────────────────────────

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 450,
    height: 420,
    title: "Translator Settings",
    resizable: false,
    minimizable: false,
    maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  settingsWindow.loadFile(path.join(__dirname, "renderer", "settings.html"));
  settingsWindow.setMenuBarVisibility(false);

  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}

// ─── IPC Handlers ───────────────────────────────────────────────────────────

ipcMain.handle("translate", async (_event, text, targetLang) => {
  const mode = store.get("translationMode");

  if (mode === "local") {
    try {
      return await translateLocal(text, targetLang);
    } catch (err) {
      return { error: err.message || "Local translation failed" };
    }
  }

  // Cloud mode (Claude API / CLI)
  const apiKey = store.get("apiKey") || getKeychainToken();
  if (!apiKey) {
    return { error: "API key not set. Please configure in Settings or run: claude auth login" };
  }
  try {
    return await translate(text, apiKey, targetLang);
  } catch (err) {
    return { error: err.message || "Translation failed" };
  }
});

ipcMain.handle("get-settings", () => ({
  apiKey: store.get("apiKey"),
  defaultTargetLang: store.get("defaultTargetLang"),
  enabled: store.get("enabled"),
  translationMode: store.get("translationMode"),
}));

ipcMain.handle("save-settings", (_event, settings) => {
  if (settings.apiKey !== undefined) store.set("apiKey", settings.apiKey);
  if (settings.defaultTargetLang !== undefined)
    store.set("defaultTargetLang", settings.defaultTargetLang);
  if (settings.translationMode !== undefined)
    store.set("translationMode", settings.translationMode);
  if (settings.enabled !== undefined) {
    store.set("enabled", settings.enabled);
    settings.enabled ? startClipboardWatcher() : stopClipboardWatcher();
  }
  return { success: true };
});

ipcMain.handle("copy-to-clipboard", (_event, text) => {
  markOwnClipboardWrite();
  clipboard.writeText(text);
  return { success: true };
});

ipcMain.handle("replace-in-app", async (_event, text) => {
  markOwnClipboardWrite();
  clipboard.writeText(text);

  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.hide();
  }

  // Wait for previous app to regain focus, then simulate Cmd+V
  await new Promise((r) => setTimeout(r, 300));

  const { execFile } = require("child_process");
  execFile("osascript", [
    "-e",
    'tell application "System Events" to keystroke "v" using command down',
  ], (err) => {
    if (err) console.error("Failed to simulate paste:", err.message);
  });

  return { success: true };
});

ipcMain.on("close-popup", () => {
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.hide();
  }
});

// ─── App Lifecycle ──────────────────────────────────────────────────────────

app.dock?.hide();

app.whenReady().then(() => {
  createTray();

  // Pre-create popup window for instant response
  createPopupWindow();

  if (store.get("enabled")) {
    startClipboardWatcher();
  }

  if (store.get("translationMode") !== "local" && !store.get("apiKey") && !getKeychainToken()) {
    openSettings();
  }
});

app.on("will-quit", () => {
  stopClipboardWatcher();
});

app.on("window-all-closed", (e) => {
  e.preventDefault();
});

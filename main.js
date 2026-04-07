const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  clipboard,
  screen,
  nativeImage,
  globalShortcut,
} = require("electron");
const path = require("path");
const fs = require("fs");
const Store = require("electron-store");
const { translate, getKeychainToken } = require("./translate");
const { translateLocal, downloadModels, terminateWorker } = require("./translate-local");
const { LANGUAGES } = require("./lang-detect");

// ─── Single Instance Lock ───────────────────────────────────────────────────

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

// ─── Store ──────────────────────────────────────────────────────────────────

const store = new Store({
  defaults: {
    apiKey: "",
    defaultTargetLang: "en",
    enabled: true,
    translationMode: "cloud",
  },
});

// ─── App State ──────────────────────────────────────────────────────────────

let tray = null;
let popupWindow = null;
let settingsWindow = null;
let popupBusy = false;

// Clipboard watcher
let lastCopyTime = 0;
let clipboardWatcherProcess = null;
let clipboardPollTimer = null;
let lastChangeCount = -1;
let ignoreClipboardUntil = 0;

// Translation cancellation
let currentTranslationController = null;

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

// ─── Clipboard Watcher (with JS fallback) ───────────────────────────────────

function markOwnClipboardWrite() {
  ignoreClipboardUntil = Date.now() + 500;
}

function handleClipboardData(data) {
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
}

function getChangeCount() {
  try {
    const { execFileSync } = require("child_process");
    const out = execFileSync(
      "osascript",
      [
        "-l",
        "JavaScript",
        "-e",
        'ObjC.import("AppKit"); $.NSPasteboard.generalPasteboard.changeCount',
      ],
      { encoding: "utf-8", timeout: 2000 }
    );
    return parseInt(out.trim(), 10);
  } catch {
    return -1;
  }
}

function startClipboardWatcher() {
  if (clipboardPollTimer) return;

  // Poll NSPasteboard changeCount directly from main process.
  // Each Cmd+C bumps changeCount even if text is identical — that's how
  // we detect a "double copy" when the user presses Cmd+C twice in a row.
  lastChangeCount = getChangeCount();
  clipboardPollTimer = setInterval(() => {
    const count = getChangeCount();
    if (count !== -1 && count !== lastChangeCount) {
      lastChangeCount = count;
      handleClipboardData("copy\n");
    }
  }, 300);
}

function stopClipboardWatcher() {
  if (clipboardPollTimer) {
    clearInterval(clipboardPollTimer);
    clipboardPollTimer = null;
  }
}

async function onDoubleCopy(text) {
  if (!text || !text.trim()) return;

  const mode = store.get("translationMode");
  if (mode !== "local") {
    const apiKey = store.get("apiKey");
    if (!apiKey && !(await getKeychainToken())) {
      openSettings();
      return;
    }
  }

  showPopup(text, null, true);
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
    if (popupBusy) return;
    if (popupWindow && !popupWindow.isDestroyed()) {
      popupWindow.hide();
    }
  });
}

function showPopup(text, targetLangOverride, autoTranslate) {
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
      targetLang: targetLangOverride || store.get("defaultTargetLang"),
      languages: LANGUAGES,
      translationMode: store.get("translationMode"),
      autoTranslate: !!targetLangOverride || !!autoTranslate,
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
    height: 480,
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

// ─── IPC: Translation (with cancellation + streaming) ───────────────────────

ipcMain.handle("translate", async (_event, text, targetLang) => {
  // Cancel any in-flight cloud translation
  if (currentTranslationController) {
    currentTranslationController.abort();
    currentTranslationController = null;
  }

  const mode = store.get("translationMode");

  if (mode === "local") {
    try {
      return await translateLocal(text, targetLang);
    } catch (err) {
      return { error: err.message || "Local translation failed" };
    }
  }

  // Cloud mode — create AbortController for cancellation
  const controller = new AbortController();
  currentTranslationController = controller;

  const apiKey = store.get("apiKey") || (await getKeychainToken());
  if (!apiKey) {
    currentTranslationController = null;
    return { error: "API key not set. Please configure in Settings or run: claude auth login" };
  }

  // Stream chunks to popup as they arrive
  const sendChunk = (chunk) => {
    if (popupWindow && !popupWindow.isDestroyed()) {
      popupWindow.webContents.send("translation-chunk", chunk);
    }
  };

  try {
    const result = await translate(text, apiKey, targetLang, controller.signal, sendChunk);
    currentTranslationController = null;
    return result;
  } catch (err) {
    currentTranslationController = null;
    if (controller.signal.aborted) {
      return { error: "cancelled" };
    }
    return { error: err.message || "Translation failed" };
  }
});

// ─── IPC: Settings ──────────────────────────────────────────────────────────

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

// ─── IPC: Model Download ────────────────────────────────────────────────────

ipcMain.handle("download-models", async () => {
  const targetLang = store.get("defaultTargetLang") || "en";
  const sender = settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : null;

  try {
    await downloadModels(targetLang, (data) => {
      if (sender) {
        sender.webContents.send("download-progress", data);
      }
    });
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

// ─── IPC: Clipboard & Popup ─────────────────────────────────────────────────

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

ipcMain.on("popup-busy", (_event, busy) => {
  popupBusy = busy;
});

ipcMain.on("close-popup", () => {
  popupBusy = false;
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.hide();
  }
});

// ─── Global Shortcuts ───────────────────────────────────────────────────────

const SHORTCUTS = {
  "Ctrl+CommandOrControl+E": "en",
  "Ctrl+CommandOrControl+R": "ru",
  "Ctrl+CommandOrControl+S": "es",
};

function registerGlobalShortcuts() {
  for (const [accelerator, lang] of Object.entries(SHORTCUTS)) {
    const ok = globalShortcut.register(accelerator, () => {
      const text = clipboard.readText();
      if (!text || !text.trim()) return;
      showPopup(text, lang);
    });
    if (!ok) {
      console.error(`[shortcut] failed to register ${accelerator} — already taken`);
    }
  }
}

// ─── App Lifecycle ──────────────────────────────────────────────────────────

app.dock?.hide();

app.whenReady().then(async () => {
  createTray();
  createPopupWindow();

  if (store.get("enabled")) {
    startClipboardWatcher();
  }

  registerGlobalShortcuts();

  if (store.get("translationMode") !== "local" && !store.get("apiKey") && !(await getKeychainToken())) {
    openSettings();
  }

  // Pre-warm: load default model pair in local mode (background, non-blocking)
  if (store.get("translationMode") === "local") {
    const targetLang = store.get("defaultTargetLang") || "en";
    translateLocal("warmup", targetLang).catch(() => {});
  }
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  stopClipboardWatcher();
  terminateWorker();
});

app.on("window-all-closed", (e) => {
  e.preventDefault();
});

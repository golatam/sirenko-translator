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
  dialog,
  shell,
} = require("electron");
const path = require("path");
const fs = require("fs");
const Store = require("electron-store");
const { translate, translateOpenAI, getKeychainToken, getCodexToken, loginOpenAI, listOpenAIModels } = require("./translate");
const { translateLocal, downloadModels, terminateWorker } = require("./translate-local");
const { LANGUAGES } = require("./lang-detect");
const { checkForUpdates, scheduleUpdateChecks } = require("./updater");
const doubleCopy = require("./double-copy");

// ─── Single Instance Lock ───────────────────────────────────────────────────

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

// ─── Store ──────────────────────────────────────────────────────────────────

const POPUP_DEFAULT_WIDTH = 420;
const POPUP_DEFAULT_HEIGHT = 320;
const POPUP_MIN_WIDTH = 320;
const POPUP_MIN_HEIGHT = 240;

// "Command" only exists on macOS — Electron accelerators have no Windows
// equivalent for it, so registerGlobalShortcuts() would silently fail to
// bind these on Windows. Use Ctrl+Alt+<key> there instead.
const DEFAULT_SHORTCUTS = process.platform === "win32"
  ? { en: "Ctrl+Alt+E", ru: "Ctrl+Alt+R", es: "Ctrl+Alt+S" }
  : { en: "Ctrl+Command+E", ru: "Ctrl+Command+R", es: "Ctrl+Command+S" };

const store = new Store({
  defaults: {
    apiKey: "",
    cloudProvider: "claude",
    claudeModel: "claude-haiku-4-5",
    openaiModel: "gpt-5.6-luna",
    defaultTargetLang: "en",
    lastTargetLang: null,
    enabled: true,
    translationMode: "cloud",
    popupWidth: POPUP_DEFAULT_WIDTH,
    popupHeight: POPUP_DEFAULT_HEIGHT,
    shortcuts: DEFAULT_SHORTCUTS,
  },
});

// ─── App State ──────────────────────────────────────────────────────────────

let tray = null;
let popupWindow = null;
let settingsWindow = null;
let popupBusy = false;

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
        item.checked ? doubleCopy.start(onDoubleCopy) : doubleCopy.stop();
      },
    },
    { label: "Settings...", click: () => openSettings() },
    {
      label: "Check for Updates...",
      click: () => checkForUpdates({ silent: false }).catch(() => {}),
    },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);

  tray.setContextMenu(contextMenu);
}

// Resolve the auth state for the current cloud provider. Catches refresh
// failures (e.g. OpenAI's refresh_token_reused, network errors) so they
// don't bubble up as unhandled rejections from the double-copy detector and
// silently swallow the popup trigger.
async function resolveAuth() {
  const mode = store.get("translationMode");
  if (mode === "local") return { ok: true };

  const provider = store.get("cloudProvider") || "claude";
  try {
    if (provider === "openai") {
      const token = await getCodexToken();
      if (!token) return { ok: false };
      return { ok: true };
    }
    const apiKey = store.get("apiKey");
    if (apiKey) return { ok: true };
    const kc = await getKeychainToken();
    if (kc) return { ok: true };
    return { ok: false };
  } catch (err) {
    return { ok: false, error: err };
  }
}

async function onDoubleCopy(text) {
  if (!text || !text.trim()) return;

  const auth = await resolveAuth();
  if (!auth.ok) {
    if (auth.error) {
      dialog.showErrorBox(
        "Translator: re-sign in required",
        `${auth.error.message || auth.error}\n\nOpening Settings — please re-authenticate.`
      );
    }
    openSettings();
    return;
  }

  showPopup(text, null, true);
}

// ─── Popup Window ───────────────────────────────────────────────────────────

let savePopupSizeTimer = null;

function createPopupWindow() {
  const w = Math.max(POPUP_MIN_WIDTH, store.get("popupWidth") || POPUP_DEFAULT_WIDTH);
  const h = Math.max(POPUP_MIN_HEIGHT, store.get("popupHeight") || POPUP_DEFAULT_HEIGHT);

  popupWindow = new BrowserWindow({
    width: w,
    height: h,
    minWidth: POPUP_MIN_WIDTH,
    minHeight: POPUP_MIN_HEIGHT,
    frame: false,
    transparent: true,
    resizable: true,
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

  // Follow the user across Spaces / fullscreen apps instead of pulling them
  // back to the Space where the window was last shown.
  popupWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  popupWindow.loadFile(path.join(__dirname, "renderer", "popup.html"));

  popupWindow.on("blur", () => {
    if (popupBusy) return;
    if (popupWindow && !popupWindow.isDestroyed()) {
      popupWindow.hide();
    }
  });

  // Persist user-chosen size (debounced, ignored while window is hidden during reposition)
  popupWindow.on("resize", () => {
    if (!popupWindow || popupWindow.isDestroyed() || !popupWindow.isVisible()) return;
    if (savePopupSizeTimer) clearTimeout(savePopupSizeTimer);
    savePopupSizeTimer = setTimeout(() => {
      const [width, height] = popupWindow.getSize();
      store.set("popupWidth", width);
      store.set("popupHeight", height);
    }, 250);
  });
}

function showPopup(text, targetLangOverride, autoTranslate) {
  const cursorPoint = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursorPoint);
  const { workArea } = display;

  if (!popupWindow || popupWindow.isDestroyed()) {
    createPopupWindow();
  }

  const [popupWidth, popupHeight] = popupWindow.getSize();

  let x = cursorPoint.x - popupWidth / 2;
  let y = cursorPoint.y + 20;
  x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - popupWidth));
  y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - popupHeight));

  popupWindow.setPosition(Math.round(x), Math.round(y));

  const sendRequest = () => {
    const defaultTarget =
      targetLangOverride ||
      store.get("lastTargetLang") ||
      store.get("defaultTargetLang");
    popupWindow.webContents.send("translation-request", {
      text,
      targetLang: defaultTarget,
      languages: LANGUAGES,
      translationMode: store.get("translationMode"),
      cloudProvider: store.get("cloudProvider") || "claude",
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
  doubleCopy.syncMode();

  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 450,
    height: 660,
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

  const provider = store.get("cloudProvider") || "claude";

  // Stream chunks to popup as they arrive
  const sendChunk = (chunk) => {
    if (popupWindow && !popupWindow.isDestroyed()) {
      popupWindow.webContents.send("translation-chunk", chunk);
    }
  };

  try {
    let result;
    if (provider === "openai") {
      const codexToken = await getCodexToken();
      if (!codexToken) {
        currentTranslationController = null;
        return { error: "ChatGPT not authorized. Open Settings and click \"Sign in with ChatGPT\"." };
      }
      result = await translateOpenAI(text, codexToken, targetLang, controller.signal, sendChunk, store.get("openaiModel"));
    } else {
      const apiKey = store.get("apiKey") || (await getKeychainToken());
      if (!apiKey) {
        currentTranslationController = null;
        return { error: "No Claude credentials. Paste an API key in Settings, or sign in to Claude Code." };
      }
      result = await translate(text, apiKey, targetLang, controller.signal, sendChunk, store.get("claudeModel"));
    }
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
  cloudProvider: store.get("cloudProvider"),
  claudeModel: store.get("claudeModel"),
  openaiModel: store.get("openaiModel"),
  defaultTargetLang: store.get("defaultTargetLang"),
  enabled: store.get("enabled"),
  translationMode: store.get("translationMode"),
  shortcuts: { ...DEFAULT_SHORTCUTS, ...(store.get("shortcuts") || {}) },
  accessibility: { trusted: doubleCopy.isAccessibilityTrusted(), mode: doubleCopy.getMode() },
}));

ipcMain.handle("open-accessibility-settings", () => {
  doubleCopy.requestAccessibilityAccess();
  return { success: true };
});

ipcMain.handle("save-settings", (_event, settings) => {
  if (settings.apiKey !== undefined) store.set("apiKey", settings.apiKey);
  if (settings.cloudProvider !== undefined) store.set("cloudProvider", settings.cloudProvider);
  if (settings.claudeModel !== undefined) store.set("claudeModel", settings.claudeModel);
  if (settings.openaiModel !== undefined) store.set("openaiModel", settings.openaiModel);
  if (settings.defaultTargetLang !== undefined)
    store.set("defaultTargetLang", settings.defaultTargetLang);
  if (settings.translationMode !== undefined)
    store.set("translationMode", settings.translationMode);
  if (settings.enabled !== undefined) {
    store.set("enabled", settings.enabled);
    settings.enabled ? doubleCopy.start(onDoubleCopy) : doubleCopy.stop();
  }
  if (settings.shortcuts !== undefined) {
    const merged = { ...(store.get("shortcuts") || DEFAULT_SHORTCUTS), ...settings.shortcuts };
    store.set("shortcuts", merged);
    const failed = registerGlobalShortcuts();
    return { success: true, failedShortcuts: failed };
  }
  return { success: true };
});

// ─── IPC: Codex Auth Status ────────────────────────────────────────────────

ipcMain.handle("get-codex-status", async () => {
  const token = await getCodexToken();
  return { authorized: !!token };
});

ipcMain.handle("get-openai-models", async () => {
  try {
    return { models: await listOpenAIModels() };
  } catch (err) {
    return { error: err.message };
  }
});

// Dedup concurrent login attempts (e.g. a double-click on the button) so we
// don't pop open two browser tabs / bind the callback server twice.
let openaiLoginInProgress = null;

ipcMain.handle("openai-login", async () => {
  if (!openaiLoginInProgress) {
    openaiLoginInProgress = loginOpenAI({ openExternal: (url) => shell.openExternal(url) }).finally(
      () => { openaiLoginInProgress = null; }
    );
  }
  try {
    await openaiLoginInProgress;
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
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
  doubleCopy.ignoreOwnWrite();
  clipboard.writeText(text);
  return { success: true };
});

ipcMain.handle("replace-in-app", async (_event, text) => {
  doubleCopy.ignoreOwnWrite();
  clipboard.writeText(text);

  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.hide();
  }

  await new Promise((r) => setTimeout(r, 300));

  const { execFile } = require("child_process");
  if (process.platform === "win32") {
    execFile("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')",
    ], (err) => {
      if (err) console.error("Failed to simulate paste:", err.message);
    });
  } else {
    execFile("osascript", [
      "-e",
      'tell application "System Events" to keystroke "v" using command down',
    ], (err) => {
      if (err) console.error("Failed to simulate paste:", err.message);
    });
  }

  return { success: true };
});

ipcMain.on("save-last-target-lang", (_event, lang) => {
  if (typeof lang === "string" && lang) {
    store.set("lastTargetLang", lang);
  }
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

// globalShortcut binds to the OS-level key-down event, so holding the
// accelerator a beat longer than a quick tap lets the OS's own key-repeat
// fire the callback again for what the user experiences as a single press.
// Ignore re-fires that land within this window of the last one.
const SHORTCUT_REFIRE_GUARD_MS = 400;
let lastShortcutFireTime = 0;

// Register user-configured shortcuts from the store. Returns a map of
// lang → false for accelerators that could not be registered (taken by
// another app), so the settings UI can surface the conflict.
function registerGlobalShortcuts() {
  globalShortcut.unregisterAll();
  const shortcuts = store.get("shortcuts") || DEFAULT_SHORTCUTS;
  const failed = {};

  for (const [lang, accelerator] of Object.entries(shortcuts)) {
    if (!accelerator) continue; // cleared by user — shortcut disabled
    const ok = globalShortcut.register(accelerator, () => {
      const now = Date.now();
      if (now - lastShortcutFireTime < SHORTCUT_REFIRE_GUARD_MS) return;
      lastShortcutFireTime = now;

      const text = clipboard.readText();
      if (!text || !text.trim()) return;
      showPopup(text, lang);
    });
    if (!ok) {
      failed[lang] = accelerator;
      console.error(`[shortcut] failed to register ${accelerator} — already taken`);
    }
  }
  return failed;
}

// ─── App Lifecycle ──────────────────────────────────────────────────────────

app.dock?.hide();

app.whenReady().then(async () => {
  createTray();
  createPopupWindow();

  if (store.get("enabled")) {
    doubleCopy.start(onDoubleCopy);
  }

  registerGlobalShortcuts();

  if (store.get("translationMode") !== "local") {
    const provider = store.get("cloudProvider") || "claude";
    const needsSetup = provider === "openai"
      ? !(await getCodexToken())
      : !store.get("apiKey") && !(await getKeychainToken());
    if (needsSetup) openSettings();
  }

  if (
    process.platform === "darwin" &&
    store.get("enabled") &&
    !doubleCopy.isAccessibilityTrusted()
  ) {
    openSettings();
  }

  // Pre-warm: load default model pair in local mode (background, non-blocking)
  if (store.get("translationMode") === "local") {
    const targetLang = store.get("defaultTargetLang") || "en";
    translateLocal("warmup", targetLang).catch(() => {});
  }

  scheduleUpdateChecks();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  doubleCopy.stop();
  terminateWorker();
});

app.on("window-all-closed", (e) => {
  e.preventDefault();
});

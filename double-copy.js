const { clipboard, systemPreferences, shell } = require("electron");

// Double-Cmd+C window. See handlePollingChange for why 1000ms/50ms.
const DOUBLE_COPY_MAX_MS = 1000;
const DOUBLE_COPY_MIN_MS = 50;

// Gives the target app time to actually write the selection to the
// pasteboard after we see the second Cmd+C keydown (uiohook's listen-only
// tap fires before/concurrently with the app's own copy handler).
const CLIPBOARD_SETTLE_DELAY_MS = 80;

let mode = null; // 'uiohook' | 'polling' | null (not started)
let onDoubleCopy = null;

// ─── Accessibility (macOS only — always "trusted" elsewhere) ───────────────

function isAccessibilityTrusted() {
  if (process.platform !== "darwin") return true;
  return systemPreferences.isTrustedAccessibilityClient(false);
}

function requestAccessibilityAccess() {
  if (process.platform === "darwin") {
    // Triggers the OS "add to Accessibility list" dialog on first call.
    systemPreferences.isTrustedAccessibilityClient(true);
  }
  shell.openExternal(
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
  );
}

// ─── uiohook mode: real keydown events (macOS w/ trust, always on Windows) ──

let uiohookHandle = null;
let firstPressAt = 0;

function startUiohookMode() {
  const { uIOhook, UiohookKey } = require("uiohook-napi");

  const onKeydown = (e) => {
    const isPlainCopyCombo =
      e.keycode === UiohookKey.C &&
      !e.shiftKey &&
      !e.altKey &&
      (process.platform === "darwin"
        ? e.metaKey && !e.ctrlKey
        : e.ctrlKey && !e.metaKey);
    if (!isPlainCopyCombo) return;

    const now = Date.now();
    if (firstPressAt && now - firstPressAt <= DOUBLE_COPY_MAX_MS) {
      firstPressAt = 0;
      setTimeout(() => {
        const text = clipboard.readText();
        if (text && text.trim()) onDoubleCopy(text);
      }, CLIPBOARD_SETTLE_DELAY_MS);
    } else {
      firstPressAt = now;
    }
  };

  uIOhook.on("keydown", onKeydown);
  uIOhook.start();
  uiohookHandle = { uIOhook, onKeydown };
  mode = "uiohook";
}

function stopUiohookMode() {
  if (!uiohookHandle) return;
  uiohookHandle.uIOhook.off("keydown", uiohookHandle.onKeydown);
  uiohookHandle.uIOhook.stop();
  uiohookHandle = null;
  firstPressAt = 0;
}

// ─── Polling mode: NSPasteboard.changeCount fallback (macOS, no trust) ─────
// Can't tell a real double Cmd+C from any other source that writes the same
// text to the pasteboard twice (e.g. a terminal's copy-on-select). Kept only
// as a degraded fallback until Accessibility is granted.

let clipboardPollTimer = null;
let lastChangeCount = -1;
let lastCopyTime = 0;
let lastCopyText = "";
let ignoreClipboardUntil = 0;

function getMacChangeCount() {
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

function handlePollingChange(delta) {
  if (Date.now() < ignoreClipboardUntil) return;

  const text = clipboard.readText();

  // Two Cmd+C presses may land inside one poll window (delta >= 2). But
  // some apps also bump changeCount by 2 for a single copy (clearContents +
  // writeObjects), so only trust delta >= 2 when the text matches what we
  // already had — confirming same selection.
  if (delta >= 2 && text === lastCopyText && text !== "") {
    lastCopyTime = 0;
    lastCopyText = "";
    onDoubleCopy(text);
    return;
  }

  const now = Date.now();
  const timeSinceLastCopy = now - lastCopyTime;
  const sameSelection = text === lastCopyText && text !== "";

  lastCopyTime = now;
  lastCopyText = text;

  if (
    timeSinceLastCopy < DOUBLE_COPY_MAX_MS &&
    timeSinceLastCopy > DOUBLE_COPY_MIN_MS &&
    sameSelection
  ) {
    lastCopyText = "";
    onDoubleCopy(text);
  }
}

function startPollingMode() {
  lastChangeCount = getMacChangeCount();
  clipboardPollTimer = setInterval(() => {
    const count = getMacChangeCount();
    if (count === -1 || count === lastChangeCount) return;
    const delta = count - lastChangeCount;
    lastChangeCount = count;
    handlePollingChange(delta);
  }, 150);
  mode = "polling";
}

function stopPollingMode() {
  if (clipboardPollTimer) {
    clearInterval(clipboardPollTimer);
    clipboardPollTimer = null;
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

function start(callback) {
  onDoubleCopy = callback;
  if (process.platform === "darwin" && !isAccessibilityTrusted()) {
    startPollingMode();
  } else {
    startUiohookMode();
  }
}

function stop() {
  stopUiohookMode();
  stopPollingMode();
  mode = null;
  onDoubleCopy = null;
}

// Re-check Accessibility trust and switch mode if it changed while running
// (e.g. user granted access in System Settings without restarting the app).
function syncMode() {
  if (process.platform !== "darwin" || !onDoubleCopy) return;
  const trusted = isAccessibilityTrusted();
  if (trusted && mode !== "uiohook") {
    stopPollingMode();
    startUiohookMode();
  } else if (!trusted && mode !== "polling") {
    stopUiohookMode();
    startPollingMode();
  }
}

// Call before the app writes to the clipboard itself, so that write isn't
// mistaken for a user copy by the polling fallback. No-op in uiohook mode
// (which watches keydowns, not clipboard writes) but safe to call always.
function ignoreOwnWrite() {
  ignoreClipboardUntil = Date.now() + 500;
}

module.exports = {
  start,
  stop,
  syncMode,
  ignoreOwnWrite,
  isAccessibilityTrusted,
  requestAccessibilityAccess,
  getMode: () => mode,
};

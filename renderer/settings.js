const apiKeyInput = document.getElementById("apiKey");
const apiKeyField = document.getElementById("apiKeyField");
const claudeModelField = document.getElementById("claudeModelField");
const claudeModelSelect = document.getElementById("claudeModel");
const openaiKeyField = document.getElementById("openaiKeyField");
const openaiModelField = document.getElementById("openaiModelField");
const openaiModelInput = document.getElementById("openaiModel");
const shortcutInputs = Array.from(document.querySelectorAll(".shortcut-input"));
const shortcutError = document.getElementById("shortcutError");
const codexStatusEl = document.getElementById("codexStatus");
const cloudProviderField = document.getElementById("cloudProviderField");
const providerClaudeBtn = document.getElementById("providerClaude");
const providerOpenAIBtn = document.getElementById("providerOpenAI");
const defaultLangSelect = document.getElementById("defaultLang");
const enabledCheckbox = document.getElementById("enabled");
const statusEl = document.getElementById("status");
const modeLocalBtn = document.getElementById("modeLocal");
const modeCloudBtn = document.getElementById("modeCloud");
const modeHint = document.getElementById("modeHint");

const modelSection = document.getElementById("modelSection");
const downloadBtn = document.getElementById("downloadBtn");
const downloadStatus = document.getElementById("downloadStatus");
const progressBar = document.getElementById("progressBar");
const progressFill = document.getElementById("progressFill");

let currentMode = "cloud";
let currentProvider = "claude";

function showSaved() {
  statusEl.textContent = "Saved!";
  clearTimeout(showSaved._timer);
  showSaved._timer = setTimeout(() => { statusEl.textContent = ""; }, 1500);
}

function refreshFieldVisibility() {
  const isLocal = currentMode === "local";
  const showClaude = !isLocal && currentProvider === "claude";
  const showOpenAI = !isLocal && currentProvider === "openai";

  cloudProviderField.style.display = isLocal ? "none" : "";
  apiKeyField.style.display = showClaude ? "" : "none";
  claudeModelField.style.display = showClaude ? "" : "none";
  openaiKeyField.style.display = showOpenAI ? "" : "none";
  openaiModelField.style.display = showOpenAI ? "" : "none";
  modelSection.style.display = isLocal ? "" : "none";

  modeHint.textContent = isLocal
    ? "OPUS-MT models running locally. First use downloads ~300 MB per language pair."
    : currentProvider === "openai"
      ? "Uses your ChatGPT Plus subscription via the Codex CLI."
      : "Uses the Claude API — your API key or a Claude Code sign-in.";
}

function setProvider(provider) {
  currentProvider = provider;
  providerClaudeBtn.classList.toggle("active", provider === "claude");
  providerOpenAIBtn.classList.toggle("active", provider === "openai");
  refreshFieldVisibility();
}

function setMode(mode) {
  currentMode = mode;
  modeLocalBtn.classList.toggle("active", mode === "local");
  modeCloudBtn.classList.toggle("active", mode === "cloud");
  refreshFieldVisibility();
}

modeLocalBtn.addEventListener("click", async () => {
  setMode("local");
  await window.api.saveSettings({ translationMode: "local" });
  showSaved();
});
modeCloudBtn.addEventListener("click", async () => {
  setMode("cloud");
  await window.api.saveSettings({ translationMode: "cloud" });
  showSaved();
});

providerClaudeBtn.addEventListener("click", async () => {
  setProvider("claude");
  setMode("cloud"); // refresh visibility
  await window.api.saveSettings({ cloudProvider: "claude" });
  showSaved();
});
providerOpenAIBtn.addEventListener("click", async () => {
  setProvider("openai");
  setMode("cloud"); // refresh visibility
  await window.api.saveSettings({ cloudProvider: "openai" });
  showSaved();
});

// Load current settings
async function loadSettings() {
  try {
    const settings = await window.api.getSettings();
    apiKeyInput.value = settings.apiKey || "";
    claudeModelSelect.value = settings.claudeModel || "claude-haiku-4-5";
    if (!claudeModelSelect.value) claudeModelSelect.value = "claude-haiku-4-5";
    openaiModelInput.value = settings.openaiModel || "";
    defaultLangSelect.value = settings.defaultTargetLang || "";
    updateCodexStatus();
    enabledCheckbox.checked = settings.enabled !== false;
    setProvider(settings.cloudProvider || "claude");
    setMode(settings.translationMode || "cloud");

    const shortcuts = settings.shortcuts || {};
    for (const input of shortcutInputs) {
      input.dataset.accelerator = shortcuts[input.dataset.lang] || "";
      input.value = prettyAccelerator(input.dataset.accelerator);
    }
  } catch {
    statusEl.textContent = "Failed to load settings";
  }
}

loadSettings();

// Instant-save: all fields save on change
defaultLangSelect.addEventListener("change", async () => {
  await window.api.saveSettings({ defaultTargetLang: defaultLangSelect.value });
  showSaved();
});

enabledCheckbox.addEventListener("change", async () => {
  await window.api.saveSettings({ enabled: enabledCheckbox.checked });
  showSaved();
});

// API key saves on blur (not every keystroke) or Enter
async function saveApiKey() {
  const key = apiKeyInput.value.trim();
  await window.api.saveSettings({ apiKey: key });
  showSaved();
}

apiKeyInput.addEventListener("blur", saveApiKey);
apiKeyInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    saveApiKey();
  }
});

// Model selection
claudeModelSelect.addEventListener("change", async () => {
  await window.api.saveSettings({ claudeModel: claudeModelSelect.value });
  showSaved();
});

async function saveOpenAIModel() {
  const model = openaiModelInput.value.trim() || "gpt-5.4-mini";
  openaiModelInput.value = model;
  await window.api.saveSettings({ openaiModel: model });
  showSaved();
}
openaiModelInput.addEventListener("blur", saveOpenAIModel);
openaiModelInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    saveOpenAIModel();
  }
});

// ─── Global Shortcut Recording ───────────────────────────────────────────────

// Map a keydown event to an Electron accelerator string, or null if the
// combo is unusable (no non-shift modifier, or a bare modifier key).
function eventToAccelerator(e) {
  const mods = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Command");
  if (!e.ctrlKey && !e.altKey && !e.metaKey) return null;

  let key = e.key;
  if (["Control", "Alt", "Shift", "Meta"].includes(key)) return null;
  if (key === " ") key = "Space";
  else if (key.length === 1) key = key.toUpperCase();
  // e.key gives the char produced with modifiers; for letters/digits use e.code
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);

  return [...mods, key].join("+");
}

function prettyAccelerator(acc) {
  if (!acc) return "";
  return acc
    .replace("Ctrl", "⌃")
    .replace("Alt", "⌥")
    .replace("Shift", "⇧")
    .replace("Command", "⌘")
    .replace(/\+/g, "");
}

async function saveShortcut(input, accelerator) {
  input.dataset.accelerator = accelerator;
  input.value = prettyAccelerator(accelerator);
  shortcutError.textContent = "";

  const result = await window.api.saveSettings({
    shortcuts: { [input.dataset.lang]: accelerator },
  });
  if (result.failedShortcuts && result.failedShortcuts[input.dataset.lang]) {
    shortcutError.textContent = `${prettyAccelerator(accelerator)} is taken by another app — pick a different combo.`;
  } else {
    showSaved();
  }
}

for (const input of shortcutInputs) {
  input.addEventListener("focus", () => {
    input.classList.add("recording");
    input.placeholder = "press keys…";
  });
  input.addEventListener("blur", () => {
    input.classList.remove("recording");
    input.placeholder = "click to record";
    input.value = prettyAccelerator(input.dataset.accelerator || "");
  });
  input.addEventListener("keydown", (e) => {
    e.preventDefault();
    if (e.key === "Escape") {
      input.blur();
      return;
    }
    if (e.key === "Backspace" || e.key === "Delete") {
      saveShortcut(input, ""); // clear — shortcut disabled
      input.blur();
      return;
    }
    const accelerator = eventToAccelerator(e);
    if (!accelerator) return; // incomplete combo — keep recording
    saveShortcut(input, accelerator);
    input.blur();
  });
}

async function updateCodexStatus() {
  try {
    const status = await window.api.getCodexStatus();
    codexStatusEl.textContent = status.authorized ? "Authorized ✓" : "Not authorized";
    codexStatusEl.className = "codex-status " + (status.authorized ? "ok" : "err");
  } catch {
    codexStatusEl.textContent = "Unknown";
    codexStatusEl.className = "codex-status err";
  }
}

// ─── Model Download ──────────────────────────────────────────────────────────

downloadBtn.addEventListener("click", async () => {
  downloadBtn.disabled = true;
  downloadBtn.textContent = "Downloading...";
  downloadStatus.textContent = "Preparing...";
  downloadStatus.className = "download-status";
  progressBar.style.display = "";
  progressFill.style.width = "0%";

  try {
    const result = await window.api.downloadModels();

    if (result.error) {
      downloadStatus.textContent = "Error: " + result.error;
      downloadBtn.disabled = false;
      downloadBtn.textContent = "Retry Download";
      progressBar.style.display = "none";
    } else {
      downloadStatus.textContent = "All models ready!";
      downloadStatus.className = "download-status done";
      progressFill.style.width = "100%";
      downloadBtn.textContent = "Downloaded";
    }
  } catch {
    downloadStatus.textContent = "Download failed";
    downloadBtn.disabled = false;
    downloadBtn.textContent = "Retry Download";
    progressBar.style.display = "none";
  }
});

window.api.onDownloadProgress((data) => {
  if (data.status === "model") {
    downloadStatus.textContent = `Model ${data.current}/${data.total}: ${data.pair}`;
    progressFill.style.width = "0%";
  } else if (data.status === "progress" && data.progress != null) {
    const pct = Math.round(data.progress);
    progressFill.style.width = pct + "%";
    const file = data.file ? data.file.split("/").pop() : "";
    downloadStatus.textContent = `Downloading ${file}... ${pct}%`;
  }
});

const apiKeyInput = document.getElementById("apiKey");
const apiKeyField = document.getElementById("apiKeyField");
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

function showSaved() {
  statusEl.textContent = "Saved!";
  clearTimeout(showSaved._timer);
  showSaved._timer = setTimeout(() => { statusEl.textContent = ""; }, 1500);
}

function setMode(mode) {
  currentMode = mode;

  modeLocalBtn.classList.toggle("active", mode === "local");
  modeCloudBtn.classList.toggle("active", mode === "cloud");

  // Hide API key field in local mode, show model section
  apiKeyField.style.display = mode === "local" ? "none" : "";
  modelSection.style.display = mode === "local" ? "" : "none";

  // Update hint text
  modeHint.textContent =
    mode === "local"
      ? "OPUS-MT models running locally. First use downloads ~300 MB per language pair."
      : "Uses Claude Haiku via Anthropic API or CLI.";
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

// Load current settings
async function loadSettings() {
  try {
    const settings = await window.api.getSettings();
    apiKeyInput.value = settings.apiKey || "";
    defaultLangSelect.value = settings.defaultTargetLang || "";
    enabledCheckbox.checked = settings.enabled !== false;
    setMode(settings.translationMode || "cloud");
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

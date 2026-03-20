const apiKeyInput = document.getElementById("apiKey");
const apiKeyField = document.getElementById("apiKeyField");
const defaultLangSelect = document.getElementById("defaultLang");
const enabledCheckbox = document.getElementById("enabled");
const saveBtn = document.getElementById("saveBtn");
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

modeLocalBtn.addEventListener("click", () => {
  setMode("local");
  window.api.saveSettings({ translationMode: "local" });
});
modeCloudBtn.addEventListener("click", () => {
  setMode("cloud");
  window.api.saveSettings({ translationMode: "cloud" });
});

// Load current settings
async function loadSettings() {
  const settings = await window.api.getSettings();
  apiKeyInput.value = settings.apiKey || "";
  defaultLangSelect.value = settings.defaultTargetLang || "";
  enabledCheckbox.checked = settings.enabled !== false;
  setMode(settings.translationMode || "cloud");
}

loadSettings();

// Save settings
saveBtn.addEventListener("click", async () => {
  const settings = {
    apiKey: apiKeyInput.value.trim(),
    defaultTargetLang: defaultLangSelect.value,
    enabled: enabledCheckbox.checked,
    translationMode: currentMode,
  };

  await window.api.saveSettings(settings);

  statusEl.textContent = "Saved!";
  setTimeout(() => {
    statusEl.textContent = "";
  }, 2000);
});

// Save on Enter in API key field
apiKeyInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    saveBtn.click();
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

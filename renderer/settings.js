const apiKeyInput = document.getElementById("apiKey");
const apiKeyField = document.getElementById("apiKeyField");
const defaultLangSelect = document.getElementById("defaultLang");
const enabledCheckbox = document.getElementById("enabled");
const saveBtn = document.getElementById("saveBtn");
const statusEl = document.getElementById("status");
const modeLocalBtn = document.getElementById("modeLocal");
const modeCloudBtn = document.getElementById("modeCloud");
const modeHint = document.getElementById("modeHint");

let currentMode = "cloud";

function setMode(mode) {
  currentMode = mode;

  modeLocalBtn.classList.toggle("active", mode === "local");
  modeCloudBtn.classList.toggle("active", mode === "cloud");

  // Hide API key field in local mode
  apiKeyField.style.display = mode === "local" ? "none" : "";

  // Update hint text
  modeHint.textContent =
    mode === "local"
      ? "OPUS-MT models running locally. First use downloads ~300 MB per language pair."
      : "Uses Claude Haiku via Anthropic API or CLI.";
}

modeLocalBtn.addEventListener("click", () => setMode("local"));
modeCloudBtn.addEventListener("click", () => setMode("cloud"));

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

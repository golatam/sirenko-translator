const apiKeyInput = document.getElementById("apiKey");
const defaultLangSelect = document.getElementById("defaultLang");
const enabledCheckbox = document.getElementById("enabled");
const saveBtn = document.getElementById("saveBtn");
const statusEl = document.getElementById("status");

// Load current settings
async function loadSettings() {
  const settings = await window.api.getSettings();
  apiKeyInput.value = settings.apiKey || "";
  defaultLangSelect.value = settings.defaultTargetLang || "";
  enabledCheckbox.checked = settings.enabled !== false;
}

loadSettings();

// Save settings
saveBtn.addEventListener("click", async () => {
  const settings = {
    apiKey: apiKeyInput.value.trim(),
    defaultTargetLang: defaultLangSelect.value,
    enabled: enabledCheckbox.checked,
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

const targetLangSelect = document.getElementById("targetLang");
const closeBtn = document.getElementById("closeBtn");
const sourcePreview = document.getElementById("sourcePreview");
const translationArea = document.getElementById("translationArea");
const loading = document.getElementById("loading");
const errorMsg = document.getElementById("errorMsg");
const copyBtn = document.getElementById("copyBtn");
const replaceBtn = document.getElementById("replaceBtn");
const translateBtn = document.getElementById("translateBtn");

const modeBadge = document.getElementById("modeBadge");

let currentSourceText = "";
let requestId = 0; // guard against stale translation responses

// Listen for translation requests from main process
window.api.onTranslationRequest((data) => {
  currentSourceText = data.text;

  // Show mode badge
  const mode = data.translationMode || "cloud";
  modeBadge.textContent = mode === "local" ? "LOCAL" : "CLOUD";
  modeBadge.className = "mode-badge " + mode;

  // Auto-detect: Cyrillic → English, otherwise → Russian
  const hasCyrillic = (data.text.match(/[\u0400-\u04FF]/g) || []).length;
  const hasLetters = (data.text.match(/\p{L}/gu) || []).length;
  const isRussian = hasLetters > 0 && hasCyrillic / hasLetters > 0.5;
  const defaultTarget = data.targetLang || (isRussian ? "en" : "ru");

  targetLangSelect.value = defaultTarget;

  sourcePreview.textContent =
    currentSourceText.length > 150
      ? currentSourceText.substring(0, 150) + "..."
      : currentSourceText;

  // Reset UI
  translationArea.value = "";
  errorMsg.classList.add("hidden");
  loading.classList.add("hidden");
  translateBtn.classList.remove("hidden");
  translateBtn.textContent = "Translate ▶";

  // Auto-translate when triggered via global shortcut
  if (data.autoTranslate) {
    startTranslation();
  }
});

// Manual translate button
translateBtn.addEventListener("click", () => {
  startTranslation();
});

// Language changed — translate immediately
targetLangSelect.addEventListener("change", () => {
  if (currentSourceText) {
    startTranslation();
  }
});

async function startTranslation() {
  if (!currentSourceText) return;

  const id = ++requestId;

  translateBtn.classList.add("hidden");
  loading.classList.remove("hidden");
  errorMsg.classList.add("hidden");
  translationArea.value = "";
  window.api.setBusy(true);

  const result = await window.api.translate(
    currentSourceText,
    targetLangSelect.value || undefined
  );

  window.api.setBusy(false);

  // Discard stale response if a newer request was made
  if (id !== requestId) return;

  loading.classList.add("hidden");

  if (result.error) {
    errorMsg.textContent = result.error;
    errorMsg.classList.remove("hidden");
    translateBtn.classList.remove("hidden");
    return;
  }

  translationArea.value = result.translation;

  if (result.targetLang && !targetLangSelect.value) {
    targetLangSelect.value = result.targetLang;
  }
}

// Button actions
closeBtn.addEventListener("click", () => {
  window.api.setBusy(false);
  window.api.closePopup();
});

copyBtn.addEventListener("click", async () => {
  const text = translationArea.value;
  if (!text) return;

  await window.api.copyToClipboard(text);

  copyBtn.textContent = "Copied!";
  copyBtn.classList.add("copied");
  setTimeout(() => {
    copyBtn.textContent = "Copy";
    copyBtn.classList.remove("copied");
  }, 1500);
});

replaceBtn.addEventListener("click", async () => {
  const text = translationArea.value;
  if (!text) return;
  await window.api.replaceInApp(text);
});

// Keyboard shortcuts
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    window.api.setBusy(false);
    window.api.closePopup();
  }
  if (e.key === "Enter" && !e.shiftKey && !translationArea.value) {
    e.preventDefault();
    startTranslation();
  }
});

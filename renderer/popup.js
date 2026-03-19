const targetLangSelect = document.getElementById("targetLang");
const closeBtn = document.getElementById("closeBtn");
const sourcePreview = document.getElementById("sourcePreview");
const translationArea = document.getElementById("translationArea");
const loading = document.getElementById("loading");
const errorMsg = document.getElementById("errorMsg");
const copyBtn = document.getElementById("copyBtn");
const replaceBtn = document.getElementById("replaceBtn");
const translateBtn = document.getElementById("translateBtn");

let currentSourceText = "";
let requestId = 0; // guard against stale translation responses

// Listen for translation requests from main process
window.api.onTranslationRequest((data) => {
  currentSourceText = data.text;

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

  const result = await window.api.translate(
    currentSourceText,
    targetLangSelect.value || undefined
  );

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
    window.api.closePopup();
  }
  if (e.key === "Enter" && !e.shiftKey && !translationArea.value) {
    e.preventDefault();
    startTranslation();
  }
});

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

/**
 * Detect language in renderer (mirrors lang-detect.js logic).
 * Returns "ru", "es", or "en".
 */
function detectLanguageLocal(text) {
  const letters = (text.match(/\p{L}/gu) || []);
  if (letters.length === 0) return "en";

  const cyrillicCount = (text.match(/[\u0400-\u04FF]/g) || []).length;
  if (cyrillicCount / letters.length > 0.5) return "ru";

  const spanishChars = (text.match(/[ñÑáéíóúüÁÉÍÓÚÜ¿¡]/g) || []).length;
  if (spanishChars >= 2) return "es";

  const lowerText = text.toLowerCase();
  const spanishWords =
    /\b(el|los|las|del|por|para|con|una|uno|como|más|pero|que|esta|fue|hay|puede|todos|así|entre|cuando|muy|sin|sobre|después|tiene|desde|están|donde|antes|esos?|estas?|aunque|cada|hacia|porque|alguna?|entonces|ahora|durante|siempre|además|mejor|hacer|también|nuevo|otro)\b/g;
  const spanishHits = (lowerText.match(spanishWords) || []).length;
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount >= 3 && spanishHits / wordCount > 0.15) return "es";

  return "en";
}

// Listen for translation requests from main process
window.api.onTranslationRequest((data) => {
  currentSourceText = data.text;

  // Show mode badge
  const mode = data.translationMode || "cloud";
  if (mode === "local") {
    modeBadge.textContent = "LOCAL";
    modeBadge.className = "mode-badge local";
  } else {
    const provider = data.cloudProvider || "claude";
    modeBadge.textContent = provider === "openai" ? "GPT" : "CLAUDE";
    modeBadge.className = "mode-badge cloud";
  }

  // Auto-detect source and pick target
  const detectedSrc = detectLanguageLocal(data.text);
  let defaultTarget = data.targetLang;
  // If the detected source matches the target, pick an alternative
  if (detectedSrc === defaultTarget) {
    defaultTarget = detectedSrc === "ru" ? "en" : "ru";
  }

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

  // Auto-translate: global shortcut or double-copy
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

// Handle streaming chunks from cloud translation
let streamingForId = 0;
window.api.onTranslationChunk((chunk) => {
  // Only accept chunks for the current request
  if (streamingForId !== requestId) return;

  // Hide loading on first chunk — text is arriving
  if (loading.classList.contains("hidden") === false) {
    loading.classList.add("hidden");
  }
  translationArea.value += chunk;
});

async function startTranslation() {
  if (!currentSourceText) return;

  const id = ++requestId;
  streamingForId = id;

  translateBtn.classList.add("hidden");
  loading.classList.remove("hidden");
  errorMsg.classList.add("hidden");
  translationArea.value = "";
  window.api.setBusy(true);

  try {
    const result = await window.api.translate(
      currentSourceText,
      targetLangSelect.value || undefined
    );

    // Only release busy if this is still the current request
    if (id === requestId) {
      window.api.setBusy(false);
    }

    // Discard stale response if a newer request was made
    if (id !== requestId) return;

    loading.classList.add("hidden");

    if (result.error) {
      if (result.error === "cancelled") return;
      errorMsg.textContent = result.error;
      errorMsg.classList.remove("hidden");
      translateBtn.classList.remove("hidden");
      return;
    }

    // For non-streaming (local mode), set the full result
    // For streaming (cloud mode), text was already set via chunks —
    // use the final trimmed result as authoritative
    translationArea.value = result.translation;

    if (result.targetLang && !targetLangSelect.value) {
      targetLangSelect.value = result.targetLang;
    }
  } catch (err) {
    if (id === requestId) {
      window.api.setBusy(false);
      loading.classList.add("hidden");
      errorMsg.textContent = err.message || "Translation failed";
      errorMsg.classList.remove("hidden");
      translateBtn.classList.remove("hidden");
    }
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

  try {
    await window.api.copyToClipboard(text);

    copyBtn.textContent = "Copied!";
    copyBtn.classList.add("copied");
    setTimeout(() => {
      copyBtn.textContent = "Copy";
      copyBtn.classList.remove("copied");
    }, 1500);
  } catch {
    errorMsg.textContent = "Failed to copy";
    errorMsg.classList.remove("hidden");
  }
});

replaceBtn.addEventListener("click", async () => {
  const text = translationArea.value;
  if (!text) return;
  try {
    await window.api.replaceInApp(text);
  } catch {
    errorMsg.textContent = "Failed to replace";
    errorMsg.classList.remove("hidden");
  }
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

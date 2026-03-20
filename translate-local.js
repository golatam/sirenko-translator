// ─── Local Translation via OPUS-MT (Helsinki-NLP) ──────────────────────────
//
// Uses @xenova/transformers to run OPUS-MT models locally in ONNX Runtime.
// Models are downloaded on first use (~300 MB per language pair) and cached.

// Pipeline cache: keyed by "srcLang-tgtLang"
const pipelineCache = new Map();

// Direct model mapping for supported language pairs
const MODEL_MAP = {
  "ru-en": "Xenova/opus-mt-ru-en",
  "en-ru": "Xenova/opus-mt-en-ru",
  "en-es": "Xenova/opus-mt-en-es",
  "es-en": "Xenova/opus-mt-es-en",
  "ru-es": "Xenova/opus-mt-ru-es",
  "es-ru": "Xenova/opus-mt-es-ru",
};

// Loading state to show progress to the user
let onProgress = null;

function setProgressCallback(cb) {
  onProgress = cb;
}

/**
 * Get or create a translation pipeline for a language pair.
 */
async function getPipeline(srcLang, tgtLang) {
  const key = `${srcLang}-${tgtLang}`;

  if (pipelineCache.has(key)) {
    return pipelineCache.get(key);
  }

  const modelName = MODEL_MAP[key];
  if (!modelName) {
    throw new Error(`No local model available for ${srcLang} → ${tgtLang}`);
  }

  // Dynamic import since @xenova/transformers may use ESM internals
  const { pipeline } = await import("@xenova/transformers");

  const progressCallback = onProgress
    ? (data) => {
        if (data.status === "download" || data.status === "progress") {
          onProgress({
            status: data.status,
            file: data.file,
            progress: data.progress,
            loaded: data.loaded,
            total: data.total,
          });
        }
      }
    : undefined;

  const translator = await pipeline("translation", modelName, {
    progress_callback: progressCallback,
  });

  pipelineCache.set(key, translator);
  return translator;
}

/**
 * Detect source language from text (mirrors detectLanguage in translate.js).
 */
function detectSourceLang(text) {
  const cyrillicCount = (text.match(/[\u0400-\u04FF]/g) || []).length;
  const letterCount = (text.match(/\p{L}/gu) || []).length;
  if (letterCount === 0) return "en";
  return cyrillicCount / letterCount > 0.5 ? "ru" : "en";
}

/**
 * Translate text locally using OPUS-MT.
 *
 * @param {string} text - Text to translate
 * @param {string} targetLang - Target language code (en, ru, es)
 * @returns {{ translation: string, detectedSource: string, targetLang: string }}
 */
async function translateLocal(text, targetLang) {
  const srcLang = detectSourceLang(text);

  if (srcLang === targetLang) {
    // Same language — return as-is
    return { translation: text, detectedSource: srcLang, targetLang };
  }

  const translator = await getPipeline(srcLang, targetLang);
  const result = await translator(text, { max_length: 512 });

  return {
    translation: result[0].translation_text,
    detectedSource: srcLang,
    targetLang,
  };
}

/**
 * Pre-download all models for a given target language.
 * Downloads both directions: ru↔target, en↔target (skipping identity pairs).
 */
async function downloadModels(targetLang, progressCallback) {
  const pairs = Object.keys(MODEL_MAP).filter(
    (key) => key.endsWith(`-${targetLang}`) || key.startsWith(`${targetLang}-`)
  );

  const oldCb = onProgress;
  onProgress = progressCallback;

  for (let i = 0; i < pairs.length; i++) {
    const [src, tgt] = pairs[i].split("-");
    if (progressCallback) {
      progressCallback({
        status: "model",
        current: i + 1,
        total: pairs.length,
        pair: pairs[i],
      });
    }
    await getPipeline(src, tgt);
  }

  onProgress = oldCb;
}

module.exports = { translateLocal, setProgressCallback, downloadModels, MODEL_MAP };

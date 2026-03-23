// ─── Worker Thread: Local Translation via OPUS-MT ───────────────────────────
//
// Runs in a separate thread to avoid blocking Electron's main process.
// Communicates via postMessage/onmessage with translate-local.js.

const { parentPort } = require("worker_threads");

const pipelineCache = new Map();

const MODEL_MAP = {
  "ru-en": "Xenova/opus-mt-ru-en",
  "en-ru": "Xenova/opus-mt-en-ru",
  "en-es": "Xenova/opus-mt-en-es",
  "es-en": "Xenova/opus-mt-es-en",
  "ru-es": "Xenova/opus-mt-ru-es",
  "es-ru": "Xenova/opus-mt-es-ru",
};

/**
 * Detect language (mirrors lang-detect.js — duplicated here because
 * worker_threads run in a separate context and cannot share require cache
 * with the main thread).
 */
function detectLanguage(text) {
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

async function getPipeline(srcLang, tgtLang, requestId) {
  const key = `${srcLang}-${tgtLang}`;

  if (pipelineCache.has(key)) {
    return pipelineCache.get(key);
  }

  const modelName = MODEL_MAP[key];
  if (!modelName) {
    throw new Error(`No local model available for ${srcLang} → ${tgtLang}`);
  }

  const { pipeline } = await import("@xenova/transformers");

  const translator = await pipeline("translation", modelName, {
    progress_callback: (data) => {
      if (data.status === "download" || data.status === "progress") {
        parentPort.postMessage({
          type: "progress",
          id: requestId,
          data: {
            status: data.status,
            file: data.file,
            progress: data.progress,
            loaded: data.loaded,
            total: data.total,
          },
        });
      }
    },
  });

  pipelineCache.set(key, translator);
  return translator;
}

async function handleTranslate(msg) {
  const srcLang = detectLanguage(msg.text);

  if (srcLang === msg.targetLang) {
    return { translation: msg.text, detectedSource: srcLang, targetLang: msg.targetLang };
  }

  const translator = await getPipeline(srcLang, msg.targetLang, msg.id);
  const result = await translator(msg.text, { max_length: 512 });

  return {
    translation: result[0].translation_text,
    detectedSource: srcLang,
    targetLang: msg.targetLang,
  };
}

async function handleDownload(msg) {
  const pairs = Object.keys(MODEL_MAP).filter(
    (key) => key.endsWith(`-${msg.targetLang}`) || key.startsWith(`${msg.targetLang}-`)
  );

  for (let i = 0; i < pairs.length; i++) {
    const [src, tgt] = pairs[i].split("-");
    parentPort.postMessage({
      type: "progress",
      id: msg.id,
      data: {
        status: "model",
        current: i + 1,
        total: pairs.length,
        pair: pairs[i],
      },
    });
    await getPipeline(src, tgt, msg.id);
  }

  return { success: true };
}

parentPort.on("message", async (msg) => {
  try {
    let result;
    if (msg.type === "translate") {
      result = await handleTranslate(msg);
    } else if (msg.type === "download") {
      result = await handleDownload(msg);
    } else {
      throw new Error(`Unknown message type: ${msg.type}`);
    }
    parentPort.postMessage({ type: "result", id: msg.id, result });
  } catch (err) {
    parentPort.postMessage({ type: "error", id: msg.id, error: err.message });
  }
});

// ─── Local Translation Manager ──────────────────────────────────────────────
//
// Thin wrapper that delegates all heavy work (ONNX model loading, inference)
// to a worker thread, keeping Electron's main process responsive.

const { Worker } = require("worker_threads");
const path = require("path");

let worker = null;
let requestId = 0;
const pending = new Map(); // id → { resolve, reject, onProgress }

// Direct model mapping — exported for settings UI
const MODEL_MAP = {
  "ru-en": "Xenova/opus-mt-ru-en",
  "en-ru": "Xenova/opus-mt-en-ru",
  "en-es": "Xenova/opus-mt-en-es",
  "es-en": "Xenova/opus-mt-es-en",
  "ru-es": "Xenova/opus-mt-ru-es",
  "es-ru": "Xenova/opus-mt-es-ru",
};

function getWorker() {
  if (worker) return worker;

  worker = new Worker(path.join(__dirname, "translate-local-worker.js"));

  worker.on("message", (msg) => {
    if (msg.type === "progress") {
      const p = pending.get(msg.id);
      if (p && p.onProgress) p.onProgress(msg.data);
      return;
    }

    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);

    if (msg.type === "error") {
      p.reject(new Error(msg.error));
    } else {
      p.resolve(msg.result);
    }
  });

  worker.on("error", (err) => {
    // Reject all pending requests
    for (const [id, p] of pending) {
      p.reject(err);
    }
    pending.clear();
    worker = null;
  });

  worker.on("exit", (code) => {
    if (code !== 0) {
      for (const [id, p] of pending) {
        p.reject(new Error(`Worker exited with code ${code}`));
      }
      pending.clear();
    }
    worker = null;
  });

  return worker;
}

/**
 * Translate text locally via worker thread.
 */
async function translateLocal(text, targetLang) {
  const id = ++requestId;
  const w = getWorker();

  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ type: "translate", id, text, targetLang });
  });
}

/**
 * Pre-download models for a target language via worker thread.
 */
async function downloadModels(targetLang, progressCallback) {
  const id = ++requestId;
  const w = getWorker();

  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress: progressCallback });
    w.postMessage({ type: "download", id, targetLang });
  });
}

/**
 * Terminate the worker (call on app quit).
 */
function terminateWorker() {
  if (worker) {
    worker.terminate();
    worker = null;
  }
}

module.exports = { translateLocal, downloadModels, terminateWorker, MODEL_MAP };

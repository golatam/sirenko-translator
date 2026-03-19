const { execSync, spawn } = require("child_process");
const os = require("os");
const fs = require("fs");

// ─── Cached state ───────────────────────────────────────────────────────────

let cachedKeychainToken = undefined; // undefined = not checked yet
let cachedClaudePath = undefined;

/**
 * Check if Claude CLI auth exists in macOS Keychain (cached).
 */
function getKeychainToken() {
  if (cachedKeychainToken !== undefined) return cachedKeychainToken;
  try {
    const raw = execSync(
      'security find-generic-password -s "Claude Code-credentials" -w',
      { encoding: "utf-8", timeout: 5000 }
    ).trim();
    const parsed = JSON.parse(raw);
    cachedKeychainToken = parsed?.claudeAiOauth?.accessToken ? "oauth" : null;
  } catch {
    cachedKeychainToken = null;
  }
  return cachedKeychainToken;
}

/**
 * Resolve claude CLI path (cached).
 */
function getClaudePath() {
  if (cachedClaudePath !== undefined) return cachedClaudePath;
  const home = os.homedir();
  const candidates = [
    `${home}/.local/bin/claude`,
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
  ];
  cachedClaudePath = candidates.find((p) => fs.existsSync(p)) || "claude";
  return cachedClaudePath;
}

// ─── Shared language config ─────────────────────────────────────────────────

const LANGUAGES = {
  en: "English",
  es: "Spanish",
  ru: "Russian",
};

/**
 * Detect if text contains Cyrillic characters (Russian).
 */
function detectLanguage(text) {
  const cyrillicCount = (text.match(/[\u0400-\u04FF]/g) || []).length;
  const letterCount = (text.match(/\p{L}/gu) || []).length;
  if (letterCount === 0) return "other";
  return cyrillicCount / letterCount > 0.5 ? "ru" : "other";
}

/**
 * Auto-select target language based on source text.
 */
function autoTargetLang(text) {
  return detectLanguage(text) === "ru" ? "en" : "ru";
}

/**
 * Translate text using Claude API or CLI.
 */
async function translate(text, apiKey, targetLang) {
  if (!targetLang) {
    targetLang = autoTargetLang(text);
  }

  const target = LANGUAGES[targetLang] || "English";

  // Direct SDK path for regular API keys
  if (apiKey && apiKey.startsWith("sk-ant-api")) {
    const Anthropic = require("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system:
        "You are a translator. Translate the given text to " +
        target +
        ". Output ONLY the translation, nothing else. Preserve formatting.",
      messages: [{ role: "user", content: text }],
    });
    return {
      translation: message.content[0].text,
      detectedSource: detectLanguage(text) === "ru" ? "ru" : "auto",
      targetLang,
    };
  }

  // Claude CLI path (async spawn, works with OAuth subscription)
  const prompt = `Translate to ${target}:\n\n${text}`;
  const translation = await spawnClaude(prompt);

  return {
    translation,
    detectedSource: detectLanguage(text) === "ru" ? "ru" : "auto",
    targetLang,
  };
}

/**
 * Run claude CLI asynchronously via spawn (non-blocking).
 */
function spawnClaude(prompt) {
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      "--model", "claude-haiku-4-5-20251001",
      "--append-system-prompt",
      "You are a translator. Output ONLY the translation, nothing else. Preserve formatting.",
      prompt,
    ];

    const claudePath = getClaudePath();

    const proc = spawn(claudePath, args, {
      timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    proc.stdin.end();

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    proc.on("close", (code) => {
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim() || `claude exited with code ${code}`));
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to start claude CLI: ${err.message}`));
    });
  });
}

module.exports = { translate, detectLanguage, autoTargetLang, getKeychainToken, LANGUAGES };

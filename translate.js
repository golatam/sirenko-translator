const { execFile } = require("child_process");
const https = require("https");
const { detectLanguage, autoTargetLang, LANGUAGES } = require("./lang-detect");

// ─── Constants ──────────────────────────────────────────────────────────────

const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before expiry

// ─── Cached state ───────────────────────────────────────────────────────────

let cachedOauth = undefined; // full { accessToken, refreshToken, expiresAt, ... }
let cachedClient = null;
let cachedClientKey = null;
let refreshInProgress = null; // dedup concurrent refreshes

/**
 * Read raw credentials JSON from macOS Keychain.
 */
async function readKeychainCredentials() {
  const raw = await new Promise((resolve, reject) => {
    execFile(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
      { encoding: "utf-8", timeout: 5000 },
      (err, stdout) => (err ? reject(err) : resolve(stdout.trim()))
    );
  });
  return JSON.parse(raw);
}

/**
 * Write updated credentials back to macOS Keychain.
 */
async function writeKeychainCredentials(credentials) {
  const json = JSON.stringify(credentials);
  // Delete old entry, then add new one
  await new Promise((resolve) => {
    execFile(
      "security",
      ["delete-generic-password", "-s", KEYCHAIN_SERVICE],
      { timeout: 5000 },
      () => resolve() // ignore errors (entry may not exist)
    );
  });
  await new Promise((resolve, reject) => {
    execFile(
      "security",
      ["add-generic-password", "-s", KEYCHAIN_SERVICE, "-U", "-w", json],
      { timeout: 5000 },
      (err) => (err ? reject(err) : resolve())
    );
  });
}

/**
 * Refresh an expired OAuth access token using the refresh token.
 * Returns the new OAuth object or throws on failure.
 */
async function refreshOAuthToken(refreshToken) {
  const body = JSON.stringify({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: OAUTH_CLIENT_ID,
  });

  return new Promise((resolve, reject) => {
    const url = new URL(OAUTH_TOKEN_URL);
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            return reject(new Error(`OAuth refresh failed (${res.statusCode}): ${data}`));
          }
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error("Failed to parse OAuth refresh response"));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/**
 * Perform the actual token refresh: call OAuth endpoint, update cache and Keychain.
 */
async function doRefresh() {
  if (!refreshInProgress) {
    refreshInProgress = (async () => {
      try {
        const resp = await refreshOAuthToken(cachedOauth.refreshToken);
        cachedOauth = {
          ...cachedOauth,
          accessToken: resp.access_token,
          refreshToken: resp.refresh_token || cachedOauth.refreshToken,
          expiresAt: resp.expires_in
            ? Date.now() + resp.expires_in * 1000
            : resp.expires_at || cachedOauth.expiresAt,
        };
        // Persist to Keychain
        try {
          const creds = await readKeychainCredentials();
          creds.claudeAiOauth = cachedOauth;
          await writeKeychainCredentials(creds);
        } catch { /* non-fatal: token works even if Keychain write fails */ }
        // Invalidate cached SDK client (token changed)
        cachedClient = null;
        cachedClientKey = null;
      } finally {
        refreshInProgress = null;
      }
    })();
  }
  await refreshInProgress;
}

/**
 * Load OAuth credentials from Keychain, refresh if expired,
 * and return the valid access token string or null.
 */
async function getKeychainToken() {
  // First load from Keychain if we haven't yet
  if (cachedOauth === undefined) {
    try {
      const creds = await readKeychainCredentials();
      cachedOauth = creds?.claudeAiOauth || null;
    } catch {
      cachedOauth = null;
    }
  }
  if (!cachedOauth?.accessToken) return null;

  // Check if token needs refresh
  const now = Date.now();
  if (cachedOauth.expiresAt && now >= cachedOauth.expiresAt - TOKEN_EXPIRY_BUFFER_MS) {
    if (!cachedOauth.refreshToken) return null;
    await doRefresh();
  }

  return cachedOauth.accessToken;
}

/**
 * Force-refresh the OAuth token (e.g. after a 401 error).
 * Returns new access token or null.
 */
async function forceRefreshKeychainToken() {
  if (!cachedOauth?.refreshToken) return null;
  await doRefresh();
  return cachedOauth?.accessToken || null;
}

/**
 * Get or create a reusable Anthropic SDK client.
 * Both API keys and OAuth tokens are sent via x-api-key header.
 */
function getClient(key) {
  if (cachedClient && cachedClientKey === key) return cachedClient;
  const Anthropic = require("@anthropic-ai/sdk");
  cachedClient = new Anthropic({ apiKey: key });
  cachedClientKey = key;
  return cachedClient;
}

/**
 * Translate text via Anthropic SDK with streaming.
 * Works with both API keys (sk-ant-api...) and OAuth tokens (sk-ant-oat...).
 *
 * @param {string} text
 * @param {string} apiKey - API key or OAuth token
 * @param {string} [targetLang]
 * @param {AbortSignal} [signal]
 * @param {(chunk: string) => void} [onChunk] - Called with each text chunk
 */
async function translate(text, apiKey, targetLang, signal, onChunk) {
  if (!targetLang) {
    targetLang = autoTargetLang(text);
  }

  if (signal?.aborted) throw new Error("Translation cancelled");

  const target = LANGUAGES[targetLang] || "English";
  const systemPrompt =
    "You are a translator. Translate the given text to " +
    target +
    ". Output ONLY the translation, nothing else. Preserve formatting.";

  const isOAuth = apiKey.startsWith("sk-ant-oat");
  let retried = false;

  const doTranslate = async (key) => {
    const client = getClient(key);
    const msgParams = {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: text }],
    };
    const reqOpts = signal ? { signal } : undefined;

    if (onChunk) {
      const stream = client.messages.stream(msgParams, reqOpts);
      let fullText = "";
      for await (const event of stream) {
        if (signal?.aborted) throw new Error("Translation cancelled");
        if (event.type === "content_block_delta" && event.delta?.text) {
          fullText += event.delta.text;
          onChunk(event.delta.text);
        }
      }
      return { translation: fullText, detectedSource: detectLanguage(text), targetLang };
    }

    const message = await client.messages.create(msgParams, reqOpts);
    return { translation: message.content[0].text, detectedSource: detectLanguage(text), targetLang };
  };

  try {
    return await doTranslate(apiKey);
  } catch (err) {
    // On 401 with OAuth token, try refreshing once
    if (!retried && isOAuth && err?.status === 401) {
      retried = true;
      const newToken = await forceRefreshKeychainToken();
      if (newToken) return doTranslate(newToken);
    }
    throw err;
  }
}

module.exports = { translate, detectLanguage, autoTargetLang, getKeychainToken, forceRefreshKeychainToken, LANGUAGES };

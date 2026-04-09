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

// ─── OpenAI Translation ────────────────────────────────────────────────────

const fs = require("fs");
const path = require("path");
const os = require("os");

const CODEX_AUTH_PATH = path.join(os.homedir(), ".codex", "auth.json");
const OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";

let cachedOpenAIOauth = undefined; // { accessToken, refreshToken, expiresAt, accountId }
let openaiRefreshInProgress = null;

/**
 * Read Codex CLI auth.json and extract OAuth tokens.
 */
function readCodexAuth() {
  const raw = fs.readFileSync(CODEX_AUTH_PATH, "utf-8");
  const data = JSON.parse(raw);
  if (!data.tokens?.access_token) return null;

  // Decode JWT to get expiry (payload is base64url in second segment)
  let expiresAt = null;
  try {
    const payload = JSON.parse(
      Buffer.from(data.tokens.access_token.split(".")[1], "base64url").toString()
    );
    expiresAt = payload.exp ? payload.exp * 1000 : null;
  } catch { /* ignore parse errors */ }

  return {
    accessToken: data.tokens.access_token,
    refreshToken: data.tokens.refresh_token,
    accountId: data.tokens.account_id,
    expiresAt,
  };
}

/**
 * Write updated tokens back to Codex auth.json.
 */
function writeCodexAuth(oauth) {
  try {
    const raw = fs.readFileSync(CODEX_AUTH_PATH, "utf-8");
    const data = JSON.parse(raw);
    data.tokens.access_token = oauth.accessToken;
    if (oauth.refreshToken) data.tokens.refresh_token = oauth.refreshToken;
    data.last_refresh = new Date().toISOString();
    fs.writeFileSync(CODEX_AUTH_PATH, JSON.stringify(data, null, 2), "utf-8");
  } catch { /* non-fatal */ }
}

/**
 * Refresh OpenAI OAuth token via auth.openai.com.
 */
async function refreshOpenAIToken(refreshToken) {
  const body = JSON.stringify({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: OPENAI_OAUTH_CLIENT_ID,
  });

  return new Promise((resolve, reject) => {
    const url = new URL(OPENAI_OAUTH_TOKEN_URL);
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
            return reject(new Error(`OpenAI OAuth refresh failed (${res.statusCode}): ${data}`));
          }
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error("Failed to parse OpenAI OAuth refresh response"));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function doOpenAIRefresh() {
  if (!openaiRefreshInProgress) {
    openaiRefreshInProgress = (async () => {
      try {
        const resp = await refreshOpenAIToken(cachedOpenAIOauth.refreshToken);
        cachedOpenAIOauth = {
          ...cachedOpenAIOauth,
          accessToken: resp.access_token,
          refreshToken: resp.refresh_token || cachedOpenAIOauth.refreshToken,
          expiresAt: resp.expires_in
            ? Date.now() + resp.expires_in * 1000
            : cachedOpenAIOauth.expiresAt,
        };
        writeCodexAuth(cachedOpenAIOauth);
      } finally {
        openaiRefreshInProgress = null;
      }
    })();
  }
  await openaiRefreshInProgress;
}

/**
 * Get OpenAI access token from Codex CLI auth, refreshing if needed.
 */
async function getCodexToken() {
  if (cachedOpenAIOauth === undefined) {
    try {
      cachedOpenAIOauth = readCodexAuth();
    } catch {
      cachedOpenAIOauth = null;
    }
  }
  if (!cachedOpenAIOauth?.accessToken) return null;

  const now = Date.now();
  if (cachedOpenAIOauth.expiresAt && now >= cachedOpenAIOauth.expiresAt - TOKEN_EXPIRY_BUFFER_MS) {
    if (!cachedOpenAIOauth.refreshToken) return null;
    await doOpenAIRefresh();
  }

  return cachedOpenAIOauth.accessToken;
}

async function forceRefreshCodexToken() {
  if (!cachedOpenAIOauth?.refreshToken) return null;
  await doOpenAIRefresh();
  return cachedOpenAIOauth?.accessToken || null;
}

/**
 * Translate text via ChatGPT backend (Responses API) with SSE streaming.
 * Uses Codex OAuth token from ~/.codex/auth.json.
 *
 * @param {string} text
 * @param {string} token - OAuth access token (JWT)
 * @param {string} [targetLang]
 * @param {AbortSignal} [signal]
 * @param {(chunk: string) => void} [onChunk]
 */
async function translateOpenAI(text, token, targetLang, signal, onChunk) {
  if (!targetLang) {
    targetLang = autoTargetLang(text);
  }

  if (signal?.aborted) throw new Error("Translation cancelled");

  const target = LANGUAGES[targetLang] || "English";
  const systemPrompt =
    "You are a translator. Translate the given text to " +
    target +
    ". Output ONLY the translation, nothing else. Preserve formatting.";

  let retried = false;

  const doTranslate = async (key) => {
    const accountId = cachedOpenAIOauth?.accountId;
    const body = JSON.stringify({
      model: "gpt-5.4-mini",
      instructions: systemPrompt,
      input: [{ role: "user", content: text }],
      store: false,
      stream: true,
    });

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: "chatgpt.com",
          path: "/backend-api/codex/responses",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + key,
            ...(accountId ? { "ChatGPT-Account-ID": accountId } : {}),
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          if (res.statusCode === 401) {
            let errData = "";
            res.on("data", (c) => (errData += c));
            res.on("end", () => {
              const err = new Error(errData || "Unauthorized");
              err.status = 401;
              reject(err);
            });
            return;
          }
          if (res.statusCode !== 200) {
            let errData = "";
            res.on("data", (c) => (errData += c));
            res.on("end", () => reject(new Error(`ChatGPT API error (${res.statusCode}): ${errData}`)));
            return;
          }

          let fullText = "";
          let buffer = "";

          res.on("data", (chunk) => {
            if (signal?.aborted) {
              req.destroy();
              reject(new Error("Translation cancelled"));
              return;
            }

            buffer += chunk.toString();
            const lines = buffer.split("\n");
            buffer = lines.pop(); // keep incomplete line

            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              try {
                const event = JSON.parse(line.slice(6));
                if (event.type === "response.output_text.delta" && event.delta) {
                  fullText += event.delta;
                  if (onChunk) onChunk(event.delta);
                }
              } catch { /* skip unparseable lines */ }
            }
          });

          res.on("end", () => {
            resolve({
              translation: fullText,
              detectedSource: detectLanguage(text),
              targetLang,
            });
          });
        }
      );

      if (signal) {
        signal.addEventListener("abort", () => req.destroy(), { once: true });
      }

      req.on("error", (err) => {
        if (signal?.aborted) reject(new Error("Translation cancelled"));
        else reject(err);
      });
      req.write(body);
      req.end();
    });
  };

  try {
    return await doTranslate(token);
  } catch (err) {
    if (!retried && err?.status === 401) {
      retried = true;
      const newToken = await forceRefreshCodexToken();
      if (newToken) return doTranslate(newToken);
    }
    throw err;
  }
}

module.exports = { translate, translateOpenAI, detectLanguage, autoTargetLang, getKeychainToken, forceRefreshKeychainToken, getCodexToken, forceRefreshCodexToken, LANGUAGES };

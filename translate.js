const { execFile } = require("child_process");
const https = require("https");
const { detectLanguage, autoTargetLang, LANGUAGES } = require("./lang-detect");

// ─── Constants ──────────────────────────────────────────────────────────────

const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before expiry

const DEFAULT_CLAUDE_MODEL = "claude-haiku-4-5";
const DEFAULT_OPENAI_MODEL = "gpt-5.4-mini";

// ─── Cached state ───────────────────────────────────────────────────────────

let cachedOauth = undefined; // full { accessToken, refreshToken, expiresAt, ... }
let cachedClient = null;
let cachedClientKey = null;
let refreshInProgress = null; // dedup concurrent refreshes

// On Windows, Claude Code CLI has no Keychain to piggyback on — it stores
// the same {claudeAiOauth: {accessToken, refreshToken, expiresAt}} shape
// as a plain JSON file instead.
function win32CredentialsPath() {
  const path = require("path");
  const os = require("os");
  return path.join(
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
    ".credentials.json"
  );
}

/**
 * Read raw credentials JSON from macOS Keychain (or its Windows file equivalent).
 */
async function readKeychainCredentials() {
  if (process.platform === "win32") {
    const fs = require("fs");
    return JSON.parse(fs.readFileSync(win32CredentialsPath(), "utf-8"));
  }

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
 * Write updated credentials back to macOS Keychain (or its Windows file equivalent).
 */
async function writeKeychainCredentials(credentials) {
  if (process.platform === "win32") {
    const fs = require("fs");
    fs.writeFileSync(win32CredentialsPath(), JSON.stringify(credentials));
    return;
  }

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
 * API keys (sk-ant-api...) go via x-api-key; OAuth tokens (sk-ant-oat...)
 * must go via Authorization: Bearer + the oauth beta header — the API
 * rejects them on x-api-key.
 */
function getClient(key) {
  if (cachedClient && cachedClientKey === key) return cachedClient;
  const Anthropic = require("@anthropic-ai/sdk");
  if (key.startsWith("sk-ant-oat")) {
    cachedClient = new Anthropic({
      apiKey: null,
      authToken: key,
      defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" },
    });
  } else {
    cachedClient = new Anthropic({ apiKey: key });
  }
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
 * @param {string} [model] - Claude model ID (defaults to Haiku)
 */
async function translate(text, apiKey, targetLang, signal, onChunk, model) {
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

  // Estimate max_tokens from input length: translations are usually
  // within ~2x of source in tokens. Rough 1 token ≈ 3 chars (safe for
  // Cyrillic which tokenizes denser than Latin). Clamp to sane bounds.
  const estimatedTokens = Math.ceil(text.length / 3) * 2 + 256;
  const maxTokens = Math.min(8192, Math.max(1024, estimatedTokens));

  const doTranslate = async (key) => {
    const client = getClient(key);
    const msgParams = {
      model: model || DEFAULT_CLAUDE_MODEL,
      max_tokens: maxTokens,
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
const http = require("http");
const crypto = require("crypto");

const CODEX_AUTH_PATH = path.join(os.homedir(), ".codex", "auth.json");
const OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_OAUTH_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
// Same loopback ports (and fallback) the Codex CLI registers as redirect_uri
// with OpenAI — https://github.com/openai/codex codex-rs/login/src/server.rs.
const OPENAI_LOGIN_PORT = 1455;
const OPENAI_LOGIN_FALLBACK_PORT = 1457;
const OPENAI_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

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

// ─── OpenAI Sign-In (PKCE, in-app) ─────────────────────────────────────────
//
// Reimplements the same browser-based login `codex login` performs, so it
// can be triggered from a Settings button instead of a terminal. Parameters
// (ports, scopes, claim paths) are taken from the Codex CLI's own source
// (codex-rs/login), not guessed — see OPENAI_LOGIN_PORT above.

function base64url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeJwtPayload(jwt) {
  return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf-8"));
}

function buildOpenAIAuthorizeUrl({ redirectUri, challenge, state }) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: OPENAI_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access api.connectors.read api.connectors.invoke",
    code_challenge: challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "codex_cli_rs",
  });
  return `${OPENAI_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Exchange an authorization code for tokens (grant_type=authorization_code).
 */
async function exchangeOpenAICode({ code, verifier, redirectUri }) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: OPENAI_OAUTH_CLIENT_ID,
    code_verifier: verifier,
  }).toString();

  return new Promise((resolve, reject) => {
    const url = new URL(OPENAI_OAUTH_TOKEN_URL);
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            return reject(new Error(`OpenAI token exchange failed (${res.statusCode}): ${data}`));
          }
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error("Failed to parse OpenAI token exchange response"));
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
 * Bind the loopback callback server, trying the Codex CLI's default port
 * first and its documented fallback second (e.g. if a real `codex login` is
 * already running).
 */
async function bindOpenAILoginServer() {
  for (const port of [OPENAI_LOGIN_PORT, OPENAI_LOGIN_FALLBACK_PORT]) {
    const server = http.createServer();
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
      server.removeAllListeners("error");
      return { server, port };
    } catch (err) {
      server.close();
      if (err.code !== "EADDRINUSE") throw err;
    }
  }
  throw new Error("Could not start local sign-in server (ports 1455 and 1457 are both busy)");
}

function loginPage(ok) {
  return (
    `<html><body style="font-family:-apple-system,sans-serif;text-align:center;margin-top:4rem">` +
    (ok
      ? "<h2>Signed in ✓</h2><p>You can close this tab and return to Translator.</p>"
      : "<h2>Sign-in failed</h2><p>You can close this tab and try again in Translator.</p>") +
    `</body></html>`
  );
}

/**
 * Full re-write of ~/.codex/auth.json after a fresh login (as opposed to
 * writeCodexAuth's in-place refresh), so it also lands account_id and works
 * even if the file didn't exist yet. Keeps the exact shape Codex CLI itself
 * reads/writes, so `codex` on the machine keeps working too.
 */
function writeCodexAuthFull(oauth, idToken) {
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(CODEX_AUTH_PATH, "utf-8"));
  } catch { /* no existing file — first-time sign-in */ }

  data.tokens = data.tokens || {};
  data.tokens.id_token = idToken;
  data.tokens.access_token = oauth.accessToken;
  data.tokens.refresh_token = oauth.refreshToken;
  data.tokens.account_id = oauth.accountId;
  data.last_refresh = new Date().toISOString();

  fs.mkdirSync(path.dirname(CODEX_AUTH_PATH), { recursive: true });
  fs.writeFileSync(CODEX_AUTH_PATH, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * Run the full OpenAI sign-in flow: opens the system browser to
 * auth.openai.com, waits for the loopback redirect, exchanges the code for
 * tokens, and writes them to ~/.codex/auth.json. Updates the in-memory
 * token cache immediately so a translation works right after this resolves,
 * with no app restart needed.
 *
 * @param {{ openExternal: (url: string) => any }} deps - injected so this
 *   module doesn't need to depend on Electron directly.
 */
async function loginOpenAI({ openExternal }) {
  const { server, port } = await bindOpenAILoginServer();
  const redirectUri = `http://localhost:${port}/auth/callback`;
  const verifier = base64url(crypto.randomBytes(64));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  const state = base64url(crypto.randomBytes(32));

  const codePromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("Sign-in timed out — please try again"));
    }, OPENAI_LOGIN_TIMEOUT_MS);

    server.on("request", (req, res) => {
      let url;
      try {
        url = new URL(req.url, redirectUri);
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (url.pathname !== "/auth/callback") {
        res.writeHead(404).end();
        return;
      }

      const error = url.searchParams.get("error");
      const returnedState = url.searchParams.get("state");
      const authCode = url.searchParams.get("code");
      const ok = !error && returnedState === state && !!authCode;

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(loginPage(ok));

      clearTimeout(timer);
      server.close();

      if (!ok) {
        reject(new Error(error ? `OpenAI sign-in error: ${error}` : "OpenAI sign-in state mismatch"));
      } else {
        resolve(authCode);
      }
    });

    server.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  }).catch((err) => {
    server.close();
    throw err;
  });

  // Open the browser only after the callback listener is armed — awaiting
  // codePromise before this point would deadlock forever waiting for a
  // redirect nothing ever triggered.
  const authorizeUrl = buildOpenAIAuthorizeUrl({ redirectUri, challenge, state });
  await openExternal(authorizeUrl);

  const code = await codePromise;
  const tokens = await exchangeOpenAICode({ code, verifier, redirectUri });

  let accountId = null;
  try {
    accountId = decodeJwtPayload(tokens.id_token)["https://api.openai.com/auth"]?.chatgpt_account_id || null;
  } catch { /* leave accountId null — most requests still work without it */ }

  let expiresAt = null;
  try {
    expiresAt = decodeJwtPayload(tokens.access_token).exp * 1000;
  } catch { /* leave expiresAt null — treated as never-expiring until a 401 */ }

  cachedOpenAIOauth = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    accountId,
    expiresAt,
  };
  writeCodexAuthFull(cachedOpenAIOauth, tokens.id_token);

  return { accountId };
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
 * @param {string} [model] - Model ID on the ChatGPT backend
 */
async function translateOpenAI(text, token, targetLang, signal, onChunk, model) {
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
      model: model || DEFAULT_OPENAI_MODEL,
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
            // Flush any trailing line left in the buffer (SSE event
            // without final newline would otherwise be dropped).
            if (buffer && buffer.startsWith("data: ")) {
              try {
                const event = JSON.parse(buffer.slice(6));
                if (event.type === "response.output_text.delta" && event.delta) {
                  fullText += event.delta;
                  if (onChunk) onChunk(event.delta);
                }
              } catch { /* ignore */ }
            }
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

module.exports = { translate, translateOpenAI, detectLanguage, autoTargetLang, getKeychainToken, forceRefreshKeychainToken, getCodexToken, forceRefreshCodexToken, loginOpenAI, LANGUAGES };

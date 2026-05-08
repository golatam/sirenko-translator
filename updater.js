const { app, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const https = require("https");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");
const Store = require("electron-store");

// ─── Configuration ──────────────────────────────────────────────────────────
const GITHUB_OWNER = "golatam";
const GITHUB_REPO = "sirenko-translator";
const MANIFEST_BRANCH = "main";
const MANIFEST_PATH = "latest.json";

const MANIFEST_URL = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${MANIFEST_BRANCH}/${MANIFEST_PATH}`;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const STARTUP_DELAY_MS = 30 * 1000; // wait 30s after launch before first check

const store = new Store({ name: "updater-state" });

// ─── Semver helpers (only x.y.z, no pre-release tags) ───────────────────────

function parseSemver(v) {
  return v.split(".").map((n) => parseInt(n, 10) || 0);
}

function semverGt(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

function semverGte(a, b) {
  return a === b || semverGt(a, b);
}

// ─── HTTP ───────────────────────────────────────────────────────────────────

function httpGet(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "User-Agent": "translator-updater" }, ...opts },
      (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode)) {
          res.resume();
          return resolve(httpGet(res.headers.location, opts));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        resolve(res);
      }
    );
    req.on("error", reject);
    req.setTimeout(30_000, () => req.destroy(new Error("Request timeout")));
  });
}

async function fetchJson(url) {
  // Cache-bust to dodge the GitHub raw CDN holding an old manifest
  const bust = `${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`;
  const res = await httpGet(bust);
  let data = "";
  res.setEncoding("utf-8");
  for await (const chunk of res) data += chunk;
  return JSON.parse(data);
}

async function downloadFile(url, dest) {
  const res = await httpGet(url);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    res.pipe(file);
    file.on("finish", () => file.close(resolve));
    file.on("error", reject);
    res.on("error", reject);
  });
}

async function sha256OfFile(filePath) {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

// ─── Paths ──────────────────────────────────────────────────────────────────

function getAppBundlePath() {
  // app.getPath('exe') -> /Applications/Translator.app/Contents/MacOS/Translator
  return path.resolve(path.dirname(app.getPath("exe")), "..", "..");
}

function getResourcesAppDir() {
  // /Applications/Translator.app/Contents/Resources/app
  return path.join(getAppBundlePath(), "Contents", "Resources", "app");
}

// ─── Unzip via system tool (no extra dependencies) ──────────────────────────

function unzip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(destDir, { recursive: true });
    execFile("/usr/bin/unzip", ["-o", "-q", zipPath, "-d", destDir], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// ─── Apply: JS-only update ──────────────────────────────────────────────────

async function copyTreeOver(srcDir, destDir) {
  const entries = await fsp.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      await fsp.mkdir(destPath, { recursive: true });
      await copyTreeOver(srcPath, destPath);
    } else if (entry.isFile()) {
      await fsp.copyFile(srcPath, destPath);
    }
  }
}

async function applyJsUpdate(zipPath) {
  const tempExtract = path.join(
    app.getPath("temp"),
    `translator-update-${Date.now()}`
  );
  await unzip(zipPath, tempExtract);

  // Sanity check — we expect main.js at the root of the archive
  const hasMain = await fsp
    .access(path.join(tempExtract, "main.js"))
    .then(() => true)
    .catch(() => false);
  if (!hasMain) {
    throw new Error("Update archive is missing main.js — refusing to apply");
  }

  const targetAppDir = getResourcesAppDir();
  await copyTreeOver(tempExtract, targetAppDir);

  // Best-effort cleanup
  await fsp.rm(tempExtract, { recursive: true, force: true }).catch(() => {});
}

// ─── Apply: full .app replacement (via detached helper script) ──────────────

async function applyFullUpdate(zipPath) {
  const tempExtract = path.join(
    app.getPath("temp"),
    `translator-full-${Date.now()}`
  );
  await unzip(zipPath, tempExtract);

  const newAppPath = path.join(tempExtract, "Translator.app");
  if (!fs.existsSync(newAppPath)) {
    throw new Error("Archive does not contain Translator.app at its root");
  }

  const oldAppPath = getAppBundlePath();
  const oldVersion = app.getVersion();
  const helperScript = path.join(
    app.getPath("temp"),
    `translator-apply-${Date.now()}.sh`
  );

  // Wait for *this* process to exit, then swap and relaunch.
  // Quoting: paths can contain spaces; double-quote and escape only " inside.
  const q = (s) => `"${s.replace(/"/g, '\\"')}"`;
  const script = `#!/bin/bash
set -e
PARENT_PID=${process.pid}
for i in $(seq 1 100); do
  if ! kill -0 $PARENT_PID 2>/dev/null; then break; fi
  sleep 0.2
done
sleep 0.3
rm -rf ${q(oldAppPath + ".backup-" + oldVersion)} 2>/dev/null || true
mv ${q(oldAppPath)} ${q(oldAppPath + ".backup-" + oldVersion)}
mv ${q(newAppPath)} ${q(oldAppPath)}
xattr -dr com.apple.quarantine ${q(oldAppPath)} 2>/dev/null || true
open ${q(oldAppPath)}
rm -rf ${q(tempExtract)} 2>/dev/null || true
rm -- "$0"
`;

  await fsp.writeFile(helperScript, script);
  await fsp.chmod(helperScript, 0o755);

  const child = spawn("/bin/bash", [helperScript], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

// ─── Main flow ──────────────────────────────────────────────────────────────

async function performUpdate(manifest) {
  const tempZip = path.join(
    app.getPath("temp"),
    `translator-${manifest.version}-${manifest.kind}.zip`
  );

  await downloadFile(manifest.url, tempZip);

  if (manifest.sha256) {
    const actual = await sha256OfFile(tempZip);
    if (actual.toLowerCase() !== manifest.sha256.toLowerCase()) {
      await fsp.unlink(tempZip).catch(() => {});
      throw new Error(
        `Checksum mismatch: expected ${manifest.sha256}, got ${actual}`
      );
    }
  }

  if (manifest.kind === "js") {
    await applyJsUpdate(tempZip);
    await fsp.unlink(tempZip).catch(() => {});
    app.relaunch();
    app.exit(0);
  } else if (manifest.kind === "full") {
    await applyFullUpdate(tempZip);
    // helper script is detached and will relaunch us
    app.exit(0);
  } else {
    await fsp.unlink(tempZip).catch(() => {});
    throw new Error(`Unknown update kind: ${manifest.kind}`);
  }
}

async function checkForUpdates({ silent = true } = {}) {
  if (!app.isPackaged) {
    if (!silent) {
      await dialog.showMessageBox({
        type: "info",
        message: "Updates are disabled in dev mode.",
        detail: `Current version: ${app.getVersion()}`,
      });
    }
    return { status: "dev" };
  }

  store.set("lastUpdateCheck", Date.now());

  let manifest;
  try {
    manifest = await fetchJson(MANIFEST_URL);
  } catch (err) {
    if (!silent) {
      dialog.showErrorBox("Update check failed", err.message || String(err));
    }
    return { status: "fetch-error", error: err };
  }

  const current = app.getVersion();

  if (!semverGt(manifest.version, current)) {
    if (!silent) {
      await dialog.showMessageBox({
        type: "info",
        message: "You are up to date.",
        detail: `Translator ${current}`,
      });
    }
    return { status: "current" };
  }

  if (
    manifest.kind === "js" &&
    manifest.minBaseVersion &&
    !semverGte(current, manifest.minBaseVersion)
  ) {
    if (!silent) {
      await dialog.showMessageBox({
        type: "info",
        message: "A larger update is required",
        detail: `Translator ${manifest.version} requires base ${manifest.minBaseVersion} or newer. Wait for the next full release.`,
      });
    }
    return { status: "needs-full" };
  }

  if (silent && store.get("skippedVersion") === manifest.version) {
    return { status: "skipped" };
  }

  const result = await dialog.showMessageBox({
    type: "info",
    buttons: ["Update Now", "Later", "Skip This Version"],
    defaultId: 0,
    cancelId: 1,
    message: `Translator ${manifest.version} is available`,
    detail:
      (manifest.notes ? manifest.notes + "\n\n" : "") +
      `Current: ${current}\nUpdate type: ${manifest.kind === "js" ? "lightweight (JS-only)" : "full app"}`,
  });

  if (result.response === 2) {
    store.set("skippedVersion", manifest.version);
    return { status: "user-skipped" };
  }
  if (result.response !== 0) return { status: "deferred" };

  try {
    await performUpdate(manifest);
    return { status: "applied" };
  } catch (err) {
    dialog.showErrorBox(
      "Update failed",
      `${err.message || String(err)}\n\nYou can keep using the current version.`
    );
    return { status: "apply-error", error: err };
  }
}

function scheduleUpdateChecks() {
  if (!app.isPackaged) return;

  const last = store.get("lastUpdateCheck") || 0;
  const elapsed = Date.now() - last;
  const initialDelay = Math.max(
    STARTUP_DELAY_MS,
    CHECK_INTERVAL_MS - elapsed
  );

  setTimeout(() => {
    checkForUpdates({ silent: true }).catch(() => {});
    setInterval(
      () => checkForUpdates({ silent: true }).catch(() => {}),
      CHECK_INTERVAL_MS
    );
  }, initialDelay);
}

module.exports = { checkForUpdates, scheduleUpdateChecks };

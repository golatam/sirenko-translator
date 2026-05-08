#!/usr/bin/env node
/* eslint-disable no-console */

// Build a release artifact for the Translator auto-updater.
//
// Usage:
//   node scripts/build-update.js js     — patch JS files only (~hundreds of KB)
//   node scripts/build-update.js full   — entire .app bundle (~hundreds of MB)
//
// Prints a JSON snippet to paste into latest.json on `main`.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const RELEASES_DIR = path.join(ROOT, "releases");

// Files included in JS-only updates. Intentionally excludes node_modules,
// Electron itself, and bundled ML models — those only ship in `full` updates.
const JS_UPDATE_FILES = [
  "main.js",
  "preload.js",
  "translate.js",
  "translate-local.js",
  "translate-local-worker.js",
  "lang-detect.js",
  "clipboard-watcher.js",
  "clipboard-watcher",
  "package.json",
  "renderer",
  "updater.js",
];

function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function fileSizeMb(filePath) {
  const bytes = fs.statSync(filePath).size;
  return (bytes / 1024 / 1024).toFixed(2);
}

function pkg() {
  return JSON.parse(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf-8")
  );
}

function findBuiltApp() {
  const candidates = [
    path.join(ROOT, "dist", "mac-arm64", "Translator.app"),
    path.join(ROOT, "dist", "mac", "Translator.app"),
    path.join(ROOT, "dist", "mac-universal", "Translator.app"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

function buildJs() {
  const version = pkg().version;
  fs.mkdirSync(RELEASES_DIR, { recursive: true });
  const zipPath = path.join(RELEASES_DIR, `translator-${version}-js.zip`);

  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

  const present = JS_UPDATE_FILES.filter((f) =>
    fs.existsSync(path.join(ROOT, f))
  );
  const missing = JS_UPDATE_FILES.filter(
    (f) => !fs.existsSync(path.join(ROOT, f))
  );
  if (missing.length) {
    console.warn(`! skipping missing files: ${missing.join(", ")}`);
  }

  console.log(`→ packing ${present.length} entries into ${zipPath}`);
  execFileSync("/usr/bin/zip", ["-r", "-q", zipPath, ...present], {
    cwd: ROOT,
    stdio: "inherit",
  });

  return { version, zipPath, kind: "js" };
}

function buildFull() {
  const version = pkg().version;
  const builtApp = findBuiltApp();
  if (!builtApp) {
    console.error(
      "! No built .app found. Run `npm run dist` first to produce dist/mac-arm64/Translator.app"
    );
    process.exit(1);
  }
  fs.mkdirSync(RELEASES_DIR, { recursive: true });
  const zipPath = path.join(RELEASES_DIR, `translator-${version}-full.zip`);
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

  console.log(`→ packing ${builtApp} into ${zipPath}`);
  // Use ditto to preserve macOS bundle metadata (resource forks, xattrs)
  // — `zip` can corrupt code-signing metadata and bundle layouts.
  execFileSync(
    "/usr/bin/ditto",
    ["-c", "-k", "--sequesterRsrc", "--keepParent", builtApp, zipPath],
    { stdio: "inherit" }
  );

  return { version, zipPath, kind: "full" };
}

function emitManifest({ version, zipPath, kind }) {
  const sum = sha256(zipPath);
  const sizeMb = fileSizeMb(zipPath);
  const fileName = path.basename(zipPath);

  console.log("");
  console.log(`✓ Built ${kind} update: ${fileName} (${sizeMb} MB)`);
  console.log(`  sha256: ${sum}`);
  console.log("");
  console.log("Next steps:");
  console.log(
    `  1. Create GitHub release tag v${version} and upload ${fileName} as a release asset.`
  );
  console.log(`  2. Commit this latest.json to the main branch:`);
  console.log("");

  const manifest = {
    version,
    kind,
    url: `https://github.com/golatam/sirenko-translator/releases/download/v${version}/${fileName}`,
    sha256: sum,
    notes: "TODO: short release notes",
  };
  if (kind === "js") {
    // Set this to the version of the most recent `full` release.
    // The client refuses JS updates if its base is older than this.
    manifest.minBaseVersion = "1.0.0";
  }

  console.log(JSON.stringify(manifest, null, 2));
  console.log("");
}

function main() {
  const kind = process.argv[2];
  if (!["js", "full"].includes(kind)) {
    console.error("Usage: node scripts/build-update.js <js|full>");
    process.exit(1);
  }
  const result = kind === "js" ? buildJs() : buildFull();
  emitManifest(result);
}

main();

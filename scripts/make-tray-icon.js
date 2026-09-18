// Generates the monochrome menu-bar (template) icon without external
// graphics tools: renders the 文A glyph as solid black on transparent HTML,
// crops tightly to its bounding box, then downsamples with macOS sips.
//
// Unlike make-icon.js (the colored Dock icon on a gradient plate), a macOS
// "template" image must be plain black with only alpha varying — the OS
// re-tints it for light/dark menu bars and the highlighted state.
//
// Usage: npm run tray-icon

const { app, BrowserWindow } = require("electron");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const RENDER_SIZE = 800; // generous canvas; we crop to content afterwards
// assets/, not build/ — electron-builder treats the top-level build/ dir as
// its own build-time resources and never copies it into the packaged app.
const OUT_DIR = path.join(__dirname, "..", "assets");

const HTML = `
<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; background: transparent; width: ${RENDER_SIZE}px; height: ${RENDER_SIZE}px; }
  .glyph {
    position: absolute; left: 0; top: 0;
    font-family: -apple-system, "PingFang SC", "Hiragino Sans", sans-serif;
    font-size: 260px; font-weight: 700; color: #000; line-height: 1;
    letter-spacing: -14px; padding-right: 14px;
    white-space: nowrap;
  }
</style></head><body><span class="glyph">文A</span></body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: RENDER_SIZE,
    height: RENDER_SIZE,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true },
  });

  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(HTML));
  await new Promise((r) => setTimeout(r, 500)); // let fonts render

  const rect = await win.webContents.executeJavaScript(
    "document.querySelector('.glyph').getBoundingClientRect().toJSON()"
  );

  const pad = 6;
  const cropX = Math.max(0, Math.floor(rect.left) - pad);
  const cropY = Math.max(0, Math.floor(rect.top) - pad);
  const cropWidth = Math.ceil(rect.width) + pad * 2;
  const cropHeight = Math.ceil(rect.height) + pad * 2;

  const image = await win.webContents.capturePage({
    x: cropX,
    y: cropY,
    width: cropWidth,
    height: cropHeight,
  });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const masterPng = path.join(OUT_DIR, "tray-icon-master.png");
  fs.writeFileSync(masterPng, image.toPNG());

  // Menu bar glyphs render around 18pt tall at @1x; scale width to match
  // the master's aspect ratio so 文A isn't stretched or squished.
  const targetHeight1x = 18;
  const targetWidth1x = Math.round((cropWidth / cropHeight) * targetHeight1x);

  const variants = [
    ["trayTemplate.png", targetWidth1x, targetHeight1x],
    ["trayTemplate@2x.png", targetWidth1x * 2, targetHeight1x * 2],
  ];
  for (const [name, w, h] of variants) {
    execFileSync(
      "sips",
      ["-z", String(h), String(w), masterPng, "--out", path.join(OUT_DIR, name)],
      { stdio: "ignore" }
    );
  }

  fs.rmSync(masterPng);

  console.log(`✓ assets/trayTemplate.png + @2x generated (${targetWidth1x}x${targetHeight1x} @1x)`);
  app.quit();
}).catch((err) => {
  console.error(err);
  app.exit(1);
});

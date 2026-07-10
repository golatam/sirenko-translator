// Generates build/icon.icns without any external graphics tools:
// renders the icon as HTML in an offscreen Electron window, captures it
// as a 1024px PNG, then uses macOS sips + iconutil to build the .icns.
//
// Usage: npm run icon

const { app, BrowserWindow } = require("electron");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const SIZE = 1024;
const BUILD_DIR = path.join(__dirname, "..", "build");

// Big Sur-style icon: rounded square with margins on a transparent canvas.
// Glyph 文A is the classic "translation" motif.
const HTML = `
<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; background: transparent; width: ${SIZE}px; height: ${SIZE}px; }
  .plate {
    position: absolute; left: 100px; top: 100px;
    width: 824px; height: 824px; border-radius: 185px;
    background: linear-gradient(160deg, #5c7cfa 0%, #4c6ef5 45%, #3b5bdb 100%);
    box-shadow: inset 0 6px 30px rgba(255,255,255,0.25), inset 0 -14px 40px rgba(0,0,0,0.25);
    display: flex; align-items: center; justify-content: center;
  }
  .glyph {
    font-family: -apple-system, "PingFang SC", "Hiragino Sans", sans-serif;
    font-size: 340px; font-weight: 700; color: #fff; line-height: 1;
    letter-spacing: -18px; padding-right: 18px;
    text-shadow: 0 10px 24px rgba(0,0,0,0.28);
  }
</style></head><body><div class="plate"><span class="glyph">文A</span></div></body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true },
  });

  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(HTML));
  await new Promise((r) => setTimeout(r, 500)); // let fonts render

  const image = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });

  fs.mkdirSync(BUILD_DIR, { recursive: true });
  const masterPng = path.join(BUILD_DIR, "icon-1024.png");
  fs.writeFileSync(masterPng, image.toPNG());

  const iconset = path.join(BUILD_DIR, "icon.iconset");
  fs.rmSync(iconset, { recursive: true, force: true });
  fs.mkdirSync(iconset);

  const variants = [
    ["icon_16x16.png", 16], ["icon_16x16@2x.png", 32],
    ["icon_32x32.png", 32], ["icon_32x32@2x.png", 64],
    ["icon_128x128.png", 128], ["icon_128x128@2x.png", 256],
    ["icon_256x256.png", 256], ["icon_256x256@2x.png", 512],
    ["icon_512x512.png", 512], ["icon_512x512@2x.png", 1024],
  ];
  for (const [name, px] of variants) {
    execFileSync("sips", ["-z", String(px), String(px), masterPng, "--out", path.join(iconset, name)], { stdio: "ignore" });
  }

  execFileSync("iconutil", ["-c", "icns", iconset, "-o", path.join(BUILD_DIR, "icon.icns")]);
  fs.rmSync(iconset, { recursive: true, force: true });

  console.log("✓ build/icon.icns generated");
  app.quit();
}).catch((err) => {
  console.error(err);
  app.exit(1);
});

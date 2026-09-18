const fs = require("fs");
const path = require("path");

// This project lives on an exFAT disk. Compiling native modules there
// (e.g. uiohook-napi via @electron/rebuild) leaves AppleDouble metadata
// sidecar files (._foo.node) next to the real binary. node-gyp-build picks
// whichever *.node file readdirSync() returns first, which is sometimes the
// sidecar — a dlopen of that fails with "slice is not valid mach-o file".
// Strip them from the packaged app before it's zipped/dmg'd.
module.exports = async function afterPack(context) {
  removeAppleDoubleFiles(context.appOutDir);
};

function removeAppleDoubleFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      removeAppleDoubleFiles(full);
    } else if (entry.name.startsWith("._")) {
      fs.unlinkSync(full);
    }
  }
}

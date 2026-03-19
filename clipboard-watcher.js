// Standalone clipboard changeCount watcher for macOS
// Runs as a child process, sends "copy" events to parent via stdout
// Uses JXA (JavaScript for Automation) via osascript for NSPasteboard access

const { execSync } = require("child_process");

function getChangeCount() {
  try {
    return parseInt(
      execSync(
        'osascript -l JavaScript -e \'ObjC.import("AppKit"); $.NSPasteboard.generalPasteboard.changeCount\'',
        { encoding: "utf-8", timeout: 2000 }
      ).trim(),
      10
    );
  } catch {
    return -1;
  }
}

let lastCount = getChangeCount();

setInterval(() => {
  const count = getChangeCount();
  if (count !== -1 && count !== lastCount) {
    lastCount = count;
    process.stdout.write("copy\n");
  }
}, 300);

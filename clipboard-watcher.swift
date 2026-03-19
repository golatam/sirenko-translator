// Native macOS clipboard watcher — polls NSPasteboard.changeCount
// Outputs "copy" to stdout on each clipboard change
// Much faster than osascript (~0.001ms vs ~113ms per poll)
import AppKit
import Foundation

var lastCount = NSPasteboard.general.changeCount

// Use a DispatchSource timer for precise 150ms polling
let timer = DispatchSource.makeTimerSource(queue: .main)
timer.schedule(deadline: .now(), repeating: .milliseconds(150))
timer.setEventHandler {
    let count = NSPasteboard.general.changeCount
    if count != lastCount {
        lastCount = count
        print("copy")
        fflush(stdout)
    }
}
timer.resume()

// Keep process alive
dispatchMain()

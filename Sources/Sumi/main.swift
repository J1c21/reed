import AppKit

// Sumi — a quiet notebook for Jupyter.

let application = NSApplication.shared
let appDelegate = AppDelegate()
application.delegate = appDelegate
application.setActivationPolicy(.regular)
application.run()

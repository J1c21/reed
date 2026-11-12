import AppKit
import SumiCore
import UniformTypeIdentifiers
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    let hub = Hub()
    let kernels = KernelManager()
    private(set) lazy var preferences = PreferencesStore(hub: hub, directory: options.preferencesDirectory)
    private(set) var schemeHandler: SchemeHandler!
    /// Where the UI is loaded from: the bundle, or a dev server when SUMI_DEV_URL is set.
    private(set) var pageURL = URL(string: "sumi://app/index.html")!
    var pageOrigin: URL { pageURL }

    private var controllers: [NotebookWindowController] = []
    private var launched = false
    private var openedAtLaunch = false
    private var recentMenu: NSMenu?
    private var options = LaunchOptions()

    // MARK: - Launch

    func applicationWillFinishLaunching(_ notification: Notification) {
        // WebKit applies the system's "smart" text substitutions to editable content unless
        // told otherwise. Curly quotes and auto-capitalised words have no place in code.
        UserDefaults.standard.register(defaults: [
            "WebAutomaticQuoteSubstitutionEnabled": false,
            "WebAutomaticDashSubstitutionEnabled": false,
            "WebAutomaticTextReplacementEnabled": false,
            "WebAutomaticSpellingCorrectionEnabled": false,
            "WebContinuousSpellCheckingEnabled": false,
            "WebGrammarCheckingEnabled": false,
            "NSAutomaticQuoteSubstitutionEnabled": false,
            "NSAutomaticDashSubstitutionEnabled": false,
            "NSAutomaticTextReplacementEnabled": false,
            "NSAutomaticSpellingCorrectionEnabled": false,
            "NSAutomaticCapitalizationEnabled": false,
            "NSAutomaticPeriodSubstitutionEnabled": false,
        ])

        options = LaunchOptions(arguments: CommandLine.arguments, environment: ProcessInfo.processInfo.environment)
        if let dev = options.devURL {
            pageURL = dev
        }
        schemeHandler = SchemeHandler(root: options.webRoot)
        registerMethods()
        NSApp.mainMenu = MainMenu.build(delegate: self)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        launched = true
        // Snapshot runs stay out of the way: no Dock icon, no focus, window parked off screen.
        if options.snapshot != nil { NSApp.setActivationPolicy(.accessory) }
        for path in options.files { openNotebook(at: path) }
        if !openedAtLaunch { newNotebook() }
        if let snapshot = options.snapshot { runSnapshot(snapshot) }
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls where url.isFileURL { openNotebook(at: url.path) }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag && controllers.isEmpty { newNotebook() }
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    // MARK: - Windows

    @discardableResult
    func newNotebook() -> NotebookWindowController {
        openedAtLaunch = true
        return makeController(path: nil)
    }

    private func makeController(path: String?) -> NotebookWindowController {
        let controller = NotebookWindowController(app: self, path: path)
        controller.isHeadless = options.snapshot != nil
        if controller.isHeadless, let window = controller.window {
            if let size = options.size { window.setContentSize(size) }
        } else if let window = controller.window {
            // New windows open where the last one was left, stepping down and right from the
            // current one so they never stack exactly on top of each other.
            if !window.setFrameUsingName("SumiNotebookWindow") { window.center() }
            if let front = controllers.last?.window {
                let origin = window.cascadeTopLeft(from: NSPoint(x: front.frame.minX, y: front.frame.maxY))
                window.setFrameTopLeftPoint(origin)
            }
            window.setFrameAutosaveName("SumiNotebookWindow")
        }
        controllers.append(controller)
        return controller
    }

    func openNotebook(at rawPath: String) {
        openedAtLaunch = true
        let path = URL(fileURLWithPath: (rawPath as NSString).expandingTildeInPath).standardizedFileURL.path
        guard FileManager.default.fileExists(atPath: path) else {
            presentError("The file “\((path as NSString).lastPathComponent)” could not be found.")
            return
        }
        NSDocumentController.shared.noteNewRecentDocumentURL(URL(fileURLWithPath: path))
        if let existing = controllers.first(where: { $0.filePath == path }) {
            existing.window?.makeKeyAndOrderFront(nil)
            return
        }
        // Like any document app: an untouched "Untitled" window is replaced, not left behind.
        if let pristine = controllers.first(where: { $0.isPristine }) {
            pristine.load(path: path)
            pristine.window?.makeKeyAndOrderFront(nil)
            return
        }
        _ = makeController(path: path)
    }

    func controllerDidClose(_ controller: NotebookWindowController) {
        controllers.removeAll { $0 === controller }
    }

    func controller(for client: RPCClient) -> NotebookWindowController? {
        controllers.first { $0.client === client }
    }

    private var frontController: NotebookWindowController? {
        if let key = NSApp.keyWindow?.windowController as? NotebookWindowController { return key }
        return NSApp.mainWindow?.windowController as? NotebookWindowController ?? controllers.last
    }

    private func presentError(_ message: String) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = message
        if let window = frontController?.window, window.isVisible {
            alert.beginSheetModal(for: window)
        } else {
            alert.runModal()
        }
    }

    // MARK: - Menu actions

    @objc func newDocument(_ sender: Any?) {
        newNotebook()
    }

    @objc func openDocument(_ sender: Any?) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        if let type = UTType(filenameExtension: "ipynb") { panel.allowedContentTypes = [type] }
        if let current = frontController?.filePath {
            panel.directoryURL = URL(fileURLWithPath: current).deletingLastPathComponent()
        }
        guard panel.runModal() == .OK else { return }
        for url in panel.urls { openNotebook(at: url.path) }
    }

    @objc func openRecent(_ sender: NSMenuItem) {
        if let url = sender.representedObject as? URL { openNotebook(at: url.path) }
    }

    @objc func clearRecent(_ sender: Any?) {
        NSDocumentController.shared.clearRecentDocuments(nil)
    }

    @objc func showAbout(_ sender: Any?) {
        let credits = NSAttributedString(
            string: "A quiet notebook for Jupyter.",
            attributes: [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: NSColor.secondaryLabelColor]
        )
        NSApp.orderFrontStandardAboutPanel(options: [.credits: credits, .applicationName: "Sumi"])
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Menu commands are aimed at the key window; with none open, a few still make sense.
    @objc func performWebCommand(_ sender: Any?) {
        frontController?.performWebCommand(sender)
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        guard menu === recentMenu else { return }
        menu.removeAllItems()
        let urls = NSDocumentController.shared.recentDocumentURLs.filter { FileManager.default.fileExists(atPath: $0.path) }
        for url in urls.prefix(12) {
            let item = NSMenuItem(title: url.lastPathComponent, action: #selector(openRecent(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = url
            item.toolTip = (url.path as NSString).abbreviatingWithTildeInPath
            let icon = NSWorkspace.shared.icon(forFile: url.path)
            icon.size = NSSize(width: 16, height: 16)
            item.image = icon
            menu.addItem(item)
        }
        if !urls.isEmpty { menu.addItem(.separator()) }
        let clear = NSMenuItem(title: "Clear Menu", action: #selector(clearRecent(_:)), keyEquivalent: "")
        clear.target = self
        clear.isEnabled = !urls.isEmpty
        menu.addItem(clear)
    }

    func adoptRecentMenu(_ menu: NSMenu) {
        recentMenu = menu
        menu.delegate = self
        menu.autoenablesItems = false
    }

    // MARK: - Quitting

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        let unsaved = controllers.filter { $0.isDirty }
        guard !unsaved.isEmpty else { return .terminateNow }
        review(unsaved[...])
        return .terminateLater
    }

    private func review(_ remaining: ArraySlice<NotebookWindowController>) {
        guard let controller = remaining.first else {
            NSApp.reply(toApplicationShouldTerminate: true)
            return
        }
        controller.confirmClose { [weak self] proceed in
            guard proceed else {
                NSApp.reply(toApplicationShouldTerminate: false)
                return
            }
            controller.closeWithoutAsking()
            self?.review(remaining.dropFirst())
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        kernels.killAllNow()
    }

    // MARK: - RPC

    private func registerMethods() {
        let router = hub.router
        kernels.register(on: router)
        FileService.register(on: router)
        preferences.register(on: router)

        /// Runs a handler on the main thread with the window that sent the request.
        func window(_ method: String, _ body: @escaping (NotebookWindowController, RPCParams) throws -> Any?) {
            router.register(method) { [weak self] params, client in
                try await MainActor.run {
                    guard let self, let controller = self.controller(for: client) else { return nil as Any? }
                    return try body(controller, params)
                }
            }
        }

        window("window.init") { controller, _ in controller.initPayload() }
        window("window.ready") { controller, _ in
            controller.pageDidBecomeReady()
            return nil
        }
        window("window.startDrag") { controller, _ in
            controller.startWindowDrag()
            return nil
        }
        window("window.zoom") { controller, _ in
            controller.performTitlebarDoubleClick()
            return nil
        }
        window("window.setAppearance") { controller, params in
            controller.applyAppearance(params.optString("appearance") ?? "system")
            return nil
        }
        window("window.setZoom") { controller, params in
            controller.webView.pageZoom = CGFloat(min(2, max(0.5, params.double("zoom") ?? 1)))
            return nil
        }
        window("doc.setState") { controller, params in
            controller.setDocumentState(
                path: params.optString("path"),
                dirty: params.bool("dirty") ?? false,
                title: params.optString("title") ?? "Untitled",
                savesItself: params.bool("autosave") ?? false
            )
            return nil
        }
        window("menu.setState") { controller, params in
            var states: [String: [String: Bool]] = [:]
            for (id, value) in params["states"] as? [String: Any] ?? [:] {
                guard let flags = value as? [String: Any] else { continue }
                var entry: [String: Bool] = [:]
                if let checked = flags["checked"] as? Bool { entry["checked"] = checked }
                if let enabled = flags["enabled"] as? Bool { entry["enabled"] = enabled }
                states[id] = entry
            }
            controller.setCommandStates(states)
            return nil
        }

        router.register("dialog.save") { [weak self] params, client in
            let name = params.optString("name") ?? "Untitled.ipynb"
            let directory = params.optString("directory")
            let fileExtension = params.optString("extension") ?? "ipynb"
            let path: String? = await withCheckedContinuation { continuation in
                DispatchQueue.main.async {
                    guard let self, let window = self.controller(for: client)?.window else {
                        continuation.resume(returning: nil)
                        return
                    }
                    let panel = NSSavePanel()
                    panel.nameFieldStringValue = name
                    panel.canCreateDirectories = true
                    panel.isExtensionHidden = false
                    if let type = UTType(filenameExtension: fileExtension) { panel.allowedContentTypes = [type] }
                    if let directory { panel.directoryURL = URL(fileURLWithPath: directory) }
                    panel.beginSheetModal(for: window) { response in
                        continuation.resume(returning: response == .OK ? panel.url?.path : nil)
                    }
                }
            }
            return ["path": path ?? NSNull()] as [String: Any]
        }

        router.register("app.open") { [weak self] params, _ in
            let path = try params.string("path")
            await MainActor.run { self?.openNotebook(at: path) }
            return nil
        }
        router.register("app.reveal") { params, _ in
            let path = try params.string("path")
            await MainActor.run { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)]) }
            return nil
        }
        router.register("app.openExternal") { params, _ in
            guard let url = URL(string: try params.string("url")), ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") else { return nil }
            await MainActor.run { _ = NSWorkspace.shared.open(url) }
            return nil
        }
        router.register("app.recents") { _, _ in
            let paths: [String] = await MainActor.run {
                NSDocumentController.shared.recentDocumentURLs.map(\.path).filter { FileManager.default.fileExists(atPath: $0) }
            }
            return ["paths": Array(paths.prefix(20))] as [String: Any]
        }
        router.register("app.noteRecent") { params, _ in
            let path = try params.string("path")
            await MainActor.run { NSDocumentController.shared.noteNewRecentDocumentURL(URL(fileURLWithPath: path)) }
            return nil
        }
        router.register("clipboard.writeText") { params, _ in
            let text = try params.string("text")
            // A table goes out as HTML as well, so that it pastes as a table where that matters.
            let html = params.optString("html")
            let board = self.options.pasteboardName
            await MainActor.run {
                let pasteboard = board.map { NSPasteboard(name: NSPasteboard.Name($0)) } ?? .general
                pasteboard.clearContents()
                pasteboard.setString(text, forType: .string)
                if let html { pasteboard.setString(html, forType: .html) }
            }
            return nil
        }
        router.register("clipboard.writeImage") { params, _ in
            guard let data = Data(base64Encoded: try params.string("base64"), options: [.ignoreUnknownCharacters]),
                  let image = NSImage(data: data) else {
                throw RPCError("That image could not be copied.", code: "bad_params")
            }
            let board = self.options.pasteboardName
            await MainActor.run {
                let pasteboard = board.map { NSPasteboard(name: NSPasteboard.Name($0)) } ?? .general
                pasteboard.clearContents()
                // The original PNG for apps that take it, and what NSImage offers for the rest.
                pasteboard.writeObjects([image])
                pasteboard.setData(data, forType: .png)
            }
            return nil
        }
    }

    // MARK: - Automated snapshots

    /// `--snapshot out.png [--snapshot-delay 2] [--eval "js"]`: render the first window to a
    /// PNG and quit. Used to check the real app's appearance from the command line.
    private func runSnapshot(_ output: URL) {
        guard let controller = controllers.first else { return }
        controller.whenReady { [options] in
            let capture = {
                DispatchQueue.main.asyncAfter(deadline: .now() + options.snapshotDelay) {
                    controller.snapshot(to: output) { ok in
                        FileHandle.standardError.write(Data((ok ? "snapshot written\n" : "snapshot failed\n").utf8))
                        self.kernels.killAllNow()
                        exit(ok ? 0 : 1)
                    }
                }
            }
            // `--menu "Run/Run All"` triggers a menu item exactly as a click on it would.
            for path in options.menuItems {
                let ok = self.performMenuItem(path)
                FileHandle.standardError.write(Data("menu \(path): \(ok ? "performed" : "NOT AVAILABLE")\n".utf8))
            }
            if let script = options.eval {
                controller.evaluate(script) { result in
                    if case .failure(let error) = result {
                        FileHandle.standardError.write(Data("eval failed: \(error)\n".utf8))
                    } else if case .success(let value) = result {
                        FileHandle.standardError.write(Data("eval result: \(value)\n".utf8))
                    }
                    capture()
                }
            } else {
                capture()
            }
        }
    }
}

extension AppDelegate {
    /// Finds a menu item by its path ("File/Export/Markdown…") and performs it if enabled.
    func performMenuItem(_ path: String) -> Bool {
        var menu = NSApp.mainMenu
        var found: NSMenuItem?
        for title in path.split(separator: "/").map(String.init) {
            menu?.update()
            found = menu?.items.first { $0.title == title }
            menu = found?.submenu
        }
        guard let item = found, let parent = item.menu else { return false }
        parent.update()
        guard item.isEnabled, let action = item.action else { return false }
        return NSApp.sendAction(action, to: item.target, from: item)
    }
}

/// Command-line and environment switches. None are needed in normal use.
struct LaunchOptions {
    var files: [String] = []
    var devURL: URL?
    var webRoot = Bundle.main.resourceURL?.appendingPathComponent("web") ?? URL(fileURLWithPath: "/")
    var snapshot: URL?
    var snapshotDelay: TimeInterval = 1.5
    var eval: String?
    var size: NSSize?
    var menuItems: [String] = []
    /// Where preferences live. Automated runs point this elsewhere so they never alter the user's own.
    var preferencesDirectory: URL?
    /// A named pasteboard to copy to instead of the system clipboard — again for automated
    /// runs, which have no business replacing whatever the user last copied.
    var pasteboardName: String?

    init() {}

    init(arguments: [String], environment: [String: String]) {
        if let dev = environment["SUMI_DEV_URL"], let url = URL(string: dev) { devURL = url }
        if let root = environment["SUMI_WEB_DIR"] { webRoot = URL(fileURLWithPath: root) }
        if let directory = environment["SUMI_PREFS_DIR"] { preferencesDirectory = URL(fileURLWithPath: directory, isDirectory: true) }
        if let name = environment["SUMI_PASTEBOARD"], !name.isEmpty { pasteboardName = name }
        var index = 1
        while index < arguments.count {
            let argument = arguments[index]
            let next: String? = index + 1 < arguments.count ? arguments[index + 1] : nil
            switch argument {
            case "--snapshot":
                if let next { snapshot = URL(fileURLWithPath: next) }
                index += 1
            case "--snapshot-delay":
                if let next, let value = TimeInterval(next) { snapshotDelay = value }
                index += 1
            case "--eval":
                eval = next
                index += 1
            case "--menu":
                if let next { menuItems.append(next) }
                index += 1
            case "--size":
                if let next {
                    let parts = next.lowercased().split(separator: "x").compactMap { Double($0) }
                    if parts.count == 2 { size = NSSize(width: parts[0], height: parts[1]) }
                }
                index += 1
            case "--web-dir":
                if let next { webRoot = URL(fileURLWithPath: next) }
                index += 1
            default:
                // Finder passes -psn_…; Xcode and `open` pass -NS… defaults pairs.
                if argument.hasPrefix("-") {
                    if argument.hasPrefix("-NS") || argument.hasPrefix("-Apple") { index += 1 }
                } else {
                    files.append(argument)
                }
            }
            index += 1
        }
    }
}

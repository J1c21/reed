import AppKit
import SumiCore
import WebKit

/// One notebook window: a WKWebView running the UI, bridged to the native core.
final class NotebookWindowController: NSWindowController, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, EventSink, NSMenuItemValidation {
    let client = RPCClient()
    private(set) var webView: SumiWebView!
    private unowned let app: AppDelegate

    /// The file to load when the page asks (`window.init`).
    private(set) var initialPath: String?
    private(set) var filePath: String?
    private(set) var isDirty = false
    /// The notebook has a file and saves to it by itself (File ▸ Save Automatically).
    private(set) var savesItself = false
    private(set) var documentTitle = "Untitled"
    private var commandStates: [String: [String: Bool]] = [:]

    private var pendingEvents: [String] = []
    private var flushScheduled = false
    private let eventLock = NSLock()
    private var pageReady = false
    private var isClosing = false
    private var readyHandlers: [() -> Void] = []
    private var showFallback: DispatchWorkItem?
    private var didInit = false
    private let createdAt = Date()
    /// Set for automated snapshot runs: the window never takes focus or appears on screen.
    var isHeadless = false

    /// True for a brand-new notebook nobody has touched: opening a file may reuse its window.
    var isPristine: Bool { filePath == nil && initialPath == nil && !isDirty }

    init(app: AppDelegate, path: String?) {
        self.app = app
        self.initialPath = path
        self.filePath = path

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1060, height: 780),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: true
        )
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.titlebarSeparatorStyle = .none
        // An empty compact toolbar makes AppKit lay out a taller title bar with the traffic
        // lights centred in it. It draws nothing and takes no clicks: the page, which extends
        // underneath, renders the bar's contents and handles its events.
        window.toolbar = NSToolbar(identifier: "sumi.titlebar")
        window.toolbarStyle = .unifiedCompact
        window.minSize = NSSize(width: 480, height: 360)
        window.isReleasedWhenClosed = false
        window.tabbingMode = .disallowed
        window.animationBehavior = .documentWindow
        super.init(window: window)
        window.delegate = self
        client.sink = self

        if let path {
            documentTitle = ((path as NSString).lastPathComponent as NSString).deletingPathExtension
            window.representedURL = URL(fileURLWithPath: path)
        }
        window.title = documentTitle

        // The page fills the window and paints its own background. Until it has (and at the
        // edge of a fast resize) the window shows through, so it is given the page's colour.
        window.backgroundColor = NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor(srgbRed: 0x1c / 255, green: 0x1c / 255, blue: 0x1d / 255, alpha: 1)
                : .white
        }

        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(app.schemeHandler, forURLScheme: SchemeHandler.scheme)
        configuration.userContentController.addScriptMessageHandler(
            WebBridge(router: app.hub.router, client: client, origin: app.pageOrigin),
            contentWorld: .page,
            name: WebBridge.name
        )
        configuration.preferences.setValue(true, forKey: "developerExtrasEnabled")
        configuration.suppressesIncrementalRendering = false

        webView = SumiWebView(frame: window.contentLayoutRect, configuration: configuration)
        webView.autoresizingMask = [.width, .height]
        webView.setValue(false, forKey: "drawsBackground")
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsMagnification = false
        webView.allowsBackForwardNavigationGestures = false
        if #available(macOS 13.3, *) { webView.isInspectable = true }
        webView.onOpenFiles = { [weak app] urls in
            urls.forEach { app?.openNotebook(at: $0.path) }
        }
        window.contentView = webView
        // The page has the keyboard from the start, handed over directly. Left to find a first
        // responder by itself, the window would walk its key-view loop into the web view, and
        // WebKit takes that as a Tab press: it would focus the first focusable thing on the
        // page — a cell's editor — and the notebook would open with the caret already in it.
        window.initialFirstResponder = webView

        app.hub.add(client)
        webView.load(URLRequest(url: app.pageURL))

        // Never leave the user staring at nothing if the page fails to report in.
        let fallback = DispatchWorkItem { [weak self] in self?.pageDidBecomeReady(viaFallback: true) }
        showFallback = fallback
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0, execute: fallback)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    // MARK: - Page lifecycle

    /// What the page receives from `window.init`.
    func initPayload() -> [String: Any] {
        let path = initialPath
        initialPath = nil
        didInit = true
        return [
            "host": "app",
            "filePath": path ?? NSNull(),
            "preferences": app.preferences.all(),
            "titlebarHeight": Double(titlebarHeight),
            "trafficLightsWidth": Double(trafficLightsWidth),
            "home": NSHomeDirectory(),
            "version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev",
            // An automated run (see --snapshot) looks at notebooks; it must never write to them.
            "automated": isHeadless,
        ]
    }

    /// The page has painted its first frame: reveal the window.
    func pageDidBecomeReady(viaFallback: Bool = false) {
        showFallback?.cancel()
        showFallback = nil
        guard !pageReady else { return }
        pageReady = true
        Log.debug("window shown \(Int(Date().timeIntervalSince(createdAt) * 1000)) ms after creation\(viaFallback ? " (fallback: the page never reported ready)" : "")")
        guard let window, !isClosing else { return }
        if isHeadless {
            // On a screen (so WebKit renders) but out of sight.
            if let screen = NSScreen.main {
                window.setFrameOrigin(NSPoint(x: screen.frame.maxX - 1, y: screen.frame.minY - window.frame.height + 1))
            }
            window.makeFirstResponder(webView)
            window.orderFrontRegardless()
        } else {
            window.makeFirstResponder(webView)
            window.makeKeyAndOrderFront(nil)
        }
        let handlers = readyHandlers
        readyHandlers.removeAll()
        handlers.forEach { $0() }
    }

    func whenReady(_ handler: @escaping () -> Void) {
        if pageReady { handler() } else { readyHandlers.append(handler) }
    }

    /// Loads a file into this (pristine) window instead of opening another one.
    func load(path: String) {
        filePath = path
        documentTitle = ((path as NSString).lastPathComponent as NSString).deletingPathExtension
        window?.title = documentTitle
        window?.representedURL = URL(fileURLWithPath: path)
        if didInit {
            client.emit("doc.open", ["path": path])
        } else {
            initialPath = path
        }
    }

    // MARK: - Title bar

    /// Height of the title bar area the page draws into, as AppKit laid it out.
    var titlebarHeight: CGFloat {
        guard let window else { return 40 }
        window.layoutIfNeeded()
        let height = window.frame.height - window.contentLayoutRect.maxY
        return height > 20 && height < 80 ? height : 40
    }

    /// Horizontal space the traffic lights occupy, including their leading inset.
    var trafficLightsWidth: CGFloat {
        guard let zoom = window?.standardWindowButton(.zoomButton) else { return 78 }
        return zoom.convert(zoom.bounds, to: nil).maxX + 8
    }

    func windowWillEnterFullScreen(_ notification: Notification) {
        client.emit("window.fullscreen", ["on": true])
    }

    func windowDidExitFullScreen(_ notification: Notification) {
        client.emit("window.fullscreen", ["on": false])
    }

    func startWindowDrag() {
        // The request arrives a moment after the click. If the button has already been
        // released there is nothing to drag — starting now would glue the window to the cursor.
        guard NSEvent.pressedMouseButtons & 1 == 1 else { return }
        guard let window, let event = webView.lastMouseDown ?? NSApp.currentEvent, event.type == .leftMouseDown else { return }
        window.performDrag(with: event)
    }

    func performTitlebarDoubleClick() {
        guard let window else { return }
        let action = UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") ?? "Maximize"
        switch action {
        case "Minimize": window.miniaturize(nil)
        case "None": break
        default: window.zoom(nil)
        }
    }

    func applyAppearance(_ name: String) {
        switch name {
        case "light": window?.appearance = NSAppearance(named: .aqua)
        case "dark": window?.appearance = NSAppearance(named: .darkAqua)
        default: window?.appearance = nil
        }
    }

    // MARK: - Document state

    func setDocumentState(path: String?, dirty: Bool, title: String, savesItself: Bool) {
        filePath = path
        isDirty = dirty
        self.savesItself = savesItself
        documentTitle = title
        guard let window else { return }
        window.title = title
        window.representedURL = path.map { URL(fileURLWithPath: $0) }
        window.isDocumentEdited = dirty
    }

    func setCommandStates(_ states: [String: [String: Bool]]) {
        commandStates = states
    }

    // MARK: - Menu commands

    @objc func performWebCommand(_ sender: Any?) {
        guard let id = (sender as? NSMenuItem)?.representedObject as? String else { return }
        sendCommand(id)
    }

    func sendCommand(_ id: String) {
        client.emit("menu.command", ["id": id])
    }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        guard menuItem.action == #selector(performWebCommand(_:)), let id = menuItem.representedObject as? String else { return true }
        let state = commandStates[id]
        menuItem.state = state?["checked"] == true ? .on : .off
        return state?["enabled"] ?? true
    }

    @objc func saveDocument(_ sender: Any?) { sendCommand("file.save") }
    @objc func saveDocumentAs(_ sender: Any?) { sendCommand("file.saveAs") }

    // MARK: - Events to the page

    func emit(event: String, json: String) {
        let entry = "[" + JSON.quote(event) + "," + json + "]"
        eventLock.lock()
        pendingEvents.append(entry)
        let schedule = !flushScheduled
        flushScheduled = true
        eventLock.unlock()
        if schedule {
            DispatchQueue.main.async { [weak self] in self?.flushEvents() }
        }
    }

    /// Kernel output can arrive thousands of messages at a time; everything that queued up
    /// since the last turn of the run loop crosses into the page as one batch.
    private func flushEvents() {
        eventLock.lock()
        let batch = pendingEvents
        pendingEvents.removeAll(keepingCapacity: true)
        flushScheduled = false
        eventLock.unlock()
        guard !batch.isEmpty, !isClosing else { return }
        let payload = "[" + batch.joined(separator: ",") + "]"
        webView.callAsyncJavaScript(
            "if (window.__sumiReceive) window.__sumiReceive(batch)",
            arguments: ["batch": payload],
            in: nil,
            in: .page,
            completionHandler: nil
        )
    }

    func evaluate(_ script: String, completion: ((Result<Any, Error>) -> Void)? = nil) {
        webView.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page, completionHandler: completion)
    }

    // MARK: - Closing

    /// Asks about unsaved changes. Calls back with `true` when it is fine to close.
    func confirmClose(_ completion: @escaping (Bool) -> Void) {
        guard isDirty, let window else {
            completion(true)
            return
        }
        // A notebook that saves itself is not asked about: the last few keystrokes are
        // written out and the window closes. Only if that fails does the question come up.
        if savesItself, filePath != nil {
            evaluate("return await window.__sumi.saveForClose()") { [weak self] result in
                if case .success(let value) = result, (value as? Bool) == true {
                    completion(true)
                } else {
                    self?.askToSave(in: window, completion)
                }
            }
            return
        }
        askToSave(in: window, completion)
    }

    private func askToSave(in window: NSWindow, _ completion: @escaping (Bool) -> Void) {
        window.makeKeyAndOrderFront(nil)
        let alert = NSAlert()
        alert.messageText = "Do you want to save the changes made to “\(documentTitle)”?"
        alert.informativeText = "Your changes will be lost if you don’t save them."
        alert.addButton(withTitle: filePath == nil ? "Save…" : "Save")
        alert.addButton(withTitle: "Cancel")
        let discard = alert.addButton(withTitle: "Don’t Save")
        discard.hasDestructiveAction = true
        discard.keyEquivalent = "d"
        discard.keyEquivalentModifierMask = [.command]
        alert.beginSheetModal(for: window) { [weak self] response in
            guard let self else { return }
            switch response {
            case .alertFirstButtonReturn:
                self.evaluate("return await window.__sumi.saveForClose()") { result in
                    if case .success(let value) = result, (value as? Bool) == true {
                        completion(true)
                    } else {
                        completion(false)
                    }
                }
            case .alertThirdButtonReturn:
                completion(true)
            default:
                completion(false)
            }
        }
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if isClosing { return true }
        confirmClose { [weak self] proceed in
            guard proceed, let self else { return }
            self.isClosing = true
            self.window?.close()
        }
        return false
    }

    func closeWithoutAsking() {
        isClosing = true
        window?.close()
    }

    func windowWillClose(_ notification: Notification) {
        isClosing = true
        showFallback?.cancel()
        app.kernels.shutdownAll(ownedBy: client.id)
        app.hub.remove(client)
        webView.configuration.userContentController.removeScriptMessageHandler(forName: WebBridge.name, contentWorld: .page)
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        webView.stopLoading()
        app.controllerDidClose(self)
    }

    // MARK: - Navigation

    private func openExternally(_ url: URL) {
        guard let scheme = url.scheme?.lowercased(), ["http", "https", "mailto"].contains(scheme) else { return }
        NSWorkspace.shared.open(url)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        guard let target = navigationAction.targetFrame else {
            // target="_blank" and window.open: hand the link to the browser.
            openExternally(url)
            decisionHandler(.cancel)
            return
        }
        if target.isMainFrame {
            // The window only ever shows the app itself.
            let origin = app.pageOrigin
            if url.scheme == origin.scheme, url.host == origin.host, url.port == origin.port {
                decisionHandler(.allow)
            } else {
                openExternally(url)
                decisionHandler(.cancel)
            }
            return
        }
        // Inside an output: a clicked link opens in the browser instead of replacing the output.
        if navigationAction.navigationType == .linkActivated {
            openExternally(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { openExternally(url) }
        return nil
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // The page crashed. Kernels belong to it and its unsaved state is gone; start over.
        Log.info("web content process terminated; reloading")
        app.kernels.shutdownAll(ownedBy: client.id)
        initialPath = filePath
        didInit = false
        webView.reload()
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        guard frame.isMainFrame, let window else {
            completionHandler()
            return
        }
        let alert = NSAlert()
        alert.messageText = message
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard frame.isMainFrame, let window else {
            completionHandler(false)
            return
        }
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    // MARK: - A scripted mouse (for automated checks)

    /// Presses, moves or releases the mouse at a point in the page (in the page's own pixels,
    /// from its top left), as far as the web view can tell. What the engine itself does with
    /// a click — placing a caret, moving the focus — only happens for events like these, so
    /// a scripted run uses them where a made-up DOM event would prove nothing.
    func simulateMouse(_ kind: String, x: Double, y: Double, clickCount: Int, modifiers: NSEvent.ModifierFlags) {
        guard let window else { return }
        let zoom = Double(webView.pageZoom)
        let inView = NSPoint(x: x * zoom, y: webView.isFlipped ? y * zoom : Double(webView.bounds.height) - y * zoom)
        let location = webView.convert(inView, to: nil)
        func send(_ type: NSEvent.EventType) {
            guard let event = NSEvent.mouseEvent(
                with: type, location: location, modifierFlags: modifiers,
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil,
                eventNumber: 0, clickCount: type == .mouseMoved ? 0 : clickCount, pressure: type == .leftMouseDown ? 1 : 0
            ) else { return }
            switch type {
            case .leftMouseDown: webView.mouseDown(with: event)
            case .leftMouseUp: webView.mouseUp(with: event)
            case .leftMouseDragged: webView.mouseDragged(with: event)
            default: webView.mouseMoved(with: event)
            }
        }
        switch kind {
        case "down": send(.leftMouseDown)
        case "up": send(.leftMouseUp)
        case "drag": send(.leftMouseDragged)
        case "move": send(.mouseMoved)
        default:
            send(.leftMouseDown)
            send(.leftMouseUp)
        }
    }

    // MARK: - Snapshots (for automated visual checks)

    /// Renders the window — native chrome plus web content — to a PNG file.
    func snapshot(to url: URL, completion: @escaping (Bool) -> Void) {
        guard let window, let frameView = window.contentView?.superview else {
            completion(false)
            return
        }
        let configuration = WKSnapshotConfiguration()
        webView.takeSnapshot(with: configuration) { image, _ in
            let bounds = frameView.bounds
            guard let chrome = frameView.bitmapImageRepForCachingDisplay(in: bounds) else {
                completion(false)
                return
            }
            frameView.cacheDisplay(in: bounds, to: chrome)
            let scale = window.backingScaleFactor
            let composite = NSImage(size: bounds.size)
            composite.lockFocus()
            NSColor.windowBackgroundColor.setFill()
            bounds.fill()
            image?.draw(in: self.webView.convert(self.webView.bounds, to: frameView))
            // Only the strip with the traffic lights comes from the AppKit rendering.
            let strip = NSRect(x: 0, y: bounds.height - self.titlebarHeight, width: self.trafficLightsWidth, height: self.titlebarHeight)
            chrome.draw(in: strip, from: strip, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
            composite.unlockFocus()
            _ = scale
            guard let tiff = composite.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
                  let png = rep.representation(using: .png, properties: [:])
            else {
                completion(false)
                return
            }
            completion((try? png.write(to: url)) != nil)
        }
    }
}

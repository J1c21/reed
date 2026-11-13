import AppKit
import ReedCore
import UniformTypeIdentifiers
import WebKit

// MARK: - Web view

/// The web view hosting the notebook UI. It remembers the last mouse-down so the page can
/// start a window drag, and opens notebooks dropped onto it instead of navigating to them.
final class ReedWebView: WKWebView {
    var onOpenFiles: (([URL]) -> Void)?
    private(set) var lastMouseDown: NSEvent?

    override func mouseDown(with event: NSEvent) {
        lastMouseDown = event
        super.mouseDown(with: event)
    }

    private func notebooks(in info: NSDraggingInfo) -> [URL] {
        let urls = info.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
        return urls.filter { $0.pathExtension.lowercased() == "ipynb" }
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        notebooks(in: sender).isEmpty ? super.draggingEntered(sender) : .copy
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        notebooks(in: sender).isEmpty ? super.draggingUpdated(sender) : .copy
    }

    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool {
        notebooks(in: sender).isEmpty ? super.prepareForDragOperation(sender) : true
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let files = notebooks(in: sender)
        guard !files.isEmpty else { return super.performDragOperation(sender) }
        onOpenFiles?(files)
        return true
    }
}

// MARK: - reed:// scheme

/// Serves the bundled web UI from `reed://app/…`, and local media that notebooks reference
/// from `reed://app/__file__/absolute/path`.
final class SchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "reed"
    static let host = "app"

    private let root: URL
    private let queue = DispatchQueue(label: "reed.scheme", qos: .userInitiated, attributes: .concurrent)
    private var stopped = Set<ObjectIdentifier>()
    private let lock = NSLock()

    /// Only passive media may be read from arbitrary locations on disk.
    private static let mediaExtensions: Set<String> = [
        "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif", "heic", "tif", "tiff",
        "mp4", "webm", "mov", "m4v", "mp3", "wav", "m4a", "ogg", "pdf",
    ]

    private static let contentSecurityPolicy = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https: http:",
        "media-src 'self' data: blob: https: http:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "frame-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
    ].joined(separator: "; ")

    init(root: URL) {
        self.root = root.standardizedFileURL
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else {
            task.didFailWithError(URLError(.badURL))
            return
        }
        let id = ObjectIdentifier(task)
        queue.async {
            let (status, headers, body) = self.respond(to: url)
            DispatchQueue.main.async {
                self.lock.lock()
                let wasStopped = self.stopped.remove(id) != nil
                self.lock.unlock()
                guard !wasStopped else { return }
                var fields = headers
                fields["Content-Length"] = String(body.count)
                fields["Cache-Control"] = "no-cache"
                guard let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: fields) else {
                    task.didFailWithError(URLError(.badServerResponse))
                    return
                }
                task.didReceive(response)
                task.didReceive(body)
                task.didFinish()
            }
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        lock.lock()
        stopped.insert(ObjectIdentifier(task))
        lock.unlock()
    }

    private func respond(to url: URL) -> (Int, [String: String], Data) {
        let path = url.path
        let filePrefix = "/__file__"
        if path.hasPrefix(filePrefix + "/") {
            let file = URL(fileURLWithPath: String(path.dropFirst(filePrefix.count))).standardizedFileURL
            guard Self.mediaExtensions.contains(file.pathExtension.lowercased()),
                  let data = try? Data(contentsOf: file)
            else { return (404, ["Content-Type": "text/plain"], Data("Not found".utf8)) }
            return (200, ["Content-Type": Self.mimeType(for: file)], data)
        }

        let relative = path.isEmpty || path == "/" ? "index.html" : String(path.dropFirst())
        let file = root.appendingPathComponent(relative).standardizedFileURL
        guard file.path.hasPrefix(root.path + "/"), let data = try? Data(contentsOf: file) else {
            return (404, ["Content-Type": "text/plain"], Data("Not found".utf8))
        }
        var headers = ["Content-Type": Self.mimeType(for: file)]
        // The app's own page may only run the app's own scripts. The output sandbox is exempt:
        // running notebook scripts is its purpose, and it has no privileges to abuse.
        if file.pathExtension == "html", file.lastPathComponent != "sandbox.html" {
            headers["Content-Security-Policy"] = Self.contentSecurityPolicy
        }
        return (200, headers, data)
    }

    private static func mimeType(for file: URL) -> String {
        switch file.pathExtension.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json", "map": return "application/json; charset=utf-8"
        case "svg": return "image/svg+xml"
        case "woff2": return "font/woff2"
        case "woff": return "font/woff"
        case "ttf": return "font/ttf"
        case "wasm": return "application/wasm"
        case "txt": return "text/plain; charset=utf-8"
        default:
            return UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        }
    }
}

// MARK: - Script message bridge

/// Receives RPC requests from the page and answers them through the shared router.
final class WebBridge: NSObject, WKScriptMessageHandlerWithReply {
    static let name = "reed"

    private let router: RPCRouter
    private let client: RPCClient
    private let allowedOrigin: (scheme: String, host: String, port: Int)

    init(router: RPCRouter, client: RPCClient, origin: URL) {
        self.router = router
        self.client = client
        self.allowedOrigin = (origin.scheme ?? "", origin.host ?? "", origin.port ?? 0)
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        // Script message handlers are visible to every frame. Only the app's own top-level
        // page may use them — never an output sandbox or a page that was navigated to.
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame,
              origin.protocol == allowedOrigin.scheme,
              origin.host == allowedOrigin.host,
              origin.port == allowedOrigin.port
        else {
            replyHandler(nil, "Not allowed.")
            return
        }
        guard let body = message.body as? [String: Any], let method = body["method"] as? String else {
            replyHandler(nil, "Malformed request.")
            return
        }
        let params = body["params"]
        let router = self.router
        let client = self.client
        Task {
            do {
                let result = try await router.handle(method: method, params: params, client: client)
                await MainActor.run { replyHandler(result ?? NSNull(), nil) }
            } catch {
                await MainActor.run { replyHandler(nil, error.localizedDescription) }
            }
        }
    }
}

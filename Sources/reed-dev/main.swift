import Foundation
import Network
import ReedCore

// reed-dev — a headless host for developing the web UI in an ordinary browser.
//
// It exposes the same RPC surface as the app, over a loopback WebSocket:
//   → {"id": 1, "method": "kernel.start", "params": {…}}
//   ← {"id": 1, "result": {…}}   or   {"id": 1, "error": {"message": "…"}}
//   ← {"event": "kernel.message", "payload": {…}}
//
// Usage: reed-dev [--port 47821] [--selftest]

let arguments = CommandLine.arguments
func option(_ name: String) -> String? {
    guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else { return nil }
    return arguments[index + 1]
}

let hub = Hub()
let kernels = KernelManager()
let preferences = PreferencesStore(
    hub: hub,
    directory: FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("Reed-dev", isDirectory: true)
)
kernels.register(on: hub.router)
FileService.register(on: hub.router)
preferences.register(on: hub.router)

// Stand-ins for the handful of methods only the real app can implement.
hub.router.register("window.init") { params, _ in
    [
        "host": "dev",
        "filePath": params["filePath"] ?? NSNull(),
        "preferences": preferences.all(),
        "titlebarHeight": 38,
        "trafficLightsWidth": 78,
        "home": NSHomeDirectory(),
        "version": "dev",
    ] as [String: Any]
}
for method in [
    "doc.setState", "window.setAppearance", "window.setZoom", "window.startDrag", "window.zoom", "window.ready",
    "menu.setState", "app.open", "app.openExternal", "app.reveal", "app.noteRecent", "app.recents", "clipboard.writeText", "clipboard.writeImage",
] {
    hub.router.register(method) { _, _ in nil }
}

// MARK: - WebSocket host

final class DevConnection: EventSink {
    static var live: [ObjectIdentifier: DevConnection] = [:]
    static let liveLock = NSLock()

    let connection: NWConnection
    let client = RPCClient()
    let queue = DispatchQueue(label: "reed.dev.connection")
    private var closed = false

    init(_ connection: NWConnection) {
        self.connection = connection
        client.sink = self
    }

    func start() {
        Self.liveLock.lock()
        Self.live[ObjectIdentifier(self)] = self
        Self.liveLock.unlock()
        hub.add(client)
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                Log.info("browser connected")
                self?.receive()
            case .failed, .cancelled:
                self?.close()
            default:
                break
            }
        }
        connection.start(queue: queue)
    }

    private func receive() {
        connection.receiveMessage { [weak self] data, context, _, error in
            guard let self, !self.closed else { return }
            if error != nil {
                self.close()
                return
            }
            let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata
            if metadata?.opcode == .close {
                self.close()
                return
            }
            if let data, !data.isEmpty, metadata?.opcode == .text {
                self.handle(data)
            }
            self.receive()
        }
    }

    private func handle(_ data: Data) {
        guard let request = JSON.parse(data) as? [String: Any],
              let method = request["method"] as? String
        else { return }
        let id = JSON.string(request["id"])
        let params = request["params"]
        Task {
            do {
                let result = try await hub.router.handle(method: method, params: params, client: self.client)
                self.send("{\"id\":\(id),\"result\":\(JSON.string(result))}")
            } catch {
                let code = (error as? RPCError)?.code ?? "error"
                let payload: [String: Any] = ["message": error.localizedDescription, "code": code]
                self.send("{\"id\":\(id),\"error\":\(JSON.string(payload))}")
            }
        }
    }

    func emit(event: String, json: String) {
        send("{\"event\":\(JSON.quote(event)),\"payload\":\(json)}")
    }

    private func send(_ text: String) {
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "text", metadata: [metadata])
        connection.send(content: Data(text.utf8), contentContext: context, isComplete: true, completion: .contentProcessed { _ in })
    }

    private func close() {
        guard !closed else { return }
        closed = true
        Log.info("browser disconnected")
        connection.cancel()
        hub.remove(client)
        kernels.shutdownAll(ownedBy: client.id)
        Self.liveLock.lock()
        Self.live.removeValue(forKey: ObjectIdentifier(self))
        Self.liveLock.unlock()
    }
}

func startServer() {
    let port = UInt16(option("--port") ?? "") ?? 47821
    let websocket = NWProtocolWebSocket.Options()
    websocket.autoReplyPing = true
    websocket.maximumMessageSize = 512 << 20
    // Browsers happily open WebSockets across origins, so only accept pages served from
    // this machine's own dev server.
    websocket.setClientRequestHandler(.global()) { _, headers in
        let origin = headers.first { $0.name.lowercased() == "origin" }?.value ?? ""
        let allowed = origin.hasPrefix("http://localhost:") || origin.hasPrefix("http://127.0.0.1:")
        if !allowed { Log.info("rejected a connection from origin “\(origin)”") }
        return NWProtocolWebSocket.Response(status: allowed ? .accept : .reject, subprotocol: nil)
    }
    let parameters = NWParameters.tcp
    parameters.defaultProtocolStack.applicationProtocols.insert(websocket, at: 0)
    parameters.allowLocalEndpointReuse = true
    parameters.acceptLocalOnly = true
    parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: NWEndpoint.Port(rawValue: port)!)

    do {
        let listener = try NWListener(using: parameters)
        listener.newConnectionHandler = { connection in
            DevConnection(connection).start()
        }
        listener.stateUpdateHandler = { state in
            switch state {
            case .ready:
                Log.info("reed-dev listening on ws://127.0.0.1:\(port)")
            case .failed(let error):
                Log.info("listener failed: \(error)")
                exit(1)
            default:
                break
            }
        }
        listener.start(queue: .main)
        // Keep the listener alive for the lifetime of the process.
        _ = Unmanaged.passRetained(listener)
    } catch {
        Log.info("could not start: \(error)")
        exit(1)
    }
}

// MARK: - Self test

final class SelfTestSink: EventSink {
    var seen: [String] = []
    let lock = NSLock()

    func emit(event: String, json: String) {
        guard let object = JSON.parse(json) as? [String: Any] else { return }
        if event == "kernel.message" {
            let header = object["header"] as? [String: Any] ?? [:]
            let type = header["msg_type"] as? String ?? "?"
            let channel = object["channel"] as? String ?? "?"
            var detail = ""
            let content = object["content"] as? [String: Any] ?? [:]
            switch type {
            case "status": detail = content["execution_state"] as? String ?? ""
            case "stream": detail = (content["text"] as? String ?? "").trimmingCharacters(in: .newlines)
            case "execute_result": detail = ((content["data"] as? [String: Any])?["text/plain"] as? String) ?? ""
            case "error": detail = content["ename"] as? String ?? ""
            case "execute_reply": detail = content["status"] as? String ?? ""
            case "input_request": detail = content["prompt"] as? String ?? ""
            case "kernel_info_reply":
                detail = ((content["language_info"] as? [String: Any])?["version"] as? String ?? "") + " / protocol " + (content["protocol_version"] as? String ?? "")
            default: break
            }
            lock.lock()
            seen.append(type)
            lock.unlock()
            print("  ← [\(channel)] \(type) \(detail)")
        } else {
            print("  ← event \(event): \(json.prefix(400))")
        }
    }

    func count(_ type: String) -> Int {
        lock.lock()
        defer { lock.unlock() }
        return seen.filter { $0 == type }.count
    }
}

func runSelfTest() {
    Task {
        let sink = SelfTestSink()
        let client = RPCClient(sink: sink)
        let started = Date()
        let specs = await kernels.listSpecs(notebookDir: FileManager.default.currentDirectoryPath)
        print("discovered \(specs.count) kernels in \(String(format: "%.0f", Date().timeIntervalSince(started) * 1000)) ms")
        for spec in specs {
            print("  \(spec.available ? "●" : "○") \(spec.id)  “\(spec.displayName)”  \(spec.language) \(spec.pythonVersion ?? "")  [\(spec.envKind ?? spec.kind.rawValue)]")
        }
        let wanted = option("--kernel")
        guard let spec = specs.first(where: { $0.available && (wanted == nil ? $0.language == "python" : $0.id.contains(wanted!)) }) else {
            print("no usable kernel found")
            exit(1)
        }
        do {
            let launch = Date()
            let session = try await kernels.start(specId: spec.id, cwd: NSHomeDirectory(), client: client, extraArguments: [])
            print("channels connected in \(String(format: "%.0f", Date().timeIntervalSince(launch) * 1000)) ms — pid \(session.pid), own process group: \(getpgid(session.pid) == session.pid)")

            func request(_ type: String, _ content: [String: Any], channel: String = "shell") {
                let header: [String: Any] = [
                    "msg_id": UUID().uuidString.lowercased(), "session": "selftest", "username": "reed",
                    "date": ISO8601DateFormatter().string(from: Date()), "msg_type": type, "version": "5.3",
                ]
                print("  → [\(channel)] \(type)")
                session.send(channel: channel, message: WireMessage(
                    header: Data(JSON.string(header).utf8), parentHeader: Data("{}".utf8),
                    metadata: Data("{}".utf8), content: Data(JSON.string(content).utf8)
                ))
            }
            func execute(_ code: String) {
                request("execute_request", [
                    "code": code, "silent": false, "store_history": true,
                    "user_expressions": [String: Any](), "allow_stdin": true, "stop_on_error": true,
                ])
            }
            func pause(_ seconds: Double) async { try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) }

            // Wait until the kernel answers and iopub is flowing.
            for _ in 0 ..< 100 {
                request("kernel_info_request", [:])
                await pause(0.3)
                if sink.count("kernel_info_reply") > 0 && sink.count("status") > 0 { break }
            }
            print("kernel ready \(String(format: "%.0f", Date().timeIntervalSince(launch) * 1000)) ms after launch")

            execute("import sys\nprint('héllo 你好 from', sys.version.split()[0])\n6 * 7")
            await pause(1.0)
            execute("print('x' * 300000)")
            await pause(1.0)
            print("-- interrupt")
            execute("import time\ntime.sleep(30)")
            await pause(0.8)
            session.interrupt()
            await pause(0.8)
            print("-- stdin")
            execute("name = input('who? ')\nprint('hi', name)")
            await pause(0.8)
            request("input_reply", ["value": "reed"], channel: "stdin")
            await pause(0.8)

            let stop = Date()
            await kernels.shutdown(session.id)
            print("shutdown in \(String(format: "%.0f", Date().timeIntervalSince(stop) * 1000)) ms")
            let ok = sink.count("execute_reply") >= 4 && sink.count("input_request") == 1 && sink.count("error") >= 1
            print(ok ? "SELFTEST PASSED" : "SELFTEST FAILED")
            exit(ok ? 0 : 1)
        } catch {
            print("failed: \(error.localizedDescription)")
            exit(1)
        }
    }
}

if arguments.contains("--selftest") {
    runSelfTest()
} else {
    startServer()
}
dispatchMain()

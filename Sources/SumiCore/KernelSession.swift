import Foundation

public enum KernelError: Error, LocalizedError {
    case executableNotFound(String)
    case launchFailed(String)
    case exitedDuringStartup(code: Int32, log: String)
    case notRunning
    case unknownSpec(String)
    case unavailable(String)

    public var errorDescription: String? {
        switch self {
        case .executableNotFound(let name):
            return "Could not find the kernel executable “\(name)”."
        case .launchFailed(let reason):
            return "The kernel could not be launched: \(reason)"
        case .exitedDuringStartup(let code, let log):
            let detail = log.trimmingCharacters(in: .whitespacesAndNewlines)
            return "The kernel exited while starting (code \(code))." + (detail.isEmpty ? "" : "\n\n" + detail)
        case .notRunning:
            return "The kernel is not running."
        case .unknownSpec(let id):
            return "Unknown kernel “\(id)”."
        case .unavailable(let reason):
            return reason
        }
    }
}

/// One running kernel: the child process plus its four ZeroMQ channels.
public final class KernelSession: @unchecked Sendable {
    public let id = UUID().uuidString.lowercased()
    public let spec: KernelSpec
    public let cwd: String
    public let ownerId: String
    public private(set) var pid: Int32 = 0

    private let queue: DispatchQueue
    private weak var client: RPCClient?
    private let codec: WireCodec
    private let key = UUID().uuidString.lowercased()
    private var ports: [UInt16] = []
    private let connectionFile: URL
    private var process: Process?
    private var channels: [String: ZMTPConnection] = [:]
    private var log = ""
    private var exited = false
    private var expectedExit = false
    private var startCompletion: ((Result<Void, Error>) -> Void)?
    private var exitWaiters: [() -> Void] = []

    public var onExit: ((KernelSession) -> Void)?

    public init(spec: KernelSpec, cwd: String, client: RPCClient) {
        self.spec = spec
        self.cwd = cwd
        self.client = client
        self.ownerId = client.id
        self.queue = DispatchQueue(label: "sumi.kernel." + id)
        self.codec = WireCodec(key: key)
        let runtimeDir = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Jupyter/runtime")
        self.connectionFile = runtimeDir.appendingPathComponent("kernel-\(id).json")
    }

    // MARK: - Starting

    public func start(environment: [String: String], extraArguments: [String] = []) async throws {
        try launch(environment: environment, extraArguments: extraArguments)
        try await connect()
    }

    private func launch(environment base: [String: String], extraArguments: [String]) throws {
        ports = try Self.freePorts(5)
        let info: [String: Any] = [
            "transport": "tcp",
            "ip": "127.0.0.1",
            "shell_port": Int(ports[0]),
            "iopub_port": Int(ports[1]),
            "stdin_port": Int(ports[2]),
            "control_port": Int(ports[3]),
            "hb_port": Int(ports[4]),
            "key": key,
            "signature_scheme": "hmac-sha256",
            "kernel_name": spec.name,
        ]
        let fm = FileManager.default
        try fm.createDirectory(at: connectionFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = try JSONSerialization.data(withJSONObject: info, options: [.prettyPrinted, .sortedKeys])
        guard fm.createFile(atPath: connectionFile.path, contents: data, attributes: [.posixPermissions: 0o600]) else {
            throw KernelError.launchFailed("could not write \(connectionFile.path)")
        }

        var env = base
        env.removeValue(forKey: "PYTHONHOME")
        env["JPY_PARENT_PID"] = String(getpid())
        env["PYDEVD_DISABLE_FILE_VALIDATION"] = "1"
        // A light-weight "activation": enough for tools that look at these variables.
        if let prefix = spec.envPrefix {
            env["PATH"] = prefix + "/bin:" + (env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin")
            switch spec.envKind {
            case "conda":
                env["CONDA_PREFIX"] = prefix
                env["CONDA_DEFAULT_ENV"] = spec.envName ?? (prefix as NSString).lastPathComponent
                env.removeValue(forKey: "VIRTUAL_ENV")
            case "venv", "pipenv", "poetry":
                env["VIRTUAL_ENV"] = prefix
            default:
                break
            }
        }
        for (name, value) in spec.env { env[name] = value }

        var argv = spec.argv.map {
            $0.replacingOccurrences(of: "{connection_file}", with: connectionFile.path)
                .replacingOccurrences(of: "{resource_dir}", with: spec.resourceDir ?? "")
        }
        if KernelDiscovery.isPlainIPyKernel(spec.argv) { argv += extraArguments }
        guard let executable = Self.resolveExecutable(argv[0], path: env["PATH"]) else {
            throw KernelError.executableNotFound(argv[0])
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = Array(argv.dropFirst())
        process.environment = env
        var isDirectory: ObjCBool = false
        if fm.fileExists(atPath: cwd, isDirectory: &isDirectory), isDirectory.boolValue {
            process.currentDirectoryURL = URL(fileURLWithPath: cwd)
        }
        process.standardInput = FileHandle.nullDevice
        let output = Pipe()
        process.standardOutput = output
        process.standardError = output
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            if chunk.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            let text = String(decoding: chunk, as: UTF8.self)
            self?.queue.async {
                guard let self else { return }
                self.log += text
                if self.log.utf8.count > 24_000 { self.log = String(self.log.suffix(16_000)) }
            }
        }
        process.terminationHandler = { [weak self] finished in
            let status = finished.terminationStatus
            let crashed = finished.terminationReason == .uncaughtSignal
            self?.queue.asyncAfter(deadline: .now() + .milliseconds(40)) {
                self?.didExit(status: status, crashed: crashed)
            }
        }
        do {
            try process.run()
        } catch {
            try? fm.removeItem(at: connectionFile)
            throw KernelError.launchFailed(error.localizedDescription)
        }
        self.process = process
        self.pid = process.processIdentifier
        Log.debug("kernel \(id) started: pid \(pid) \(executable) \(argv.dropFirst().joined(separator: " "))")
    }

    private func connect() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            queue.async {
                if self.exited {
                    continuation.resume(throwing: KernelError.exitedDuringStartup(code: -1, log: self.log))
                    return
                }
                var remaining = 4
                self.startCompletion = { [weak self] result in
                    guard let self, self.startCompletion != nil else { return }
                    self.startCompletion = nil
                    continuation.resume(with: result)
                }
                let identity = Data(self.id.utf8)
                let layout: [(String, UInt16, ZMTPSocketType)] = [
                    ("shell", self.ports[0], .dealer),
                    ("iopub", self.ports[1], .sub),
                    ("stdin", self.ports[2], .dealer),
                    ("control", self.ports[3], .dealer),
                ]
                for (name, port, type) in layout {
                    let channel = ZMTPConnection(host: "127.0.0.1", port: port, type: type, identity: identity, queue: self.queue)
                    channel.onReady = { [weak self] in
                        remaining -= 1
                        if remaining == 0 { self?.startCompletion?(.success(())) }
                    }
                    channel.onMessage = { [weak self] frames in
                        self?.received(channel: name, frames: frames)
                    }
                    channel.onClose = { [weak self] error in
                        self?.startCompletion?(.failure(error ?? ZMTPError.closedByPeer))
                    }
                    self.channels[name] = channel
                    channel.connect(timeout: 60)
                }
            }
        }
    }

    // MARK: - Messages

    public func send(channel: String, message: WireMessage) {
        let frames = codec.encode(message)
        queue.async {
            self.channels[channel]?.send(frames)
        }
    }

    private func received(channel: String, frames: [Data]) {
        guard let message = try? codec.decode(frames) else {
            Log.info("dropped an undecodable message on \(channel)")
            return
        }
        var json = "{\"kernelId\":\"\(id)\",\"channel\":\"\(channel)\",\"header\":"
        json.reserveCapacity(message.header.count + message.parentHeader.count + message.metadata.count + message.content.count + 128)
        json += String(decoding: message.header, as: UTF8.self)
        json += ",\"parent_header\":"
        json += String(decoding: message.parentHeader, as: UTF8.self)
        json += ",\"metadata\":"
        json += String(decoding: message.metadata, as: UTF8.self)
        json += ",\"content\":"
        json += String(decoding: message.content, as: UTF8.self)
        if !message.buffers.isEmpty {
            json += ",\"buffers\":["
            json += message.buffers.map { "\"" + $0.base64EncodedString() + "\"" }.joined(separator: ",")
            json += "]"
        }
        json += "}"
        client?.emit("kernel.message", json: json)
    }

    // MARK: - Interrupting and stopping

    public func interrupt() {
        guard pid > 0, !exited else { return }
        signal(SIGINT)
    }

    private func signal(_ sig: Int32) {
        guard pid > 0 else { return }
        // Foundation launches children in their own process group; signalling the group reaches
        // the kernel's subprocesses too (`!sleep 100`), like Jupyter's own kernel manager.
        if getpgid(pid) == pid {
            kill(-pid, sig)
        } else {
            kill(pid, sig)
        }
    }

    /// Asks the kernel to shut down, escalating to SIGTERM and SIGKILL if it does not comply.
    public func shutdown() async {
        let alreadyExited: Bool = await withCheckedContinuation { continuation in
            queue.async {
                self.expectedExit = true
                continuation.resume(returning: self.exited || self.process == nil)
            }
        }
        if alreadyExited {
            cleanUp()
            return
        }
        let header: [String: Any] = [
            "msg_id": UUID().uuidString.lowercased(),
            "session": id,
            "username": "sumi",
            "date": isoTimestamp(),
            "msg_type": "shutdown_request",
            "version": "5.3",
        ]
        send(channel: "control", message: WireMessage(
            header: Data(JSON.string(header).utf8),
            parentHeader: Data("{}".utf8),
            metadata: Data("{}".utf8),
            content: Data("{\"restart\":false}".utf8)
        ))
        if await waitForExit(timeout: 1.5) { return }
        signal(SIGTERM)
        if await waitForExit(timeout: 1.0) { return }
        signal(SIGKILL)
        _ = await waitForExit(timeout: 1.0)
    }

    /// Immediate, synchronous teardown for app termination.
    public func killNow() {
        expectedExit = true
        if pid > 0, process?.isRunning == true { signal(SIGKILL) }
        try? FileManager.default.removeItem(at: connectionFile)
    }

    private func waitForExit(timeout: TimeInterval) async -> Bool {
        await withCheckedContinuation { continuation in
            queue.async {
                if self.exited {
                    continuation.resume(returning: true)
                    return
                }
                var resumed = false
                self.exitWaiters.append {
                    guard !resumed else { return }
                    resumed = true
                    continuation.resume(returning: true)
                }
                self.queue.asyncAfter(deadline: .now() + timeout) {
                    guard !resumed else { return }
                    resumed = true
                    continuation.resume(returning: self.exited)
                }
            }
        }
    }

    private func didExit(status: Int32, crashed: Bool) {
        guard !exited else { return }
        exited = true
        for channel in channels.values { channel.close() }
        channels.removeAll()
        cleanUp()

        if let completion = startCompletion {
            completion(.failure(KernelError.exitedDuringStartup(code: status, log: log)))
        } else {
            client?.emit("kernel.exit", [
                "kernelId": id,
                "code": Int(status),
                "crashed": crashed,
                "expected": expectedExit,
                "log": String(log.suffix(4000)),
            ])
        }
        let waiters = exitWaiters
        exitWaiters.removeAll()
        for waiter in waiters { waiter() }
        onExit?(self)
    }

    private func cleanUp() {
        try? FileManager.default.removeItem(at: connectionFile)
    }

    // MARK: - Helpers

    static func resolveExecutable(_ name: String, path: String?) -> String? {
        let fm = FileManager.default
        if name.contains("/") {
            let expanded = name.expandingTilde
            return fm.isExecutableFile(atPath: expanded) ? expanded : nil
        }
        for dir in (path ?? "/usr/bin:/bin").split(separator: ":") {
            let candidate = String(dir) + "/" + name
            if fm.isExecutableFile(atPath: candidate) { return candidate }
        }
        return nil
    }

    /// Asks the OS for free loopback TCP ports. All sockets are held open until every port is
    /// known so that the same port is never handed out twice.
    static func freePorts(_ count: Int) throws -> [UInt16] {
        var sockets: [Int32] = []
        defer { sockets.forEach { close($0) } }
        var ports: [UInt16] = []
        for _ in 0 ..< count {
            let fd = socket(AF_INET, SOCK_STREAM, 0)
            guard fd >= 0 else { throw KernelError.launchFailed("could not allocate a port") }
            sockets.append(fd)
            var address = sockaddr_in()
            address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
            address.sin_family = sa_family_t(AF_INET)
            address.sin_port = 0
            address.sin_addr.s_addr = inet_addr("127.0.0.1")
            let bound = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
                }
            }
            guard bound == 0 else { throw KernelError.launchFailed("could not bind a port") }
            var length = socklen_t(MemoryLayout<sockaddr_in>.size)
            let named = withUnsafeMutablePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) }
            }
            guard named == 0 else { throw KernelError.launchFailed("could not read a port") }
            ports.append(UInt16(bigEndian: address.sin_port))
        }
        return ports
    }
}

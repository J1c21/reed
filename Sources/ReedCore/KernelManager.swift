import Foundation

/// Tracks running kernels and exposes them over RPC.
public final class KernelManager: @unchecked Sendable {
    private var sessions: [String: KernelSession] = [:]
    private var specs: [String: KernelSpec] = [:]
    private let lock = NSLock()

    public init() {
        // Warm the login-shell environment in the background so the first kernel starts fast.
        DispatchQueue.global(qos: .utility).async { _ = ShellEnvironment.resolved() }
    }

    // MARK: - Discovery

    public func listSpecs(notebookDir: String?) async -> [KernelSpec] {
        let found = await Task.detached(priority: .userInitiated) {
            KernelDiscovery.discover(notebookDir: notebookDir, environment: ShellEnvironment.resolved())
        }.value
        lock.withLock {
            for spec in found { specs[spec.id] = spec }
        }
        return found
    }

    private func spec(_ id: String) -> KernelSpec? {
        lock.lock()
        defer { lock.unlock() }
        return specs[id]
    }

    // MARK: - Lifecycle

    public func start(specId: String, cwd: String, client: RPCClient, extraArguments: [String]) async throws -> KernelSession {
        var resolved = spec(specId)
        if resolved == nil {
            // The spec may predate this process (remembered from a previous run): rediscover.
            _ = await listSpecs(notebookDir: cwd)
            resolved = spec(specId)
        }
        guard let spec = resolved else { throw KernelError.unknownSpec(specId) }
        guard spec.available else {
            throw KernelError.unavailable("ipykernel is not installed in “\(spec.displayName)”.")
        }

        let environment = await Task.detached { ShellEnvironment.resolved() }.value
        let session = KernelSession(spec: spec, cwd: cwd, client: client)
        session.onExit = { [weak self] session in
            self?.forget(session.id)
        }
        lock.withLock { sessions[session.id] = session }
        do {
            try await session.start(environment: environment, extraArguments: extraArguments)
        } catch {
            await session.shutdown()
            forget(session.id)
            throw error
        }
        return session
    }

    public func session(_ id: String) -> KernelSession? {
        lock.lock()
        defer { lock.unlock() }
        return sessions[id]
    }

    public func shutdown(_ id: String) async {
        guard let session = session(id) else { return }
        await session.shutdown()
        forget(id)
    }

    private func forget(_ id: String) {
        lock.withLock { _ = sessions.removeValue(forKey: id) }
    }

    /// Stops every kernel owned by a client (a closing window, a dropped dev connection).
    public func shutdownAll(ownedBy clientId: String) {
        lock.lock()
        let owned = sessions.values.filter { $0.ownerId == clientId }
        lock.unlock()
        for session in owned {
            Task { await self.shutdown(session.id) }
        }
    }

    /// Synchronous teardown, for when the app is about to exit.
    public func killAllNow() {
        lock.lock()
        let all = Array(sessions.values)
        sessions.removeAll()
        lock.unlock()
        for session in all { session.killNow() }
    }

    public var runningCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return sessions.count
    }

    // MARK: - Installing ipykernel

    /// Installs ipykernel into an environment that lacks it, the way that environment expects:
    /// conda for conda environments, pip otherwise (uv for uv-made virtualenvs without pip).
    public func installKernelSupport(specId: String) async throws -> String {
        guard let spec = spec(specId), spec.kind == .environment, let python = spec.pythonPath, let prefix = spec.envPrefix else {
            throw KernelError.unknownSpec(specId)
        }
        let environment = await Task.detached { ShellEnvironment.resolved() }.value
        var commands: [[String]] = []

        if spec.envKind == "conda", let conda = Self.findConda(for: prefix, environment: environment) {
            var command = [conda, "install", "--yes", "--prefix", prefix]
            if Self.usesCondaForge(prefix: prefix) { command += ["--channel", "conda-forge"] }
            commands.append(command + ["ipykernel"])
        }
        commands.append([python, "-m", "pip", "install", "ipykernel"])
        if let uv = KernelSession.resolveExecutable("uv", path: environment["PATH"]) {
            commands.append([uv, "pip", "install", "--python", python, "ipykernel"])
        }

        var log = ""
        for command in commands {
            let (status, output) = await Self.run(command, environment: environment, timeout: 600)
            log += "$ " + command.joined(separator: " ") + "\n" + output + "\n"
            if status == 0 { return log }
        }
        throw RPCError("Could not install ipykernel into “\(spec.displayName)”.\n\n" + String(log.suffix(1500)), code: "install_failed")
    }

    private static func findConda(for prefix: String, environment: [String: String]) -> String? {
        let fm = FileManager.default
        var roots = [prefix]
        let parent = (prefix as NSString).deletingLastPathComponent
        if (parent as NSString).lastPathComponent == "envs" { roots.append((parent as NSString).deletingLastPathComponent) }
        var candidates = roots.flatMap { [$0 + "/condabin/conda", $0 + "/bin/conda", $0 + "/bin/mamba", $0 + "/bin/micromamba"] }
        if let exe = environment["CONDA_EXE"] { candidates.append(exe) }
        if let found = candidates.first(where: { fm.isExecutableFile(atPath: $0) }) { return found }
        return KernelSession.resolveExecutable("conda", path: environment["PATH"])
            ?? KernelSession.resolveExecutable("mamba", path: environment["PATH"])
    }

    /// True when the environment's Python came from conda-forge.
    private static func usesCondaForge(prefix: String) -> Bool {
        let meta = prefix + "/conda-meta"
        guard let files = try? FileManager.default.contentsOfDirectory(atPath: meta),
              let python = files.first(where: { $0.hasPrefix("python-3") && $0.hasSuffix(".json") }),
              let data = FileManager.default.contents(atPath: meta + "/" + python),
              let object = JSON.parse(data) as? [String: Any],
              let channel = object["channel"] as? String
        else { return false }
        return channel.contains("conda-forge")
    }

    private static func run(_ command: [String], environment: [String: String], timeout: TimeInterval) async -> (Int32, String) {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let process = Process()
                process.executableURL = URL(fileURLWithPath: command[0])
                process.arguments = Array(command.dropFirst())
                process.environment = environment
                process.standardInput = FileHandle.nullDevice
                let pipe = Pipe()
                process.standardOutput = pipe
                process.standardError = pipe
                do {
                    try process.run()
                } catch {
                    continuation.resume(returning: (-1, error.localizedDescription))
                    return
                }
                let watchdog = DispatchWorkItem { if process.isRunning { process.terminate() } }
                DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: watchdog)
                let output = pipe.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                watchdog.cancel()
                continuation.resume(returning: (process.terminationStatus, String(decoding: output, as: UTF8.self)))
            }
        }
    }

    // MARK: - RPC

    public func register(on router: RPCRouter) {
        router.register("kernels.list") { [weak self] params, _ in
            guard let self else { return nil }
            let specs = await self.listSpecs(notebookDir: params.optString("notebookDir"))
            return ["specs": specs.map(\.json)]
        }

        router.register("kernels.install") { [weak self] params, _ in
            guard let self else { return nil }
            let log = try await self.installKernelSupport(specId: try params.string("specId"))
            return ["log": String(log.suffix(4000))]
        }

        router.register("kernel.start") { [weak self] params, client in
            guard let self else { return nil }
            let specId = try params.string("specId")
            let cwd = params.optString("cwd") ?? NSHomeDirectory()
            let extra = params["extraArguments"] as? [String] ?? []
            let session = try await self.start(specId: specId, cwd: cwd, client: client, extraArguments: extra)
            return [
                "kernelId": session.id,
                "pid": Int(session.pid),
                "interruptMode": session.spec.interruptMode,
                "spec": session.spec.json,
            ]
        }

        router.register("kernel.send") { [weak self] params, _ in
            guard let self else { return nil }
            guard let session = self.session(try params.string("kernelId")) else { throw KernelError.notRunning }
            var buffers: [Data] = []
            if let encoded = params["buffers"] as? [String] {
                buffers = encoded.compactMap { Data(base64Encoded: $0) }
            }
            session.send(channel: try params.string("channel"), message: WireMessage(
                header: Data(try params.string("header").utf8),
                parentHeader: Data((params.optString("parent_header") ?? "{}").utf8),
                metadata: Data((params.optString("metadata") ?? "{}").utf8),
                content: Data(try params.string("content").utf8),
                buffers: buffers
            ))
            return nil
        }

        router.register("kernel.interrupt") { [weak self] params, _ in
            guard let self, let session = self.session(try params.string("kernelId")) else { throw KernelError.notRunning }
            session.interrupt()
            return nil
        }

        router.register("kernel.shutdown") { [weak self] params, _ in
            guard let self else { return nil }
            await self.shutdown(try params.string("kernelId"))
            return nil
        }
    }
}

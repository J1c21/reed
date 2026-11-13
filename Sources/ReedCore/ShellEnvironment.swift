import Foundation

/// Apps launched from Finder inherit a bare environment (PATH is just /usr/bin:/bin:…), so a
/// kernel started from Reed would not find `git`, `conda`, Homebrew tools and friends. Like
/// other editors, we ask the user's login shell for its environment once and reuse it.
public enum ShellEnvironment {
    private static let lock = NSLock()
    private static var cached: [String: String]?

    private static let begin = "__REED_ENV_BEGIN__"
    private static let end = "__REED_ENV_END__"

    /// The process environment overlaid with the login shell's. Blocks for up to `timeout`
    /// seconds the first time it is called; later calls return the cached value.
    public static func resolved(timeout: TimeInterval = 6) -> [String: String] {
        lock.lock()
        defer { lock.unlock() }
        if let cached { return cached }

        var environment = ProcessInfo.processInfo.environment
        if let fromShell = queryLoginShell(timeout: timeout) {
            let ignored: Set<String> = ["PWD", "OLDPWD", "SHLVL", "_", "TERM", "TERM_PROGRAM", "COLUMNS", "LINES"]
            for (key, value) in fromShell where !ignored.contains(key) {
                environment[key] = value
            }
        }
        cached = environment
        return environment
    }

    private static func queryLoginShell(timeout: TimeInterval) -> [String: String]? {
        let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
        guard FileManager.default.isExecutableFile(atPath: shell) else { return nil }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: shell)
        process.arguments = ["-ilc", "printf '%s' '\(begin)'; /usr/bin/env -0; printf '%s' '\(end)'"]
        process.standardInput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        let pipe = Pipe()
        process.standardOutput = pipe

        var output = Data()
        let reader = DispatchQueue(label: "reed.shell-env.reader")
        let finished = DispatchSemaphore(value: 0)
        do {
            try process.run()
        } catch {
            return nil
        }
        reader.async {
            output = pipe.fileHandleForReading.readDataToEndOfFile()
            finished.signal()
        }
        if finished.wait(timeout: .now() + timeout) == .timedOut {
            process.terminate()
            Log.info("Timed out reading the login shell environment; using the app's own.")
            return nil
        }

        guard let startRange = output.range(of: Data(begin.utf8)),
              let endRange = output.range(of: Data(end.utf8), in: startRange.upperBound ..< output.endIndex)
        else { return nil }

        var result: [String: String] = [:]
        let body = output.subdata(in: startRange.upperBound ..< endRange.lowerBound)
        for entry in body.split(separator: 0) {
            let line = String(decoding: entry, as: UTF8.self)
            guard let equals = line.firstIndex(of: "=") else { continue }
            result[String(line[..<equals])] = String(line[line.index(after: equals)...])
        }
        return result.isEmpty ? nil : result
    }
}

import Foundation

/// File system access for the web UI.
public enum FileService {
    private static let fm = FileManager.default

    private static func stat(_ path: String) -> [String: Any] {
        guard let attributes = try? fm.attributesOfItem(atPath: path) else { return ["exists": false] }
        let modified = (attributes[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
        return [
            "exists": true,
            "isDirectory": (attributes[.type] as? FileAttributeType) == .typeDirectory,
            "size": (attributes[.size] as? NSNumber)?.intValue ?? 0,
            "mtime": modified * 1000,
            "writable": fm.isWritableFile(atPath: path),
        ]
    }

    public static func register(on router: RPCRouter) {
        router.register("fs.readText") { params, _ in
            let path = try params.string("path").expandingTilde
            do {
                let data = try Data(contentsOf: URL(fileURLWithPath: path))
                var result = stat(path)
                result["text"] = String(decoding: data, as: UTF8.self)
                return result
            } catch {
                throw RPCError("Could not read “\((path as NSString).lastPathComponent)”: \(error.localizedDescription)", code: "read_failed")
            }
        }

        router.register("fs.writeText") { params, _ in
            let path = try params.string("path").expandingTilde
            let text = try params.string("text")
            do {
                try Data(text.utf8).write(to: URL(fileURLWithPath: path), options: [.atomic])
                return stat(path)
            } catch {
                throw RPCError("Could not save “\((path as NSString).lastPathComponent)”: \(error.localizedDescription)", code: "write_failed")
            }
        }

        router.register("fs.writeBinary") { params, _ in
            let path = try params.string("path").expandingTilde
            guard let data = Data(base64Encoded: try params.string("base64"), options: [.ignoreUnknownCharacters]) else {
                throw RPCError("Invalid data.", code: "bad_params")
            }
            do {
                try data.write(to: URL(fileURLWithPath: path), options: [.atomic])
                return stat(path)
            } catch {
                throw RPCError("Could not save “\((path as NSString).lastPathComponent)”: \(error.localizedDescription)", code: "write_failed")
            }
        }

        router.register("fs.stat") { params, _ in
            stat(try params.string("path").expandingTilde)
        }

        router.register("fs.list") { params, _ in
            let path = try params.string("path").expandingTilde
            let showHidden = params.bool("hidden") ?? false
            guard let names = try? fm.contentsOfDirectory(atPath: path) else {
                throw RPCError("Could not open the folder “\((path as NSString).lastPathComponent)”.", code: "read_failed")
            }
            var entries: [[String: Any]] = []
            for name in names {
                if !showHidden && name.hasPrefix(".") { continue }
                let full = (path as NSString).appendingPathComponent(name)
                var isDirectory: ObjCBool = false
                guard fm.fileExists(atPath: full, isDirectory: &isDirectory) else { continue }
                entries.append(["name": name, "path": full, "isDirectory": isDirectory.boolValue])
            }
            entries.sort { lhs, rhs in
                let lDir = lhs["isDirectory"] as? Bool ?? false
                let rDir = rhs["isDirectory"] as? Bool ?? false
                if lDir != rDir { return lDir }
                return (lhs["name"] as? String ?? "").localizedStandardCompare(rhs["name"] as? String ?? "") == .orderedAscending
            }
            return ["path": path, "entries": entries]
        }

        // Files with one extension under a folder, nearest first, for "Open Quickly". The walk
        // is breadth-first and bounded in depth, count and time, so it answers at once
        // wherever it is pointed.
        router.register("fs.find") { params, _ in
            let root = try params.string("path").expandingTilde
            let wanted = (params.optString("extension") ?? "ipynb").lowercased()
            let limit = min(max(params.int("limit") ?? 300, 1), 2000)
            var maxDepth = min(max(params.int("depth") ?? 4, 0), 8)
            // From the home folder (or above it) only the folder itself is read: walking down
            // from there would wander into Desktop, Documents and Downloads, each of which
            // macOS guards with a permission prompt.
            let home = NSHomeDirectory()
            if home == root || home.hasPrefix(root.hasSuffix("/") ? root : root + "/") { maxDepth = 0 }

            let skipped: Set<String> = [
                "node_modules", "__pycache__", "site-packages", "venv", "env", "build", "dist", "target", "DerivedData", "Pods",
            ]
            let keys: [URLResourceKey] = [.isDirectoryKey, .isSymbolicLinkKey, .isPackageKey]
            let deadline = Date().addingTimeInterval(0.4)
            var found: [String] = []
            var truncated = false
            var level = [URL(fileURLWithPath: root, isDirectory: true)]
            var depth = 0
            walk: while !level.isEmpty && depth <= maxDepth {
                var next: [URL] = []
                for directory in level {
                    if Date() > deadline {
                        truncated = true
                        break walk
                    }
                    guard let children = try? fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles]) else {
                        continue
                    }
                    let sorted = children.sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }
                    for child in sorted {
                        let values = try? child.resourceValues(forKeys: Set(keys))
                        if values?.isSymbolicLink == true { continue }
                        if values?.isDirectory == true {
                            if values?.isPackage != true && !skipped.contains(child.lastPathComponent) { next.append(child) }
                        } else if child.pathExtension.lowercased() == wanted {
                            found.append(child.path)
                            if found.count >= limit {
                                truncated = true
                                break walk
                            }
                        }
                    }
                }
                level = next
                depth += 1
            }
            return ["root": root, "paths": found, "truncated": truncated] as [String: Any]
        }

        router.register("fs.mkdir") { params, _ in
            let path = try params.string("path").expandingTilde
            try fm.createDirectory(atPath: path, withIntermediateDirectories: true)
            return stat(path)
        }

        router.register("fs.rename") { params, _ in
            let from = try params.string("from").expandingTilde
            let to = try params.string("to").expandingTilde
            guard !fm.fileExists(atPath: to) else {
                throw RPCError("“\((to as NSString).lastPathComponent)” already exists.", code: "exists")
            }
            try fm.moveItem(atPath: from, toPath: to)
            return stat(to)
        }

        router.register("fs.trash") { params, _ in
            let path = try params.string("path").expandingTilde
            try fm.trashItem(at: URL(fileURLWithPath: path), resultingItemURL: nil)
            return nil
        }

        router.register("fs.home") { _, _ in
            ["home": NSHomeDirectory(), "documents": NSHomeDirectory() + "/Documents"]
        }
    }
}

/// Preferences shared by every window, stored as one JSON file.
public final class PreferencesStore: @unchecked Sendable {
    private let url: URL
    private var values: [String: Any] = [:]
    private let lock = NSLock()
    private weak var hub: Hub?

    public init(hub: Hub, directory: URL? = nil) {
        self.hub = hub
        let base = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Sumi", isDirectory: true)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        url = base.appendingPathComponent("preferences.json")
        if let data = try? Data(contentsOf: url), let object = JSON.parse(data) as? [String: Any] {
            values = object
        }
    }

    public func all() -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        return values
    }

    public func value(_ key: String) -> Any? {
        lock.lock()
        defer { lock.unlock() }
        return values[key]
    }

    public func set(_ key: String, _ value: Any?, from client: RPCClient? = nil) {
        lock.lock()
        if let value, !(value is NSNull) {
            values[key] = value
        } else {
            values.removeValue(forKey: key)
        }
        let snapshot = values
        lock.unlock()
        if JSONSerialization.isValidJSONObject(snapshot),
           let data = try? JSONSerialization.data(withJSONObject: snapshot, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: url, options: [.atomic])
        }
        hub?.broadcast("prefs.changed", ["key": key, "value": value ?? NSNull()], except: client)
    }

    public func register(on router: RPCRouter) {
        router.register("prefs.all") { [weak self] _, _ in
            self?.all() ?? [:]
        }
        router.register("prefs.set") { [weak self] params, client in
            self?.set(try params.string("key"), params["value"], from: client)
            return nil
        }
    }
}

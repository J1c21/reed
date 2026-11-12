import Foundation

/// Something Sumi can launch as a kernel: either a registered Jupyter kernelspec, or a Python
/// environment that has `ipykernel` installed (no `python -m ipykernel install` needed).
public struct KernelSpec {
    public enum Kind: String { case kernelspec, environment }

    public var id: String
    public var kind: Kind
    public var name: String
    public var displayName: String
    public var language: String
    public var argv: [String]
    public var env: [String: String] = [:]
    public var interruptMode: String = "signal"
    public var resourceDir: String?

    // Python environment details (when known).
    public var pythonPath: String?
    public var pythonVersion: String?
    public var envKind: String?
    public var envPrefix: String?
    public var envName: String?
    /// False for environments that exist but cannot run notebooks yet.
    public var available: Bool = true

    public var json: [String: Any] {
        var out: [String: Any] = [
            "id": id,
            "kind": kind.rawValue,
            "name": name,
            "displayName": displayName,
            "language": language,
            "interruptMode": interruptMode,
            "available": available,
        ]
        if let pythonPath { out["pythonPath"] = pythonPath }
        if let pythonVersion { out["pythonVersion"] = pythonVersion }
        if let envKind { out["envKind"] = envKind }
        if let envPrefix { out["envPrefix"] = envPrefix }
        if let envName { out["envName"] = envName }
        if let resourceDir { out["resourceDir"] = resourceDir }
        return out
    }
}

struct PythonEnvironment {
    var prefix: String
    var python: String
    var name: String
    var kind: String
    var version: String?
    var hasIPyKernel: Bool
}

public enum KernelDiscovery {
    private static let fm = FileManager.default
    private static var home: String { NSHomeDirectory() }

    public static func discover(notebookDir: String?, environment: [String: String]) -> [KernelSpec] {
        let pythons = pythonEnvironments(notebookDir: notebookDir, environment: environment)
        var specs: [KernelSpec] = []
        var seenSpecDirs = Set<String>()

        // 1. Registered kernelspecs: user and system data dirs, then each environment's own.
        var searchDirs: [(dir: String, owner: PythonEnvironment?)] = []
        if let extra = environment["JUPYTER_PATH"] {
            for path in extra.split(separator: ":") { searchDirs.append((String(path) + "/kernels", nil)) }
        }
        let dataDir = environment["JUPYTER_DATA_DIR"] ?? home + "/Library/Jupyter"
        for dir in [
            dataDir + "/kernels",
            home + "/.local/share/jupyter/kernels",
            "/opt/homebrew/share/jupyter/kernels",
            "/usr/local/share/jupyter/kernels",
            "/usr/share/jupyter/kernels",
        ] {
            searchDirs.append((dir, nil))
        }
        for env in pythons {
            searchDirs.append((env.prefix + "/share/jupyter/kernels", env))
        }

        for (dir, owner) in searchDirs {
            guard let names = try? fm.contentsOfDirectory(atPath: dir) else { continue }
            for name in names.sorted() {
                let specDir = (dir as NSString).appendingPathComponent(name)
                let resolved = (specDir as NSString).resolvingSymlinksInPath
                guard !seenSpecDirs.contains(resolved),
                      var spec = readKernelSpec(directory: specDir, name: name)
                else { continue }
                seenSpecDirs.insert(resolved)

                if let owner {
                    // An environment's built-in ipykernel spec is represented by the environment itself.
                    if isPlainIPyKernel(spec.argv) { continue }
                    // Bare "python" inside an environment's spec means that environment's interpreter.
                    if let first = spec.argv.first, !first.contains("/"), first.hasPrefix("python") {
                        spec.argv[0] = owner.python
                    }
                    spec.envPrefix = owner.prefix
                    spec.envName = owner.name
                    spec.envKind = owner.kind
                }
                specs.append(spec)
            }
        }

        // 2. Python environments. Skip ones a registered spec already launches identically.
        let registeredInterpreters = Set(
            specs.filter { isPlainIPyKernel($0.argv) && $0.env.isEmpty }
                .compactMap { $0.argv.first }
                .map { ($0 as NSString).standardizingPath }
        )
        for env in pythons {
            if registeredInterpreters.contains((env.python as NSString).standardizingPath) { continue }
            var spec = KernelSpec(
                id: "env:" + env.python,
                kind: .environment,
                name: "python3",
                displayName: env.name,
                language: "python",
                argv: [env.python, "-m", "ipykernel_launcher", "-f", "{connection_file}"]
            )
            spec.pythonPath = env.python
            spec.pythonVersion = env.version
            spec.envKind = env.kind
            spec.envPrefix = env.prefix
            spec.envName = env.name
            spec.available = env.hasIPyKernel
            specs.append(spec)
        }

        // Annotate registered Python specs with their interpreter's environment, when we know it.
        let byPython = Dictionary(pythons.map { (($0.python as NSString).standardizingPath, $0) }, uniquingKeysWith: { a, _ in a })
        for index in specs.indices where specs[index].kind == .kernelspec {
            guard let first = specs[index].argv.first, first.contains("/") else { continue }
            let path = (first as NSString).standardizingPath
            if specs[index].language.lowercased() == "python" { specs[index].pythonPath = path }
            if let env = byPython[path] {
                specs[index].pythonVersion = env.version
                specs[index].envKind = env.kind
                specs[index].envPrefix = env.prefix
                specs[index].envName = env.name
            }
        }
        return specs
    }

    // MARK: - Kernelspecs

    static func readKernelSpec(directory: String, name: String) -> KernelSpec? {
        let file = (directory as NSString).appendingPathComponent("kernel.json")
        guard let data = fm.contents(atPath: file),
              let object = JSON.parse(data) as? [String: Any],
              let argv = object["argv"] as? [String], !argv.isEmpty
        else { return nil }
        var spec = KernelSpec(
            id: "spec:" + directory,
            kind: .kernelspec,
            name: name,
            displayName: object["display_name"] as? String ?? name,
            language: object["language"] as? String ?? "",
            argv: argv
        )
        spec.resourceDir = directory
        spec.interruptMode = object["interrupt_mode"] as? String ?? "signal"
        if let env = object["env"] as? [String: Any] {
            for (key, value) in env { spec.env[key] = value as? String ?? "\(value)" }
        }
        return spec
    }

    /// True for `python [-X…] -m ipykernel_launcher -f {connection_file}` — the stock launcher,
    /// possibly with interpreter flags such as `-Xfrozen_modules=off` in front of `-m`.
    static func isPlainIPyKernel(_ argv: [String]) -> Bool {
        guard let m = argv.firstIndex(of: "-m"), m >= 1, m + 1 < argv.count else { return false }
        guard argv[1 ..< m].allSatisfy({ $0.hasPrefix("-") }) else { return false }
        return argv[m + 1] == "ipykernel_launcher" || argv[m + 1] == "ipykernel"
    }

    // MARK: - Python environments

    static func pythonEnvironments(notebookDir: String?, environment: [String: String]) -> [PythonEnvironment] {
        var result: [PythonEnvironment] = []
        var seen = Set<String>()

        func add(prefix rawPrefix: String, kind: String, name: String? = nil, requireKernel: Bool) {
            let prefix = (rawPrefix as NSString).standardizingPath
            guard !seen.contains(prefix) else { return }
            let python = prefix + "/bin/python"
            let python3 = prefix + "/bin/python3"
            let interpreter = fm.isExecutableFile(atPath: python) ? python
                : (fm.isExecutableFile(atPath: python3) ? python3 : nil)
            guard let interpreter else { return }
            let (version, hasKernel) = inspect(prefix: prefix)
            if requireKernel && !hasKernel { return }
            seen.insert(prefix)
            result.append(PythonEnvironment(
                prefix: prefix,
                python: interpreter,
                name: name ?? (prefix as NSString).lastPathComponent,
                kind: kind,
                version: version,
                hasIPyKernel: hasKernel
            ))
        }

        // Virtual environments next to the notebook (and in its parent folders) come first.
        if let notebookDir {
            var dir = (notebookDir as NSString).standardizingPath
            var depth = 0
            while depth < 6, dir.count > 1 {
                for candidate in [".venv", "venv", "env", ".env"] {
                    let prefix = dir + "/" + candidate
                    if fm.fileExists(atPath: prefix + "/pyvenv.cfg") {
                        add(prefix: prefix, kind: "venv", name: (dir as NSString).lastPathComponent + "/" + candidate, requireKernel: false)
                    }
                }
                if dir == home { break }
                dir = (dir as NSString).deletingLastPathComponent
                depth += 1
            }
        }

        // Conda: every prefix conda has ever recorded, plus the usual install locations.
        var condaPrefixes: [String] = []
        if let text = try? String(contentsOfFile: home + "/.conda/environments.txt", encoding: .utf8) {
            condaPrefixes += text.split(whereSeparator: \.isNewline).map { String($0).trimmingCharacters(in: .whitespaces) }
        }
        var condaRoots = [
            "/opt/anaconda3", "/opt/miniconda3", "/opt/miniforge3",
            home + "/anaconda3", home + "/miniconda3", home + "/miniforge3", home + "/mambaforge",
            home + "/micromamba", home + "/.local/share/mamba",
            "/opt/homebrew/Caskroom/miniconda/base", "/opt/homebrew/Caskroom/miniforge/base",
            "/opt/homebrew/Caskroom/mambaforge/base", "/opt/homebrew/anaconda3", "/usr/local/anaconda3",
        ]
        if let exe = environment["CONDA_EXE"] {
            condaRoots.append(((exe as NSString).deletingLastPathComponent as NSString).deletingLastPathComponent)
        }
        if let root = environment["MAMBA_ROOT_PREFIX"] { condaRoots.append(root) }
        for root in condaRoots {
            condaPrefixes.append(root)
            if let envs = try? fm.contentsOfDirectory(atPath: root + "/envs") {
                condaPrefixes += envs.sorted().map { root + "/envs/" + $0 }
            }
        }
        for prefix in condaPrefixes where fm.fileExists(atPath: prefix + "/conda-meta") {
            let parent = (prefix as NSString).deletingLastPathComponent
            let isNamed = (parent as NSString).lastPathComponent == "envs"
            add(prefix: prefix, kind: "conda", name: isNamed ? (prefix as NSString).lastPathComponent : "base", requireKernel: false)
        }

        // Shared virtualenv collections; only worth listing when they can run a notebook.
        for (root, kind) in [
            (home + "/.virtualenvs", "venv"),
            (home + "/.local/share/virtualenvs", "pipenv"),
            (home + "/Library/Caches/pypoetry/virtualenvs", "poetry"),
            (home + "/.pyenv/versions", "pyenv"),
        ] {
            guard let names = try? fm.contentsOfDirectory(atPath: root) else { continue }
            for name in names.sorted() where !name.hasPrefix(".") {
                add(prefix: root + "/" + name, kind: kind, requireKernel: true)
            }
        }

        // uv-managed and system interpreters.
        if let names = try? fm.contentsOfDirectory(atPath: home + "/.local/share/uv/python") {
            for name in names.sorted() where name.hasPrefix("cpython-") {
                add(prefix: home + "/.local/share/uv/python/" + name, kind: "uv", requireKernel: true)
            }
        }
        if let versions = try? fm.contentsOfDirectory(atPath: "/Library/Frameworks/Python.framework/Versions") {
            for version in versions.sorted() where version != "Current" {
                add(prefix: "/Library/Frameworks/Python.framework/Versions/" + version, kind: "system", name: "Python.org " + version, requireKernel: true)
            }
        }
        add(prefix: "/opt/homebrew", kind: "homebrew", name: "Homebrew", requireKernel: true)
        add(prefix: "/usr/local", kind: "system", name: "/usr/local", requireKernel: true)

        return result
    }

    /// Reads an environment's Python version and whether ipykernel is installed, without
    /// launching the interpreter.
    private static func inspect(prefix: String) -> (version: String?, hasIPyKernel: Bool) {
        var version: String?
        var hasKernel = false
        if let libs = try? fm.contentsOfDirectory(atPath: prefix + "/lib") {
            // Prefer the newest pythonX.Y that actually has a site-packages directory.
            let candidates = libs.filter { $0.hasPrefix("python3.") }.sorted { lhs, rhs in
                (Int(lhs.dropFirst("python3.".count)) ?? 0) > (Int(rhs.dropFirst("python3.".count)) ?? 0)
            }
            for lib in candidates {
                let site = prefix + "/lib/" + lib + "/site-packages"
                guard fm.fileExists(atPath: site) else { continue }
                if version == nil { version = String(lib.dropFirst("python".count)) }
                if fm.fileExists(atPath: site + "/ipykernel/__init__.py") {
                    version = String(lib.dropFirst("python".count))
                    hasKernel = true
                    break
                }
            }
        }
        if let config = try? String(contentsOfFile: prefix + "/pyvenv.cfg", encoding: .utf8) {
            for line in config.split(whereSeparator: \.isNewline) {
                let parts = line.split(separator: "=", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
                if parts.count == 2, parts[0] == "version" || parts[0] == "version_info" {
                    version = parts[1].split(separator: ".").prefix(3).joined(separator: ".")
                }
            }
        } else if let meta = try? fm.contentsOfDirectory(atPath: prefix + "/conda-meta") {
            // conda-meta/python-3.13.1-h123abc_0.json
            for file in meta where file.hasPrefix("python-3") && file.hasSuffix(".json") {
                let rest = file.dropFirst("python-".count)
                if let dash = rest.firstIndex(of: "-") { version = String(rest[..<dash]) }
            }
        }
        return (version, hasKernel)
    }
}

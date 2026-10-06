import Foundation

/// What is installed on this Mac for each agent (docs/agents-v0.md §2): the vendor's own install where the vendor puts
/// it, the copy in ChatGPT.app, what AgentSwitch's store holds, and anything else of that name on the PATH.
public enum AgentInventory {
    /// From the file system alone — no program is run — so it is quick enough to call before the service starts.
    /// Versions the layout does not say come from `withVersions`, sizes from `withSizes`.
    public static func scan(layout: AgentLayout, path: String, fileManager fm: FileManager = .default) -> [AgentReport] {
        AgentCLI.allCases.map { agent in
            var installs: [AgentInstall] = []
            let own = stable(agent, layout: layout, fm: fm)
            if let own { installs.append(own) }
            let app = agent == .codex ? appCodex(layout: layout, fm: fm) : nil
            if let app { installs.append(app) }
            installs += stored(agent, .beta, layout: layout, fm: fm)
            installs += stored(agent, .pinned, layout: layout, fm: fm)
            installs += others(agent, layout: layout, path: path, known: installs, fm: fm)
            return AgentReport(agent: agent, installs: installs, leftovers: own.flatMap { leftovers(agent, current: $0, layout: layout, fm: fm) })
        }
    }

    // MARK: the vendor's own install

    static func stable(_ agent: AgentCLI, layout: AgentLayout, fm: FileManager) -> AgentInstall? {
        let command = layout.command(agent)
        guard fm.isExecutableFile(atPath: command) else { return nil }
        let target = real(command)
        switch agent {
        case .claude:
            // `~/.local/bin/claude` → `~/.local/share/claude/versions/2.1.291`: the file's name is the version.
            guard inside(target, layout.programRoot(.claude)) else { return nil }
            let name = (target as NSString).lastPathComponent
            return AgentInstall(agent: agent, source: .stable, key: "stable", binary: command, command: agent.command, location: target,
                                version: AgentVersion.isWellFormed(name) ? name : nil, channel: claudeChannel(home: layout.home, fm: fm))
        case .codex:
            guard inside(target, layout.programRoot(.codex)) else { return nil }
            return AgentInstall(agent: agent, source: .stable, key: "stable", binary: command, command: agent.command, location: layout.programRoot(.codex))
        case .opencode:
            // One file where the official script puts it; a link from there to another prefix is that other install.
            guard target == real(layout.programRoot(.opencode)) + "/opencode" else { return nil }
            return AgentInstall(agent: agent, source: .stable, key: "stable", binary: command, command: agent.command, location: command)
        case .pi:
            guard inside(target, layout.programRoot(.pi)) else { return nil }
            let install = "\(layout.programRoot(.pi))/install"
            let current = piCurrent(install: install, fm: fm)
            let release = current.map { "\(install)/releases/\($0)" }
            return AgentInstall(agent: agent, source: .stable, key: "stable", binary: command, command: agent.command,
                                location: release.flatMap { fm.fileExists(atPath: $0) ? $0 : nil } ?? install, version: current)
        }
    }

    /// pi's `install/current-version`: one line, the release folder's name.
    static func piCurrent(install: String, fm: FileManager) -> String? {
        guard let data = fm.contents(atPath: "\(install)/current-version"), data.count < 200,
              let text = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
              AgentVersion.isWellFormed(text) else { return nil }
        return text
    }

    /// Which channel Claude Code's own updater follows: its `autoUpdatesChannel` setting, `latest` when unset.
    static func claudeChannel(home: String, fm: FileManager) -> String {
        guard let data = fm.contents(atPath: "\(home)/.claude/settings.json"), data.count < 1_000_000,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let channel = object["autoUpdatesChannel"] as? String, ["latest", "stable"].contains(channel) else { return "latest" }
        return channel
    }

    /// Versions the vendor keeps beside the current one.
    static func leftovers(_ agent: AgentCLI, current: AgentInstall, layout: AgentLayout, fm: FileManager) -> AgentLeftovers? {
        let folder: String
        switch agent {
        case .claude: folder = layout.programRoot(.claude)
        case .pi: folder = "\(layout.programRoot(.pi))/install/releases"
        case .codex, .opencode: return nil
        }
        guard let version = current.version, let names = try? fm.contentsOfDirectory(atPath: folder) else { return nil }
        let old = names.filter { $0 != version && AgentVersion.isWellFormed($0) }.sorted { AgentVersion($0) < AgentVersion($1) }
        return old.isEmpty ? nil : AgentLeftovers(versions: old, paths: old.map { "\(folder)/\($0)" })
    }

    // MARK: the app's copy, the store, the rest

    static func appCodex(layout: AgentLayout, fm: FileManager) -> AgentInstall? {
        guard let path = layout.appCodex.first(where: { fm.isExecutableFile(atPath: $0) }) else { return nil }
        return AgentInstall(agent: .codex, source: .app, key: "app", binary: path, location: path)
    }

    /// Versions in the store: a folder named by a version with its launcher in it. The beta is one version — the
    /// newest, should an interrupted update have left two.
    static func stored(_ agent: AgentCLI, _ source: AgentSource, layout: AgentLayout, fm: FileManager) -> [AgentInstall] {
        guard agent.betaCommand != nil, let names = try? fm.contentsOfDirectory(atPath: layout.storeFolder(agent, source)) else { return [] }
        let versions = names.filter { AgentVersion.isWellFormed($0) && fm.isExecutableFile(atPath: layout.launcher(agent, source, $0)) }
            .sorted { AgentVersion($0) > AgentVersion($1) }
        return (source == .beta ? Array(versions.prefix(1)) : versions).map { version in
            let launcher = layout.launcher(agent, source, version)
            var command: String?
            // The beta's name is on the command line only while its link points at this version's launcher.
            if source == .beta, let link = layout.betaCommand(agent), fm.fileExists(atPath: link), real(link) == real(launcher) { command = agent.betaCommand }
            return AgentInstall(agent: agent, source: source, key: source == .beta ? "beta" : AgentInstall.pinnedKey(version), binary: launcher,
                                command: command, location: layout.storeVersion(agent, source, version), version: version)
        }
    }

    /// Programs of the agent's name on the PATH that are none of the above: each real file once, in PATH order.
    static func others(_ agent: AgentCLI, layout: AgentLayout, path: String, known: [AgentInstall], fm: FileManager) -> [AgentInstall] {
        var seen = Set(known.map { real($0.binary) })
        var out: [AgentInstall] = []
        for dir in path.split(separator: ":").map(String.init) + legacyFolders(agent, home: layout.home) {
            let candidate = "\(dir)/\(agent.command)"
            guard fm.isExecutableFile(atPath: candidate) else { continue }
            let target = real(candidate)
            guard !seen.contains(target), !inside(target, layout.store) else { continue }
            seen.insert(target)
            out.append(AgentInstall(agent: agent, source: .other, key: AgentInstall.otherKey(candidate), binary: candidate, command: nil, location: candidate))
        }
        return out
    }

    /// Where older installers put a command that may not be on the PATH.
    static func legacyFolders(_ agent: AgentCLI, home: String) -> [String] {
        agent == .claude ? ["\(home)/.claude/local"] : []
    }

    // MARK: versions and sizes

    /// Versions the layout does not say, asked of each program (`--version`, never a model call).
    public static func withVersions(_ reports: [AgentReport], path: String, environment: [String: String],
                                    timeout: TimeInterval = HarnessDetector.versionTimeout) async -> [AgentReport] {
        let env = environment.merging(["PATH": path]) { _, new in new }
        let pending = reports.flatMap(\.installs).filter { $0.version == nil }
        let found = await withTaskGroup(of: (String, String?).self) { group -> [String: String] in
            for install in pending {
                group.addTask {
                    let result = try? await ProcessRunner.run(URL(fileURLWithPath: install.binary), ["--version"], environment: env, timeout: timeout)
                    return (install.id, result.flatMap { HarnessEvaluator.parseVersion($0.stdoutText + $0.stderrText) })
                }
            }
            var out: [String: String] = [:]
            for await (id, version) in group { if let version { out[id] = version } }
            return out
        }
        return reports.map { report in
            var report = report
            report.installs = report.installs.map { var i = $0; if i.version == nil { i.version = found[i.id] }; return i }
            return report
        }
    }

    /// The room each managed install and each vendor's leftovers take. The app's copy and what was found elsewhere
    /// are not AgentSwitch's to count.
    public static func withSizes(_ reports: [AgentReport]) async -> [AgentReport] {
        await Task.detached(priority: .utility) {
            reports.map { report in
                var report = report
                report.installs = report.installs.map { var i = $0; if i.deletable { i.bytes = size(of: i.location) }; return i }
                if var left = report.leftovers {
                    left.bytes = left.paths.reduce(Int64(0)) { $0 + size(of: $1) }
                    report.leftovers = left
                }
                return report
            }
        }.value
    }

    /// Allocated bytes of a file, or of everything in a folder; links are not followed.
    public static func size(of path: String, fileManager fm: FileManager = .default) -> Int64 {
        let url = URL(fileURLWithPath: path)
        let keys: Set<URLResourceKey> = [.isRegularFileKey, .totalFileAllocatedSizeKey, .fileAllocatedSizeKey]
        func bytes(_ url: URL) -> Int64 {
            guard let values = try? url.resourceValues(forKeys: keys), values.isRegularFile == true else { return 0 }
            return Int64(values.totalFileAllocatedSize ?? values.fileAllocatedSize ?? 0)
        }
        var isDirectory: ObjCBool = false
        guard fm.fileExists(atPath: path, isDirectory: &isDirectory) else { return 0 }
        guard isDirectory.boolValue else { return bytes(url) }
        guard let walk = fm.enumerator(at: url, includingPropertiesForKeys: Array(keys), options: [], errorHandler: nil) else { return 0 }
        var total: Int64 = 0
        for case let item as URL in walk { total += bytes(item) }
        return total
    }

    // MARK: paths

    /// The path with every link followed.
    static func real(_ path: String) -> String { URL(fileURLWithPath: path).resolvingSymlinksInPath().path }

    /// `path` is `root` or something in it, links followed on both sides.
    static func inside(_ path: String, _ root: String) -> Bool {
        let p = real(path), r = real(root)
        return p == r || p.hasPrefix(r.hasSuffix("/") ? r : r + "/")
    }
}

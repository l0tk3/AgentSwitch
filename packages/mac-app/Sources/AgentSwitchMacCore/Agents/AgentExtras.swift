import Foundation

/// The two agents AgentSwitch runs in terminals but keeps no versions of its own for (docs/agents-v0.md §13): Grok
/// (xAI) and Antigravity (Google). Each program says what version it is; Grok also says what the newest is
/// (`update --check --json`), Antigravity only updates; each updates itself, with the PATH a terminal of the user's has.
/// Nothing is installed from here, and no beta or pinned version is kept: what the user installed is what is shown.
public struct AgentExtra: Sendable, Equatable, Identifiable, Codable {
    /// The daemon's name for it.
    public var id: String
    public var title: String
    /// Its name on the command line.
    public var command: String
    /// Where that command is; nil: not installed.
    public var binary: String?
    /// What the program says it is (`--version`), or what `update --check` says it is.
    public var version: String?
    /// The newest version, when the program says; nil: it does not, or it could not be read.
    public var latest: String?
    /// It can be asked what the newest is.
    public var canCheck: Bool
    /// Why the newest was not read, when it was not (the last one it had stays beside it).
    public var problem: String?

    public init(id: String, title: String, command: String, binary: String? = nil, version: String? = nil,
                latest: String? = nil, canCheck: Bool = false, problem: String? = nil) {
        self.id = id
        self.title = title
        self.command = command
        self.binary = binary
        self.version = version
        self.latest = latest
        self.canCheck = canCheck
        self.problem = problem
    }

    public var installed: Bool { binary != nil }

    /// The version to move to, when what the program says is newer than what is there.
    public var newer: String? {
        guard let latest, let version, AgentVersion(latest) > AgentVersion(version) else { return nil }
        return latest
    }
}

/// One of their programs' own updater at work (one at a time for each).
public struct AgentExtraJob: Sendable, Equatable, Codable {
    public let id: String
    public var phase: AgentStore.Phase
    /// Why it stopped; the row keeps it until it is read.
    public var error: String?

    public init(id: String, phase: AgentStore.Phase = .updating, error: String? = nil) {
        self.id = id
        self.phase = phase
        self.error = error
    }

    public var failed: Bool { error != nil }
}

public enum AgentExtras {
    public struct Spec: Sendable, Equatable {
        public let id: String
        public let title: String
        public let command: String
        /// The variable AgentSwitch is told its program by (as `CLAUDE_BIN` names Claude Code's).
        public let environmentKey: String
        /// Where its own installer puts the command, under the user's home.
        public let homePath: String
        /// It says what the newest version is.
        public let checksNewest: Bool
    }

    public static let all: [Spec] = [
        Spec(id: "grok", title: "Grok", command: "grok", environmentKey: "GROK_BIN", homePath: ".grok/bin/grok", checksNewest: true),
        Spec(id: "agy", title: "Antigravity", command: "agy", environmentKey: "AGY_BIN", homePath: ".local/bin/agy", checksNewest: false),
    ]

    public static func spec(_ id: String) -> Spec? { all.first { $0.id == id } }

    /// Where its command is: the variable naming it, the PATH a terminal of the user's has, then the place its own
    /// installer puts it.
    public static func binary(_ spec: Spec, home: String, path: String, environment: [String: String],
                              fileManager fm: FileManager = .default) -> String? {
        if let named = environment[spec.environmentKey]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !named.isEmpty, fm.isExecutableFile(atPath: named) { return named }
        for folder in path.split(separator: ":").map(String.init) where !folder.isEmpty {
            let candidate = "\(folder)/\(spec.command)"
            if fm.isExecutableFile(atPath: candidate) { return candidate }
        }
        let own = "\(home)/\(spec.homePath)"
        return fm.isExecutableFile(atPath: own) ? own : nil
    }

    /// What is there now: where each command is and the version it says (`--version`, never a model call). `latest` and
    /// `problem` are kept from `before` — the newest takes a call of its own (`check`).
    public static func scan(home: String, path: String, environment: [String: String], before: [AgentExtra] = [],
                            fileManager fm: FileManager = .default) async -> [AgentExtra] {
        let env = environment.merging(["PATH": path]) { _, new in new }
        var out: [AgentExtra] = []
        for spec in all {
            let found = binary(spec, home: home, path: path, environment: environment, fileManager: fm)
            let had = before.first { $0.id == spec.id }
            var version: String?
            if let found {
                let result = try? await ProcessRunner.run(URL(fileURLWithPath: found), ["--version"], environment: env, timeout: 15)
                version = result.flatMap { HarnessEvaluator.parseVersion($0.stdoutText + $0.stderrText) }
            }
            out.append(AgentExtra(id: spec.id, title: spec.title, command: spec.command, binary: found, version: version,
                                  latest: had?.latest, canCheck: spec.checksNewest, problem: had?.problem))
        }
        return out
    }

    /// What the newest is, where the program says it: Grok's `update --check --json`
    /// (`{"currentVersion":"1.0.92","latestVersion":"1.0.93","updateAvailable":true,…}`). What it had is kept when the
    /// program does not answer; `problem` says why.
    public static func check(_ extra: AgentExtra, environment: [String: String], path: String) async -> AgentExtra {
        guard extra.canCheck, let binary = extra.binary else { return extra }
        var extra = extra
        let env = environment.merging(["PATH": path]) { _, new in new }
        let result = try? await ProcessRunner.run(URL(fileURLWithPath: binary), ["update", "--check", "--json"], environment: env, timeout: 40)
        if let result, result.ok, let object = try? JSONSerialization.jsonObject(with: result.stdout) as? [String: Any],
           let latest = object["latestVersion"] as? String, AgentVersion.isWellFormed(latest) {
            extra.latest = latest
            extra.problem = nil
            if let current = object["currentVersion"] as? String, AgentVersion.isWellFormed(current) { extra.version = current }
            return extra
        }
        extra.problem = "没有读到最新版本。"
        return extra
    }

    /// Runs the program's own updater (`grok update` / `agy update`), with the PATH a terminal of the user's has.
    public static func update(_ extra: AgentExtra, environment: [String: String], path: String,
                              log: @escaping @Sendable (String) -> Void = { _ in },
                              report: @escaping @Sendable (AgentStore.Phase) -> Void = { _ in }) async throws {
        guard let binary = extra.binary else { throw AgentError("\(extra.title) 没有安装。") }
        let env = environment.merging(["PATH": path]) { _, new in new }
        report(.updating)
        log("$ \(binary) update")
        let result: CommandResult
        do {
            result = try await ProcessRunner.run(URL(fileURLWithPath: binary), ["update"], environment: env, timeout: 600)
        } catch {
            log("could not start: \(error.localizedDescription)")
            throw error
        }
        for line in AgentExtras.lastLines(result.stdoutText) { log("  \(line)") }
        for line in AgentExtras.lastLines(result.stderrText) { log("  \(line)") }
        log(result.timedOut ? "timed out" : "exit \(result.status)")
        guard result.ok else { throw AgentError(result.timedOut ? "更新超时。" : "更新失败（退出码 \(result.status)）。") }
    }

    /// The last lines of what a program printed, for the log (the same bound the vendors' own updaters are kept to).
    static func lastLines(_ text: String, limit: Int = 80) -> [String] {
        text.split(whereSeparator: \.isNewline).suffix(limit).map(String.init)
    }
}

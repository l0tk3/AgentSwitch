import Foundation

/// An install, update or delete under way for one agent (docs/agents-v0.md §5): one at a time per agent, shown on the
/// row it works on.
public struct AgentJob: Sendable, Equatable {
    public let agent: AgentCLI
    /// The row it runs on: an install's key (`beta`, `pinned:2.1.280`, `stable`) or a missing row's id (`missing:beta`).
    public let row: String
    /// What it is making, for the row to say while it has no install yet.
    public let source: AgentSource
    public let version: String?
    public var phase: AgentStore.Phase
    /// Why it stopped; the row keeps it until dismissed.
    public var error: String?

    public init(agent: AgentCLI, row: String, source: AgentSource, version: String?, phase: AgentStore.Phase = .resolving, error: String? = nil) {
        self.agent = agent
        self.row = row
        self.source = source
        self.version = version
        self.phase = phase
        self.error = error
    }

    public var failed: Bool { error != nil }
    /// A download can still be called off; once the files are being put in place it runs to its end.
    public var cancellable: Bool {
        guard !failed else { return false }
        switch phase {
        case .resolving, .downloading, .verifying: return true
        case .unpacking, .checking, .installing, .updating, .removing: return false
        }
    }
}

/// What one operation did, line by line, in a file of the agent's own (agents-v0 §5, §6): the addresses asked, the
/// installer's digest, each command run and how it ended with the end of what it printed. The next operation on the
/// same agent starts the file over, so there is one per agent and no more.
public final class AgentLog: @unchecked Sendable {
    public let file: URL
    private let lock = NSLock()

    public init(file: URL, title: String, now: Date = Date()) {
        self.file = file
        let fm = FileManager.default
        try? fm.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        fm.createFile(atPath: file.path, contents: Data("=== \(ISO8601DateFormatter().string(from: now)) \(title)\n".utf8), attributes: [.posixPermissions: 0o600])
    }

    public func add(_ line: String) {
        lock.lock()
        defer { lock.unlock() }
        guard let handle = try? FileHandle(forWritingTo: file) else { return }
        defer { try? handle.close() }
        _ = try? handle.seekToEnd()
        try? handle.write(contentsOf: Data((line + "\n").utf8))
    }
}

/// Lets a progress report through at most every so often, and always when the phase changes: a download reports each
/// piece it writes, far more often than a row needs to redraw.
public final class AgentProgressGate: @unchecked Sendable {
    private let lock = NSLock()
    private let interval: TimeInterval
    private var last: (kind: Int, at: Date)?

    public init(interval: TimeInterval = 0.2) { self.interval = interval }

    public func pass(_ phase: AgentStore.Phase, now: Date = Date()) -> Bool {
        let kind: Int
        switch phase {
        case .resolving: kind = 0
        case .downloading(let received, let total): kind = total != nil && received == total ? 2 : 1   // the last piece always shows
        case .verifying: kind = 3
        case .unpacking: kind = 4
        case .checking: kind = 5
        case .installing: kind = 6
        case .updating: kind = 7
        case .removing: kind = 8
        }
        lock.lock()
        defer { lock.unlock() }
        if let last, last.kind == kind, kind == 1, now.timeIntervalSince(last.at) < interval { return false }
        last = (kind, now)
        return true
    }
}

extension AgentText {
    /// What a job is doing, in a word or two.
    public static func phase(_ phase: AgentStore.Phase) -> String {
        switch phase {
        case .resolving: return "Looking Up"
        case .downloading(let received, let total):
            let got = megabytes(received)
            return total.map { "Downloading \(got) / \(megabytes($0)) MB" } ?? "Downloading \(got) MB"
        case .verifying: return "Verifying"
        case .unpacking: return "Unpacking"
        case .checking: return "Checking"
        case .installing: return "Installing"
        case .updating: return "Updating"
        case .removing: return "Removing"
        }
    }

    /// How far along, 0…1, when that can be said: the download is most of the wait.
    public static func fraction(_ phase: AgentStore.Phase) -> Double? {
        switch phase {
        case .resolving: return nil
        case .downloading(let received, let total):
            guard let total, total > 0 else { return nil }
            return min(1, Double(received) / Double(total)) * 0.9
        case .verifying: return 0.92
        case .unpacking: return 0.95
        case .checking: return 0.98
        // The vendor's installer says nothing of how far it is.
        case .installing, .updating, .removing: return nil
        }
    }

    private static func megabytes(_ bytes: Int64) -> Int { Int((Double(bytes) / 1_000_000).rounded()) }

    /// The question before the vendor's own install is removed (agents-v0 §5): which version, how large, the places
    /// that go, what stays, and what AgentSwitch runs afterwards when this was the one in use.
    public static func uninstallQuestion(_ install: AgentInstall, paths: [String], bytes: Int64?, inUse: Bool, next: AgentInstall?,
                                         home: String) -> (title: String, message: String) {
        let agent = install.agent
        let name = "\(agent.title) \(install.version ?? "")".trimmingCharacters(in: .whitespaces)
        var lines = ["将从这台 Mac 上卸载 \(name)\(bytes.map { "（\(size($0))）" } ?? "")。命令行里的 \(agent.command) 将不可用。"]
        lines += paths.map { DisplayPath.short($0, home: home) }
        lines.append("登录、配置和会话记录不受影响。")
        if inUse {
            lines.append(next.map { "AgentSwitch 正在使用此版本，卸载后改用 \($0.source.title) \($0.version ?? "")，重启服务后生效。" }
                ?? "AgentSwitch 正在使用此版本，卸载后将没有可用的 \(agent.title)。")
        }
        return ("卸载 \(agent.title) Stable\(install.version.map { " \($0)" } ?? "")？", lines.joined(separator: "\n"))
    }

    /// The question before the versions a vendor keeps beside the current one are cleared.
    public static func cleanQuestion(_ agent: AgentCLI, leftovers: AgentLeftovers, current: String?, home: String) -> (title: String, message: String) {
        let folder = leftovers.paths.first.map { DisplayPath.short(($0 as NSString).deletingLastPathComponent, home: home) }
        let what = "将删除 \(leftovers.versions.joined(separator: "、"))\(leftovers.bytes.map { "，共 \(size($0))" } ?? "")。"
        let lines = [what + (current.map { "当前版本 \($0) 保留。" } ?? ""), folder].compactMap { $0 }
        return ("清除 \(agent.title) 的旧版本？", lines.joined(separator: "\n"))
    }

    /// The question before a stored version is deleted (agents-v0 §5): what goes, from where, how large, what stays,
    /// and what AgentSwitch runs afterwards when this was the one in use.
    public static func deleteQuestion(_ install: AgentInstall, inUse: Bool, next: AgentInstall?, home: String) -> (title: String, message: String) {
        let name = "\(install.agent.title) \(install.source.title) \(install.version ?? "")".trimmingCharacters(in: .whitespaces)
        var lines = ["将从版本库中删除 \(name)\(install.bytes.map { "（\(size($0))）" } ?? "")：\(DisplayPath.short(install.location, home: home))"]
        if let command = install.command { lines.append("命令行里的 \(command) 将不可用。") }
        lines.append("登录、配置和会话记录不受影响。")
        if inUse {
            lines.append(next.map { "AgentSwitch 正在使用此版本，删除后改用 \($0.source.title) \($0.version ?? "")，重启服务后生效。" }
                ?? "AgentSwitch 正在使用此版本，删除后将没有可用的 \(install.agent.title)。")
        }
        return ("删除 \(name)？", lines.joined(separator: "\n"))
    }
}

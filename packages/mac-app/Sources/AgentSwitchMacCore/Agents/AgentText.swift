import Foundation

/// What 设置 › Agents writes about an install (docs/agents-v0.md §8): short words in title case, sentences in formal
/// Chinese (docs/ui-v0.md §7.2.7).
public enum AgentText {
    /// `233 MB`, `1.18 GB`: decimal units, as Finder counts.
    public static func size(_ bytes: Int64) -> String {
        if bytes >= 1_000_000_000 { return String(format: "%.2f GB", Double(bytes) / 1_000_000_000) }
        if bytes >= 1_000_000 { return "\(Int((Double(bytes) / 1_000_000).rounded())) MB" }
        if bytes >= 1000 { return "\(Int((Double(bytes) / 1000).rounded())) KB" }
        return "\(bytes) B"
    }

    /// The line under a row: its name on the command line and where that is, or what the row is.
    public static func detail(_ install: AgentInstall, home: String) -> String {
        switch install.source {
        case .stable:
            let folder = DisplayPath.short((install.binary as NSString).deletingLastPathComponent, home: home)
            let follows = install.channel.map { " · Follows \($0.prefix(1).uppercased() + $0.dropFirst())" } ?? ""
            return "\(install.command ?? install.agent.command) · \(folder)\(follows)"
        case .beta: return install.command ?? "Not on the Command Line"
        case .pinned: return "AgentSwitch Only"
        case .app: return "Updates with ChatGPT App"
        case .other: return DisplayPath.short(install.binary, home: home)
        }
    }

    /// Said under the row when its version is one AgentSwitch does not run, or was not checked against.
    public static func caution(_ install: AgentInstall) -> String? {
        if install.unsupportedLine { return "\(install.agent.title) 1.x 不受 AgentSwitch 支持，需要 2.x。" }
        if install.belowVerified { return "低于 AgentSwitch 验证过的版本（\(install.agent.verifiedFloor)）。" }
        return nil
    }

    /// The folder of an install's command when the login shell's PATH does not have it: installed, but not yet a
    /// name a new terminal knows. `path` is what the shell itself said.
    public static func offPathFolder(_ install: AgentInstall, layout: AgentLayout, path: String) -> String? {
        guard install.command != nil, install.source == .stable || install.source == .beta else { return nil }
        let folder = install.source == .beta ? layout.binDir : (install.binary as NSString).deletingLastPathComponent
        let real = AgentInventory.real(folder)
        let onPath = path.split(separator: ":").contains { $0 == folder || AgentInventory.real(String($0)) == real }
        return onPath ? nil : folder
    }

    /// At the foot of the page (agents-v0 §2, §8): each such folder once, the commands in it, and the line that puts
    /// it on the PATH — written out, not added to the shell profile for the user.
    public static func pathNotes(_ reports: [AgentReport], layout: AgentLayout, path: String?) -> [String] {
        guard let path else { return [] }
        var folders: [String] = []
        var commands: [String: [String]] = [:]
        for install in reports.flatMap(\.installs) {
            guard let folder = offPathFolder(install, layout: layout, path: path), let command = install.command else { continue }
            if commands[folder] == nil { folders.append(folder) }
            commands[folder, default: []].append(command)
        }
        return folders.map { folder in
            let written = folder.hasPrefix(layout.home + "/") ? "$HOME" + folder.dropFirst(layout.home.count) : folder
            return "\(DisplayPath.short(folder, home: layout.home)) 不在 PATH 中，新开的终端里还不能直接使用 \(commands[folder, default: []].joined(separator: "、"))。"
                + "可在 shell 配置中加入：export PATH=\"\(written):$PATH\""
        }
    }

    /// Under an agent whose choice the running service does not have yet: what it still runs, what it will run.
    /// `applied` is the program the service was started with for this agent.
    public static func pendingRestart(_ report: AgentReport, chosen: AgentInstall?, applied: String?) -> String {
        func name(_ install: AgentInstall) -> String { "\(install.source.title) \(install.version ?? "")".trimmingCharacters(in: .whitespaces) }
        let next = chosen.map { "重启服务后改用 \(name($0))。" } ?? "重启服务后生效。"
        guard let applied else { return "服务启动时还没有 \(report.agent.title)，" + next }
        guard let old = report.installs.first(where: { $0.binary == applied }) else { return "服务仍在使用原先的版本，" + next }
        return "服务仍在使用 \(name(old))，" + next
    }

    /// When the vendors were last asked.
    public static func checked(_ info: AgentReleaseInfo?, checking: Bool, now: Date = Date()) -> String {
        if checking { return "Checking" }
        guard let at = info?.checkedAt else { return "Not Checked" }
        return "Checked \(TimeText.moment(at, now: now))"
    }

    /// The agents whose vendors did not answer the last time, named in one sentence; nil when all did.
    public static func failed(_ info: AgentReleaseInfo?) -> String? {
        guard let failed = info?.failed, !failed.isEmpty else { return nil }
        let names = failed.compactMap { AgentCLI(rawValue: $0)?.title }.joined(separator: "、")
        return "未能读取 \(names) 的发布信息，显示的是上次的结果。"
    }
}

/// A line of an agent's group in 设置 › Agents, top to bottom (agents-v0 §8): the vendor's own install or the offer of
/// one, the versions it keeps beside it, the app's copy, the beta or the offer of one, the pinned versions, the rest.
public enum AgentRow: Sendable, Equatable, Identifiable {
    case install(AgentInstall)
    /// Not installed: the channel's newest version, when the vendors were asked.
    case missing(AgentSource, available: String?)
    case leftovers(AgentLeftovers)

    public var id: String {
        switch self {
        case .install(let install): return install.key
        case .missing(let source, _): return "missing:\(source.rawValue)"
        case .leftovers: return AgentRow.leftoversID
        }
    }

    public static let leftoversID = "leftovers"

    public static func rows(_ report: AgentReport, channels: AgentChannels?) -> [AgentRow] {
        var out: [AgentRow] = []
        if let stable = report.install(.stable) { out.append(.install(stable)) } else { out.append(.missing(.stable, available: channels?.stable)) }
        if let leftovers = report.leftovers { out.append(.leftovers(leftovers)) }
        out += report.installs.filter { $0.source == .app }.map(AgentRow.install)
        if report.agent.betaCommand != nil {
            if let beta = report.install(.beta) { out.append(.install(beta)) } else { out.append(.missing(.beta, available: channels?.beta)) }
        }
        out += report.installs.filter { $0.source == .pinned || $0.source == .other }.map(AgentRow.install)
        return out
    }
}

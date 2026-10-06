import Foundation

/// Where an install came from (docs/agents-v0.md §2).
public enum AgentSource: String, Sendable, Codable, CaseIterable {
    /// The vendor's own install in the vendor's own place: `claude`, `codex`, `opencode`, `pi` on the command line.
    case stable
    /// The test channel, in AgentSwitch's store: one version, replaced on update.
    case beta
    /// A version the user asked for, in the store: never updated.
    case pinned
    /// The copy inside ChatGPT.app (Codex only): updated with the app, never deleted here.
    case app
    /// Found elsewhere (Homebrew, npm, another prefix): listed, not managed.
    case other

    public var title: String {
        switch self {
        case .stable: return "Stable"
        case .beta: return "Beta"
        case .pinned: return "Pinned"
        case .app: return "ChatGPT App"
        case .other: return "Other"
        }
    }
}

/// One install of one agent's CLI.
public struct AgentInstall: Sendable, Equatable, Identifiable {
    public let agent: AgentCLI
    public let source: AgentSource
    /// What a choice of this install is saved as: `stable`, `beta`, `pinned:2.1.280`, `app`, `other:/opt/…/codex`.
    public let key: String
    /// What AgentSwitch runs for it: the vendor's command, the store's launcher, the app's copy.
    public let binary: String
    /// Its name on the command line, when it has one (`claude`, `claude-beta`).
    public let command: String?
    /// Its program files, a file or a folder: what is shown, sized and deleted.
    public let location: String
    public var version: String?
    public var bytes: Int64?
    /// Claude Code's own install: the channel its updater follows (`latest`, `stable`).
    public var channel: String?

    public var id: String { "\(agent.rawValue):\(key)" }

    public init(agent: AgentCLI, source: AgentSource, key: String, binary: String, command: String? = nil, location: String,
                version: String? = nil, bytes: Int64? = nil, channel: String? = nil) {
        self.agent = agent
        self.source = source
        self.key = key
        self.binary = binary
        self.command = command
        self.location = location
        self.version = version
        self.bytes = bytes
        self.channel = channel
    }

    public static func pinnedKey(_ version: String) -> String { "pinned:\(version)" }
    public static func otherKey(_ path: String) -> String { "other:\(path)" }

    /// OpenCode's first line (1.x): AgentSwitch is written against 2.x (agents-v0 §1), so it is listed and not offered.
    /// Its test builds are numbered `0.0.0-beta-N`, which says nothing of the line: those are of the second.
    public var unsupportedLine: Bool {
        agent == .opencode && version.map { !isTestBuild($0) && AgentVersion($0).major < 2 } == true
    }

    /// Older than what AgentSwitch was checked against: said beside the row, not refused.
    public var belowVerified: Bool {
        guard let version, !unsupportedLine else { return false }
        return AgentVersion(version) < agent.verifiedFloor && !isTestBuild(version)
    }

    private func isTestBuild(_ version: String) -> Bool { version.hasPrefix("0.0.0-") }

    public var selectable: Bool { !unsupportedLine }
    /// The app's copy goes with the app; what was found elsewhere is removed the way it was installed.
    public var deletable: Bool { source == .stable || source == .beta || source == .pinned }
}

/// Earlier versions a vendor's own install keeps beside the current one (Claude Code's `versions/`, pi's
/// `releases/`): listed apart so they can be cleared (agents-v0 §6).
public struct AgentLeftovers: Sendable, Equatable {
    public let versions: [String]
    public let paths: [String]
    public var bytes: Int64?

    public init(versions: [String], paths: [String], bytes: Int64? = nil) {
        self.versions = versions
        self.paths = paths
        self.bytes = bytes
    }
}

/// Everything found for one agent.
public struct AgentReport: Sendable, Equatable, Identifiable {
    public let agent: AgentCLI
    public var installs: [AgentInstall]
    public var leftovers: AgentLeftovers?

    public var id: String { agent.rawValue }

    public init(agent: AgentCLI, installs: [AgentInstall], leftovers: AgentLeftovers? = nil) {
        self.agent = agent
        self.installs = installs
        self.leftovers = leftovers
    }

    public func install(_ key: String) -> AgentInstall? { installs.first { $0.key == key } }
    public func install(_ source: AgentSource) -> AgentInstall? { installs.first { $0.source == source } }
}

/// Where things are (agents-v0 §1, §2): each vendor's own places under the user's home, and AgentSwitch's store.
public struct AgentLayout: Sendable, Equatable {
    public let home: String
    /// `~/.local/share/agentswitch/cli`: a path without spaces, outside the app and its data folder, so what is in it
    /// goes on working without the app.
    public let store: String
    /// ChatGPT.app's Codex, newest layout first.
    public let appCodex: [String]

    public static let defaultAppCodex = [
        "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
        "/Applications/ChatGPT.app/Contents/Resources/codex",
        "/Applications/Codex.app/Contents/Resources/codex",
    ]

    public init(home: String, store: String? = nil, appCodex: [String] = AgentLayout.defaultAppCodex) {
        self.home = home
        self.store = store ?? "\(home)/.local/share/agentswitch/cli"
        self.appCodex = appCodex
    }

    /// Where the beta names go, and where three of the four vendors put their own command.
    public var binDir: String { "\(home)/.local/bin" }

    /// The vendor's own command.
    public func command(_ agent: AgentCLI) -> String {
        switch agent {
        case .opencode: return "\(home)/.opencode/bin/opencode"
        case .claude, .codex, .pi: return "\(binDir)/\(agent.command)"
        }
    }

    /// The folder a command must resolve into to be the vendor's own install (OpenCode's is the file itself).
    public func programRoot(_ agent: AgentCLI) -> String {
        switch agent {
        case .claude: return "\(home)/.local/share/claude/versions"
        case .codex: return "\(home)/.codex/packages/standalone"
        case .opencode: return "\(home)/.opencode/bin"
        case .pi: return "\(home)/.pi/agent"
        }
    }

    public func betaCommand(_ agent: AgentCLI) -> String? { agent.betaCommand.map { "\(binDir)/\($0)" } }
    public func storeFolder(_ agent: AgentCLI, _ source: AgentSource) -> String { "\(store)/\(agent.rawValue)/\(source.rawValue)" }
    public func storeVersion(_ agent: AgentCLI, _ source: AgentSource, _ version: String) -> String { "\(storeFolder(agent, source))/\(version)" }
    /// What is run for a stored version: a few lines of shell that turn its self-update off and start it.
    public func launcher(_ agent: AgentCLI, _ source: AgentSource, _ version: String) -> String { "\(storeVersion(agent, source, version))/\(AgentLayout.launcherName)" }
    public var downloads: String { "\(store)/downloads" }

    public static let launcherName = "launch"
}

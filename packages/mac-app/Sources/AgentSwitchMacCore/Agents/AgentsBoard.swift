import Foundation

/// 设置 › Agents as one thing that can be sent (docs/agents-v0.md §12): what a Mac has of the agent CLIs, what the vendors
/// have that is newer, which install its AgentSwitch runs, and the jobs under way. The page draws a board, this Mac's
/// own or another node's: that node's app makes its board, hands it to its service, and the page asks there.
public struct AgentsBoard: Codable, Equatable, Sendable {
    /// The user's home there, for writing its paths short (`~/.local/bin`).
    public var home: String
    /// AgentSwitch's own store of betas and pinned versions, and whether the folder is there.
    public var store: String
    public var storeExists: Bool
    public var agents: [AgentReport]
    public var releases: AgentReleaseInfo?
    /// The vendors are being asked now.
    public var checking: Bool
    /// The install chosen for each agent, by the agent's name; what the running service was started with.
    public var use: [String: String]
    public var applied: [String: String]
    /// Its service runs (else nothing is pending a restart).
    public var running: Bool
    public var jobs: [String: AgentJob]
    public var pathNotes: [String]
    /// What uninstalling each vendor's own install would remove, by the agent's name.
    public var uninstallPaths: [String: [String]]

    public init(home: String, store: String, storeExists: Bool, agents: [AgentReport], releases: AgentReleaseInfo?, checking: Bool, use: [String: String],
                applied: [String: String], running: Bool, jobs: [String: AgentJob], pathNotes: [String], uninstallPaths: [String: [String]]) {
        self.home = home
        self.store = store
        self.storeExists = storeExists
        self.agents = agents
        self.releases = releases
        self.checking = checking
        self.use = use
        self.applied = applied
        self.running = running
        self.jobs = jobs
        self.pathNotes = pathNotes
        self.uninstallPaths = uninstallPaths
    }

    public func inUse(_ report: AgentReport) -> AgentInstall? { AgentSelection.chosen(report, saved: use[report.agent.rawValue]) }
    public func job(_ agent: AgentCLI) -> AgentJob? { jobs[agent.rawValue] }
    public func newer(for install: AgentInstall) -> String? { AgentUpdates.newer(for: install, channels: releases?.channels(install.agent)) }
    public var updateCount: Int { AgentUpdates.count(agents, info: releases) }
    public func applied(_ agent: AgentCLI) -> String? { applied[agent.rawValue] }

    /// The agents the service runs another program for than the one now chosen.
    public var pending: Set<AgentCLI> {
        guard running, !agents.isEmpty else { return [] }
        var was: [AgentCLI: String] = [:]
        for (name, binary) in applied { if let agent = AgentCLI(rawValue: name) { was[agent] = binary } }
        return AgentSelection.pending(agents, saved: use, applied: was)
    }
    public var needsRestart: Bool { !pending.isEmpty }

    /// `path` as that Mac writes it short.
    public func short(_ path: String) -> String { path == home ? "~" : path.hasPrefix(home + "/") ? "~" + path.dropFirst(home.count) : path }
}

/// What the page asks of a board's Mac: one of the page's own buttons.
public struct AgentsAction: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable { case refresh, check, use, install, update, delete, clean, cancel, dismiss, restart }
    public var kind: Kind
    public var agent: AgentCLI?
    /// An install's key (`stable`, `beta`, `pinned:2.1.280`).
    public var key: String?
    public var source: AgentSource?
    public var version: String?
    /// The row a new install shows on.
    public var row: String?

    public init(_ kind: Kind, agent: AgentCLI? = nil, key: String? = nil, source: AgentSource? = nil, version: String? = nil, row: String? = nil) {
        self.kind = kind
        self.agent = agent
        self.key = key
        self.source = source
        self.version = version
        self.row = row
    }
}

extension DaemonClient {
    /// A node's board as its app last handed it over; `fresh`: handed over within the last moments (its app runs).
    public struct AgentsBoardAnswer: Decodable, Sendable { public let board: AgentsBoard; public let fresh: Bool }

    public func agentsBoard() async throws -> AgentsBoardAnswer { try decode(AgentsBoardAnswer.self, try await call("GET", "/agents/board", timeout: 10)) }

    public func sendAgents(_ action: AgentsAction) async throws { _ = try await call("POST", "/agents/actions", body: try JSONEncoder().encode(action), timeout: 10) }

    /// This Mac's own app to its own service: the board as it is now, and the actions asked of it since last time.
    public func putAgentsBoard(_ board: Data) async throws { _ = try await call("PUT", "/agents/board", body: board, timeout: 5) }

    public func takeAgentsActions() async throws -> [AgentsAction] {
        struct Answer: Decodable { let actions: [AgentsAction] }
        return try decode(Answer.self, try await call("GET", "/agents/actions", timeout: 5)).actions
    }
}

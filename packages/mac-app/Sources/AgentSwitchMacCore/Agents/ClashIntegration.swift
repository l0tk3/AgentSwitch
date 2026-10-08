import Foundation

/// Clash Integration (docs/clash-v0.md §6): what the service found of Clash Verge and what its core runs, and what
/// AgentSwitch is set to add — the nodes for Claude and for OpenAI in their order, the addresses that go direct.
public struct ClashServiceProxy: Codable, Equatable, Sendable {
    /// Nodes by name, the first preferred.
    public var nodes: [String]
    /// `auto`: the first that answers; `manual`: the one picked.
    public var mode: String
    public var picked: String?

    public init(nodes: [String] = [], mode: String = "auto", picked: String? = nil) {
        self.nodes = nodes
        self.mode = mode
        self.picked = picked
    }
}

public struct ClashSettings: Codable, Equatable, Sendable {
    /// The subscription of Clash Verge's it works from (its uid); nil: none chosen yet.
    public var source: String?
    public var claude: ClashServiceProxy
    public var openai: ClashServiceProxy
    public var direct: [String]

    public init(source: String? = nil, claude: ClashServiceProxy = .init(), openai: ClashServiceProxy = .init(), direct: [String] = []) {
        self.source = source
        self.claude = claude
        self.openai = openai
        self.direct = direct
    }

    private enum CodingKeys: String, CodingKey { case source, claude, openai, direct }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(source, forKey: .source)   // null is said, not left out
        try c.encode(claude, forKey: .claude)
        try c.encode(openai, forKey: .openai)
        try c.encode(direct, forKey: .direct)
    }
}

public struct ClashProfile: Decodable, Equatable, Sendable, Identifiable {
    public let uid: String
    public let name: String
    public let type: String
    public var id: String { uid }
}

public struct ClashView: Decodable, Equatable, Sendable {
    /// Clash Verge is on this Mac; its core answers.
    public let found: Bool
    public let running: Bool
    public let version: String?
    public let tun: Bool?
    public let nodes: [String]?
    public let profiles: [ClashProfile]
    public let currentProfile: String?
    public let settings: ClashSettings
    /// The core runs the subscription AgentSwitch makes; its groups are the ones asked for now.
    public let active: Bool
    public let upToDate: Bool
    /// The link Clash Verge takes the subscription by.
    public let install: String

    /// What is still to do in Clash Verge, in order; empty when nothing is.
    public var todo: [String] {
        guard found else { return ["这台 Mac 上没有找到 Clash Verge。"] }
        guard running else { return ["Clash Verge 没有在运行：打开它。"] }
        var steps: [String] = []
        if settings.source == nil { steps.append("先在下面选一个订阅作为底本。") }
        else if !active { steps.append("在 Clash Verge 里添加并切换到 AgentSwitch 订阅。") }
        else if !upToDate { steps.append("节点的顺序改过了：在 Clash Verge 里更新一次 AgentSwitch 订阅。") }
        if tun == false { steps.append("打开 Clash Verge 的 TUN 模式。") }
        return steps
    }
}

extension DaemonClient {
    public func clash() async throws -> ClashView { try decode(ClashView.self, try await call("GET", "/clash")) }

    public func saveClash(_ settings: ClashSettings) async throws -> ClashView {
        try decode(ClashView.self, try await call("PUT", "/clash/settings", body: try JSONEncoder().encode(settings)))
    }
}

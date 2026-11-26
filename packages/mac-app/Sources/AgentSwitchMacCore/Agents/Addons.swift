import Foundation

/// What a profile has installed (docs/profiles-v0.md "Add-Ons"; daemon `profiles/addons.ts`): an MCP server, a skill,
/// a plugin, an agent, a command — Codex's prompts and rules. Names only reach here: a server's command has what
/// looks like a credential struck out, its environment and headers are a count.
public struct ProfileAddon: Decodable, Hashable, Sendable, Identifiable {
    public let kind: String
    public let name: String
    public let about: String?
    /// It is `Default`'s, linked: changed there.
    public let shared: Bool
    /// MCP servers and plugins; false: switched off under this profile.
    public let enabled: Bool?
    public let transport: String?
    public let command: String?
    public let secrets: Int?
    public let version: String?

    public var id: String { "\(kind)/\(name)" }
    public var isOn: Bool { enabled != false }

    public init(kind: String, name: String, about: String? = nil, shared: Bool = false, enabled: Bool? = nil, transport: String? = nil, command: String? = nil, secrets: Int? = nil, version: String? = nil) {
        self.kind = kind; self.name = name; self.about = about; self.shared = shared; self.enabled = enabled
        self.transport = transport; self.command = command; self.secrets = secrets; self.version = version
    }
}

/// Every profile of one agent with what it has.
public struct ProfileAddons: Decodable, Equatable, Sendable {
    public struct Entry: Decodable, Equatable, Sendable, Identifiable {
        public let id: String
        public let items: [ProfileAddon]
        public init(id: String, items: [ProfileAddon]) { self.id = id; self.items = items }
    }
    public let agent: String
    public let kinds: [String]
    public let profiles: [Entry]

    public init(agent: String, kinds: [String], profiles: [Entry]) { self.agent = agent; self.kinds = kinds; self.profiles = profiles }

    public func items(of profile: String) -> [ProfileAddon] { profiles.first { $0.id == profile }?.items ?? [] }
    public func item(_ id: String, in profile: String) -> ProfileAddon? { items(of: profile).first { $0.id == id } }

    /// Every add-on some profile in `scope` has, once each, in the order of `kinds` then by name.
    public func all(in scope: [String]) -> [ProfileAddon] {
        var seen = Set<String>(), out: [ProfileAddon] = []
        for id in scope { for item in items(of: id) where seen.insert(item.id).inserted { out.append(item) } }
        return out.sorted { (kinds.firstIndex(of: $0.kind) ?? 99, $0.name.lowercased()) < (kinds.firstIndex(of: $1.kind) ?? 99, $1.name.lowercased()) }
    }
}

/// How a change went under one profile.
public struct AddonResult: Decodable, Equatable, Sendable {
    public let profile: String
    public let ok: Bool
    public let said: String
}

public enum AddonWords {
    public static func kind(_ kind: String) -> String {
        switch kind {
        case "mcp": "MCP Servers"
        case "skills": "Skills"
        case "plugins": "Plugins"
        case "agents": "Agents"
        case "commands": "Commands"
        case "prompts": "Prompts"
        case "rules": "Rules"
        case "extensions": "Extensions"
        case "workflows": "Workflows"
        default: kind
        }
    }
    /// The kinds kept as files: copied between profiles and removed as files.
    public static let files: Set<String> = ["skills", "agents", "commands", "prompts", "rules", "extensions", "workflows"]
    /// What the agent's own install command looks like, for the field's placeholder.
    public static func example(_ agent: String) -> String {
        let cli = ["claude-code": "claude", "codex": "codex", "opencode": "opencode", "grok": "grok", "agy": "agy"][agent] ?? "claude"
        return "\(cli) mcp add sentry -- npx -y @sentry/mcp-server"
    }
    /// The picker's word for an agent: short, so six fit side by side.
    public static func agent(_ id: String) -> String {
        ["claude-code": "Claude", "codex": "Codex", "opencode": "OpenCode", "pi": "pi", "grok": "Grok", "agy": "agy"][id] ?? id
    }
    /// `Installed in 3 profiles` / `2 of 3: work: <why>`.
    public static func summary(_ results: [AddonResult], done: String, name: (String) -> String) -> String {
        let failed = results.filter { !$0.ok }
        if failed.isEmpty { return "\(done) in \(results.count) \(results.count == 1 ? "profile" : "profiles")" }
        let first = failed[0]
        return "\(results.count - failed.count) of \(results.count) · \(name(first.profile)): \(first.said)"
    }
}

extension DaemonClient {
    private struct AddonReply: Decodable { let results: [AddonResult] }

    public func profileAddons(agent: String) async throws -> ProfileAddons {
        try decode(ProfileAddons.self, try await call("GET", "/profiles/addons?agent=\(Self.segment(agent))", timeout: 60))
    }

    /// `command`: the agent's own `mcp add …` line, run once under each profile.
    public func installMCP(agent: String, command: String, profiles: [String]) async throws -> [AddonResult] {
        struct Body: Encodable { let agent: String; let command: String; let profiles: [String] }
        return try decode(AddonReply.self, try await call("POST", "/profiles/addons/mcp/install", body: try JSONEncoder().encode(Body(agent: agent, command: command, profiles: profiles)), timeout: 600)).results
    }

    public func removeMCP(agent: String, name: String, profiles: [String]) async throws -> [AddonResult] {
        struct Body: Encodable { let agent: String; let name: String; let profiles: [String] }
        return try decode(AddonReply.self, try await call("POST", "/profiles/addons/mcp/remove", body: try JSONEncoder().encode(Body(agent: agent, name: name, profiles: profiles)), timeout: 600)).results
    }

    public func switchMCP(agent: String, name: String, on: Bool, profiles: [String]) async throws -> [AddonResult] {
        struct Body: Encodable { let agent: String; let name: String; let on: Bool; let profiles: [String] }
        return try decode(AddonReply.self, try await call("POST", "/profiles/addons/mcp/switch", body: try JSONEncoder().encode(Body(agent: agent, name: name, on: on, profiles: profiles)), timeout: 600)).results
    }

    public func copyAddon(agent: String, kind: String, name: String, from: String, profiles: [String]) async throws -> [AddonResult] {
        struct Body: Encodable { let agent: String; let kind: String; let name: String; let from: String; let profiles: [String] }
        return try decode(AddonReply.self, try await call("POST", "/profiles/addons/copy", body: try JSONEncoder().encode(Body(agent: agent, kind: kind, name: name, from: from, profiles: profiles)))).results
    }

    public func removeAddon(agent: String, kind: String, name: String, profiles: [String]) async throws -> [AddonResult] {
        struct Body: Encodable { let agent: String; let kind: String; let name: String; let profiles: [String] }
        return try decode(AddonReply.self, try await call("POST", "/profiles/addons/remove", body: try JSONEncoder().encode(Body(agent: agent, kind: kind, name: name, profiles: profiles)))).results
    }
}

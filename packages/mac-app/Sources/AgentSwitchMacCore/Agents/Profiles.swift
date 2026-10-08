import Foundation

/// Profiles (docs/profiles-v0.md §3): several sign-ins per agent, each started with a folder of its own; `Default` is
/// the Mac's own. The service keeps them (`GET /profiles`).
/// Where a profile's own proxy let traffic out when it was last checked (docs/profiles-v0.md §4).
public struct ProfileExit: Decodable, Equatable, Sendable {
    public let ip: String
    public let place: String?

    public init(ip: String, place: String? = nil) {
        self.ip = ip
        self.place = place
    }

    /// `Tokyo 203.0.113.9`.
    public var text: String { [place, ip].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ") }
}

public struct AgentProfile: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    /// `subscription` or `api`.
    public let kind: String
    /// Who is signed in, as the agent's own files say; nil: nobody yet.
    public let account: String?
    /// Its own proxy (the password is never told, only that it has one); nil: this Mac's own way out.
    public let proxy: BrowserProxy?
    public let exit: ProfileExit?

    public var isDefault: Bool { id == "default" }

    public init(id: String, name: String, kind: String = "subscription", account: String? = nil, proxy: BrowserProxy? = nil, exit: ProfileExit? = nil) {
        self.id = id
        self.name = name
        self.kind = kind
        self.account = account
        self.proxy = proxy
        self.exit = exit
    }

    /// Where what runs under it leaves from, in a few words: `This Mac`; with a proxy of its own, where that proxy
    /// lets traffic out (`Tokyo 203.0.113.9`), or the proxy itself while that is not known (`proxy.example:8080`).
    public var way: String {
        guard let proxy else { return "This Mac" }
        return exit?.text ?? BrowserIdentityText.proxySite(proxy.server) ?? proxy.server
    }
}

public struct AgentProfiles: Decodable, Equatable, Sendable {
    public let current: String
    public let profiles: [AgentProfile]
    /// More than `Default` can be made for this agent.
    public let creatable: Bool

    public init(current: String, profiles: [AgentProfile], creatable: Bool) {
        self.current = current
        self.profiles = profiles
        self.creatable = creatable
    }
}

extension DaemonClient {
    private struct ProfilesReply: Decodable { let agents: [String: AgentProfiles] }

    /// Every agent's profiles, by the agent's id (`claude-code`, `codex`…).
    public func profiles() async throws -> [String: AgentProfiles] {
        try decode(ProfilesReply.self, try await call("GET", "/profiles")).agents
    }

    public func setCurrentProfile(agent: String, id: String) async throws -> [String: AgentProfiles] {
        try decode(ProfilesReply.self, try await call("POST", "/profiles/current", body: try JSONEncoder().encode(["agent": agent, "id": id]))).agents
    }

    public func createProfile(agent: String, name: String, kind: String = "subscription") async throws -> [String: AgentProfiles] {
        try decode(ProfilesReply.self, try await call("POST", "/profiles", body: try JSONEncoder().encode(["agent": agent, "name": name, "kind": kind]))).agents
    }

    /// A profile's own proxy from now on (nil: none, this Mac's own way out). It is checked at once: `problem` is why it
    /// let nothing out, when it did not — it is kept all the same.
    public func setProfileProxy(agent: String, id: String, proxy: BrowserProxyRequest?) async throws -> (agents: [String: AgentProfiles], problem: String?) {
        struct None: Encodable { let server: String? = nil
            func encode(to encoder: Encoder) throws { var c = encoder.container(keyedBy: Key.self); try c.encodeNil(forKey: .server) }
            enum Key: String, CodingKey { case server } }
        let body = try proxy.map { try JSONEncoder().encode($0) } ?? JSONEncoder().encode(None())
        return try profileExitReply(try await call("PUT", "/profiles/\(Self.segment(agent))/\(Self.segment(id))/proxy", body: body, timeout: 30))
    }

    /// Where a profile's proxy lets traffic out, asked now.
    public func checkProfileExit(agent: String, id: String) async throws -> (agents: [String: AgentProfiles], problem: String?) {
        try profileExitReply(try await call("POST", "/profiles/\(Self.segment(agent))/\(Self.segment(id))/check", timeout: 30))
    }

    private func profileExitReply(_ data: Data) throws -> (agents: [String: AgentProfiles], problem: String?) {
        struct Reply: Decodable { let agents: [String: AgentProfiles]; let problem: String? }
        let reply = try decode(Reply.self, data)
        return (reply.agents, reply.problem)
    }

    public func deleteProfile(agent: String, id: String) async throws -> [String: AgentProfiles] {
        try decode(ProfilesReply.self, try await call("DELETE", "/profiles/\(Self.segment(agent))/\(Self.segment(id))")).agents
    }
}

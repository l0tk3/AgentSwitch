import Foundation

/// Profiles (docs/profiles-v0.md §3): several sign-ins per agent, each started with a folder of its own; `Default` is
/// the Mac's own. The service keeps them (`GET /profiles`).
public struct AgentProfile: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    /// `subscription` or `api`.
    public let kind: String
    /// Who is signed in, as the agent's own files say; nil: nobody yet.
    public let account: String?

    public var isDefault: Bool { id == "default" }

    public init(id: String, name: String, kind: String = "subscription", account: String? = nil) {
        self.id = id
        self.name = name
        self.kind = kind
        self.account = account
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

    public func deleteProfile(agent: String, id: String) async throws -> [String: AgentProfiles] {
        try decode(ProfilesReply.self, try await call("DELETE", "/profiles/\(Self.segment(agent))/\(Self.segment(id))")).agents
    }
}

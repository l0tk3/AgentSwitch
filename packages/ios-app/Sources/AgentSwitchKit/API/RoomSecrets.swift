import Foundation

// A room's secrets (2026-11-24; the service's `rooms/secrets.ts`): what the members need to log in, call an API or run a
// command with, each sealed on the Mac by the gate before it comes here — the room keeps ciphertexts (`enc:v1:…`),
// never a value. The phone reads and removes them; adding one needs the Mac's gate.

/// One secret: its name, what it is for, and its token.
public struct RoomSecret: Decodable, Sendable, Hashable, Identifiable {
    public enum Kind: String, Sendable, Hashable {
        /// A site's password.
        case site
        /// An API's key.
        case api
        /// A value a command reads from its environment.
        case exec
        case other

        /// The list's word for it.
        public var word: String {
            switch self {
            case .site: return "网站登录"
            case .api: return "API Key"
            case .exec: return "命令用"
            case .other: return "其他"
            }
        }
    }

    public let id: String
    public let name: String
    public let kind: Kind
    public let url: String?
    public let account: String?
    public let env: String?
    /// The ciphertext a member puts where the value would go.
    public let token: String
    /// Milliseconds since 1970.
    public let addedAt: Int64

    private enum CodingKeys: String, CodingKey { case id, name, kind, url, account, env, token, addedAt }

    public init(id: String, name: String, kind: Kind, url: String? = nil, account: String? = nil, env: String? = nil, token: String, addedAt: Int64 = 0) {
        self.id = id
        self.name = name
        self.kind = kind
        self.url = url
        self.account = account
        self.env = env
        self.token = token
        self.addedAt = addedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = (try? c.decode(String.self, forKey: .name)) ?? ""
        kind = (try? c.decode(String.self, forKey: .kind)).flatMap(Kind.init(rawValue:)) ?? .other
        func text(_ key: CodingKeys) -> String? { (try? c.decodeIfPresent(String.self, forKey: key)).flatMap { $0 }.flatMap { $0.isEmpty ? nil : $0 } }
        url = text(.url)
        account = text(.account)
        env = text(.env)
        token = (try? c.decode(String.self, forKey: .token)) ?? ""
        addedAt = (try? c.decode(Int64.self, forKey: .addedAt)) ?? 0
    }

    /// Where and how it is used, in a line: `github.com · me@x.com`, `env OPENAI_API_KEY`; nil when nothing is said.
    public var whereLine: String? {
        let parts = [url, account, env.map { "env \($0)" }].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// The token cut to what fits a line: its first `limit` characters and `…`.
    public func shortToken(_ limit: Int = 28) -> String {
        token.count > limit ? String(token.prefix(limit)) + "…" : token
    }

    /// What the list says under them.
    public static let addOnMacSays = "在 Mac 上添加：密码由 Mac 的网关当场封成密文，明文不进房间。"
}

/// `GET /rooms/:id/secrets`.
public struct RoomSecrets: Decodable, Sendable, Hashable {
    public let secrets: [RoomSecret]

    private enum CodingKeys: String, CodingKey { case secrets }

    public init(secrets: [RoomSecret]) { self.secrets = secrets }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        secrets = (try? c.decode([RoomSecret].self, forKey: .secrets)) ?? []
    }
}

private struct SecretRemoved: Decodable { let ok: Bool? }

extension AgentSwitchAPI {
    /// The room's secrets: names, what they are for, and their ciphertexts.
    public func roomSecrets(_ room: String) async throws -> [RoomSecret] {
        (try await get(["rooms", room, "secrets"]) as RoomSecrets).secrets
    }

    public func deleteRoomSecret(_ id: String, in room: String) async throws {
        let _: SecretRemoved = try await perform("DELETE", ["rooms", room, "secrets", id], query: [], body: nil)
    }
}

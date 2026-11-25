import Foundation

/// `GET /healthz`. The remote listener answers only `{ok:true}`; the local one adds version and counts.
public struct Health: Codable, Sendable, Hashable {
    public let ok: Bool
    public let version: String?
}

/// `POST /pair` response.
public struct PairResult: Codable, Sendable, Hashable {
    public let deviceId: String
    public let token: String
}

/// `GET /addresses`: where the Mac can be reached now.
public struct MacAddresses: Codable, Sendable, Hashable {
    public let lan: [String]
    public let tailnet: [String]

    public init(lan: [String], tailnet: [String]) {
        self.lan = lan
        self.tailnet = tailnet
    }
}

/// `GET /me`. app-v0 does not fix the shape yet; every field is optional and `id`/`deviceId` both count.
public struct Me: Codable, Sendable, Hashable {
    public let deviceId: String?
    public let name: String?
    public let platform: String?
    public let createdAt: Int64?
    public let lastSeenAt: Int64?

    private enum CodingKeys: String, CodingKey { case deviceId, id, name, platform, createdAt, lastSeenAt }

    public init(deviceId: String?, name: String?, platform: String?, createdAt: Int64?, lastSeenAt: Int64?) {
        self.deviceId = deviceId
        self.name = name
        self.platform = platform
        self.createdAt = createdAt
        self.lastSeenAt = lastSeenAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let direct = try c.decodeIfPresent(String.self, forKey: .deviceId)
        deviceId = try direct ?? c.decodeIfPresent(String.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name)
        platform = try c.decodeIfPresent(String.self, forKey: .platform)
        createdAt = try c.decodeIfPresent(Int64.self, forKey: .createdAt)
        lastSeenAt = try c.decodeIfPresent(Int64.self, forKey: .lastSeenAt)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(deviceId, forKey: .deviceId)
        try c.encodeIfPresent(name, forKey: .name)
        try c.encodeIfPresent(platform, forKey: .platform)
        try c.encodeIfPresent(createdAt, forKey: .createdAt)
        try c.encodeIfPresent(lastSeenAt, forKey: .lastSeenAt)
    }
}

struct PairRequest: Encodable, Sendable {
    let code: String
    let name: String
    let platform: String
}

struct EmptyBody: Encodable, Sendable {}

/// `{ok:true}` replies.
public struct OKReply: Decodable, Sendable { public let ok: Bool? }

struct ErrorReply: Decodable { let error: String }

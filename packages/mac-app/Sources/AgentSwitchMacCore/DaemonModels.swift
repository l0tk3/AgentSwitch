import Foundation

/// The JSON inside the pairing link (app-v0 §2 配对).
public struct PairingPayload: Codable, Equatable, Sendable {
    public struct Gate: Codable, Equatable, Sendable {
        public let publicKey: String
        public let keypair: String
        public init(publicKey: String, keypair: String) {
            self.publicKey = publicKey
            self.keypair = keypair
        }
    }

    public let v: Int
    public let name: String
    public let port: Int
    public let fp: String
    public let code: String
    public let lan: [String]
    public let tailnet: [String]
    public let bonjour: String?
    public let gate: Gate?

    public init(v: Int = 1, name: String, port: Int, fp: String, code: String, lan: [String], tailnet: [String],
                bonjour: String?, gate: Gate?) {
        self.v = v
        self.name = name
        self.port = port
        self.fp = fp
        self.code = code
        self.lan = lan
        self.tailnet = tailnet
        self.bonjour = bonjour
        self.gate = gate
    }
}

/// `POST /pairing` → `{code, expiresAt, link, payload}`.
public struct Pairing: Decodable, Equatable, Sendable {
    public let code: String
    public let expiresAt: Date
    public let link: String
    public let payload: PairingPayload?

    public init(code: String, expiresAt: Date, link: String, payload: PairingPayload?) {
        self.code = code
        self.expiresAt = expiresAt
        self.link = link
        self.payload = payload
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        code = try c.require(String.self, "code")
        link = try c.require(String.self, "link")
        guard let expires = c.date("expiresAt", "expires_at") else {
            throw DecodingError.keyNotFound(AnyKey("expiresAt"), .init(codingPath: c.codingPath, debugDescription: "expiresAt missing"))
        }
        expiresAt = expires
        // The payload is optional for display: the link carries it anyway.
        payload = c.first(PairingPayload.self, "payload") ?? (try? PairingLink.parse(link))
    }
}

/// A row of `GET /devices` (table `devices` in app-v0 §2).
public struct Device: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let platform: String
    public let createdAt: Date?
    public let lastSeenAt: Date?
    public let revokedAt: Date?
    /// Set when the daemon reports presence per device.
    public let online: Bool?
    /// What of this Mac's files it may read (docs/files-v0.md §7.5); nil from a service before the Files column.
    public let files: FileScope?

    public var isRevoked: Bool { revokedAt != nil }

    public init(id: String, name: String, platform: String, createdAt: Date?, lastSeenAt: Date?, revokedAt: Date?,
                online: Bool? = nil, files: FileScope? = nil) {
        self.files = files
        self.id = id
        self.name = name
        self.platform = platform
        self.createdAt = createdAt
        self.lastSeenAt = lastSeenAt
        self.revokedAt = revokedAt
        self.online = online
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        id = try c.require(String.self, "id")
        name = c.first(String.self, "name") ?? "未命名设备"
        platform = c.first(String.self, "platform") ?? ""
        createdAt = c.date("createdAt", "created_at")
        lastSeenAt = c.date("lastSeenAt", "last_seen_at")
        revokedAt = c.date("revokedAt", "revoked_at")
        online = c.first(Bool.self, "online")
        files = c.first(FileScope.self, "files")
    }

    /// `[...]` or `{devices: [...]}`.
    public static func decodeList(_ data: Data) throws -> [Device] {
        let decoder = JSONDecoder()
        if let list = try? decoder.decode([Device].self, from: data) { return list }
        struct Wrapped: Decodable { let devices: [Device] }
        return try decoder.decode(Wrapped.self, from: data).devices
    }
}

/// `GET /remote/info`: port, fingerprint, addresses, Bonjour name, devices online.
public struct RemoteInfo: Decodable, Equatable, Sendable {
    public let enabled: Bool
    public let port: Int?
    public let fingerprint: String?
    public let lan: [String]
    public let tailnet: [String]
    public let bonjour: String?
    public let name: String?
    public let onlineDevices: Int?

    public init(enabled: Bool = true, port: Int?, fingerprint: String?, lan: [String], tailnet: [String],
                bonjour: String?, name: String? = nil, onlineDevices: Int?) {
        self.enabled = enabled
        self.port = port
        self.fingerprint = fingerprint
        self.lan = lan
        self.tailnet = tailnet
        self.bonjour = bonjour
        self.name = name
        self.onlineDevices = onlineDevices
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        enabled = c.first(Bool.self, "enabled", "remote") ?? true
        port = c.first(Int.self, "port")
        fingerprint = c.first(String.self, "fingerprint", "fp")
        lan = c.first([String].self, "lan") ?? []
        tailnet = c.first([String].self, "tailnet", "tailscale") ?? []
        bonjour = c.first(String.self, "bonjour", "bonjourName")
        name = c.first(String.self, "name")
        if let count = c.first(Int.self, "onlineDevices", "online_devices", "devicesOnline", "online") {
            onlineDevices = count
        } else if let list = c.first([String].self, "online") {
            onlineDevices = list.count
        } else {
            onlineDevices = nil
        }
    }
}

public struct Health: Decodable, Equatable, Sendable {
    public let ok: Bool
    public let version: String?

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        ok = c.first(Bool.self, "ok") ?? false
        version = c.first(String.self, "version")
    }
}

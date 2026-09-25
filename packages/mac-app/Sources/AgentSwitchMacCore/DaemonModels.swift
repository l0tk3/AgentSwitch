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

    public var isRevoked: Bool { revokedAt != nil }

    public init(id: String, name: String, platform: String, createdAt: Date?, lastSeenAt: Date?, revokedAt: Date?,
                online: Bool? = nil) {
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

/// `GET /settings/models` → `{router:{model, options}, default:{harness, model}, harnesses:{<name>:{models, default_model}}}`.
public struct ModelSettings: Decodable, Equatable, Sendable {
    public struct Router: Equatable, Sendable {
        public let model: String?
        public let options: [String]
    }

    public struct Target: Equatable, Sendable {
        public let harness: String?
        public let model: String?
    }

    public struct Harness: Equatable, Sendable {
        public let models: [String]
        public let defaultModel: String?
    }

    public let router: Router
    public let defaultTarget: Target
    public let harnesses: [String: Harness]
    /// GET reports the saved selection; true when it differs from what the running daemon uses.
    public let restartPending: Bool

    public init(router: Router, defaultTarget: Target, harnesses: [String: Harness], restartPending: Bool = false) {
        self.router = router
        self.defaultTarget = defaultTarget
        self.harnesses = harnesses
        self.restartPending = restartPending
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        if let r = try? c.nestedContainer(keyedBy: AnyKey.self, forKey: AnyKey("router")) {
            router = Router(model: r.first(String.self, "model"),
                            options: r.first(FlexibleStringList.self, "options", "models")?.values ?? [])
        } else {
            router = Router(model: nil, options: [])
        }
        if let d = try? c.nestedContainer(keyedBy: AnyKey.self, forKey: AnyKey("default")) {
            defaultTarget = Target(harness: d.first(String.self, "harness"), model: d.first(String.self, "model"))
        } else {
            defaultTarget = Target(harness: nil, model: nil)
        }
        var harnesses: [String: Harness] = [:]
        if let h = try? c.nestedContainer(keyedBy: AnyKey.self, forKey: AnyKey("harnesses")) {
            for key in h.allKeys {
                guard let entry = try? h.nestedContainer(keyedBy: AnyKey.self, forKey: key) else { continue }
                harnesses[key.stringValue] = Harness(
                    models: entry.first(FlexibleStringList.self, "models")?.values ?? [],
                    defaultModel: entry.first(String.self, "default_model", "defaultModel"))
            }
        }
        self.harnesses = harnesses
        restartPending = c.first(Bool.self, "restartRequired", "restart_required") ?? false
    }

    public var harnessNames: [String] { harnesses.keys.sorted() }

    public func models(for harness: String?) -> [String] {
        harness.flatMap { harnesses[$0]?.models } ?? []
    }
}

/// `PUT /settings/models {router?:{model}, default?:{harness, model}}`.
public struct ModelSettingsUpdate: Encodable, Equatable, Sendable {
    public struct RouterChange: Encodable, Equatable, Sendable { public let model: String }
    public struct DefaultChange: Encodable, Equatable, Sendable {
        public let harness: String
        public let model: String
    }

    public let router: RouterChange?
    public let `default`: DefaultChange?

    public init(routerModel: String?, defaultHarness: String?, defaultModel: String?) {
        router = routerModel.map { RouterChange(model: $0) }
        if let harness = defaultHarness, let model = defaultModel {
            self.default = DefaultChange(harness: harness, model: model)
        } else {
            self.default = nil
        }
    }

    public var isEmpty: Bool { router == nil && self.default == nil }

    /// Only what differs from `current`, so an untouched field is never rewritten.
    public static func diff(current: ModelSettings, routerModel: String?, defaultHarness: String?,
                            defaultModel: String?) -> ModelSettingsUpdate {
        let routerChanged = routerModel != nil && routerModel != current.router.model
        let targetChanged = defaultHarness != nil && defaultModel != nil
            && (defaultHarness != current.defaultTarget.harness || defaultModel != current.defaultTarget.model)
        return ModelSettingsUpdate(routerModel: routerChanged ? routerModel : nil,
                                   defaultHarness: targetChanged ? defaultHarness : nil,
                                   defaultModel: targetChanged ? defaultModel : nil)
    }
}

public struct ModelSettingsSaveResult: Decodable, Equatable, Sendable {
    public let restartRequired: Bool

    public init(restartRequired: Bool) { self.restartRequired = restartRequired }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        restartRequired = c.first(Bool.self, "restartRequired", "restart_required") ?? false
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

/// A project folder a phone task may name (assistant-v0 §5). `problem`: why it cannot be used now (moved, deleted).
public struct ProjectEntry: Codable, Sendable, Hashable, Identifiable {
    public let name: String
    public let path: String
    public let problem: String?

    public var id: String { name }

    public init(name: String, path: String, problem: String? = nil) {
        self.name = name
        self.path = path
        self.problem = problem
    }

    /// A name for a picked folder: its last component, made unique among `taken` with a number.
    public static func name(for folder: URL, taken: [String]) -> String {
        let base = String(folder.lastPathComponent.prefix(36))
        let used = Set(taken.map { $0.lowercased() })
        guard used.contains(base.lowercased()) else { return base }
        return (2...).lazy.map { "\(base) \($0)" }.first { !used.contains($0.lowercased()) }!
    }
}

struct ProjectList: Codable {
    let projects: [ProjectEntry]
}

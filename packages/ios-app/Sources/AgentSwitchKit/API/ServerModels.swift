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

/// `GET /gate/pubkey`.
public typealias GatePubkey = GateKey

/// quota/types.ts QuotaReading.
public struct QuotaReading: Codable, Sendable, Hashable, Identifiable {
    public let harness: String
    /// Fraction left, 0...1; nil when unknown.
    public let remaining: Double?
    public let detail: JSONValue?
    public let source: String
    public let fetchedAt: Int64
    public let error: String?

    public var id: String { harness }
    public var fetched: Date { Date(milliseconds: fetchedAt) }
}

/// router/targets.ts ModelSpec.
public struct ModelSpec: Codable, Sendable, Hashable {
    public let cost: String
    public let strengths: [String]?
    public let efforts: [String]?
    public let unavailable: Bool?
}

/// router/targets.ts HarnessSpec, the fields the phone shows.
public struct HarnessSpec: Codable, Sendable, Hashable {
    public let quota: String
    public let maxConcurrent: Int
    public let browser: Bool
    public let defaultModel: String
    public let models: [String: ModelSpec]

    private enum CodingKeys: String, CodingKey {
        case quota, browser, models
        case maxConcurrent = "max_concurrent"
        case defaultModel = "default_model"
    }
}

public struct RouterSpec: Codable, Sendable, Hashable {
    public let harness: String
    public let model: String
    public let defaultTarget: TargetRef?
    public let planner: TargetRef?

    private enum CodingKeys: String, CodingKey {
        case harness, model, planner
        case defaultTarget = "default"
    }
}

/// `GET /targets`: the catalog plus `quota` (harness → fraction left).
public struct Targets: Codable, Sendable, Hashable {
    public let harnesses: [String: HarnessSpec]
    public let router: RouterSpec?
    public let quota: [String: Double]?

    /// What a task can be pinned to: every listed model not marked unavailable, sorted by harness then model.
    public var pinOptions: [TargetRef] {
        harnesses.keys.sorted().flatMap { name -> [TargetRef] in
            let spec = harnesses[name]!
            return spec.models.keys.sorted().filter { spec.models[$0]?.unavailable != true }.map { TargetRef(harness: name, model: $0) }
        }
    }
}

/// threads/types.ts Thread plus the folded fields `GET /threads` adds.
public struct AgentThread: Codable, Sendable, Hashable, Identifiable {
    public let id: String
    public let createdAt: Int64
    public let updatedAt: Int64
    public let title: String?
    public let cwd: String?
    public let status: String
    public let expiresAt: Int64?
    public let lastTarget: TargetRef?
    public let lastActivity: Int64?
    public let taskCount: Int?
    public let handoffs: Int?
}

/// The summarizer's view of a thread (threads-v0 §3), the part the phone shows.
public struct ThreadSummary: Decodable, Sendable, Hashable {
    public let title: String?
    public let goal: String?
    public let progress: String?
}

/// `GET /threads/:id`: the thread, its latest summary and its tasks.
public struct ThreadDetail: Decodable, Sendable, Hashable {
    public let thread: AgentThread
    public let summary: ThreadSummary?
    public let tasks: [AgentTask]

    private enum CodingKeys: String, CodingKey { case tasks, summary }

    public init(from decoder: Decoder) throws {
        thread = try AgentThread(from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        summary = try? c.decodeIfPresent(ThreadSummary.self, forKey: .summary)
        tasks = try c.decodeIfPresent([AgentTask].self, forKey: .tasks) ?? []
    }
}

// MARK: - request bodies (the daemon takes snake_case in bodies)

public struct NewTaskRequest: Encodable, Sendable {
    public let task: String
    public let pin: TargetRef?
    public let threadId: String?
    public let parentId: String?
    /// Ids from `POST /uploads`; the files land in the task's `in/`.
    public let attachments: [String]?

    public init(task: String, pin: TargetRef? = nil, threadId: String? = nil, parentId: String? = nil, attachments: [String]? = nil) {
        self.task = task
        self.pin = pin
        self.threadId = threadId
        self.parentId = parentId
        self.attachments = attachments?.isEmpty == true ? nil : attachments
    }

    private enum CodingKeys: String, CodingKey {
        case task, pin, attachments
        case threadId = "thread_id"
        case parentId = "parent_id"
    }
}

public enum ApprovalDecision: String, Codable, Sendable { case allow, deny }

struct ApproveRequest: Encodable, Sendable {
    let approvalId: String
    let decision: ApprovalDecision
    private enum CodingKeys: String, CodingKey { case approvalId = "approval_id", decision }
}

struct AnswerRequest: Encodable, Sendable {
    let approvalId: String
    let answers: [String: [String]]
    private enum CodingKeys: String, CodingKey { case approvalId = "approval_id", answers }
}

struct HandoffRequest: Encodable, Sendable {
    let to: TargetRef?
}

struct PairRequest: Encodable, Sendable {
    let code: String
    let name: String
    let platform: String
}

struct EmptyBody: Encodable, Sendable {}

struct SaveContextRequest: Encodable, Sendable {
    let text: String
}

/// `GET /context`: the Mac's CONTEXT.md after the daemon's lint (credential-looking plaintext entries removed).
public struct ContextDocument: Decodable, Sendable, Hashable {
    public let path: String?
    public let text: String
    public let warnings: [String]

    public init(path: String?, text: String, warnings: [String]) {
        self.path = path
        self.text = text
        self.warnings = warnings
    }
}

/// One credential the Mac's sealer found in a CONTEXT.md save and replaced with a token (never the value).
public struct SealedField: Decodable, Sendable, Hashable {
    public let label: String
    public let field: String
    public let hosts: [String]
}

/// `PUT /context`: the lint's warnings and what was sealed.
public struct ContextSaveResult: Decodable, Sendable, Hashable {
    public let warnings: [String]
    public let sealed: [SealedField]

    private enum CodingKeys: String, CodingKey { case warnings, sealed }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        warnings = try c.decodeIfPresent([String].self, forKey: .warnings) ?? []
        sealed = try c.decodeIfPresent([SealedField].self, forKey: .sealed) ?? []
    }
}

/// `GET /context/example`.
struct ContextExample: Decodable, Sendable { let text: String }

/// `{ok:true}` replies.
public struct OKReply: Decodable, Sendable { public let ok: Bool? }

struct ErrorReply: Decodable { let error: String }

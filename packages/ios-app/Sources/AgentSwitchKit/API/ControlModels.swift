import Foundation

/// The permission mode (control-v0 §1, daemon engine/approvalPolicy.ts). The phone only shows it: it is changed on the
/// Mac. A mode added later decodes as `.other` instead of failing the settings page.
public enum PermissionMode: Sendable, Hashable, Codable {
    case manual, scoped, auto, skip
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "manual": self = .manual
        case "scoped": self = .scoped
        case "auto": self = .auto
        case "skip": self = .skip
        default: self = .other(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .manual: return "manual"
        case .scoped: return "scoped"
        case .auto: return "auto"
        case .skip: return "skip"
        case .other(let s): return s
        }
    }

    public init(from decoder: Decoder) throws { self.init(rawValue: try decoder.singleValueContainer().decode(String.self)) }
    public func encode(to encoder: Encoder) throws { var c = encoder.singleValueContainer(); try c.encode(rawValue) }

    /// The words of the Mac's picker (control-v0 §1).
    public var label: String {
        switch self {
        case .manual: return "ask each"
        case .scoped: return "auto"
        case .auto: return "all auto"
        case .skip: return "bypass"
        case .other(let s): return s
        }
    }

    /// What the mode means for you, one sentence without the full stop (the settings footer adds where to change it).
    public var explanation: String {
        switch self {
        case .manual: return "执行器的每项操作均需你确认"
        case .scoped: return "由调度模型代为审批，删除、推送、付款仍需你确认"
        case .auto: return "由调度模型代为处理所有审批"
        case .skip: return "审批自动通过；受保护的目录仍禁止访问，提问仍需你回答"
        case .other: return "此 Mac 使用了当前版本无法识别的权限模式"
        }
    }
}

/// daemon engine/approvalPolicy.ts ApprovalPolicy, as `GET /approvals/policy` returns it.
public struct ApprovalPolicy: Decodable, Sendable, Hashable {
    public let mode: PermissionMode
    /// Categories that stay with you in `scoped` mode.
    public let human: [String]

    public init(mode: PermissionMode, human: [String] = []) {
        self.mode = mode
        self.human = human
    }

    private enum CodingKeys: String, CodingKey { case mode, human }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        mode = try c.decodeIfPresent(PermissionMode.self, forKey: .mode) ?? .scoped
        human = (try? c.decodeIfPresent([String].self, forKey: .human)) ?? []
    }
}

public struct PolicyCategory: Decodable, Sendable, Hashable, Identifiable {
    public let id: String
    public let title: String
}

/// `GET /approvals/policy`.
public struct ApprovalPolicyInfo: Decodable, Sendable, Hashable {
    public let policy: ApprovalPolicy
    public let categories: [PolicyCategory]

    public init(policy: ApprovalPolicy, categories: [PolicyCategory] = []) {
        self.policy = policy
        self.categories = categories
    }

    private enum CodingKeys: String, CodingKey { case policy, categories }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        policy = try c.decode(ApprovalPolicy.self, forKey: .policy)
        categories = (try? c.decodeIfPresent([PolicyCategory].self, forKey: .categories)) ?? []
    }

    /// The categories kept for you, by title (scoped mode's "删除、推送…").
    public var humanTitles: [String] {
        policy.human.map { id in categories.first { $0.id == id }?.title ?? id }
    }
}

/// `GET /settings/workdir` (control-v0 §2): where a task without a folder works. `default` is read either way the
/// daemon may send it: the default path, or whether `path` is the default.
public struct WorkdirSetting: Decodable, Sendable, Hashable {
    public let path: String
    public let defaultPath: String?
    public let isDefault: Bool
    /// Why the folder cannot be used right now (missing, not writable…); nil when it can.
    public let problem: String?

    public init(path: String, defaultPath: String? = nil, isDefault: Bool = false, problem: String? = nil) {
        self.path = path
        self.defaultPath = defaultPath
        self.isDefault = isDefault || defaultPath == path
        self.problem = problem
    }

    private enum CodingKeys: String, CodingKey { case path, `default`, problem }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let path = try c.decode(String.self, forKey: .path)
        let fallback = try? c.decodeIfPresent(JSONValue.self, forKey: .default)
        let problem = (try? c.decodeIfPresent(String.self, forKey: .problem)).flatMap { $0.isEmpty ? nil : $0 }
        self.init(path: path, defaultPath: fallback?.string, isDefault: fallback?.bool ?? false, problem: problem)
    }
}

/// One hit of `GET /search` (control-v0 §4); `snippet` marks the matches with ⟦ and ⟧.
public struct SearchResult: Decodable, Sendable, Hashable, Identifiable {
    public let taskId: String
    public let title: String
    public let snippet: String
    public let status: TaskStatus
    public let updatedAt: Int64

    public init(taskId: String, title: String, snippet: String, status: TaskStatus, updatedAt: Int64) {
        self.taskId = taskId
        self.title = title
        self.snippet = snippet
        self.status = status
        self.updatedAt = updatedAt
    }

    public var id: String { taskId }
    public var updated: Date { Date(milliseconds: updatedAt) }

    private enum CodingKeys: String, CodingKey { case taskId, title, snippet, status, updatedAt }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        taskId = try c.decode(String.self, forKey: .taskId)
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? ""
        snippet = (try? c.decodeIfPresent(String.self, forKey: .snippet)) ?? ""
        status = (try? c.decodeIfPresent(TaskStatus.self, forKey: .status)) ?? .other("")
        updatedAt = (try? c.decodeIfPresent(Int64.self, forKey: .updatedAt)) ?? 0
    }
}

struct SearchResults: Decodable { let results: [SearchResult] }

/// `POST /tasks/:id/ack`: whatever the daemon answers, the time it recorded if it says (top level or in `task`).
struct AckReply: Decodable {
    let acknowledgedAt: Int64?

    private enum CodingKeys: String, CodingKey { case acknowledgedAt, task }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let top = try? c.decodeIfPresent(Int64.self, forKey: .acknowledgedAt)
        let nested = (try? c.decodeIfPresent(JSONValue.self, forKey: .task))?["acknowledgedAt"]?.number.map { Int64($0) }
        acknowledgedAt = top ?? nested
    }
}

import Foundation

/// One model on one harness (daemon core/target.ts).
public struct TargetRef: Codable, Sendable, Hashable {
    public let harness: String
    public let model: String

    public init(harness: String, model: String) {
        self.harness = harness
        self.model = model
    }

    public var label: String { "\(harness)/\(model)" }
}

/// engine/types.ts TaskStatus; anything newer decodes as `.other` instead of failing the whole list.
public enum TaskStatus: Sendable, Hashable, Codable {
    case queued, routing, running, waitingApproval, done, partial, blocked, failed, cancelled
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "queued": self = .queued
        case "routing": self = .routing
        case "running": self = .running
        case "waiting_approval": self = .waitingApproval
        case "done": self = .done
        case "partial": self = .partial
        case "blocked": self = .blocked
        case "failed": self = .failed
        case "cancelled": self = .cancelled
        default: self = .other(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .queued: return "queued"
        case .routing: return "routing"
        case .running: return "running"
        case .waitingApproval: return "waiting_approval"
        case .done: return "done"
        case .partial: return "partial"
        case .blocked: return "blocked"
        case .failed: return "failed"
        case .cancelled: return "cancelled"
        case .other(let s): return s
        }
    }

    public init(from decoder: Decoder) throws { self.init(rawValue: try decoder.singleValueContainer().decode(String.self)) }
    public func encode(to encoder: Encoder) throws { var c = encoder.singleValueContainer(); try c.encode(rawValue) }

    /// engine/types.ts TERMINAL.
    public var isTerminal: Bool { [.done, .partial, .blocked, .failed, .cancelled].contains(self) }
    public var isActive: Bool { [.queued, .routing, .running, .waitingApproval].contains(self) }

    public var label: String {
        switch self {
        case .queued: return "排队中"
        case .routing: return "分诊中"
        case .running: return "执行中"
        case .waitingApproval: return "等待答复"
        case .done: return "已完成"
        case .partial: return "部分完成"
        case .blocked: return "执行受阻"
        case .failed: return "失败"
        case .cancelled: return "已取消"
        case .other(let s): return s
        }
    }
}

public struct Attachment: Codable, Sendable, Hashable {
    public let name: String
    public let path: String
    public let size: Int64
    public let type: String
}

/// One failed execution attempt (router/reroute.ts Attempt), the part the phone shows.
public struct Attempt: Codable, Sendable, Hashable {
    public let harness: String
    public let model: String
    public let kind: String
    public let excerpt: String
}

/// engine/types.ts Task. Named AgentTask so it never shadows Swift's `Task`.
public struct AgentTask: Codable, Sendable, Hashable, Identifiable {
    public let id: String
    public let createdAt: Int64
    public let updatedAt: Int64
    public let status: TaskStatus
    public let task: String
    public let cwd: String?
    public let pin: TargetRef?
    public let ephemeral: Bool?
    public let parentId: String?
    public let attachments: [Attachment]?
    public let threadId: String?
    public let harness: String?
    public let model: String?
    public let effort: String?
    public let brief: String?
    public let attempts: [Attempt]?
    public let result: String?
    public let error: String?
    public let rating: Int?
    public let spoken: String?
    /// The result retold for listening (threads-v0 §3), for 朗读.
    public let speech: String?
    public let blockCause: String?

    public var created: Date { Date(milliseconds: createdAt) }
    public var updated: Date { Date(milliseconds: updatedAt) }

    /// Where it ran (or is pinned to run), `harness/model`.
    public var targetLabel: String? {
        if let harness { return model.map { "\(harness)/\($0)" } ?? harness }
        return pin?.label
    }

    /// A blocked task's label comes from the structured `blockCause` (same table as the web UI).
    public var statusLabel: String {
        guard status == .blocked else { return status.label }
        switch blockCause {
        case "question": return "待补充条件"
        case "planner_timeout": return "规划超时"
        case "planner_error": return "规划失败"
        default: return status.label
        }
    }
}

/// `GET /tasks/:id`: the task plus its pending approvals and questions.
public struct TaskDetail: Decodable, Sendable, Hashable {
    public let task: AgentTask
    public let approvals: [Approval]

    public init(task: AgentTask, approvals: [Approval]) {
        self.task = task
        self.approvals = approvals
    }

    private enum CodingKeys: String, CodingKey { case approvals }

    public init(from decoder: Decoder) throws {
        task = try AgentTask(from: decoder)
        approvals = try decoder.container(keyedBy: CodingKeys.self).decodeIfPresent([Approval].self, forKey: .approvals) ?? []
    }
}

/// engine/types.ts TaskEvent. `type` stays a string: the daemon adds event types faster than a phone app ships.
public struct TaskEvent: Codable, Sendable, Hashable, Identifiable {
    public let taskId: String
    public let seq: Int64
    public let ts: Int64
    public let type: String
    public let payload: JSONValue

    public init(taskId: String, seq: Int64, ts: Int64, type: String, payload: JSONValue) {
        self.taskId = taskId
        self.seq = seq
        self.ts = ts
        self.type = type
        self.payload = payload
    }

    public var id: String { "\(taskId)#\(seq)" }
    public var date: Date { Date(milliseconds: ts) }

    /// The daemon closes the event stream after one of these (TERMINAL in engine/types.ts).
    public var endsStream: Bool { TaskStatus(rawValue: type).isTerminal }

    /// Events after which the pending approvals of the task may have changed.
    public var touchesApprovals: Bool { type == "approval_request" || type == "approval_resolved" || endsStream }
}

extension Date {
    init(milliseconds: Int64) { self.init(timeIntervalSince1970: TimeInterval(milliseconds) / 1000) }
}

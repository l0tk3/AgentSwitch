import Foundation

// Tasks as the daemon sends them (engine/types.ts), ported from the iPhone Kit (API/TaskModels.swift) for the Dispatch
// page (docs/dispatch-v0.md §2). Decoding is tolerant: a field the daemon adds or drops never fails a whole list.

/// One model on one harness (daemon core/target.ts): a pin, where a task ran, a handoff's target.
public struct DispatchTarget: Codable, Sendable, Hashable {
    public let harness: String
    public let model: String

    public init(harness: String, model: String) {
        self.harness = harness
        self.model = model
    }

    /// `harness/model`, as the daemon and the web console write it.
    public var label: String { "\(harness)/\(model)" }
    /// The model as people say it (Opus 5.5): a `Pin Model` menu item.
    public var modelName: String { ModelName.display(model) }
    /// "Opus 5.5 · Claude Code": a choice of model where the harness matters too (Hand to ▾).
    public var displayName: String { "\(modelName) · \(HarnessName.display(harness))" }
}

/// engine/types.ts TaskStatus; anything newer decodes as `.other` instead of failing the whole list.
public enum DispatchTaskStatus: Sendable, Hashable, Codable {
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

    /// engine/types.ts TERMINAL: the event stream closes after one of these.
    public var isTerminal: Bool { [.done, .partial, .blocked, .failed, .cancelled].contains(self) }
    public var isActive: Bool { [.queued, .routing, .running, .waitingApproval].contains(self) }

    /// The fixed status words on screen, one meaning each (docs/ui-v0.md §7.2.7).
    public var label: String {
        switch self {
        case .queued: return "Queued"
        case .routing, .running: return "Busy"
        case .waitingApproval: return "Waiting"
        case .done: return "Done"
        case .partial, .blocked: return "Incomplete"
        case .failed: return "Failed"
        case .cancelled: return "Cancelled"
        case .other(let s): return s
        }
    }

    /// The same, said aloud in Chinese (read-aloud, the Live Activity).
    public var spokenLabel: String {
        switch self {
        case .queued: return "排队"
        case .routing, .running: return "进行中"
        case .waitingApproval: return "等你处理"
        case .done: return "已完成"
        case .partial, .blocked: return "未完成"
        case .failed: return "失败"
        case .cancelled: return "已取消"
        case .other(let s): return s
        }
    }

    /// The mark and colour on the Mac (`StatusMark(level:)`): spinner while busy, amber while waiting or incomplete,
    /// green when done, red when failed, hollow when queued or cancelled (the phone's Theme.color).
    public var level: StatusLevel {
        switch self {
        case .routing, .running: return .busy
        case .waitingApproval, .partial, .blocked: return .warning
        case .done: return .ok
        case .failed: return .error
        case .queued, .cancelled, .other: return .off
        }
    }
}

/// A file the user sent with a task, moved into its `in/` (files/uploads.ts Attachment).
public struct DispatchAttachment: Decodable, Sendable, Hashable {
    public let name: String
    public let path: String
    public let size: Int64
    public let type: String

    public init(name: String, path: String, size: Int64, type: String) {
        self.name = name
        self.path = path
        self.size = size
        self.type = type
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        path = try c.require(String.self, "path")
        name = c.first(String.self, "name") ?? (path.split(separator: "/").last.map(String.init) ?? path)
        size = c.first(Int64.self, "size") ?? 0
        type = c.first(String.self, "type") ?? ""
    }
}

/// One failed execution attempt (router/reroute.ts Attempt), the part the page shows.
public struct DispatchAttempt: Decodable, Sendable, Hashable {
    public let harness: String
    public let model: String
    public let kind: String
    public let excerpt: String

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        harness = c.first(String.self, "harness") ?? ""
        model = c.first(String.self, "model") ?? ""
        kind = c.first(String.self, "kind") ?? ""
        excerpt = c.first(String.self, "excerpt") ?? ""
    }
}

/// engine/types.ts Task (the iPhone's AgentTask).
public struct DispatchTask: Decodable, Sendable, Hashable, Identifiable {
    public let id: String
    public let createdAt: Int64
    public let updatedAt: Int64
    public let status: DispatchTaskStatus
    /// What was asked, sealed (ciphertexts, maybe the sealer's legend): show it through DispatchMessageDisplay.
    public let task: String
    public let cwd: String?
    public let pin: DispatchTarget?
    public let needsBrowser: Bool
    /// A throw-away folder, deleted when the task ends.
    public let ephemeral: Bool
    public let parentId: String?
    public let attachments: [DispatchAttachment]
    public let threadId: String?
    /// The executor it was handed over from (threads-v0 §4).
    public let handoffFrom: DispatchTarget?
    /// The task's own approval mode (`approvalPolicy.mode`); nil: the Mac's.
    public let approvalMode: String?
    public let harness: String?
    public let model: String?
    public let effort: String?
    public let brief: String?
    public let attempts: [DispatchAttempt]
    public let result: String?
    public let error: String?
    /// 1 (useful), -1 (not useful), nil.
    public let rating: Int?
    /// The summarizer's one sentence on the outcome.
    public let spoken: String?
    /// The result retold for listening (threads-v0 §3).
    public let speech: String?
    /// `question` (waits for your answer), `interrupted` (the service restarted mid-run, control-v0 §4), …
    public let blockCause: String?
    /// When it was last opened (control-v0 §4, ms); older than `updatedAt` or missing means unread once ended.
    public let acknowledgedAt: Int64?

    public init(id: String, createdAt: Int64, updatedAt: Int64, status: DispatchTaskStatus, task: String, cwd: String? = nil,
                pin: DispatchTarget? = nil, needsBrowser: Bool = false, ephemeral: Bool = false, parentId: String? = nil,
                attachments: [DispatchAttachment] = [], threadId: String? = nil, handoffFrom: DispatchTarget? = nil,
                approvalMode: String? = nil, harness: String? = nil, model: String? = nil, effort: String? = nil,
                brief: String? = nil, attempts: [DispatchAttempt] = [], result: String? = nil, error: String? = nil,
                rating: Int? = nil, spoken: String? = nil, speech: String? = nil, blockCause: String? = nil,
                acknowledgedAt: Int64? = nil) {
        self.id = id
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.status = status
        self.task = task
        self.cwd = cwd
        self.pin = pin
        self.needsBrowser = needsBrowser
        self.ephemeral = ephemeral
        self.parentId = parentId
        self.attachments = attachments
        self.threadId = threadId
        self.handoffFrom = handoffFrom
        self.approvalMode = approvalMode
        self.harness = harness
        self.model = model
        self.effort = effort
        self.brief = brief
        self.attempts = attempts
        self.result = result
        self.error = error
        self.rating = rating
        self.spoken = spoken
        self.speech = speech
        self.blockCause = blockCause
        self.acknowledgedAt = acknowledgedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        let policy = c.first(DispatchJSON.self, "approvalPolicy")
        self.init(id: try c.require(String.self, "id"), createdAt: c.first(Int64.self, "createdAt") ?? 0,
                  updatedAt: c.first(Int64.self, "updatedAt") ?? c.first(Int64.self, "createdAt") ?? 0,
                  status: c.first(DispatchTaskStatus.self, "status") ?? .other(""), task: c.first(String.self, "task") ?? "",
                  cwd: c.first(String.self, "cwd"), pin: c.first(DispatchTarget.self, "pin"),
                  needsBrowser: c.first(Bool.self, "needsBrowser") ?? false, ephemeral: c.first(Bool.self, "ephemeral") ?? false,
                  parentId: c.first(String.self, "parentId"), attachments: c.first([DispatchAttachment].self, "attachments") ?? [],
                  threadId: c.first(String.self, "threadId"), handoffFrom: c.first(DispatchTarget.self, "handoffFrom"),
                  approvalMode: policy?["mode"]?.string, harness: c.first(String.self, "harness"), model: c.first(String.self, "model"),
                  effort: c.first(String.self, "effort"), brief: c.first(String.self, "brief"),
                  attempts: c.first([DispatchAttempt].self, "attempts") ?? [], result: c.first(String.self, "result"),
                  error: c.first(String.self, "error"), rating: c.first(Int.self, "rating"), spoken: c.first(String.self, "spoken"),
                  speech: c.first(String.self, "speech"), blockCause: c.first(String.self, "blockCause"),
                  acknowledgedAt: c.first(Int64.self, "acknowledgedAt"))
    }

    public var created: Date { Date(dispatchMilliseconds: createdAt) }
    public var updated: Date { Date(dispatchMilliseconds: updatedAt) }

    /// Where it ran (or is pinned to run), `harness/model`.
    public var targetLabel: String? {
        if let harness { return model.map { "\(harness)/\($0)" } ?? harness }
        return pin?.label
    }

    /// What an interrupted task says when the daemon gives no reason of its own (task page and process line).
    public static let interruptedText = "服务重启时任务仍在进行，执行进度无法确认。"

    /// The status word; a blocked task that waits for an answer says so (its `blockCause`).
    public var statusLabel: String {
        status == .blocked && blockCause == "question" ? DispatchTaskStatus.waitingApproval.label : status.label
    }

    public var spokenStatus: String {
        status == .blocked && blockCause == "question" ? DispatchTaskStatus.waitingApproval.spokenLabel : status.spokenLabel
    }

    /// The model at work, as people say it (Opus 5.5), else the executor, else the pinned model, else nil.
    public var modelName: String? {
        if let model { return ModelName.display(model) }
        return harness.map(HarnessName.display) ?? pin.map { ModelName.display($0.model) }
    }

    /// The status line's "who" (docs/design/implemented/mac-window.html): `Claude Code · Opus 5.5`; a pinned task that has
    /// not run yet names its pin; nil while the router has not chosen.
    public var who: String? {
        if let harness {
            return [HarnessName.display(harness), model.map(ModelName.display)].compactMap { $0 }.joined(separator: " · ")
        }
        return pin.map { "\(HarnessName.display($0.harness)) · \($0.modelName)" }
    }

    /// Ended and not opened since (control-v0 §4): `acknowledgedAt` older than the last change, or missing.
    public var isUnread: Bool { status.isTerminal && (acknowledgedAt ?? 0) < updatedAt }

    /// Stopped by a restart of the Mac's service mid-run (control-v0 §4); its `error` says so, and it can be handed on.
    public var isInterrupted: Bool { status == .blocked && blockCause == "interrupted" }

    /// Waiting for an answer or an approval from you, as far as the task itself says.
    public var waitsForYou: Bool { status == .waitingApproval || (status == .blocked && blockCause == "question") }

    /// The `// Task` block's Approval value: the task's own mode by its title, else Default.
    public var approvalModeTitle: String {
        guard let approvalMode else { return "Default" }
        return ApprovalMode(rawValue: approvalMode)?.title ?? approvalMode
    }

    /// The same task, read at `ms` (the local copy after opening it, before the Mac's list says so).
    public func acknowledged(at ms: Int64) -> DispatchTask {
        DispatchTask(id: id, createdAt: createdAt, updatedAt: updatedAt, status: status, task: task, cwd: cwd, pin: pin,
                     needsBrowser: needsBrowser, ephemeral: ephemeral, parentId: parentId, attachments: attachments,
                     threadId: threadId, handoffFrom: handoffFrom, approvalMode: approvalMode, harness: harness, model: model,
                     effort: effort, brief: brief, attempts: attempts, result: result, error: error, rating: rating,
                     spoken: spoken, speech: speech, blockCause: blockCause, acknowledgedAt: ms)
    }

    /// Tasks of `before` that `after` (the newest `limit`) no longer has although they would still be in it: deleted,
    /// here or elsewhere (the conversation lines about them went too, threads-v0 手动删除). One older than all of a full
    /// list only fell off its end.
    public static func deleted(from before: [DispatchTask], in after: [DispatchTask], limit: Int) -> [String] {
        let kept = Set(after.map(\.id))
        let oldest = after.count < limit ? Int64.min : after.map(\.createdAt).min() ?? Int64.min
        return before.filter { !kept.contains($0.id) && $0.createdAt >= oldest }.map(\.id)
    }
}

/// `GET /tasks/:id`: the task plus its pending approvals and questions.
public struct DispatchTaskDetail: Decodable, Sendable, Hashable {
    public let task: DispatchTask
    public let approvals: [DispatchApproval]

    public init(task: DispatchTask, approvals: [DispatchApproval]) {
        self.task = task
        self.approvals = approvals
    }

    public init(from decoder: Decoder) throws {
        task = try DispatchTask(from: decoder)
        approvals = try decoder.container(keyedBy: AnyKey.self).first([DispatchApproval].self, "approvals") ?? []
    }

    /// The approvals and questions still open.
    public var pending: [DispatchApproval] { approvals.filter { $0.status == .pending } }
}

/// engine/types.ts TaskEvent. `type` stays a string: the daemon adds event types faster than the app ships.
public struct DispatchTaskEvent: Codable, Sendable, Hashable, Identifiable {
    public let taskId: String
    public let seq: Int64
    public let ts: Int64
    public let type: String
    public let payload: DispatchJSON

    public init(taskId: String, seq: Int64, ts: Int64, type: String, payload: DispatchJSON = .object([:])) {
        self.taskId = taskId
        self.seq = seq
        self.ts = ts
        self.type = type
        self.payload = payload
    }

    public var id: String { "\(taskId)#\(seq)" }
    public var date: Date { Date(dispatchMilliseconds: ts) }

    /// The daemon closes the event stream after one of these (TERMINAL in engine/types.ts).
    public var endsStream: Bool { DispatchTaskStatus(rawValue: type).isTerminal }

    /// Events after which the task's pending approvals may have changed.
    public var touchesApprovals: Bool { type == "approval_request" || type == "approval_resolved" || endsStream }

    /// Events after which the task itself (status, executor, result) may have changed: reload it.
    public var touchesTask: Bool { endsStream || touchesApprovals || ["dispatched", "routed", "redispatch", "handoff", "summary", "thread"].contains(type) }
}

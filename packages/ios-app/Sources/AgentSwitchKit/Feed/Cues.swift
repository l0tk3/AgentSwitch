import Foundation

/// The moments the phone gives a sound, a tap and (in voice mode) a spoken line (assistant-v0 §3).
public enum Cue: String, Sendable, Equatable, CaseIterable {
    case sent, accepted, needsYou, done, failed
}

public struct TaskCue: Equatable, Sendable {
    public let taskId: String
    public let cue: Cue

    public init(taskId: String, cue: Cue) {
        self.taskId = taskId
        self.cue = cue
    }
}

/// Finds the cues by comparing what the phone saw last with what it sees now. The first look only sets the baseline, a
/// task first seen already over is not news, and a cancellation is the user's own doing.
public struct CueTracker: Sendable {
    private var statuses: [String: TaskStatus]?
    private var approvalIds: Set<String>?
    /// Tasks that ended while the phone was watching, waiting for their spoken script (read once).
    private var awaitingScript: Set<String> = []

    public init() {}

    public mutating func taskCues(_ tasks: [AgentTask]) -> [TaskCue] {
        let before = statuses
        statuses = (before ?? [:]).merging(tasks.map { ($0.id, $0.status) }) { _, new in new }
        guard let before else { return [] }
        return tasks.compactMap { task in
            guard let old = before[task.id], old.isActive, task.status.isTerminal else { return nil }
            switch task.status {
            case .done:
                awaitingScript.insert(task.id)
                return TaskCue(taskId: task.id, cue: .done)
            case .cancelled:
                return nil
            default:
                awaitingScript.insert(task.id)
                return TaskCue(taskId: task.id, cue: .failed)
            }
        }
    }

    /// Pending approvals and questions not seen before (none on the first look).
    public mutating func newApprovals(_ approvals: [Approval]) -> [Approval] {
        let pending = approvals.filter { $0.status == .pending }
        defer { approvalIds = (approvalIds ?? []).union(pending.map(\.id)) }
        guard let seen = approvalIds else { return [] }
        return pending.filter { !seen.contains($0.id) }
    }

    /// Tasks that ended while watched and whose spoken script (or one-line summary) has now arrived.
    public mutating func newScripts(_ tasks: [AgentTask]) -> [AgentTask] {
        let ready = tasks.filter { awaitingScript.contains($0.id) && ($0.speech?.isEmpty == false || $0.spoken?.isEmpty == false) }
        awaitingScript.subtract(ready.map(\.id))
        return ready
    }
}

/// One colour per thread, the same everywhere (log label, strip, thread page).
public enum ThreadStyle {
    /// A hue in 0..<1 from the thread id (FNV-1a, stable across launches, unlike Swift's hashValue).
    public static func hue(for threadId: String) -> Double {
        var hash: UInt64 = 0xcbf29ce484222325
        for byte in threadId.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x100000001b3
        }
        return Double(hash % 360) / 360
    }
}

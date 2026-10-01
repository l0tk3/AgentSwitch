import Foundation

extension AgentTask {
    /// Ended and not opened on the phone since (control-v0 §4): the daemon's `acknowledgedAt` is older than the last
    /// change, or missing.
    public var isUnread: Bool {
        status.isTerminal && (acknowledgedAt ?? 0) < updatedAt
    }

    /// Stopped by a restart of the Mac's service mid-run (control-v0 §4); its `error` says so, and it can be handed on.
    public var isInterrupted: Bool {
        status == .blocked && blockCause == "interrupted"
    }

    /// Waiting for an answer or an approval from you, as far as the task itself says.
    public var waitsForYou: Bool {
        status == .waitingApproval || (status == .blocked && blockCause == "question")
    }

    /// Tasks of `before` that `after` (the newest `limit`) no longer has although they would still be in it: deleted,
    /// here or elsewhere — the conversation lines about them went too (threads-v0 手动删除). One older than all of a full
    /// list only fell off its end.
    public static func deleted(from before: [AgentTask], in after: [AgentTask], limit: Int) -> [String] {
        let kept = Set(after.map(\.id))
        let oldest = after.count < limit ? Int64.min : after.map(\.createdAt).min() ?? Int64.min
        return before.filter { !kept.contains($0.id) && $0.createdAt >= oldest }.map(\.id)
    }

    /// The same task, read at `ms` (the local copy after opening it, before the Mac's list says so).
    public func acknowledged(at ms: Int64) -> AgentTask {
        AgentTask(id: id, createdAt: createdAt, updatedAt: updatedAt, status: status, task: task, cwd: cwd, pin: pin,
                  ephemeral: ephemeral, parentId: parentId, attachments: attachments, threadId: threadId, harness: harness,
                  model: model, effort: effort, brief: brief, attempts: attempts, result: result, error: error,
                  rating: rating, spoken: spoken, speech: speech, blockCause: blockCause, acknowledgedAt: ms)
    }
}

/// "Who needs you" first (control-v0 §5): waiting for you → ended and unread → in progress → the rest. Lists and the
/// strip use it; the conversation itself stays in time order.
public enum Attention {
    public enum Rank: Int, Sendable, Comparable {
        case needsYou = 0, unread, inProgress, rest

        public static func < (a: Rank, b: Rank) -> Bool { a.rawValue < b.rawValue }
    }

    /// `pending`: the tasks with an open approval or question. `readMarks` false (a Mac that keeps none): nothing is
    /// unread.
    public static func rank(_ task: AgentTask, pending: Set<String> = [], readMarks: Bool = true) -> Rank {
        if task.waitsForYou || (task.status.isActive && pending.contains(task.id)) { return .needsYou }
        if readMarks && task.isUnread { return .unread }
        if task.status.isActive { return .inProgress }
        return .rest
    }

    /// By rank, then the latest change first; ties keep a stable order by id.
    public static func sorted(_ tasks: [AgentTask], pending: Set<String> = [], readMarks: Bool = true) -> [AgentTask] {
        tasks.sorted { a, b in
            let (ra, rb) = (rank(a, pending: pending, readMarks: readMarks), rank(b, pending: pending, readMarks: readMarks))
            if ra != rb { return ra < rb }
            if a.updatedAt != b.updatedAt { return a.updatedAt > b.updatedAt }
            return a.id < b.id
        }
    }
}

/// A running task that has said nothing for a while (control-v0 §5): the status word stays, a second line says how
/// long. Only 进行中 counts: a queued task waits its turn and a question waits for you.
public enum Staleness {
    public static let threshold: TimeInterval = 10 * 60

    /// Whole minutes since the latest event (else the task's last change), when that is at least the threshold.
    public static func minutes(_ task: AgentTask, lastEventAt: Int64?, now: Date = Date(), waiting: Bool = false) -> Int? {
        guard task.status == .running || task.status == .routing, !waiting else { return nil }
        let last = max(lastEventAt ?? 0, task.updatedAt)
        let quiet = now.timeIntervalSince(Date(milliseconds: last))
        guard quiet >= threshold else { return nil }
        return Int(quiet / 60)
    }

    /// `Quiet 14m` / `Quiet 3h`: how long nothing has come from a task that still runs.
    public static func text(minutes: Int) -> String {
        minutes >= 120 ? "Quiet \(minutes / 60)h" : "Quiet \(minutes)m"
    }
}

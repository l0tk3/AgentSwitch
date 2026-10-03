import Foundation

/// "Who needs you" first (control-v0 §5; ported from the Kit's Attention): waiting for you → ended and unread → in
/// progress → the rest. Lists and the active-topics strip use it; the record itself stays in time order.
public enum DispatchAttention {
    public enum Rank: Int, Sendable, Comparable {
        case needsYou = 0, unread, inProgress, rest

        public static func < (a: Rank, b: Rank) -> Bool { a.rawValue < b.rawValue }
    }

    /// `pending`: the tasks with an open approval or question. `readMarks` false (a Mac that keeps none): nothing is
    /// unread.
    public static func rank(_ task: DispatchTask, pending: Set<String> = [], readMarks: Bool = true) -> Rank {
        if task.waitsForYou || (task.status.isActive && pending.contains(task.id)) { return .needsYou }
        if readMarks && task.isUnread { return .unread }
        if task.status.isActive { return .inProgress }
        return .rest
    }

    /// By rank, then the latest change first; ties keep a stable order by id.
    public static func sorted(_ tasks: [DispatchTask], pending: Set<String> = [], readMarks: Bool = true) -> [DispatchTask] {
        tasks.sorted { a, b in
            let (ra, rb) = (rank(a, pending: pending, readMarks: readMarks), rank(b, pending: pending, readMarks: readMarks))
            if ra != rb { return ra < rb }
            if a.updatedAt != b.updatedAt { return a.updatedAt > b.updatedAt }
            return a.id < b.id
        }
    }

    /// The tasks with an open approval or question.
    public static func pendingTaskIds(_ approvals: [DispatchApproval]) -> Set<String> {
        Set(approvals.filter { $0.status == .pending }.map(\.taskId))
    }
}

/// A running task that has said nothing for a while (control-v0 §5): the status word stays, a note says how long. Only
/// Busy counts: a queued task waits its turn and a question waits for you.
public enum DispatchStaleness {
    public static let threshold: TimeInterval = 10 * 60

    /// Whole minutes since the latest event (else the task's last change), when that is at least the threshold.
    public static func minutes(_ task: DispatchTask, lastEventAt: Int64?, now: Date = Date(), waiting: Bool = false) -> Int? {
        guard task.status == .running || task.status == .routing, !waiting else { return nil }
        let last = max(lastEventAt ?? 0, task.updatedAt)
        let quiet = now.timeIntervalSince(Date(dispatchMilliseconds: last))
        guard quiet >= threshold else { return nil }
        return Int(quiet / 60)
    }

    /// `Quiet 14m` / `Quiet 3h`.
    public static func text(minutes: Int) -> String {
        minutes >= 120 ? "Quiet \(minutes / 60)h" : "Quiet \(minutes)m"
    }

    /// The note for a task, or nil.
    public static func note(_ task: DispatchTask, lastEventAt: Int64?, now: Date = Date(), waiting: Bool = false) -> String? {
        minutes(task, lastEventAt: lastEventAt, now: now, waiting: waiting).map(text(minutes:))
    }
}

/// One chip of the active-topics strip above the record (assistant-v0 §2, control-v0 §5; the phone's
/// ActiveThreadsStrip): a topic that needs a look, its most pressing task standing for it.
public struct DispatchActiveTopic: Sendable, Hashable, Identifiable {
    public let threadId: String
    public let task: DispatchTask
    public let title: String
    /// Something in it waits for you: the waiting colour and mark.
    public let waiting: Bool
    /// It ended and has not been opened: the unread square.
    public let unread: Bool
    /// What it waits for (the first question, else the action), when it waits.
    public let question: String?

    public var id: String { threadId }

    /// A click opens the task itself when it is unread (which reads it), else the topic page.
    public var opensTask: Bool { unread }

    /// The mark: amber while waiting, else its task's state.
    public var level: StatusLevel { waiting ? .warning : task.status.level }

    /// The chip's second line: `Waiting`, or `Busy · Opus 5.5` (`Busy · Quiet 14m` when it has gone quiet).
    public func stateLine(lastEventAt: Int64? = nil, now: Date = Date()) -> String {
        if waiting { return DispatchTaskStatus.waitingApproval.label }
        let stale = DispatchStaleness.note(task, lastEventAt: lastEventAt, now: now)
        return [task.statusLabel, stale ?? task.modelName].compactMap { $0 }.joined(separator: " · ")
    }
}

public enum DispatchActiveTopics {
    /// Ended tasks stay in the strip while unread, for this long and at most this many.
    public static let unreadWindow: TimeInterval = 12 * 3600
    public static let maxUnread = 3
    static let questionChars = 60

    /// One chip per topic that needs a look, in the order of who needs you: waiting for you, then ended and not opened
    /// (the newest few), then in progress. Tasks outside a topic are not in the strip.
    public static func items(tasks: [DispatchTask], approvals: [DispatchApproval], threads: [DispatchThread],
                             readMarks: Bool = true, now: Date = Date()) -> [DispatchActiveTopic] {
        let pending = DispatchAttention.pendingTaskIds(approvals)
        let isUnread = { (task: DispatchTask) in readMarks && task.isUnread }
        let recent = now.addingTimeInterval(-unreadWindow)
        let unread = tasks.filter { isUnread($0) && $0.threadId != nil && $0.updated > recent }
            .sorted { $0.updatedAt > $1.updatedAt }.prefix(maxUnread)
        let candidates = tasks.filter { ($0.status.isActive || $0.waitsForYou) && $0.threadId != nil } + unread.filter { !$0.waitsForYou }
        var seen: Set<String> = []
        return DispatchAttention.sorted(candidates, pending: pending, readMarks: readMarks).compactMap { task in
            guard let id = task.threadId, seen.insert(id).inserted else { return nil }
            let waiting = DispatchAttention.rank(task, pending: pending) == .needsYou
            let title = threads.first { $0.id == id }?.title.flatMap { $0.isEmpty ? nil : $0 }
                ?? String(DispatchMessageDisplay.readable(task.task).prefix(18))
            let question = waiting ? DispatchFeed.pending(approvals, for: task.id).first.map { DispatchText.clip(DispatchMessageDisplay.readable($0.waitingLine), questionChars) } : nil
            return DispatchActiveTopic(threadId: id, task: task, title: title, waiting: waiting, unread: !waiting && isUnread(task),
                                       question: question)
        }
    }
}

/// The top bar's task counts (`⠙1 ▪1`, docs/dispatch-v0.md §1, as the web console counts them): tasks in progress
/// (not the ones waiting for an approval) and approvals waiting for you; and the mark beside the page name.
public struct DispatchCounts: Sendable, Hashable {
    public let busy: Int
    public let waiting: Int

    public init(tasks: [DispatchTask], approvals: [DispatchApproval]) {
        busy = tasks.filter { $0.status.isActive && $0.status != .waitingApproval }.count
        waiting = approvals.filter { $0.status == .pending }.count
    }

    /// The page switch's mark when Dispatch is not the page shown: amber when something waits for you, the spinner
    /// while something runs, nothing otherwise.
    public var mark: StatusLevel? {
        if waiting > 0 { return .warning }
        return busy > 0 ? .busy : nil
    }
}

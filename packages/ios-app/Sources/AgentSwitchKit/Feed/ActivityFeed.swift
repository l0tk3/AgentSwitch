import Foundation

/// The home screen's log (app-v0 §5): the recent tasks oldest first, which of them get a live event stream, and the
/// pending approvals that belong to tasks outside the log.
public enum ActivityFeed {
    public static let defaultLimit = 30
    /// Open SSE streams at once; the other active tasks are followed by polling.
    public static let maxLiveStreams = 3

    /// Oldest first, keeping the newest `limit`. Sorted here, not trusted from the daemon's order.
    public static func timeline(_ tasks: [AgentTask], limit: Int = defaultLimit) -> [AgentTask] {
        Array(tasks.sorted { ($0.createdAt, $0.id) < ($1.createdAt, $1.id) }.suffix(limit))
    }

    /// The newest active tasks, newest first.
    public static func liveTaskIds(_ tasks: [AgentTask], max: Int = maxLiveStreams) -> [String] {
        tasks.filter(\.status.isActive).sorted { $0.createdAt > $1.createdAt }.prefix(max).map(\.id)
    }

    public static func pending(_ approvals: [Approval], for taskId: String) -> [Approval] {
        approvals.filter { $0.taskId == taskId && $0.status == .pending }
    }

    /// Pending approvals whose task is not in the log; the home screen gathers them behind one banner.
    public static func looseApprovals(_ approvals: [Approval], shown: Set<String>) -> [Approval] {
        approvals.filter { $0.status == .pending && !shown.contains($0.taskId) }
    }
}

/// The last few lines of a running task under its log entry. Bookkeeping events and the end state (shown on the entry
/// itself) are left out.
public enum EventTail {
    public static let defaultKeep = 4
    private static let hidden: Set<String> = ["queued", "thread", "summary", "rated"]

    public static func shows(_ event: TaskEvent) -> Bool {
        if hidden.contains(event.type) || event.endsStream { return false }
        return !EventDescriber.line(event).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// `tail` plus `event` when it is new and shown, trimmed to the last `keep`.
    public static func appending(_ event: TaskEvent, to tail: [TaskEvent], keep: Int = defaultKeep) -> [TaskEvent] {
        guard shows(event), event.seq > (tail.last?.seq ?? 0) else { return tail }
        return Array((tail + [event]).suffix(keep))
    }
}

/// How a stored task text reads on the phone: the sealer's legend (router-v0 §9, meant for the executor) is cut off
/// and each ciphertext shows as a lock.
/// A task's name where it is listed (its card, the conversation's end line, the Live Activity): its thread's title for
/// the thread's first task, else its own request — a later task in a thread asks for something else ("pack it", "send
/// it to me") and under the thread's name every card would read the same.
public enum TaskTitle {
    public static func of(_ task: AgentTask, threadTitle: String?, tasks: [AgentTask]) -> String {
        let own = MessageDisplay.readable(task.task)
        guard let threadId = task.threadId, let title = threadTitle, !title.isEmpty else { return own }
        let later = task.parentId != nil || tasks.contains { $0.threadId == threadId && $0.id != task.id && $0.createdAt < task.createdAt }
        return later ? own : title
    }
}

public enum MessageDisplay {
    public static let tokenMark = "🔒密文"
    /// The start of the daemon's LEGEND_HEADER after the blank line `legend()` puts before it (daemon src/secrets/sealer.ts).
    static let legendStart = "\n\n[AgentSwitch sealed the credentials"
    private static let token = try! NSRegularExpression(pattern: "enc:v1:[A-Za-z0-9_-]{16,}={0,2}")

    public static func readable(_ text: String) -> String {
        let body = text.range(of: legendStart).map { String(text[..<$0.lowerBound]) } ?? text
        let range = NSRange(body.startIndex..., in: body)
        return token.stringByReplacingMatches(in: body, range: range, withTemplate: tokenMark)
    }
}

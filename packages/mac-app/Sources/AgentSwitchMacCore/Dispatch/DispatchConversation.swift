import Foundation

// The Dispatch page's record (docs/dispatch-v0.md §2, the phone's home screen): the conversation and the tasks merged
// into one timeline, with the phone's rules — a task's end is said once, a "waits for you" line stays out while its
// question is open, approvals without a card gather behind one line. Ported from the Kit (Assistant/Conversation.swift,
// Feed/ActivityFeed.swift) and the phone's HomeView / ConversationViews.

/// The timeline: the conversation, each task under the reply that created it, and tasks created elsewhere (the web
/// console, before the assistant) on their own, all by time.
public enum DispatchConversation {
    public enum Item: Sendable, Hashable, Identifiable {
        /// What you said (a box).
        case user(DispatchMessage)
        /// The assistant's line, with the cards of the tasks it created hanging under it.
        case assistant(DispatchMessage, created: [DispatchTask])
        /// A task created elsewhere, its request and card on their own.
        case task(DispatchTask)

        /// Said by the assistant on its own (an end, a question, progress).
        var unprompted: Bool {
            if case .assistant(let m, _) = self { return m.unprompted }
            return false
        }

        public var id: String {
            switch self {
            case .user(let m), .assistant(let m, _): return "m\(m.seq)"
            case .task(let t): return "task-\(t.id)"
            }
        }

        /// Tasks an answer talks about without owning them (a status or a cancel), for small links.
        public var mentions: [String] {
            guard case .assistant(let m, _) = self, !m.createdTasks else { return [] }
            return m.taskIds
        }

        /// The tasks with a card here.
        public var cardTaskIds: [String] {
            switch self {
            case .user: return []
            case .assistant(_, let created): return created.map(\.id)
            case .task(let task): return [task.id]
            }
        }

        /// When it was said or created (ms).
        public var time: Int64 {
            switch self {
            case .user(let m), .assistant(let m, _): return m.ts
            case .task(let t): return t.createdAt
            }
        }
    }

    public static let defaultLimit = 60

    /// A task's end is said once (ui-v0 §7.4): the card has the result, so a "task ended" line right under its card —
    /// nothing but other such lines in between — is left out; further down it stays, as one line (DispatchAssistantLine).
    public static func timeline(messages: [DispatchMessage], tasks: [DispatchTask], limit: Int = defaultLimit) -> [Item] {
        let byId = Dictionary(tasks.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let owned = Set(messages.filter(\.createdTasks).flatMap(\.taskIds))
        let talk: [Item] = messages.map { m in
            m.role == .user ? .user(m) : .assistant(m, created: m.createdTasks ? m.taskIds.compactMap { byId[$0] } : [])
        }
        let loose: [Item] = tasks.filter { !owned.contains($0.id) }.map { .task($0) }
        let ordered = (talk + loose).enumerated().sorted { ($0.element.time, $0.offset) < ($1.element.time, $1.offset) }.map(\.element)
        var kept: [Item] = []
        var cardAt: [String: Int] = [:]
        for item in ordered {
            switch item {
            case .assistant(let m, let created):
                if m.kind == .notice, let id = m.taskIds.first, let card = cardAt[id], kept[(card + 1)...].allSatisfy(\.unprompted) { continue }
                for task in created { cardAt[task.id] = kept.count }
            case .task(let task):
                cardAt[task.id] = kept.count
            case .user:
                break
            }
            kept.append(item)
        }
        return Array(kept.suffix(limit))
    }

    /// The day labels of the record (mac-window.html `Yesterday`, `Today`): item id → label, for the first item of each
    /// day (TimeText.day).
    public static func dayHeaders(_ items: [Item], now: Date = Date(), calendar: Calendar = .current) -> [String: String] {
        var out: [String: String] = [:]
        var previous: Date?
        for item in items {
            let date = Date(dispatchMilliseconds: item.time)
            if previous.map({ !calendar.isDate($0, inSameDayAs: date) }) ?? true {
                out[item.id] = TimeText.day(date, now: now, calendar: calendar)
            }
            previous = date
        }
        return out
    }
}

/// The record's tasks and approvals (the Kit's ActivityFeed and the phone's HomeView rules).
public enum DispatchFeed {
    /// How many of the newest tasks the record shows.
    public static let defaultLimit = 30
    /// Open event streams at once; the other active tasks are followed by polling.
    public static let maxLiveStreams = 3

    /// Oldest first, keeping the newest `limit`. Sorted here, not trusted from the daemon's order.
    public static func timeline(_ tasks: [DispatchTask], limit: Int = defaultLimit) -> [DispatchTask] {
        Array(tasks.sorted { ($0.createdAt, $0.id) < ($1.createdAt, $1.id) }.suffix(limit))
    }

    /// The newest active tasks, newest first: the ones that get a live event stream.
    public static func liveTaskIds(_ tasks: [DispatchTask], max: Int = maxLiveStreams) -> [String] {
        tasks.filter(\.status.isActive).sorted { $0.createdAt > $1.createdAt }.prefix(max).map(\.id)
    }

    /// A task's open approvals and questions: the cards inside its card.
    public static func pending(_ approvals: [DispatchApproval], for taskId: String) -> [DispatchApproval] {
        approvals.filter { $0.taskId == taskId && $0.status == .pending }
    }

    /// Pending approvals whose task has no card in the record; the page gathers them behind one line.
    public static func looseApprovals(_ approvals: [DispatchApproval], shown: Set<String>) -> [DispatchApproval] {
        approvals.filter { $0.status == .pending && !shown.contains($0.taskId) }
    }

    /// A "waits for you" line is left out while its question is open in the task's card (it would say the same thing
    /// twice), and shows as history once answered.
    public static func visibleMessages(_ messages: [DispatchMessage], approvals: [DispatchApproval]) -> [DispatchMessage] {
        let open = Set(approvals.filter { $0.status == .pending }.map(\.taskId))
        return messages.filter { m in !(m.kind == .waiting && m.taskIds.contains(where: open.contains)) }
    }

    /// The record as the page draws it: every rule above applied.
    public static func record(messages: [DispatchMessage], tasks: [DispatchTask], approvals: [DispatchApproval],
                              limit: Int = DispatchConversation.defaultLimit) -> [DispatchConversation.Item] {
        DispatchConversation.timeline(messages: visibleMessages(messages, approvals: approvals), tasks: timeline(tasks), limit: limit)
    }

    /// Tasks with a card in the record (their approvals are answered there, not behind the loose line).
    public static func shownTaskIds(_ items: [DispatchConversation.Item]) -> Set<String> {
        Set(items.flatMap(\.cardTaskIds))
    }

    /// The approvals behind the loose line (`■ 2 Waiting ›`), for this record.
    public static func looseApprovals(_ approvals: [DispatchApproval], record items: [DispatchConversation.Item]) -> [DispatchApproval] {
        looseApprovals(approvals, shown: shownTaskIds(items))
    }

    /// The loose line's words: `2 Waiting`.
    public static func looseLabel(_ count: Int) -> String { "\(count) Waiting" }
}

/// The last few lines of a running task, kept from its event stream for its card. Bookkeeping events and the end state
/// (shown on the card itself) are left out.
public enum DispatchEventTail {
    public static let defaultKeep = 4
    private static let hidden: Set<String> = ["queued", "thread", "summary", "rated"]

    public static func shows(_ event: DispatchTaskEvent) -> Bool {
        if hidden.contains(event.type) || event.endsStream { return false }
        return !DispatchEventDescriber.line(event).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// `tail` plus `event` when it is new and shown, trimmed to the last `keep`.
    public static func appending(_ event: DispatchTaskEvent, to tail: [DispatchTaskEvent], keep: Int = defaultKeep) -> [DispatchTaskEvent] {
        guard shows(event), event.seq > (tail.last?.seq ?? 0) else { return tail }
        return Array((tail + [event]).suffix(keep))
    }
}

/// How one assistant line is drawn (the phone's AssistantBubble): plain text on the left; a report carries a small
/// square in the state of its task; a task's end further down than its card is one line that opens it; tasks it only
/// talks about are small links; an answer gets `Read Aloud`.
public struct DispatchAssistantLine: Sendable, Hashable {
    public let message: DispatchMessage
    /// The cards that hang under it.
    public let created: [DispatchTask]
    /// For an end notice whose task is known: draw one line (status mark, title, status word, `›`) instead of the text.
    public let endedTask: DispatchTask?
    /// Tasks it talks about without owning them: one-line links.
    public let mentioned: [DispatchTask]
    /// A report's square: amber while its task waits for you, else its task's state; `.off` when the task is not known;
    /// nil for plain answers.
    public let dot: StatusLevel?

    public init(message: DispatchMessage, created: [DispatchTask], tasks: [DispatchTask], approvals: [DispatchApproval]) {
        self.message = message
        self.created = created
        let find = { (id: String) in tasks.first { $0.id == id } }
        let waiting = { (task: DispatchTask) in !DispatchFeed.pending(approvals, for: task.id).isEmpty }
        endedTask = message.kind == .notice ? message.taskIds.first.flatMap(find) : nil
        mentioned = !message.createdTasks && !message.unprompted ? message.taskIds.compactMap(find) : []
        if message.unprompted {
            let task = message.taskIds.first.flatMap(find)
            dot = task.map { waiting($0) ? .warning : $0.status.level } ?? .off
        } else {
            dot = nil
        }
    }

    /// The line's text as it reads (locks for ciphertexts, no legend).
    public var text: String { DispatchMessageDisplay.readable(message.text) }
    /// Reports are said in the secondary colour; answers in the primary.
    public var isSecondary: Bool { message.unprompted }
    /// An answer to what you asked: it gets a visible `Read Aloud`.
    public var isAnswer: Bool { message.isAnswer }
}

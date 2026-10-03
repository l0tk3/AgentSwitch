import Foundation

// A task as the record shows it (docs/dispatch-v0.md §2; the phone's FeedEntry): status line, title, progress blocks,
// the current step or the outcome, the files handed back, and the approvals waiting inside it. Titles, steps and the
// spoken summary ported from the Kit (Feed/ActivityFeed.swift TaskTitle, Feed/LiveSummary.swift).

/// A task's name where it is listed (its card, an end line, the Live Activity): its topic's title for the topic's first
/// task, else its own request — a later task in a topic asks for something else ("pack it") and under the topic's name
/// every card would read the same.
public enum DispatchTaskTitle {
    public static func of(_ task: DispatchTask, threadTitle: String?, tasks: [DispatchTask]) -> String {
        let own = DispatchMessageDisplay.readable(task.task)
        guard let threadId = task.threadId, let title = threadTitle, !title.isEmpty else { return own }
        let later = task.parentId != nil || tasks.contains { $0.threadId == threadId && $0.id != task.id && $0.createdAt < task.createdAt }
        return later ? own : title
    }

    public static func of(_ task: DispatchTask, threads: [DispatchThread], tasks: [DispatchTask]) -> String {
        of(task, threadTitle: task.threadId.flatMap { id in threads.first { $0.id == id }?.title }, tasks: tasks)
    }
}

/// What a running task is doing now, in plain words, from the latest event that says something (not raw tool input or
/// internal state names): the card's `└─` line.
public enum DispatchLiveStep {
    static let stepChars = 120

    /// The step line for a card; the summarizer's sentence when no event says anything yet.
    public static func current(_ task: DispatchTask, tail: [DispatchTaskEvent]) -> String? {
        for event in tail.reversed() {
            if let line = plainLine(event) { return DispatchText.clip(line, stepChars) }
        }
        return task.spoken.map { DispatchText.clip($0, stepChars) }
    }

    /// One event as a short plain line, or nil when it says nothing worth showing there.
    public static func plainLine(_ event: DispatchTaskEvent) -> String? {
        let p = event.payload
        switch event.type {
        case "text":
            let text = DispatchMessageDisplay.readable(p["text"]?.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return text.isEmpty ? nil : text.split(separator: "\n").first.map(String.init)
        case "tool_call":
            return p["denied"] == nil ? DispatchMessageDisplay.readable(DispatchToolDisplay.line(p)) : nil
        case "dispatched": return p["model"]?.string.map { "已交给 " + ModelName.display($0) } ?? "开始执行"
        case "routed":
            if let clarify = p["clarify"]?.string, !clarify.isEmpty { return "等你回答：" + clarify }
            return p["verdict"]?["model"]?.string.map { "已选定 " + ModelName.display($0) } ?? "已选定模型"
        case "step":
            switch p["action"]?.string {
            case "intake": return "已接收"
            case "plan": return "多步任务，规划中"
            case "dispatch":
                let model = p["target"]?["model"]?.string.map(ModelName.display)
                return "第 \(p["n"]?.int ?? 1) 步" + (model.map { "：交由 \($0) 执行" } ?? "")
            case "ask_user": return p["question"]?.string.map { "等你回答：" + $0 }
            case "finish": return "收尾检查"
            default: return nil
            }
        case "redispatch": return "重试"
        case "attempt_failed": return "一次尝试失败"
        case "queued": return DispatchTaskStatus.queued.label
        default: return nil
        }
    }
}

/// The progress blocks of a multi-step task (mac-window.html `▮▮▮▯▯ 3/5`): the step it is on, of the dispatch budget.
/// The daemon publishes no plan length; `of` is its budget (router/loop.ts MAX_DISPATCHES), or the step itself once a
/// task goes past it (the user granted more). A single-step task has none.
public struct DispatchProgress: Sendable, Hashable {
    public let step: Int
    public let of: Int

    /// The daemon's dispatch budget for one task (router/loop.ts MAX_DISPATCHES).
    public static let budget = 5

    public init(step: Int, of: Int = DispatchProgress.budget) {
        self.step = step
        self.of = max(of, step)
    }

    /// One flag per block, filled up to the step.
    public var blocks: [Bool] { (1...max(of, 1)).map { $0 <= step } }
    public var text: String { "\(step)/\(of)" }

    /// `progress` moved on by `event` (a `step` event of the loop with its number); unchanged otherwise. Fold the
    /// stream through it: a card keeps only the last few events (DispatchEventTail).
    public static func updated(_ progress: DispatchProgress?, with event: DispatchTaskEvent) -> DispatchProgress? {
        guard event.type == "step", ["dispatch", "ask_user", "finish"].contains(event.payload["action"]?.string ?? ""),
              let n = event.payload["n"]?.int, n >= 1, n > (progress?.step ?? 0) else { return progress }
        return DispatchProgress(step: n, of: max(progress?.of ?? budget, n))
    }

    /// The progress after all of `events`, or nil for a task without steps.
    public static func of(_ events: [DispatchTaskEvent]) -> DispatchProgress? {
        events.reduce(nil) { updated($0, with: $1) }
    }
}

/// The buttons of a task, on its card and on its page (`[ Cancel ]` `[ Retry ]` `[ Hand to ▾ ]`; docs/dispatch-v0.md §2).
public enum DispatchTaskAction: String, Sendable, CaseIterable {
    case cancel, retry, continueRun, handTo, delete

    /// The button's words, in brackets as the page writes them.
    public var title: String {
        switch self {
        case .cancel: return "[ Cancel ]"
        case .retry: return "[ Retry ]"
        case .continueRun: return "[ Continue ]"
        case .handTo: return "[ Hand to ▾ ]"
        case .delete: return "[ Delete ]"
        }
    }

    /// Cancel and delete are confirmed first and drawn in the warning style.
    public var isDestructive: Bool { self == .cancel || self == .delete }

    /// On a card: a task that stopped short offers to run again or elsewhere; a restart's leftover to go on.
    public static func card(_ task: DispatchTask) -> [DispatchTaskAction] {
        if task.isInterrupted { return [.continueRun, .handTo] }
        switch task.status {
        case .failed, .partial: return [.retry, .handTo]
        case .blocked where !task.waitsForYou: return [.retry, .handTo]
        default: return []
        }
    }

    /// On the task page: cancel or hand on while it runs; afterwards run again, hand on, or delete.
    public static func page(_ task: DispatchTask) -> [DispatchTaskAction] {
        if task.status.isActive { return [.cancel, .handTo] }
        if task.isInterrupted { return [.continueRun, .handTo, .delete] }
        return [.retry, .handTo, .delete]
    }
}

/// A right-click menu item (the phone's long-press menus, same items and symbols; ui-v0 §7.2.5).
public enum DispatchMenuItem: Sendable, Hashable {
    case open, topic, readAloud(speaking: Bool), copy, delete(enabled: Bool)

    public var title: String {
        switch self {
        case .open: return "Open"
        case .topic: return "Topic"
        case .readAloud(let speaking): return speaking ? "Stop" : "Read Aloud"
        case .copy: return "Copy"
        case .delete: return "Delete"
        }
    }

    /// The SF Symbol.
    public var symbol: String {
        switch self {
        case .open: return "arrow.up.right.square"
        case .topic: return "bubble.left.and.bubble.right"
        case .readAloud(let speaking): return speaking ? "stop.fill" : "speaker.wave.2"
        case .copy: return "doc.on.doc"
        case .delete: return "trash"
        }
    }

    public var isDestructive: Bool { if case .delete = self { return true }; return false }
    public var isEnabled: Bool { if case .delete(let enabled) = self { return enabled }; return true }

    /// A task's card: open, its topic, read aloud once it ended, delete (not while it runs; confirmed first).
    public static func task(_ task: DispatchTask, speaking: Bool = false) -> [DispatchMenuItem] {
        [.open] + (task.threadId == nil ? [] : [.topic]) + (task.status.isTerminal ? [.readAloud(speaking: speaking)] : [])
            + [.delete(enabled: !task.status.isActive)]
    }

    /// What you said: copy, delete the entry (with its answers and the tasks they created).
    public static let userMessage: [DispatchMenuItem] = [.copy, .delete(enabled: true)]

    /// An assistant line: read aloud, copy, delete the entry.
    public static func assistantMessage(speaking: Bool = false) -> [DispatchMenuItem] {
        [.readAloud(speaking: speaking), .copy, .delete(enabled: true)]
    }
}

/// Everything a task's card shows, decided here so the view only draws it.
public struct DispatchTaskCard: Sendable, Hashable, Identifiable {
    public let task: DispatchTask
    public let title: String
    /// What was asked, as it reads (for a card shown on its own, with its request above it).
    public let request: String
    /// An approval or question waits inside: the status reads Waiting, in amber.
    public let waiting: Bool
    public let statusWord: String
    public let level: StatusLevel
    /// `Claude Code · Opus 5.5`.
    public let who: String?
    public let unread: Bool
    /// `Quiet 14m` for a running task gone quiet.
    public let stale: String?
    public let progress: DispatchProgress?
    /// While it runs: what it is doing now (`└─ 运行 xcodebuild …`).
    public let step: String?
    /// Once ended: the spoken summary (plain text), shown instead of the result when there is one.
    public let summary: String?
    /// Once ended without a summary: the result, Markdown (DispatchMarkdown), a few lines.
    public let result: String?
    /// Once ended short of done: why, Markdown; `errorIsFailure` false for a restart's leftover (said plainly, not red).
    public let error: String?
    public let errorIsFailure: Bool
    /// The files handed back, the first `filesShown`; `moreFiles` more open the task.
    public let files: [DispatchTaskFile]
    public let moreFiles: Int
    /// The approvals and questions waiting inside the card.
    public let approvals: [DispatchApproval]
    public let actions: [DispatchTaskAction]

    public static let filesShown = 4

    public var id: String { task.id }

    /// `tail`: the card's last events (DispatchEventTail); `progress`: folded from its stream (DispatchProgress);
    /// `files`: its files once known (all of them; the card keeps the deliverables).
    public init(task: DispatchTask, tasks: [DispatchTask], threads: [DispatchThread], approvals: [DispatchApproval],
                tail: [DispatchTaskEvent] = [], progress: DispatchProgress? = nil, files: [DispatchTaskFile] = [],
                lastEventAt: Int64? = nil, readMarks: Bool = true, now: Date = Date()) {
        self.task = task
        title = DispatchTaskTitle.of(task, threads: threads, tasks: tasks)
        request = DispatchMessageDisplay.readable(task.task)
        self.approvals = DispatchFeed.pending(approvals, for: task.id)
        waiting = !self.approvals.isEmpty
        statusWord = waiting ? DispatchTaskStatus.waitingApproval.label : task.statusLabel
        level = waiting || task.waitsForYou ? .warning : task.status.level
        who = task.who
        unread = readMarks && task.isUnread
        stale = DispatchStaleness.note(task, lastEventAt: lastEventAt, now: now, waiting: waiting)
        let active = task.status.isActive
        self.progress = active ? progress : nil
        step = active ? DispatchLiveStep.current(task, tail: tail) : nil
        let script = task.speech.map(DispatchSpeech.speakable).flatMap { $0.isEmpty ? nil : $0 }
        summary = active ? nil : script
        result = active || script != nil ? nil : task.result.flatMap { $0.isEmpty ? nil : $0 }
        let reason = task.isInterrupted ? (task.error ?? DispatchTask.interruptedText) : task.error
        error = active || task.status == .done ? nil : reason.flatMap { $0.isEmpty ? nil : $0 }
        errorIsFailure = !task.isInterrupted
        let delivered = active ? [] : DispatchTaskFile.cardFiles(files)
        self.files = Array(delivered.prefix(Self.filesShown))
        moreFiles = max(delivered.count - Self.filesShown, 0)
        actions = waiting ? [] : DispatchTaskAction.card(task)
    }

    /// The status line's clock: how long it has run, or ran.
    public func clock(now: Date = Date()) -> String { DispatchClock.taskClock(task, now: now) }
}

/// The task page's parts besides the card's (docs/dispatch-v0.md §2: request · status line · summary · result · files ·
/// process · actions).
public enum DispatchTaskPage {
    /// The `// Task` block: Folder, Browser, Approval, ID (mac-window.html).
    public static func facts(_ task: DispatchTask, home: String = NSHomeDirectory()) -> [(label: String, value: String)] {
        let folder = task.ephemeral || (task.cwd ?? "").isEmpty ? "临时目录" : DisplayPath.short(task.cwd ?? "", home: home)
        return [("Folder", folder), ("Browser", task.needsBrowser ? "Yes" : "None"), ("Approval", task.approvalModeTitle), ("ID", task.id)]
    }

    /// The reason a task did not finish, as the page says it (a restart's leftover in plain words), or nil.
    public static func reason(_ task: DispatchTask) -> String? {
        if task.isInterrupted { return DispatchMessageDisplay.readable(task.error ?? DispatchTask.interruptedText) }
        guard task.status != .done, let error = task.error, !error.isEmpty else { return nil }
        return error
    }

    /// The spoken summary once it ended, or nil (the summarizer may still be writing it: see `awaitingSummary`).
    public static func summary(_ task: DispatchTask) -> String? {
        guard task.status.isTerminal else { return nil }
        return task.speech.map(DispatchSpeech.speakable).flatMap { $0.isEmpty ? nil : $0 }
    }

    /// The summarizer writes `spoken` / `speech` a few seconds after the end: look again until they are there (the phone
    /// polls every 3 s, 20 times).
    public static func awaitingSummary(_ task: DispatchTask) -> Bool {
        task.status.isTerminal && task.speech == nil && task.spoken == nil
    }

    /// `Useful` / `Not Useful`: what a click on `rating` sends (the same one again clears it).
    public static func nextRating(current: Int?, clicked rating: Int) -> Int? { current == rating ? nil : rating }
}

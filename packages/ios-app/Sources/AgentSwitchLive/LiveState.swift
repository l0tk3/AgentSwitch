import Foundation
#if canImport(ActivityKit) && os(iOS)
import ActivityKit
#endif

/// What the Live Activity and the Dynamic Island show (assistant-v0 §4): one summary for all tasks, not one activity
/// per task — at most three in progress, the one that needs you first, how many run and wait in all, and the last
/// conclusion once everything has ended. Its own module with no dependencies, so the widget extension stays small; the
/// app builds it from tasks (AgentSwitchKit's LiveSummary). ActivityKit keeps a state under 4 KB: every text is short.
public struct LiveState: Codable, Hashable, Sendable {
    public struct Row: Codable, Hashable, Sendable, Identifiable {
        public let id: String
        /// The thread's title, else the start of what was asked.
        public let title: String
        /// The latest step, or the question when it waits for you.
        public let step: String
        /// The model at work, if one has the task yet.
        public let model: String?
        /// For the running clock (`Text(timerInterval:)` keeps counting while the app is suspended).
        public let startedAt: Date
        public let needsYou: Bool

        public init(id: String, title: String, step: String, model: String?, startedAt: Date, needsYou: Bool) {
            self.id = id
            self.title = title
            self.step = step
            self.model = model
            self.startedAt = startedAt
            self.needsYou = needsYou
        }
    }

    /// The last conclusion after every task ended: shown for a minute, then the activity goes.
    public struct Ended: Codable, Hashable, Sendable {
        public let taskId: String
        public let title: String
        public let line: String
        public let ok: Bool

        public init(taskId: String, title: String, line: String, ok: Bool) {
            self.taskId = taskId
            self.title = title
            self.line = line
            self.ok = ok
        }
    }

    public enum Phase: String, Sendable { case running, needsYou, ended }

    public let rows: [Row]
    public let running: Int
    public let waiting: Int
    public let ended: Ended?

    public init(rows: [Row], running: Int, waiting: Int, ended: Ended? = nil) {
        self.rows = rows
        self.running = running
        self.waiting = waiting
        self.ended = ended
    }

    public static func finished(_ ended: Ended) -> LiveState { LiveState(rows: [], running: 0, waiting: 0, ended: ended) }

    public var phase: Phase { waiting > 0 ? .needsYou : rows.isEmpty && ended != nil ? .ended : .running }
    /// The row the island expands to: the one waiting for you, else the newest.
    public var lead: Row? { rows.first }
}

/// The links the activity opens: a task's card in the app.
public enum LiveLink {
    public static let scheme = "agentswitch"

    public static func task(_ id: String) -> URL {
        URL(string: "\(scheme)://task/\(id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? id)")!
    }

    /// The task id of an `agentswitch://task/<id>` link, or nil for any other link (a pairing link, say).
    public static func taskId(from url: URL) -> String? {
        guard url.scheme == scheme, url.host == "task" else { return nil }
        let id = url.pathComponents.dropFirst().first.map { $0.removingPercentEncoding ?? $0 } ?? ""
        return id.isEmpty || id.count > 64 ? nil : id
    }
}

#if canImport(ActivityKit) && os(iOS)
/// The activity's fixed part: which Mac. The rest changes with every update (`LiveState`).
public struct AgentActivityAttributes: ActivityAttributes {
    public typealias ContentState = LiveState
    public let macName: String

    public init(macName: String) {
        self.macName = macName
    }
}
#endif

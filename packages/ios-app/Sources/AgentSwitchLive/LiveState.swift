import Foundation
#if canImport(ActivityKit) && os(iOS)
import ActivityKit
#endif

/// What the Live Activity and the Dynamic Island show (assistant-v0 §4): one summary for all tasks, not one activity
/// per task — at most three in progress, the one that needs you first, how many run and wait in all, and the last
/// conclusion once everything has ended. Terminals waiting for you are rows too (terminal-v0 §1). Its own module with no dependencies, so the widget extension stays small; the
/// app builds it from tasks (AgentSwitchKit's LiveSummary). ActivityKit keeps a state under 4 KB: every text is short.
public struct LiveState: Codable, Hashable, Sendable {
    public struct Row: Codable, Hashable, Sendable, Identifiable {
        /// A task, or one of AgentSwitch's terminals waiting for you.
        public enum Kind: String, Codable, Hashable, Sendable { case task, terminal }

        public let id: String
        /// The thread's title, else the start of what was asked; a terminal's name.
        public let title: String
        /// The latest step, or the question when it waits for you; what a terminal asks to run.
        public let step: String
        /// The model at work, if one has the task yet; a terminal's agent.
        public let model: String?
        /// For the running clock (`Text(timerInterval:)` keeps counting while the app is suspended); a terminal's from
        /// when it asked.
        public let startedAt: Date
        public let needsYou: Bool
        public let kind: Kind

        public init(id: String, title: String, step: String, model: String?, startedAt: Date, needsYou: Bool, kind: Kind = .task) {
            self.id = id
            self.title = title
            self.step = step
            self.model = model
            self.startedAt = startedAt
            self.needsYou = needsYou
            self.kind = kind
        }

        private enum CodingKeys: String, CodingKey { case id, title, step, model, startedAt, needsYou, kind }

        /// A state saved before rows had a kind (an activity left from an earlier version) reads as tasks.
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            title = try c.decode(String.self, forKey: .title)
            step = try c.decode(String.self, forKey: .step)
            model = try c.decodeIfPresent(String.self, forKey: .model)
            startedAt = try c.decode(Date.self, forKey: .startedAt)
            needsYou = try c.decode(Bool.self, forKey: .needsYou)
            kind = try c.decodeIfPresent(Kind.self, forKey: .kind) ?? .task
        }

        /// Where a tap on it goes: the task's card, or the terminal.
        public var link: URL { kind == .terminal ? LiveLink.terminal(id) : LiveLink.task(id) }
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
    /// Tasks in progress and not waiting (a terminal is a row only while it waits).
    public let running: Int
    /// Tasks and terminals waiting for you.
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
    /// Tasks are in it (not only terminals): once they are over, the last conclusion is worth a minute.
    public var hasTasks: Bool { running > 0 || rows.contains { $0.kind == .task } }
}

/// The links the activity opens: a task's card or a terminal in the app.
public enum LiveLink {
    public static let scheme = "agentswitch"

    public static func task(_ id: String) -> URL { link("task", id) }
    public static func terminal(_ id: String) -> URL { link("terminal", id) }

    /// The task id of an `agentswitch://task/<id>` link, or nil for any other link (a pairing link, say).
    public static func taskId(from url: URL) -> String? { id(in: url, host: "task") }
    /// The terminal id of an `agentswitch://terminal/<id>` link.
    public static func terminalId(from url: URL) -> String? { id(in: url, host: "terminal") }

    private static func link(_ host: String, _ id: String) -> URL {
        URL(string: "\(scheme)://\(host)/\(id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? id)")!
    }

    private static func id(in url: URL, host: String) -> String? {
        guard url.scheme == scheme, url.host == host else { return nil }
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

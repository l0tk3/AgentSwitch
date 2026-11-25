import Foundation
#if canImport(ActivityKit) && os(iOS)
import ActivityKit
#endif

/// What the Live Activity and the Dynamic Island show (assistant-v0 §4): one summary for all terminals, not one
/// activity each — at most three at work or waiting for you (terminal-v0 §1), the one that needs you first, how many
/// run and wait in all. Its own module with no dependencies, so the widget extension stays small; the app builds it
/// from the terminals (AgentSwitchKit's LiveSummary). ActivityKit keeps a state under 4 KB: every text is short.
public struct LiveState: Codable, Hashable, Sendable {
    public struct Row: Codable, Hashable, Sendable, Identifiable {
        public let id: String
        /// The terminal's name.
        public let title: String
        /// What it is using, or what it asks to run when it waits for you.
        public let step: String
        /// The terminal's agent.
        public let model: String?
        /// For the running clock (`Text(timerInterval:)` keeps counting while the app is suspended): since this turn
        /// began, or since it asked.
        public let startedAt: Date
        public let needsYou: Bool
        /// What it is doing now in one short word, for the compact island (`Run`, `Edit`, `Read`, `Search`, `Web`,
        /// `Agents`…; `Allow?` or `Answer` while it waits for you). Nil from an activity saved before 2026-10-01.
        public let doing: String?

        public init(id: String, title: String, step: String, model: String?, startedAt: Date, needsYou: Bool, doing: String? = nil) {
            self.id = id
            self.title = title
            self.step = step
            self.model = model
            self.startedAt = startedAt
            self.needsYou = needsYou
            self.doing = doing
        }

        /// Where a tap on it goes: the terminal.
        public var link: URL { LiveLink.terminal(id) }
    }

    public enum Phase: String, Sendable { case running, needsYou }

    public let rows: [Row]
    /// Terminals at work.
    public let running: Int
    /// Terminals waiting for you.
    public let waiting: Int
    /// The look the app is kept in (docs/ui-v0.md §8): true draws the activity as a standard app's. It rides with the
    /// state because the widget extension reads none of the app's settings; nil (the pixel look) from an activity
    /// saved before 2026-10-04.
    public let classic: Bool?

    public init(rows: [Row], running: Int, waiting: Int, classic: Bool? = nil) {
        self.rows = rows
        self.running = running
        self.waiting = waiting
        self.classic = classic
    }

    /// The same state, drawn in the classic look or the pixel one.
    public func looking(classic: Bool) -> LiveState {
        LiveState(rows: rows, running: running, waiting: waiting, classic: classic ? true : nil)
    }

    /// Whether it is drawn in the classic look.
    public var isClassic: Bool { classic == true }

    public var phase: Phase { waiting > 0 ? .needsYou : .running }
    /// The row the island expands to: the one waiting for you, else the newest.
    public var lead: Row? { rows.first }
}

/// The links the activity opens: a terminal in the app.
public enum LiveLink {
    public static let scheme = "agentswitch"

    public static func terminal(_ id: String) -> URL { link("terminal", id) }

    /// The terminal id of an `agentswitch://terminal/<id>` link, or nil for any other link (a pairing link, say).
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

import AgentSwitchLive
import Foundation

/// The terminals at work or waiting for you, as the Live Activity's state (assistant-v0 §4).
public enum LiveSummary {
    public static let maxRows = 3
    static let titleChars = 28
    static let stepChars = 60

    /// The terminals at work or waiting for you (terminal-v0 §1), the ones waiting first, then the newest; nil when
    /// there are none. A terminal at work counts (2026-09-30, user: 实时活动应该包括终端里的活动); an idle or ended one
    /// does not.
    public static func state(terminals: [TerminalInfo]) -> LiveState? {
        let rows = terminals.filter { $0.waitsForYou || $0.status == .working }.map(row)
        guard !rows.isEmpty else { return nil }
        let ordered = rows.sorted { ($0.needsYou ? 0 : 1, $1.startedAt) < ($1.needsYou ? 0 : 1, $0.startedAt) }
        let waiting = rows.filter(\.needsYou).count
        return LiveState(rows: Array(ordered.prefix(maxRows)), running: rows.count - waiting, waiting: waiting)
    }

    /// A terminal waiting for you: its name, what it asks to run ("Bash: npm test"), its agent, since when it asks. At
    /// work: what it is using ("运行 npm test", else 进行中), since this turn began.
    static func row(_ terminal: TerminalInfo) -> LiveState.Row {
        let agent = ModelName.harness(terminal.harness)
        guard terminal.waitsForYou else {
            return LiveState.Row(id: terminal.id, title: clip(terminal.name.isEmpty ? agent : terminal.name, titleChars),
                                 step: clip(terminal.activity.map { MessageDisplay.readable($0.phrase) } ?? "进行中", stepChars), model: agent,
                                 startedAt: Date(milliseconds: terminal.statusSince ?? terminal.lastOutputAt), needsYou: false,
                                 doing: terminal.activity.map { ToolDisplay.word($0.tool) } ?? "Think")
        }
        let ask = terminal.permissions.first
        let since = ask.map(\.at).flatMap { $0 > 0 ? $0 : nil } ?? terminal.statusSince ?? terminal.lastOutputAt
        return LiveState.Row(id: terminal.id, title: clip(terminal.name.isEmpty ? agent : terminal.name, titleChars),
                             step: clip(ask.map { MessageDisplay.readable($0.summary) } ?? "等你处理", stepChars), model: agent,
                             startedAt: Date(milliseconds: since), needsYou: true,
                             doing: ask?.tool == "AskUserQuestion" ? "Answer" : "Allow?")
    }

    static func clip(_ text: String, _ limit: Int) -> String {
        let one = text.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
        return one.count > limit ? String(one.prefix(limit - 1)) + "…" : one
    }
}

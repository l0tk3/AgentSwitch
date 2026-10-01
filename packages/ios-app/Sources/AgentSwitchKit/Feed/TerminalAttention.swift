import Foundation

extension TerminalInfo {
    /// Waiting for an answer: a permission request, or a prompt on its screen the agent reported (the tab's badge).
    public var waitsForYou: Bool {
        status != .exited && (status == .waiting || !permissions.isEmpty)
    }

    /// What voice mode reads when it starts to wait: 终端「修复登录」等你批准：Bash; a question is said as one
    /// (终端「修复登录」问你：会话存在哪里？, 2026-10-01), not as a tool to approve.
    public var spokenWait: String {
        let name = name.isEmpty ? ModelName.harness(harness) : name
        if let ask = permissions.first, let question = ask.questions.first { return "终端「\(name)」问你：\(question.question)" }
        if let ask = permissions.first, !ask.tool.isEmpty { return "终端「\(name)」等你批准：\(ask.tool)" }
        return "终端「\(name)」等你处理"
    }
}

/// Terminals that newly need you (terminal-v0 §1), for the same cue as a task's question: one with a permission request
/// not seen before, or one that turned to waiting without one. The first look only sets the baseline, as for approvals.
public struct TerminalCueTracker: Sendable {
    /// "terminal/permission" (a permission id is the terminal's own).
    private var seenAsks: Set<String>?
    private var waiting: Set<String> = []

    public init() {}

    public mutating func newlyWaiting(_ terminals: [TerminalInfo]) -> [TerminalInfo] {
        let now = terminals.filter(\.waitsForYou)
        let asks = Set(now.flatMap { t in t.permissions.map { "\(t.id)/\($0.id)" } })
        let before = waiting
        defer {
            seenAsks = (seenAsks ?? []).union(asks)
            waiting = Set(now.map(\.id))
        }
        guard let seen = seenAsks else { return [] }
        return now.filter { t in !before.contains(t.id) || t.permissions.contains { !seen.contains("\(t.id)/\($0.id)") } }
    }
}

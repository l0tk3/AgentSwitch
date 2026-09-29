import AgentSwitchLive
import Foundation

/// Tasks, pending approvals, the live event tails and the terminals waiting for you, as the Live Activity's state
/// (assistant-v0 §4).
public enum LiveSummary {
    public static let maxRows = 3
    static let titleChars = 28
    static let stepChars = 60
    static let endedChars = 90

    /// The tasks in progress and the terminals waiting for you (terminal-v0 §1), the ones waiting first, then the newest;
    /// nil when there are none. A terminal at work is not in it: it has no end to report.
    public static func state(tasks: [AgentTask], approvals: [Approval], threadTitles: [String: String],
                             tails: [String: [TaskEvent]] = [:], terminals: [TerminalInfo] = []) -> LiveState? {
        let active = tasks.filter(\.status.isActive)
        let asking = terminals.filter(\.waitsForYou)
        guard !active.isEmpty || !asking.isEmpty else { return nil }
        let pending = Dictionary(grouping: approvals.filter { $0.status == .pending }, by: \.taskId)
        let rows = active.map { task -> LiveState.Row in
            let waitingOn = pending[task.id]?.first
            let needsYou = waitingOn != nil || task.status == .waitingApproval
            return LiveState.Row(id: task.id, title: title(task, threadTitles, tasks), step: step(task, waitingOn, tails[task.id] ?? []),
                                 model: task.model.map(ModelName.display), startedAt: task.created, needsYou: needsYou)
        } + asking.map(row)
        let ordered = rows.sorted { ($0.needsYou ? 0 : 1, $1.startedAt) < ($1.needsYou ? 0 : 1, $0.startedAt) }
        let waiting = rows.filter(\.needsYou).count
        return LiveState(rows: Array(ordered.prefix(maxRows)), running: rows.count - waiting, waiting: waiting)
    }

    /// A terminal waiting for you: its name, what it asks to run ("Bash: npm test"), its agent, since when it asks.
    static func row(_ terminal: TerminalInfo) -> LiveState.Row {
        let ask = terminal.permissions.first
        let since = ask.map(\.at).flatMap { $0 > 0 ? $0 : nil } ?? terminal.lastOutputAt
        let agent = ModelName.harness(terminal.harness)
        return LiveState.Row(id: terminal.id, title: clip(terminal.name.isEmpty ? agent : terminal.name, titleChars),
                             step: clip(ask.map { MessageDisplay.readable($0.summary) } ?? "等你处理", stepChars), model: agent,
                             startedAt: Date(milliseconds: since), needsYou: true, kind: .terminal)
    }

    /// The conclusion to show once nothing runs: the task that ended last (a cancelled one too, said as such).
    public static func ended(tasks: [AgentTask], threadTitles: [String: String]) -> LiveState.Ended? {
        guard let last = tasks.filter(\.status.isTerminal).max(by: { $0.updatedAt < $1.updatedAt }) else { return nil }
        let said = [last.spoken, last.speech, last.status == .done ? last.result : last.error ?? last.result]
            .compactMap { $0.map(Speech.speakable) }.first { !$0.isEmpty }
        return LiveState.Ended(taskId: last.id, title: title(last, threadTitles, tasks), line: clip(said ?? last.status.label, endedChars),
                               ok: last.status == .done)
    }

    static func title(_ task: AgentTask, _ threadTitles: [String: String], _ tasks: [AgentTask]) -> String {
        clip(TaskTitle.of(task, threadTitle: task.threadId.flatMap { threadTitles[$0] }, tasks: tasks), titleChars)
    }

    /// What it waits for; else what it is doing, in plain words, from the latest event that says something (not raw
    /// tool input or internal state names); else its state, said the same way.
    static func step(_ task: AgentTask, _ waitingOn: Approval?, _ tail: [TaskEvent]) -> String {
        if let approval = waitingOn {
            let asked = approval.questionEvidence?.questions.first?.text ?? approval.action
            return clip(MessageDisplay.readable(asked), stepChars)
        }
        for event in tail.reversed() {
            if let line = plainLine(event) { return clip(line, stepChars) }
        }
        return plainStatus(task.status)
    }

    /// What a running task is doing now, in plain words, for a card (the same line the Live Activity shows).
    public static func currentStep(_ task: AgentTask, tail: [TaskEvent]) -> String? {
        for event in tail.reversed() {
            if let line = plainLine(event) { return clip(line, stepChars * 2) }
        }
        return task.spoken.map { clip($0, stepChars * 2) }
    }

    static func plainStatus(_ status: TaskStatus) -> String {
        switch status {
        case .queued: return TaskStatus.queued.label
        case .routing: return "选择模型"
        case .running: return TaskStatus.running.label
        case .waitingApproval: return TaskStatus.waitingApproval.label
        default: return status.label
        }
    }

    /// One event as a short plain line for the island, or nil when it says nothing worth showing there.
    static func plainLine(_ event: TaskEvent) -> String? {
        let p = event.payload
        switch event.type {
        case "text":
            let text = MessageDisplay.readable(p["text"]?.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return text.isEmpty ? nil : text.split(separator: "\n").first.map(String.init)
        case "tool_call":
            return p["denied"] == nil ? MessageDisplay.readable(ToolDisplay.line(p)) : nil
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
        case "queued": return TaskStatus.queued.label
        default: return nil
        }
    }


    static func clip(_ text: String, _ limit: Int) -> String {
        let one = text.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
        return one.count > limit ? String(one.prefix(limit - 1)) + "…" : one
    }
}

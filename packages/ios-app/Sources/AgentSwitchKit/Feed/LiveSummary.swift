import AgentSwitchLive
import Foundation

/// Tasks, pending approvals and the live event tails, as the Live Activity's state (assistant-v0 §4).
public enum LiveSummary {
    public static let maxRows = 3
    static let titleChars = 28
    static let stepChars = 60
    static let endedChars = 90

    /// The tasks in progress, the ones waiting for you first, then the newest; nil when none is in progress.
    public static func state(tasks: [AgentTask], approvals: [Approval], threadTitles: [String: String],
                             tails: [String: [TaskEvent]] = [:]) -> LiveState? {
        let active = tasks.filter(\.status.isActive)
        guard !active.isEmpty else { return nil }
        let pending = Dictionary(grouping: approvals.filter { $0.status == .pending }, by: \.taskId)
        let rows = active.map { task -> LiveState.Row in
            let waitingOn = pending[task.id]?.first
            let needsYou = waitingOn != nil || task.status == .waitingApproval
            return LiveState.Row(id: task.id, title: title(task, threadTitles), step: step(task, waitingOn, tails[task.id] ?? []),
                                 model: task.model.map(shortModel), startedAt: task.created, needsYou: needsYou)
        }
        let ordered = rows.sorted { ($0.needsYou ? 0 : 1, $1.startedAt) < ($1.needsYou ? 0 : 1, $0.startedAt) }
        let waiting = rows.filter(\.needsYou).count
        return LiveState(rows: Array(ordered.prefix(maxRows)), running: rows.count - waiting, waiting: waiting)
    }

    /// The conclusion to show once nothing runs: the task that ended last (a cancelled one too, said as such).
    public static func ended(tasks: [AgentTask], threadTitles: [String: String]) -> LiveState.Ended? {
        guard let last = tasks.filter(\.status.isTerminal).max(by: { $0.updatedAt < $1.updatedAt }) else { return nil }
        let said = [last.spoken, last.speech, last.status == .done ? last.result : last.error ?? last.result]
            .compactMap { $0.map(Speech.speakable) }.first { !$0.isEmpty }
        return LiveState.Ended(taskId: last.id, title: title(last, threadTitles), line: clip(said ?? last.status.label, endedChars),
                               ok: last.status == .done)
    }

    static func title(_ task: AgentTask, _ threadTitles: [String: String]) -> String {
        if let id = task.threadId, let title = threadTitles[id], !title.isEmpty { return clip(title, titleChars) }
        return clip(MessageDisplay.readable(task.task), titleChars)
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

    static func plainStatus(_ status: TaskStatus) -> String {
        switch status {
        case .queued: return "排队中"
        case .routing: return "正在安排执行者"
        case .running: return "执行中"
        case .waitingApproval: return "等你答复"
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
            let tool = p["tool"]?.string ?? "工具"
            if let command = p["input"]?["command"]?.string ?? p["command"]?.string {
                return "在运行命令：" + MessageDisplay.readable(command)
            }
            return "在用工具 \(tool)"
        case "dispatched": return "交给 \(shortModel(p["model"]?.string ?? "执行者"))"
        case "routed":
            if let clarify = p["clarify"]?.string, !clarify.isEmpty { return "先问你：" + clarify }
            return "已选好执行者"
        case "step":
            switch p["action"]?.string {
            case "intake": return "已收到"
            case "plan": return "多步任务，正在规划"
            case "dispatch":
                let model = p["target"]?["model"]?.string.map(shortModel) ?? "执行者"
                return "第 \(p["n"]?.int ?? 1) 步：交给 \(model)"
            case "ask_user": return p["question"]?.string.map { "先问你：" + $0 }
            case "finish": return "收尾检查"
            default: return nil
            }
        case "redispatch": return "换个方式重试"
        case "attempt_failed": return "这次没成功，正在处理"
        case "queued": return "排队中"
        default: return nil
        }
    }

    /// `deepseek/deepseek-flash` → `deepseek-flash`; `claude-opus-5-5[1m]` stays as it is.
    static func shortModel(_ model: String) -> String {
        model.split(separator: "/").last.map(String.init) ?? model
    }

    static func clip(_ text: String, _ limit: Int) -> String {
        let one = text.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
        return one.count > limit ? String(one.prefix(limit - 1)) + "…" : one
    }
}

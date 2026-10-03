import Foundation

/// One human line per task event (ported from the iPhone Kit's EventDescriber), following the web console's `eventLine`
/// (packages/daemon/ui/views/task.js); unknown types fall back to `type {payload}`. Ciphertexts in a line show as 🔒密文.
public enum DispatchEventDescriber {
    public enum Tone: Sendable { case normal, muted, attention, success, failure }

    public static func line(_ ev: DispatchTaskEvent) -> String {
        DispatchMessageDisplay.readable(rawLine(ev))
    }

    private static func rawLine(_ ev: DispatchTaskEvent) -> String {
        let p = ev.payload
        switch ev.type {
        case "queued": return "排队"
        case "text": return p["text"]?.string ?? ""
        case "tool_call":
            let tool = p["tool"]?.string ?? "?"
            if let denied = p["denied"]?.string {
                return "已阻止：\(tool == "commandExecution" ? "命令" : DispatchToolDisplay.label(tool))" + (denied.contains("AgentSwitch") ? "（受保护的目录）" : "")
            }
            if tool == "claude", p["input"] == nil { return "调用工具" }   // before 2026-09-25 Claude's calls were only counted
            return DispatchToolDisplay.line(p)
        case "tool_result": return p["ok"]?.bool == false ? "失败：\(p["output"]?.string ?? "")" : (p["output"]?.string ?? "")
        case "routed":
            if let clarify = p["clarify"]?.string, !clarify.isEmpty { return "提问：\(clarify)" }
            let v = p["verdict"]
            return v?["ok"]?.bool == true ? "已选定 \(target(v))" : "无可用模型"
        case "dispatched":
            return "已交给 \(target(p))\(p["effort"]?.string.map { " · " + $0 } ?? "")"
        case "step": return stepLine(p)
        case "approval_request":
            if p["kind"]?.string == "question" {
                let texts = p["questions"]?.array?.compactMap { $0["text"]?.string } ?? [p["action"]?.string ?? ""]
                return "提问：\(texts.joined(separator: "；"))"
            }
            return "请求批准：\(p["action"]?.string ?? "")"
        case "approval_resolved":
            if p["decision"]?.string == "answer" { return "已回答：\(p["text"]?.string ?? "")" }
            // The executor cancelled its own request (control-v0 §4); the card is gone, the process says why.
            if p["decision"]?.string == "withdrawn" { return "已撤回（执行器已取消请求）" }
            let verdict = p["decision"]?.string == "allow" ? "已允许" : (p["kind"]?.string == "question" ? "未回答" : "已拒绝")
            let by = ["router": "（自动）", "timeout": "（超时）"][p["by"]?.string ?? ""] ?? ""
            return verdict + by
        case "attempt_failed":
            return "\(target(p)) 执行失败：\(p["kind"]?.string ?? "") \(p["excerpt"]?.string ?? "")"
        case "redispatch" where p["kind"]?.string == "provider_safety":
            return "原样重发" + (p["target"].flatMap { t in t["harness"]?.string.map { _ in " · " + target(t) } } ?? "")
        case "redispatch":
            let to = p["target"].flatMap { t in t["harness"]?.string.map { _ in target(t) } }
            return "改派 \(p["kind"]?.string ?? "")\(to.map { " → " + $0 } ?? "")"
        case "waiting": return "等待\(waitingText(p))"
        case "agent":
            let status = ["started": "开始", "progress": "进展", "completed": "完成", "failed": "失败"][p["status"]?.string ?? ""] ?? "停止"
            return "子任务\(status)：\(p["description"]?.string ?? p["agentId"]?.string ?? "")"
        case "handoff":
            let to = p["to"]?["harness"]?.string.map { _ in target(p["to"]) } ?? "重新选择"
            return "交接 → \(to)\(p["reason"]?.string.map { "（\($0)）" } ?? "")"
        case "thread": return "归入话题"
        case "summary":
            return p["ok"]?.bool == true ? "话题标题：「\(p["title"]?.string ?? "")」" : "话题摘要未更新：\(p["error"]?.string ?? "")"
        case "sealed":
            let entries = p["entries"]?.array?.compactMap { $0["field"]?.string ?? $0["label"]?.string } ?? []
            return "已加密：\(entries.joined(separator: "；"))"
        case "supervisor": return supervisorLine(p)
        case "refusal" where p["reason"]?.string == "provider_safety":
            return p["action"]?.string == "retry" ? "服务商安全拦截：原样重发一次（新会话、同一模型）"
                : "服务商安全拦截：已停止\(p["note"]?.string.map { " · " + $0 } ?? "")"
        case "refusal": return "模型拒绝\(p["note"]?.string.map { " · " + $0 } ?? "")"
        case "done":
            let result = p["result"]?.string ?? ""
            return result.count > 200 || result.isEmpty ? "已完成" : "已完成：\(result)"
        case "partial": return "未完成：\(p["error"]?.string ?? joined(p["remaining"]) ?? "尚有未处理的事项")"
        case "blocked" where p["cause"]?.string == "interrupted":
            return "未完成：\(p["error"]?.string ?? DispatchTask.interruptedText)"
        case "blocked": return "已停止：\(p["error"]?.string ?? joined(p["remaining"]) ?? "")"
        case "failed": return "失败：\(p["error"]?.string ?? "")\(p["security"]?.bool == true ? "（安全事件）" : "")"
        case "cancelled": return "已取消"
        case "rated": return "评价：\(p["rating"]?.int.map { $0 > 0 ? "有用" : "无用" } ?? "已清除")"
        case "feedback": return feedbackLine(p)
        case "checkpoint":
            let purpose = ["research": "调研", "do": "执行", "verify": "复查"][p["purpose"]?.string ?? ""] ?? (p["purpose"]?.string ?? "")
            return "已保存进展 · \(purpose) · \(p["ok"]?.bool == true ? "本步已结束" : "本步未完成")"
        case "cleaned":
            let kept = p["artifacts"]?.int.flatMap { $0 > 0 ? "，保留 \($0) 个文件" : nil } ?? ""
            return "已清理临时目录\(kept)"
        default: return "\(ev.type) \(String(p.compactText.prefix(160)))"
        }
    }

    /// `/bin/zsh -lc 'ps -A | head'` → `ps -A | head`: Codex wraps every command in a login shell.
    public static func unwrapShell(_ command: String) -> String {
        let pattern = #"^(?:/bin/|/usr/bin/)?(?:zsh|bash|sh) -l?c (['"])([\s\S]*)\1$"#
        guard let match = command.range(of: pattern, options: .regularExpression) else { return command }
        let inner = command[match].replacingOccurrences(of: pattern, with: "$2", options: .regularExpression)
        return inner.isEmpty ? command : inner
    }

    /// The supervisor's decisions: an approval let through, refused or left to you (the command, and why), a question
    /// answered or passed on, a check on a quiet task, a result accepted or not.
    private static func supervisorLine(_ p: DispatchJSON) -> String {
        let reason = p["reason"]?.string.map(reasonText)
        switch p["kind"]?.string {
        case "approval":
            let action = p["action"]?.string ?? ""
            let what = action.hasPrefix("Bash: ") ? String(action.dropFirst(6)) : action
            let verdict = ["allow": "已放行", "deny": "已拒绝"][p["decision"]?.string ?? ""] ?? "交由你确认"
            let subject = what.isEmpty ? "" : "：\(what)"
            return "\(verdict)\(subject)\(reason.map { "（\($0)）" } ?? "")"
        case "question":
            if p["answered"]?.bool == true { return "问题已自动回答" + (p["text"]?.string.map { "：" + $0 } ?? "") }
            return "问题交由你回答" + (reason.map { "（\($0)）" } ?? "")
        case "checkin":
            let quiet = p["silentMs"]?.number.map { "（\(Int(($0 / 1000).rounded())) 秒无输出）" } ?? ""
            let next = ["continue": "继续等待", "cancel": "取消本次执行并改派"][p["action"]?.string ?? ""] ?? "交由你决定"
            return "进度检查\(quiet)：\(next)\(p["note"]?.string.map { "，" + $0 } ?? "")"
        case "acceptance":
            if p["accepted"]?.bool == true { return "验收通过" }
            let missing = joined(p["missing"]) ?? p["note"]?.string ?? ""
            return "验收未通过" + (missing.isEmpty ? "" : "：" + missing)
        default:
            return "复核：\(p["kind"]?.string ?? "")\(reason.map { "，" + $0 } ?? "")"
        }
    }

    /// The daemon's fixed English reasons (engine/taskLoop.ts, engine/approvalPolicy.ts); anything else is shown as is.
    private static let reasons = [
        "research step is read-only": "只读步骤，不可执行此操作",
        "verify step is read-only": "只读步骤，不可执行此操作",
        "a command that only reads, in a read-only step": "只读命令",
        "skip-permissions mode": "跳过权限模式",
        "skip mode": "跳过权限模式",
        "manual mode": "逐项确认模式",
        "auto mode": "全部自动模式",
        "scoped mode, not reserved": "自动模式，不属于保留类别",
    ]

    /// Categories the user keeps in scoped mode (engine/approvalPolicy.ts CATEGORIES), for "reserved: delete, git_push".
    private static let categories = [
        "delete": "删除", "outside_cwd": "工作目录以外的写入", "shell": "shell 命令", "git_push": "git push",
        "irreversible": "不可撤销的操作", "browser": "浏览器提交",
    ]

    static func reasonText(_ reason: String) -> String {
        if let known = reasons[reason] { return known }
        guard reason.hasPrefix("reserved: ") else { return reason }
        let kept = reason.dropFirst("reserved: ".count).split(separator: ",").map { item in
            let key = item.trimmingCharacters(in: .whitespaces)
            return categories[key] ?? key
        }
        return "保留类别：" + kept.joined(separator: "、")
    }

    /// `{harness, model}` as people say it: "Opus 5.5 · Claude Code"; a model without a harness is its name alone.
    private static func target(_ p: DispatchJSON?) -> String {
        let model = p?["model"]?.string.map(ModelName.display)
        let harness = p?["harness"]?.string.map(HarnessName.display)
        let line = [model, harness].compactMap { $0 }.joined(separator: " · ")
        return line.isEmpty ? "?" : line
    }

    public static func tone(_ ev: DispatchTaskEvent) -> Tone {
        switch ev.type {
        case "approval_request": return .attention
        case "done": return .success
        case "step" where ev.payload["source"]?.string == "error": return .failure
        case "refusal" where ev.payload["action"]?.string == "retry": return .muted
        case "blocked" where ev.payload["cause"]?.string == "interrupted": return .muted
        case "failed", "attempt_failed", "refusal", "blocked": return .failure
        case "text": return .normal
        default: return .muted
        }
    }

    private static func stepLine(_ p: DispatchJSON) -> String {
        let n = p["n"]?.int.map(String.init) ?? "?"
        switch p["action"]?.string {
        case "intake":
            return "已接收" + (p["sealingMs"]?.number.map { " · 加密敏感字段 \(seconds($0)) 秒" } ?? "")
        case "plan" where p["source"]?.string == "error": return planningFailure(p)
        case "plan" where p["source"]?.string == "retry":
            return "规划调用超时\(p["timeoutMs"]?.number.map { "（\(Int(($0 / 1000).rounded())) 秒）" } ?? "")，正在重试一次"
        case "plan": return "多步任务，由 \(p["model"]?.string.map(ModelName.display) ?? "?") 规划\(p["reason"]?.string.map { "：" + $0 } ?? "")"
        case "dispatch":
            guard let to = p["target"].flatMap({ t in t["harness"]?.string.map { _ in target(t) } }) else { return "第 \(n) 步：无可用模型" }
            return "第 \(n) 步：交由 \(to) 执行"
        case "ask_user": return "第 \(n) 步：询问「\(p["question"]?.string ?? "")」"
        case "finish": return "第 \(n) 步：收尾检查"
        case let action?: return "第 \(n) 步：\(action)"
        case nil: return "第 \(n) 步"
        }
    }

    /// Same wording as the web console's `planningFailure`: stage, model, the structured kind, time, tries, and the
    /// daemon's fixed diagnostic (never raw provider text, loop-v0).
    private static func planningFailure(_ p: DispatchJSON) -> String {
        let stage = ["initial", "initial_plan"].contains(p["stage"]?.string ?? "") ? "初次规划"
            : ["next", "next_action"].contains(p["stage"]?.string ?? "") ? "下一步规划" : "规划"
        let kinds = ["timeout": "调用超时", "invalid_response": "回复格式无效", "service_error": "服务调用失败", "cancelled": "已取消"]
        let kind = kinds[p["failureKind"]?.string ?? ""] ?? "未返回有效动作"
        let timing = p["routerMs"]?.number.flatMap { $0 >= 0 ? " · 耗时 \(seconds($0)) 秒" : nil } ?? ""
        let tries = p["tries"]?.int.flatMap { $0 >= 0 ? " · 尝试 \($0) 次" : nil } ?? ""
        let detail = p["routerError"]?.string ?? p["note"]?.string ?? ""
        return "\(stage)已停止 · \(p["model"]?.string.map(ModelName.display) ?? "未指定模型") · \(kind)\(timing)\(tries)\(detail.isEmpty ? "" : "\n原因：" + detail)"
    }

    /// The receipt only: the question and the answer are in the events next to it.
    private static func feedbackLine(_ p: DispatchJSON) -> String {
        guard p["version"]?.int == 1, ["user", "router"].contains(p["source"]?.string ?? ""),
              ["answered", "unanswered"].contains(p["status"]?.string ?? "") else { return "反馈记录（格式待核对）" }
        guard p["status"]?.string == "answered" else { return "反馈待答复" }
        return "反馈已记录（\(p["source"]?.string == "user" ? "手动确认" : "自动答复")），后续任务将参考"
    }

    private static func seconds(_ ms: Double) -> String { String(format: "%.1f", ms / 1000) }

    private static func waitingText(_ p: DispatchJSON) -> String {
        switch p["for"]?.string {
        case "parent": return "上一个任务结束"
        case "thread": return "同一话题的另一个任务"
        case "cwd": return "同一目录的另一个任务"
        case "global": return "空闲名额（同时运行的任务已满）"
        case let what? where what.hasPrefix("harness:"): return " \(HarnessName.display(String(what.dropFirst(8)))) 空闲"
        case let what?: return what
        case nil: return ""
        }
    }

    private static func joined(_ value: DispatchJSON?) -> String? {
        guard let items = value?.array?.compactMap(\.string), !items.isEmpty else { return nil }
        return items.joined(separator: "；")
    }
}

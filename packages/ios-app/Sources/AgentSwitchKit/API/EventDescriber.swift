import Foundation

/// One human line per task event, following the web console's `eventLine` (packages/daemon/ui/views/task.js) for the
/// events a phone needs; unknown types fall back to `type {payload}`. Ciphertexts in a line show as 🔒密文.
public enum EventDescriber {
    public enum Tone: Sendable { case normal, muted, attention, success, failure }

    public static func line(_ ev: TaskEvent) -> String {
        MessageDisplay.readable(rawLine(ev))
    }

    private static func rawLine(_ ev: TaskEvent) -> String {
        let p = ev.payload
        switch ev.type {
        case "queued": return "已排队"
        case "text": return p["text"]?.string ?? ""
        case "tool_call":
            let detail = p["command"]?.string ?? p["input"].map { String($0.compactText.prefix(160)) } ?? ""
            return "工具 \(p["tool"]?.string ?? "?")\(detail.isEmpty ? "" : ": " + detail)"
        case "routed":
            if let clarify = p["clarify"]?.string, !clarify.isEmpty { return "路由器先问你：\(clarify)" }
            let v = p["verdict"]
            let target = v?["ok"]?.bool == true ? "\(v?["harness"]?.string ?? "?")/\(v?["model"]?.string ?? "?")" : "无目标"
            return "路由 → \(target)（\(p["source"]?.string ?? "")）"
        case "dispatched":
            let effort = p["effort"]?.string.map { " effort=\($0)" } ?? ""
            return "派发 \(p["harness"]?.string ?? "?")/\(p["model"]?.string ?? "?")\(effort)"
        case "step": return stepLine(p)
        case "approval_request":
            if p["kind"]?.string == "question" {
                let who = p["source"]?.string == "executor" ? "执行者" : "路由器"
                let texts = p["questions"]?.array?.compactMap { $0["text"]?.string } ?? [p["action"]?.string ?? ""]
                return "\(who)问你：\(texts.joined(separator: "；"))"
            }
            return "需要审批：\(p["action"]?.string ?? "")"
        case "approval_resolved":
            if p["decision"]?.string == "answer" { return "你答了：\(p["text"]?.string ?? "")" }
            let what = p["kind"]?.string == "question" ? "问题" : "审批"
            let verdict = p["decision"]?.string == "allow" ? "允许" : (p["kind"]?.string == "question" ? "没答" : "拒绝")
            let by = ["router": "路由器代批", "timeout": "超时"][p["by"]?.string ?? ""] ?? "你"
            return "\(what) → \(verdict)（\(by)）"
        case "attempt_failed":
            return "失败 \(p["harness"]?.string ?? "?")/\(p["model"]?.string ?? "?")：\(p["kind"]?.string ?? "") \(p["excerpt"]?.string ?? "")"
        case "redispatch" where p["kind"]?.string == "provider_safety":
            return "原样重发" + (p["target"].flatMap { t in t["harness"]?.string.map { " → \($0)/\(t["model"]?.string ?? "?")" } } ?? "")
        case "redispatch":
            let target = p["target"].flatMap { t in t["harness"]?.string.map { "\($0)/\(t["model"]?.string ?? "?")" } }
            return "重派 \(p["kind"]?.string ?? "")\(target.map { " → " + $0 } ?? "")"
        case "waiting": return "等待 \(waitingText(p))"
        case "agent":
            let status = ["started": "启动", "progress": "进展", "completed": "完成", "failed": "失败"][p["status"]?.string ?? ""] ?? "停止"
            return "子 agent \(status)：\(p["description"]?.string ?? p["agentId"]?.string ?? "")"
        case "handoff":
            let to = p["to"]?["harness"]?.string.map { "\($0)/\(p["to"]?["model"]?.string ?? "?")" } ?? "由路由器选"
            return "交接 → \(to)（\(p["reason"]?.string ?? "")）"
        case "thread": return "归入线程 \(p["threadId"]?.string ?? "")"
        case "summary":
            return p["ok"]?.bool == true ? "线程摘要已更新：「\(p["title"]?.string ?? "")」" : "线程摘要失败：\(p["error"]?.string ?? "")"
        case "sealed":
            let entries = p["entries"]?.array?.compactMap { $0["field"]?.string ?? $0["label"]?.string } ?? []
            return "已做密文：\(entries.joined(separator: "；"))"
        case "supervisor": return "监督者：\(p["kind"]?.string ?? "")\(p["reason"]?.string.map { "，" + $0 } ?? "")"
        case "refusal" where p["reason"]?.string == "provider_safety":
            return p["action"]?.string == "retry" ? "服务商安全拦截：原样重发一次（新会话、同一模型）"
                : "服务商安全拦截：已停止\(p["note"]?.string.map { " · " + $0 } ?? "")"
        case "refusal": return "模型拒绝\(p["note"]?.string.map { " · " + $0 } ?? "")"
        case "done":
            let result = p["result"]?.string ?? ""
            return result.count > 200 ? "完成（结果见上方）" : "完成：\(result)"
        case "partial": return "部分完成：\(p["error"]?.string ?? joined(p["remaining"]) ?? "还有事项待处理")"
        case "blocked": return "执行已停止：\(p["error"]?.string ?? joined(p["remaining"]) ?? "请查看进展")"
        case "failed": return "失败：\(p["error"]?.string ?? "")\(p["security"]?.bool == true ? " [安全事件]" : "")"
        case "cancelled": return "已取消"
        case "rated": return "评价：\(p["rating"]?.int.map { $0 > 0 ? "👍" : "👎" } ?? "清除")"
        case "feedback": return feedbackLine(p)
        case "checkpoint":
            let purpose = ["research": "调研", "do": "执行", "verify": "复查"][p["purpose"]?.string ?? ""] ?? (p["purpose"]?.string ?? "")
            return "已保存步骤进展 · \(purpose) · \(p["ok"]?.bool == true ? "本步结束" : "本步未完成")"
        case "cleaned":
            let kept = p["artifacts"]?.int.flatMap { $0 > 0 ? "（产物 \($0) 个已保留）" : nil } ?? ""
            return "已清理临时目录\(kept)"
        default: return "\(ev.type) \(String(p.compactText.prefix(160)))"
        }
    }

    public static func tone(_ ev: TaskEvent) -> Tone {
        switch ev.type {
        case "approval_request": return .attention
        case "done": return .success
        case "step" where ev.payload["source"]?.string == "error": return .failure
        case "refusal" where ev.payload["action"]?.string == "retry": return .muted
        case "failed", "attempt_failed", "refusal", "blocked": return .failure
        case "text": return .normal
        default: return .muted
        }
    }

    private static func stepLine(_ p: JSONValue) -> String {
        let n = p["n"]?.int.map(String.init) ?? "?"
        switch p["action"]?.string {
        case "intake":
            return "消息接收完成" + (p["sealingMs"]?.number.map { " · 敏感字段识别与加密 \(seconds($0)) 秒" } ?? "")
        case "plan" where p["source"]?.string == "error": return planningFailure(p)
        case "plan": return "多步任务，交给规划模型 \(p["model"]?.string ?? "")\(p["reason"]?.string.map { "：" + $0 } ?? "")"
        case "dispatch":
            let target = p["target"].flatMap { t in t["harness"]?.string.map { "\($0)/\(t["model"]?.string ?? "?")" } } ?? "无目标"
            return "第 \(n) 步：派发 → \(target)"
        case "ask_user": return "第 \(n) 步：问你：\(p["question"]?.string ?? "")"
        case "finish": return "第 \(n) 步：提交收尾判断"
        case let action?: return "第 \(n) 步：\(action)"
        case nil: return "第 \(n) 步"
        }
    }

    /// Same wording as the web console's `planningFailure`: stage, model, the structured kind, time, tries, and the
    /// daemon's fixed diagnostic (never raw provider text, loop-v0).
    private static func planningFailure(_ p: JSONValue) -> String {
        let stage = ["initial", "initial_plan"].contains(p["stage"]?.string ?? "") ? "初次规划"
            : ["next", "next_action"].contains(p["stage"]?.string ?? "") ? "下一步规划" : "规划"
        let kinds = ["timeout": "调用超时", "invalid_response": "回复格式无效", "service_error": "服务调用失败", "cancelled": "已取消"]
        let kind = kinds[p["failureKind"]?.string ?? ""] ?? "未返回有效动作"
        let timing = p["routerMs"]?.number.flatMap { $0 >= 0 ? " · 耗时 \(seconds($0)) 秒" : nil } ?? ""
        let tries = p["tries"]?.int.flatMap { $0 >= 0 ? " · 尝试 \($0) 次" : nil } ?? ""
        let detail = p["routerError"]?.string ?? p["note"]?.string ?? ""
        return "\(stage)已停止 · \(p["model"]?.string ?? "未指定模型") · \(kind)\(timing)\(tries)\(detail.isEmpty ? "" : "\n原因：" + detail)"
    }

    /// The receipt only: the question and the answer are in the events next to it.
    private static func feedbackLine(_ p: JSONValue) -> String {
        guard p["version"]?.int == 1, ["user", "router"].contains(p["source"]?.string ?? ""),
              ["answered", "unanswered"].contains(p["status"]?.string ?? "") else { return "反馈记录（格式待核对）" }
        guard p["status"]?.string == "answered" else { return "反馈待答复 · 尚无有效答复" }
        return "反馈已记录（\(p["source"]?.string == "user" ? "用户确认" : "路由器答复")）· 已加入后续上下文"
    }

    private static func seconds(_ ms: Double) -> String { String(format: "%.1f", ms / 1000) }

    private static func waitingText(_ p: JSONValue) -> String {
        switch p["for"]?.string {
        case "parent": return "父任务 \(p["taskId"]?.string ?? "") 结束"
        case "thread": return "同线程的另一个任务"
        case "cwd": return "同目录的另一个任务"
        case "global": return "并发槽位（已达上限）"
        case let what? where what.hasPrefix("harness:"): return "\(what.dropFirst(8)) 的空闲槽位"
        case let what?: return what
        case nil: return ""
        }
    }

    private static func joined(_ value: JSONValue?) -> String? {
        guard let items = value?.array?.compactMap(\.string), !items.isEmpty else { return nil }
        return items.joined(separator: "；")
    }
}

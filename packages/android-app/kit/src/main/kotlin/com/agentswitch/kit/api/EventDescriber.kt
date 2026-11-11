package com.agentswitch.kit.api

import com.agentswitch.kit.feed.MessageDisplay
import com.agentswitch.kit.feed.ModelName
import com.agentswitch.kit.support.JSONValue
import java.math.BigDecimal
import java.math.RoundingMode

/**
 * One human line per task event, following the web console's `eventLine` (packages/daemon/ui/views/task.js) for the
 * events a phone needs; unknown types fall back to `type {payload}`. Ciphertexts in a line show as 🔒密文.
 */
object EventDescriber {
    enum class Tone { Normal, Muted, Attention, Success, Failure }

    fun line(ev: TaskEvent): String = MessageDisplay.readable(rawLine(ev))

    private fun rawLine(ev: TaskEvent): String {
        val p = ev.payload
        return when (ev.type) {
            "queued" -> "排队"
            "text" -> p["text"]?.string ?: ""
            "tool_call" -> {
                val tool = p["tool"]?.string ?: "?"
                val denied = p["denied"]?.string
                if (denied != null) {
                    "已阻止：${if (tool == "commandExecution") "命令" else ToolDisplay.label(tool)}" + (if (denied.contains("AgentSwitch")) "（受保护的目录）" else "")
                } else if (tool == "claude" && p["input"] == null) {
                    "调用工具" // before 2026-09-25 Claude's calls were only counted
                } else {
                    ToolDisplay.line(p)
                }
            }
            "tool_result" -> if (p["ok"]?.bool == false) "失败：${p["output"]?.string ?: ""}" else (p["output"]?.string ?: "")
            "routed" -> {
                val clarify = p["clarify"]?.string
                if (clarify != null && clarify.isNotEmpty()) {
                    "提问：$clarify"
                } else {
                    val v = p["verdict"]
                    if (v?.get("ok")?.bool == true) "已选定 ${target(v)}" else "无可用模型"
                }
            }
            "dispatched" -> "已交给 ${target(p)}${p["effort"]?.string?.let { " · $it" } ?: ""}"
            "step" -> stepLine(p)
            "approval_request" -> {
                if (p["kind"]?.string == "question") {
                    val texts = p["questions"]?.array?.mapNotNull { it["text"]?.string } ?: listOf(p["action"]?.string ?: "")
                    "提问：${texts.joinToString("；")}"
                } else {
                    "请求批准：${p["action"]?.string ?: ""}"
                }
            }
            "approval_resolved" -> {
                if (p["decision"]?.string == "answer") {
                    "已回答：${p["text"]?.string ?: ""}"
                } else if (p["decision"]?.string == "withdrawn") {
                    // The executor cancelled its own request (control-v0 §4); the card is gone, the process says why.
                    "已撤回（执行器已取消请求）"
                } else {
                    val verdict = if (p["decision"]?.string == "allow") "已允许" else if (p["kind"]?.string == "question") "未回答" else "已拒绝"
                    val by = mapOf("router" to "（自动）", "timeout" to "（超时）")[p["by"]?.string ?: ""] ?: ""
                    verdict + by
                }
            }
            "attempt_failed" -> "${target(p)} 执行失败：${p["kind"]?.string ?: ""} ${p["excerpt"]?.string ?: ""}"
            "redispatch" -> {
                if (p["kind"]?.string == "provider_safety") {
                    "原样重发" + (p["target"]?.let { t -> t["harness"]?.string?.let { " · " + target(t) } } ?: "")
                } else {
                    val to = p["target"]?.let { t -> t["harness"]?.string?.let { target(t) } }
                    "改派 ${p["kind"]?.string ?: ""}${to?.let { " → $it" } ?: ""}"
                }
            }
            "waiting" -> "等待${waitingText(p)}"
            "agent" -> {
                val status = mapOf("started" to "开始", "progress" to "进展", "completed" to "完成", "failed" to "失败")[p["status"]?.string ?: ""] ?: "停止"
                "子任务$status：${p["description"]?.string ?: p["agentId"]?.string ?: ""}"
            }
            "handoff" -> {
                val to = p["to"]?.get("harness")?.string?.let { target(p["to"]) } ?: "重新选择"
                "交接 → $to${p["reason"]?.string?.let { "（$it）" } ?: ""}"
            }
            "thread" -> "归入话题"
            "summary" -> if (p["ok"]?.bool == true) "话题标题：「${p["title"]?.string ?: ""}」" else "话题摘要未更新：${p["error"]?.string ?: ""}"
            "sealed" -> {
                val entries = p["entries"]?.array?.mapNotNull { it["field"]?.string ?: it["label"]?.string } ?: emptyList()
                "已加密：${entries.joinToString("；")}"
            }
            "supervisor" -> supervisorLine(p)
            "refusal" -> {
                if (p["reason"]?.string == "provider_safety") {
                    if (p["action"]?.string == "retry") "服务商安全拦截：原样重发一次（新会话、同一模型）"
                    else "服务商安全拦截：已停止${p["note"]?.string?.let { " · $it" } ?: ""}"
                } else {
                    "模型拒绝${p["note"]?.string?.let { " · $it" } ?: ""}"
                }
            }
            "done" -> {
                val result = p["result"]?.string ?: ""
                if (result.graphemeCount() > 200 || result.isEmpty()) "已完成" else "已完成：$result"
            }
            "partial" -> "未完成：${p["error"]?.string ?: joined(p["remaining"]) ?: "尚有未处理的事项"}"
            "blocked" -> {
                if (p["cause"]?.string == "interrupted") "未完成：${p["error"]?.string ?: AgentTask.interruptedText}"
                else "已停止：${p["error"]?.string ?: joined(p["remaining"]) ?: ""}"
            }
            "failed" -> "失败：${p["error"]?.string ?: ""}${if (p["security"]?.bool == true) "（安全事件）" else ""}"
            "cancelled" -> "已取消"
            "rated" -> "评价：${p["rating"]?.int?.let { if (it > 0) "有用" else "无用" } ?: "已清除"}"
            "feedback" -> feedbackLine(p)
            "checkpoint" -> {
                val purpose = mapOf("research" to "调研", "do" to "执行", "verify" to "复查")[p["purpose"]?.string ?: ""] ?: (p["purpose"]?.string ?: "")
                "已保存进展 · $purpose · ${if (p["ok"]?.bool == true) "本步已结束" else "本步未完成"}"
            }
            "cleaned" -> {
                val kept = p["artifacts"]?.int?.let { if (it > 0) "，保留 $it 个文件" else null } ?: ""
                "已清理临时目录$kept"
            }
            else -> "${ev.type} ${p.compactText.graphemePrefix(160)}"
        }
    }

    /** `/bin/zsh -lc 'ps -A | head'` → `ps -A | head`: Codex wraps every command in a login shell. */
    fun unwrapShell(command: String): String {
        val match = shellWrapper.find(command) ?: return command
        val inner = match.groupValues[2]
        return if (inner.isEmpty()) command else inner
    }

    private val shellWrapper = Regex("""^(?:/bin/|/usr/bin/)?(?:zsh|bash|sh) -l?c (['"])([\s\S]*)\1$""")

    /**
     * The supervisor's decisions: an approval let through, refused or left to you (the command, and why), a question
     * answered or passed on, a check on a quiet task, a result accepted or not.
     */
    private fun supervisorLine(p: JSONValue): String {
        val reason = p["reason"]?.string?.let(::reasonText)
        return when (p["kind"]?.string) {
            "approval" -> {
                val action = p["action"]?.string ?: ""
                val what = if (action.startsWith("Bash: ")) action.drop(6) else action
                val verdict = mapOf("allow" to "已放行", "deny" to "已拒绝")[p["decision"]?.string ?: ""] ?: "交由你确认"
                val subject = if (what.isEmpty()) "" else "：$what"
                "$verdict$subject${reason?.let { "（$it）" } ?: ""}"
            }
            "question" -> {
                if (p["answered"]?.bool == true) "问题已自动回答" + (p["text"]?.string?.let { "：$it" } ?: "")
                else "问题交由你回答" + (reason?.let { "（$it）" } ?: "")
            }
            "checkin" -> {
                val quiet = p["silentMs"]?.number?.let { "（${roundAway(it / 1000)} 秒无输出）" } ?: ""
                val next = mapOf("continue" to "继续等待", "cancel" to "取消本次执行并改派")[p["action"]?.string ?: ""] ?: "交由你决定"
                "进度检查$quiet：$next${p["note"]?.string?.let { "，$it" } ?: ""}"
            }
            "acceptance" -> {
                if (p["accepted"]?.bool == true) {
                    "验收通过"
                } else {
                    val missing = joined(p["missing"]) ?: p["note"]?.string ?: ""
                    "验收未通过" + (if (missing.isEmpty()) "" else "：$missing")
                }
            }
            else -> "复核：${p["kind"]?.string ?: ""}${reason?.let { "，$it" } ?: ""}"
        }
    }

    /** The daemon's fixed English reasons (engine/taskLoop.ts, engine/approvalPolicy.ts); anything else is shown as is. */
    private val reasons = mapOf(
        "research step is read-only" to "只读步骤，不可执行此操作",
        "verify step is read-only" to "只读步骤，不可执行此操作",
        "a command that only reads, in a read-only step" to "只读命令",
        "skip-permissions mode" to "跳过权限模式",
        "skip mode" to "跳过权限模式",
        "manual mode" to "逐项确认模式",
        "auto mode" to "全部自动模式",
        "scoped mode, not reserved" to "自动模式，不属于保留类别",
    )

    /** Categories the user keeps in scoped mode (engine/approvalPolicy.ts CATEGORIES), for "reserved: delete, git_push". */
    private val categories = mapOf(
        "delete" to "删除", "outside_cwd" to "工作目录以外的写入", "shell" to "shell 命令", "git_push" to "git push",
        "irreversible" to "不可撤销的操作", "browser" to "浏览器提交",
    )

    internal fun reasonText(reason: String): String {
        reasons[reason]?.let { return it }
        if (!reason.startsWith("reserved: ")) return reason
        val kept = reason.drop("reserved: ".length).split(",").filter { it.isNotEmpty() }.map { item ->
            val key = item.trim { it.isHorizontalSpace() }
            categories[key] ?: key
        }
        return "保留类别：" + kept.joinToString("、")
    }

    /** `{harness, model}` as people say it: "Opus 5.5 · Claude Code"; a model without a harness is its name alone. */
    private fun target(p: JSONValue?): String {
        val model = p?.get("model")?.string?.let(ModelName::display)
        val harness = p?.get("harness")?.string?.let(ModelName::harness)
        val line = listOfNotNull(model, harness).joinToString(" · ")
        return line.ifEmpty { "?" }
    }

    fun tone(ev: TaskEvent): Tone {
        val p = ev.payload
        return when {
            ev.type == "approval_request" -> Tone.Attention
            ev.type == "done" -> Tone.Success
            ev.type == "step" && p["source"]?.string == "error" -> Tone.Failure
            ev.type == "refusal" && p["action"]?.string == "retry" -> Tone.Muted
            ev.type == "blocked" && p["cause"]?.string == "interrupted" -> Tone.Muted
            ev.type in setOf("failed", "attempt_failed", "refusal", "blocked") -> Tone.Failure
            ev.type == "text" -> Tone.Normal
            else -> Tone.Muted
        }
    }

    private fun stepLine(p: JSONValue): String {
        val n = p["n"]?.int?.toString() ?: "?"
        val action = p["action"]?.string
        return when {
            action == "intake" -> "已接收" + (p["sealingMs"]?.number?.let { " · 加密敏感字段 ${seconds(it)} 秒" } ?: "")
            action == "plan" && p["source"]?.string == "error" -> planningFailure(p)
            action == "plan" && p["source"]?.string == "retry" ->
                "规划调用超时${p["timeoutMs"]?.number?.let { "（${roundAway(it / 1000)} 秒）" } ?: ""}，正在重试一次"
            action == "plan" -> "多步任务，由 ${p["model"]?.string?.let(ModelName::display) ?: "?"} 规划${p["reason"]?.string?.let { "：$it" } ?: ""}"
            action == "dispatch" -> {
                val to = p["target"]?.let { t -> t["harness"]?.string?.let { target(t) } }
                if (to == null) "第 $n 步：无可用模型" else "第 $n 步：交由 $to 执行"
            }
            action == "ask_user" -> "第 $n 步：询问「${p["question"]?.string ?: ""}」"
            action == "finish" -> "第 $n 步：收尾检查"
            action != null -> "第 $n 步：$action"
            else -> "第 $n 步"
        }
    }

    /**
     * Same wording as the web console's `planningFailure`: stage, model, the structured kind, time, tries, and the
     * daemon's fixed diagnostic (never raw provider text, loop-v0).
     */
    private fun planningFailure(p: JSONValue): String {
        val s = p["stage"]?.string ?: ""
        val stage = if (s in listOf("initial", "initial_plan")) "初次规划" else if (s in listOf("next", "next_action")) "下一步规划" else "规划"
        val kinds = mapOf("timeout" to "调用超时", "invalid_response" to "回复格式无效", "service_error" to "服务调用失败", "cancelled" to "已取消")
        val kind = kinds[p["failureKind"]?.string ?: ""] ?: "未返回有效动作"
        val timing = p["routerMs"]?.number?.let { if (it >= 0) " · 耗时 ${seconds(it)} 秒" else null } ?: ""
        val tries = p["tries"]?.int?.let { if (it >= 0) " · 尝试 $it 次" else null } ?: ""
        val detail = p["routerError"]?.string ?: p["note"]?.string ?: ""
        return "${stage}已停止 · ${p["model"]?.string?.let(ModelName::display) ?: "未指定模型"} · $kind$timing$tries${if (detail.isEmpty()) "" else "\n原因：$detail"}"
    }

    /** The receipt only: the question and the answer are in the events next to it. */
    private fun feedbackLine(p: JSONValue): String {
        if (p["version"]?.int != 1 || (p["source"]?.string ?: "") !in listOf("user", "router") ||
            (p["status"]?.string ?: "") !in listOf("answered", "unanswered")
        ) return "反馈记录（格式待核对）"
        if (p["status"]?.string != "answered") return "反馈待答复"
        return "反馈已记录（${if (p["source"]?.string == "user") "手动确认" else "自动答复"}），后续任务将参考"
    }

    /** `String(format: "%.1f", ms / 1000)`: the exact binary value rounded, ties to even, as C does. */
    private fun seconds(ms: Double): String =
        BigDecimal(ms / 1000).setScale(1, RoundingMode.HALF_EVEN).toPlainString()

    /** Swift's `Int(x.rounded())`: halves away from zero. */
    private fun roundAway(x: Double): Long = if (x < 0) -Math.round(-x) else Math.round(x)

    private fun waitingText(p: JSONValue): String {
        val what = p["for"]?.string ?: return ""
        return when {
            what == "parent" -> "上一个任务结束"
            what == "thread" -> "同一话题的另一个任务"
            what == "cwd" -> "同一目录的另一个任务"
            what == "global" -> "空闲名额（同时运行的任务已满）"
            what.startsWith("harness:") -> " ${ModelName.harness(what.drop(8))} 空闲"
            else -> what
        }
    }

    private fun joined(value: JSONValue?): String? {
        val items = value?.array?.mapNotNull { it.string }
        if (items == null || items.isEmpty()) return null
        return items.joinToString("；")
    }
}

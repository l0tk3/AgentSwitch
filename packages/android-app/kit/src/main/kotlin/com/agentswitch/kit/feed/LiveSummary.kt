package com.agentswitch.kit.feed

import com.agentswitch.kit.api.AgentTask
import com.agentswitch.kit.api.Approval
import com.agentswitch.kit.api.ApprovalStatus
import com.agentswitch.kit.api.TaskEvent
import com.agentswitch.kit.api.TaskStatus
import com.agentswitch.kit.api.TerminalInfo
import com.agentswitch.kit.api.TerminalStatus
import com.agentswitch.kit.api.ToolDisplay
import com.agentswitch.kit.api.graphemeCount
import com.agentswitch.kit.api.graphemePrefix
import com.agentswitch.kit.api.isHorizontalSpace
import com.agentswitch.kit.api.isUnicodeWhitespace
import com.agentswitch.kit.api.splitNewlines
import com.agentswitch.kit.live.LiveState

/**
 * Tasks, pending approvals, the live event tails and the terminals waiting for you, as the Live Activity's state
 * (assistant-v0 §4); on Android, of the ongoing notification.
 */
object LiveSummary {
    const val maxRows = 3
    internal const val titleChars = 28
    internal const val stepChars = 60
    internal const val endedChars = 90

    /**
     * The tasks in progress and the terminals at work or waiting for you (terminal-v0 §1), the ones waiting first, then
     * the newest; null when there are none. A terminal at work counts as a task in progress (2026-09-30, user: 实时活动应该
     * 包括终端里的活动); an idle or ended one does not.
     */
    fun state(
        tasks: List<AgentTask>,
        approvals: List<Approval>,
        threadTitles: Map<String, String>,
        tails: Map<String, List<TaskEvent>> = emptyMap(),
        terminals: List<TerminalInfo> = emptyList(),
    ): LiveState? {
        val active = tasks.filter { it.status.isActive }
        val asking = terminals.filter { it.waitsForYou || it.status == TerminalStatus.Working }
        if (active.isEmpty() && asking.isEmpty()) return null
        val pending = approvals.filter { it.status == ApprovalStatus.Pending }.groupBy { it.taskId }
        val rows = active.map { task ->
            val waitingOn = pending[task.id]?.firstOrNull()
            val needsYou = waitingOn != null || task.status == TaskStatus.WaitingApproval
            LiveState.Row(
                id = task.id, title = title(task, threadTitles, tasks), step = step(task, waitingOn, tails[task.id] ?: emptyList()),
                model = task.model?.let { ModelName.display(it) }, startedAt = task.created, needsYou = needsYou,
                doing = doing(task, needsYou, waitingOn, tails[task.id] ?: emptyList()),
            )
        } + asking.map { row(it) }
        val ordered = rows.sortedWith(compareBy<LiveState.Row> { if (it.needsYou) 0 else 1 }.thenByDescending { it.startedAt })
        val waiting = rows.count { it.needsYou }
        return LiveState(ordered.take(maxRows), rows.size - waiting, waiting)
    }

    /**
     * A terminal waiting for you: its name, what it asks to run ("Bash: npm test"), its agent, since when it asks. At
     * work: what it is using ("运行 npm test", else 进行中), since this turn began.
     */
    internal fun row(terminal: TerminalInfo): LiveState.Row {
        val agent = ModelName.harness(terminal.harness)
        if (!terminal.waitsForYou) {
            return LiveState.Row(
                id = terminal.id, title = clip(terminal.name.ifEmpty { agent }, titleChars),
                step = clip(terminal.activity?.let { MessageDisplay.readable(it.phrase) } ?: "进行中", stepChars), model = agent,
                startedAt = terminal.statusSince ?: terminal.lastOutputAt, needsYou = false, kind = LiveState.Row.Kind.Terminal,
                doing = terminal.activity?.let { ToolDisplay.word(it.tool) } ?: "Think",
            )
        }
        val ask = terminal.permissions.firstOrNull()
        val since = ask?.at?.takeIf { it > 0 } ?: terminal.statusSince ?: terminal.lastOutputAt
        return LiveState.Row(
            id = terminal.id, title = clip(terminal.name.ifEmpty { agent }, titleChars),
            step = clip(ask?.let { MessageDisplay.readable(it.summary) } ?: "等你处理", stepChars), model = agent,
            startedAt = since, needsYou = true, kind = LiveState.Row.Kind.Terminal,
            doing = if (ask?.tool == "AskUserQuestion") "Answer" else "Allow?",
        )
    }

    /**
     * What a task is doing now in one word (the compact island): waiting on a question or an approval, else the latest
     * event that says something — a tool by its word, the model writing, planning, choosing a model — else its state.
     */
    internal fun doing(task: AgentTask, needsYou: Boolean, waitingOn: Approval?, tail: List<TaskEvent>): String {
        if (needsYou) return if (waitingOn?.questionEvidence?.questions?.isEmpty() == false) "Answer" else "Allow?"
        for (event in tail.reversed()) {
            val p = event.payload
            when (event.type) {
                "tool_call" -> if (p["denied"] == null) return ToolDisplay.word(p["tool"]?.string ?: "")
                "text" -> return "Reply"
                "routed" -> return if (p["clarify"]?.string?.isEmpty() == false) "Answer" else "Start"
                "dispatched", "redispatch" -> return "Start"
                "step" -> when (p["action"]?.string) {
                    "plan" -> return "Plan"
                    "ask_user" -> return "Answer"
                    "finish" -> return "Check"
                    "dispatch" -> return "Start"
                    else -> {}
                }
                else -> {}
            }
        }
        return when (task.status) {
            TaskStatus.Queued -> "Queued"
            TaskStatus.Routing -> "Route"
            else -> "Busy"
        }
    }

    /** The conclusion to show once nothing runs: the task that ended last (a cancelled one too, said as such). */
    fun ended(tasks: List<AgentTask>, threadTitles: Map<String, String>): LiveState.Ended? {
        val last = tasks.filter { it.status.isTerminal }.maxByOrNull { it.updatedAt } ?: return null
        val said = listOf(last.spoken, last.speech, if (last.status == TaskStatus.Done) last.result else last.error ?: last.result)
            .mapNotNull { it?.let(Speech::speakable) }.firstOrNull { it.isNotEmpty() }
        return LiveState.Ended(last.id, title(last, threadTitles, tasks), clip(said ?: last.status.label, endedChars), last.status == TaskStatus.Done)
    }

    internal fun title(task: AgentTask, threadTitles: Map<String, String>, tasks: List<AgentTask>): String =
        clip(TaskTitle.of(task, task.threadId?.let { threadTitles[it] }, tasks), titleChars)

    /**
     * What it waits for; else what it is doing, in plain words, from the latest event that says something (not raw
     * tool input or internal state names); else its state, said the same way.
     */
    internal fun step(task: AgentTask, waitingOn: Approval?, tail: List<TaskEvent>): String {
        if (waitingOn != null) {
            val asked = waitingOn.questionEvidence?.questions?.firstOrNull()?.text ?: waitingOn.action
            return clip(MessageDisplay.readable(asked), stepChars)
        }
        for (event in tail.reversed()) {
            plainLine(event)?.let { return clip(it, stepChars) }
        }
        return plainStatus(task.status)
    }

    /** What a running task is doing now, in plain words, for a card (the same line the Live Activity shows). */
    fun currentStep(task: AgentTask, tail: List<TaskEvent>): String? {
        for (event in tail.reversed()) {
            plainLine(event)?.let { return clip(it, stepChars * 2) }
        }
        return task.spoken?.let { clip(it, stepChars * 2) }
    }

    internal fun plainStatus(status: TaskStatus): String = when (status) {
        TaskStatus.Queued -> TaskStatus.Queued.label
        TaskStatus.Routing -> "选择模型"
        TaskStatus.Running -> TaskStatus.Running.label
        TaskStatus.WaitingApproval -> TaskStatus.WaitingApproval.label
        else -> status.label
    }

    /** One event as a short plain line for the island, or null when it says nothing worth showing there. */
    internal fun plainLine(event: TaskEvent): String? {
        val p = event.payload
        when (event.type) {
            "text" -> {
                val text = MessageDisplay.readable(p["text"]?.string ?: "").trim { it.isUnicodeWhitespace() }
                return if (text.isEmpty()) null else text.splitNewlines().firstOrNull()
            }
            "tool_call" -> return if (p["denied"] == null) MessageDisplay.readable(ToolDisplay.line(p)) else null
            "dispatched" -> return p["model"]?.string?.let { "已交给 " + ModelName.display(it) } ?: "开始执行"
            "routed" -> {
                val clarify = p["clarify"]?.string
                if (clarify != null && clarify.isNotEmpty()) return "等你回答：$clarify"
                return p["verdict"]?.get("model")?.string?.let { "已选定 " + ModelName.display(it) } ?: "已选定模型"
            }
            "step" -> return when (p["action"]?.string) {
                "intake" -> "已接收"
                "plan" -> "多步任务，规划中"
                "dispatch" -> {
                    val model = p["target"]?.get("model")?.string?.let { ModelName.display(it) }
                    "第 ${p["n"]?.int ?: 1} 步" + (model?.let { "：交由 $it 执行" } ?: "")
                }
                "ask_user" -> p["question"]?.string?.let { "等你回答：$it" }
                "finish" -> "收尾检查"
                else -> null
            }
            "redispatch" -> return "重试"
            "attempt_failed" -> return "一次尝试失败"
            "queued" -> return TaskStatus.Queued.label
            else -> return null
        }
    }

    internal fun clip(text: String, limit: Int): String {
        val one = text.replace("\n", " ").trim { it.isHorizontalSpace() }
        return if (one.graphemeCount() > limit) one.graphemePrefix(limit - 1) + "…" else one
    }
}

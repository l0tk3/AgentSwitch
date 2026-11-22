package com.agentswitch.kit.feed

import com.agentswitch.kit.api.AgentTask
import com.agentswitch.kit.api.TaskEvent
import com.agentswitch.kit.api.ToolDisplay
import kotlin.time.Duration
import kotlin.time.Duration.Companion.milliseconds

/**
 * The task page's 过程 list (control-v0 §5): consecutive tool calls fold into one line ("读取 3 个文件，运行 5 条命令"),
 * opened on a tap; a lone call stays its own line, since its own words say more than a count. `tool_result` events
 * are never rows (they belong to their call). A refused call is kept apart: what was stopped should be seen.
 */
object ProcessFolding {
    sealed class Item {
        data class Event(val event: TaskEvent) : Item()
        data class Tools(val calls: List<TaskEvent>) : Item()

        val id: String
            get() = when (this) {
                is Event -> event.id
                is Tools -> "tools:" + (calls.firstOrNull()?.id ?: "")
            }
    }

    /** Folds of at least `minimum` calls; smaller runs stay as they are. */
    const val minimum = 2

    fun items(events: List<TaskEvent>): List<Item> {
        val out = mutableListOf<Item>()
        var run = mutableListOf<TaskEvent>()
        fun flush() {
            if (run.size >= minimum) out.add(Item.Tools(run)) else out.addAll(run.map { Item.Event(it) })
            run = mutableListOf()
        }
        for (event in events) {
            if (event.type == "tool_result") continue
            if (folds(event)) run.add(event) else { flush(); out.add(Item.Event(event)) }
        }
        flush()
        return out
    }

    internal fun folds(event: TaskEvent): Boolean = event.type == "tool_call" && event.payload["denied"] == null

    /** What kind of work a call is, by its verb (ToolDisplay). */
    enum class Kind(val rawValue: Int) {
        Read(0), Run(1), Search(2), Edit(3), Browser(4), Other(5);

        /** Files count once each, however often they were read or changed. */
        val countsTargets: Boolean get() = this == Read || this == Edit

        fun clause(n: Int): String = when (this) {
            Read -> "读取 $n 个文件"
            Run -> "运行 $n 条命令"
            Search -> "搜索 $n 次"
            Edit -> "修改 $n 个文件"
            Browser -> "浏览器操作 $n 次"
            Other -> "调用工具 $n 次"
        }

        companion object {
            /** Swift's `init(tool:)`. */
            operator fun invoke(tool: String): Kind {
                val label = ToolDisplay.label(tool)
                return when (label) {
                    "读取" -> Read
                    "运行" -> Run
                    "搜索", "查找文件" -> Search
                    "修改", "写入", "修改笔记本" -> Edit
                    else -> if (label.startsWith("浏览器 · ")) Browser else Other
                }
            }
        }
    }

    /**
     * "读取 3 个文件，运行 5 条命令，搜索 2 次"; `ongoing` (the task still runs and this is its latest fold) says
     * "正在读取 3 个文件，…".
     */
    fun summary(calls: List<TaskEvent>, ongoing: Boolean = false): String {
        val counts = HashMap<Kind, Int>()
        val targets = HashMap<Kind, MutableSet<String>>()
        for (call in calls) {
            val kind = Kind(call.payload["tool"]?.string ?: "")
            val target = if (kind.countsTargets) ToolDisplay.target(call.payload) else null
            if (target != null) {
                if (targets.getOrPut(kind) { mutableSetOf() }.add(target)) counts[kind] = (counts[kind] ?: 0) + 1
            } else {
                counts[kind] = (counts[kind] ?: 0) + 1
            }
        }
        val clauses = Kind.entries.mapNotNull { kind -> counts[kind]?.let { kind.clause(it) } }
        return (if (ongoing) "正在" else "") + clauses.joinToString("，")
    }
}

/** How long a finished task took (control-v0 §5), for the muted line at the end of 过程. */
object TaskDuration {
    /** From its first `queued` or `dispatched` event to its end event; without those, created → last change. */
    fun seconds(task: AgentTask, events: List<TaskEvent>): Duration? {
        if (!task.status.isTerminal) return null
        val start = events.firstOrNull { it.type == "queued" || it.type == "dispatched" }?.ts ?: task.createdAt
        val end = events.firstOrNull { it.endsStream }?.ts ?: task.updatedAt
        if (end < start) return null
        return (end - start).milliseconds
    }

    /** 用时 45 秒 · 用时 2 分 13 秒 · 用时 1 小时 5 分. */
    fun text(seconds: Duration): String {
        val total = Math.round(seconds.inWholeMilliseconds / 1000.0).toInt()
        val h = total / 3600
        val m = total % 3600 / 60
        val s = total % 60
        if (h > 0) return if (m > 0) "用时 $h 小时 $m 分" else "用时 $h 小时"
        if (m > 0) return if (s > 0) "用时 $m 分 $s 秒" else "用时 $m 分"
        return "用时 ${maxOf(s, 1)} 秒"
    }
}

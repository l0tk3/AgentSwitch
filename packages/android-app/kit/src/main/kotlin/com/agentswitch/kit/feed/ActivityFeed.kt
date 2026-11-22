package com.agentswitch.kit.feed

import com.agentswitch.kit.api.AgentTask
import com.agentswitch.kit.api.Approval
import com.agentswitch.kit.api.ApprovalStatus
import com.agentswitch.kit.api.EventDescriber
import com.agentswitch.kit.api.TaskEvent

/**
 * The home screen's log (app-v0 §5): the recent tasks oldest first, which of them get a live event stream, and the
 * pending approvals that belong to tasks outside the log.
 */
object ActivityFeed {
    const val defaultLimit = 30

    /** Open SSE streams at once; the other active tasks are followed by polling. */
    const val maxLiveStreams = 3

    /** Oldest first, keeping the newest `limit`. Sorted here, not trusted from the daemon's order. */
    fun timeline(tasks: List<AgentTask>, limit: Int = defaultLimit): List<AgentTask> =
        tasks.sortedWith(compareBy<AgentTask> { it.createdAt }.thenBy { it.id }).takeLast(limit)

    /** The newest active tasks, newest first. */
    fun liveTaskIds(tasks: List<AgentTask>, max: Int = maxLiveStreams): List<String> =
        tasks.filter { it.status.isActive }.sortedByDescending { it.createdAt }.take(max).map { it.id }

    fun pending(approvals: List<Approval>, taskId: String): List<Approval> =
        approvals.filter { it.taskId == taskId && it.status == ApprovalStatus.Pending }

    /** Pending approvals whose task is not in the log; the home screen gathers them behind one banner. */
    fun looseApprovals(approvals: List<Approval>, shown: Set<String>): List<Approval> =
        approvals.filter { it.status == ApprovalStatus.Pending && it.taskId !in shown }
}

/**
 * The last few lines of a running task under its log entry. Bookkeeping events and the end state (shown on the entry
 * itself) are left out.
 */
object EventTail {
    const val defaultKeep = 4
    private val hidden: Set<String> = setOf("queued", "thread", "summary", "rated")

    fun shows(event: TaskEvent): Boolean {
        if (event.type in hidden || event.endsStream) return false
        return EventDescriber.line(event).isNotBlank()
    }

    /** `tail` plus `event` when it is new and shown, trimmed to the last `keep`. */
    fun appending(event: TaskEvent, tail: List<TaskEvent>, keep: Int = defaultKeep): List<TaskEvent> {
        if (!shows(event) || event.seq <= (tail.lastOrNull()?.seq ?: 0)) return tail
        return (tail + event).takeLast(keep)
    }
}

/**
 * How a stored task text reads on the phone: the sealer's legend (router-v0 §9, meant for the executor) is cut off
 * and each ciphertext shows as a lock.
 * A task's name where it is listed (its card, the conversation's end line, the Live Activity): its thread's title for
 * the thread's first task, else its own request — a later task in a thread asks for something else ("pack it", "send
 * it to me") and under the thread's name every card would read the same.
 */
object TaskTitle {
    fun of(task: AgentTask, threadTitle: String?, tasks: List<AgentTask>): String {
        val own = MessageDisplay.readable(task.task)
        val threadId = task.threadId
        if (threadId == null || threadTitle == null || threadTitle.isEmpty()) return own
        val later = task.parentId != null || tasks.any { it.threadId == threadId && it.id != task.id && it.createdAt < task.createdAt }
        return if (later) own else threadTitle
    }
}

object MessageDisplay {
    const val tokenMark = "🔒密文"

    /** The start of the daemon's LEGEND_HEADER after the blank line `legend()` puts before it (daemon src/secrets/sealer.ts). */
    internal const val legendStart = "\n\n[AgentSwitch sealed the credentials"
    private val token = Regex("enc:v1:[A-Za-z0-9_-]{16,}={0,2}")

    fun readable(text: String): String {
        val cut = text.indexOf(legendStart)
        val body = if (cut >= 0) text.substring(0, cut) else text
        return token.replace(body, tokenMark)
    }
}

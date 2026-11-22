package com.agentswitch.kit.feed

import com.agentswitch.kit.api.AgentTask
import com.agentswitch.kit.api.TaskStatus
import kotlin.time.Duration
import kotlin.time.Duration.Companion.minutes

/**
 * Ended and not opened on the phone since (control-v0 §4): the daemon's `acknowledgedAt` is older than the last
 * change, or missing.
 */
val AgentTask.isUnread: Boolean
    get() = status.isTerminal && (acknowledgedAt ?: 0) < updatedAt

/** Stopped by a restart of the Mac's service mid-run (control-v0 §4); its `error` says so, and it can be handed on. */
val AgentTask.isInterrupted: Boolean
    get() = status == TaskStatus.Blocked && blockCause == "interrupted"

/** Waiting for an answer or an approval from you, as far as the task itself says. */
val AgentTask.waitsForYou: Boolean
    get() = status == TaskStatus.WaitingApproval || (status == TaskStatus.Blocked && blockCause == "question")

/**
 * Tasks of `before` that `after` (the newest `limit`) no longer has although they would still be in it: deleted,
 * here or elsewhere — the conversation lines about them went too (threads-v0 手动删除). One older than all of a full
 * list only fell off its end. (Swift's `AgentTask.deleted(from:in:limit:)`.)
 */
fun AgentTask.Companion.deleted(before: List<AgentTask>, after: List<AgentTask>, limit: Int): List<String> {
    val kept = after.map { it.id }.toSet()
    val oldest = if (after.size < limit) Long.MIN_VALUE else after.minOfOrNull { it.createdAt } ?: Long.MIN_VALUE
    return before.filter { it.id !in kept && it.createdAt >= oldest }.map { it.id }
}

/** The same task, read at `ms` (milliseconds since 1970; the local copy after opening it, before the Mac's list says so). */
fun AgentTask.acknowledged(ms: Long): AgentTask = copy(acknowledgedAt = ms)

/**
 * "Who needs you" first (control-v0 §5): waiting for you → ended and unread → in progress → the rest. Lists and the
 * strip use it; the conversation itself stays in time order.
 */
object Attention {
    enum class Rank(val rawValue: Int) {
        NeedsYou(0), Unread(1), InProgress(2), Rest(3),
    }

    /**
     * `pending`: the tasks with an open approval or question. `readMarks` false (a Mac that keeps none): nothing is
     * unread.
     */
    fun rank(task: AgentTask, pending: Set<String> = emptySet(), readMarks: Boolean = true): Rank {
        if (task.waitsForYou || (task.status.isActive && task.id in pending)) return Rank.NeedsYou
        if (readMarks && task.isUnread) return Rank.Unread
        if (task.status.isActive) return Rank.InProgress
        return Rank.Rest
    }

    /** By rank, then the latest change first; ties keep a stable order by id. */
    fun sorted(tasks: List<AgentTask>, pending: Set<String> = emptySet(), readMarks: Boolean = true): List<AgentTask> =
        tasks.sortedWith { a, b ->
            val ra = rank(a, pending, readMarks)
            val rb = rank(b, pending, readMarks)
            when {
                ra != rb -> ra.rawValue.compareTo(rb.rawValue)
                a.updatedAt != b.updatedAt -> b.updatedAt.compareTo(a.updatedAt)
                else -> a.id.compareTo(b.id)
            }
        }
}

/**
 * A running task that has said nothing for a while (control-v0 §5): the status word stays, a second line says how
 * long. Only 进行中 counts: a queued task waits its turn and a question waits for you.
 */
object Staleness {
    val threshold: Duration = 10.minutes

    /**
     * Whole minutes since the latest event (else the task's last change), when that is at least the threshold. `now` and
     * `lastEventAt` are milliseconds since 1970.
     */
    fun minutes(task: AgentTask, lastEventAt: Long?, now: Long = System.currentTimeMillis(), waiting: Boolean = false): Int? {
        if (!(task.status == TaskStatus.Running || task.status == TaskStatus.Routing) || waiting) return null
        val last = maxOf(lastEventAt ?: 0, task.updatedAt)
        val quiet = (now - last) / 1000.0
        if (quiet < threshold.inWholeSeconds) return null
        return (quiet / 60).toInt()
    }

    /** `Quiet 14m` / `Quiet 3h`: how long nothing has come from a task that still runs. */
    fun text(minutes: Int): String = if (minutes >= 120) "Quiet ${minutes / 60}h" else "Quiet ${minutes}m"
}

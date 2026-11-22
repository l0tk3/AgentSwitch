package com.agentswitch.kit.feed

import com.agentswitch.kit.api.AgentTask
import com.agentswitch.kit.api.Approval
import com.agentswitch.kit.api.ApprovalStatus
import com.agentswitch.kit.api.TaskStatus

/** The moments the phone gives a sound, a tap and (in voice mode) a spoken line (assistant-v0 §3). */
enum class Cue(val rawValue: String) {
    Sent("sent"), Accepted("accepted"), NeedsYou("needsYou"), Done("done"), Failed("failed"),
}

data class TaskCue(val taskId: String, val cue: Cue)

/**
 * Finds the cues by comparing what the phone saw last with what it sees now. The first look only sets the baseline, a
 * task first seen already over is not news, and a cancellation is the user's own doing.
 * (A Swift struct with `mutating` functions: a class whose functions change its own state.)
 */
class CueTracker {
    private var statuses: Map<String, TaskStatus>? = null
    private var approvalIds: Set<String>? = null

    /** Tasks that ended while the phone was watching, waiting for their spoken script (read once). */
    private var awaitingScript: MutableSet<String> = mutableSetOf()

    fun taskCues(tasks: List<AgentTask>): List<TaskCue> {
        val before = statuses
        statuses = (before ?: emptyMap()) + tasks.map { it.id to it.status }
        if (before == null) return emptyList()
        return tasks.mapNotNull { task ->
            val old = before[task.id]
            if (old == null || !old.isActive || !task.status.isTerminal) return@mapNotNull null
            when (task.status) {
                TaskStatus.Done -> {
                    awaitingScript.add(task.id)
                    TaskCue(task.id, Cue.Done)
                }
                TaskStatus.Cancelled -> null
                else -> {
                    awaitingScript.add(task.id)
                    TaskCue(task.id, Cue.Failed)
                }
            }
        }
    }

    /** Pending approvals and questions not seen before (none on the first look). */
    fun newApprovals(approvals: List<Approval>): List<Approval> {
        val pending = approvals.filter { it.status == ApprovalStatus.Pending }
        val seen = approvalIds
        approvalIds = (seen ?: emptySet()) + pending.map { it.id }
        if (seen == null) return emptyList()
        return pending.filter { it.id !in seen }
    }

    /** Tasks that ended while watched and whose spoken script (or one-line summary) has now arrived. */
    fun newScripts(tasks: List<AgentTask>): List<AgentTask> {
        val ready = tasks.filter { it.id in awaitingScript && (it.speech?.isEmpty() == false || it.spoken?.isEmpty() == false) }
        awaitingScript.removeAll(ready.map { it.id }.toSet())
        return ready
    }
}

/** One colour per thread, the same everywhere (log label, strip, thread page). */
object ThreadStyle {
    /** A hue in 0..<1 from the thread id (FNV-1a, stable across launches, unlike a hash code). */
    fun hue(threadId: String): Double {
        var hash: ULong = 0xcbf29ce484222325UL
        for (byte in threadId.toByteArray(Charsets.UTF_8)) {
            hash = hash xor (byte.toULong() and 0xFFUL)
            hash *= 0x100000001b3UL
        }
        return (hash % 360UL).toDouble() / 360
    }
}

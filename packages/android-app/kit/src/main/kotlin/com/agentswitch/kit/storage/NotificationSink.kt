package com.agentswitch.kit.storage

import com.agentswitch.kit.api.AgentTask
import com.agentswitch.kit.api.Approval

/**
 * Where "a task needs you / a task finished" goes. Push is out of scope for v0 (app-v0 §5): the app refreshes live over
 * SSE while open, and this is the seam a later push or local-notification sink plugs into.
 */
interface NotificationSink {
    suspend fun needsAttention(taskId: String, approval: Approval)
    suspend fun finished(task: AgentTask)
}

/** v0: drops everything. */
class NoNotifications : NotificationSink {
    override suspend fun needsAttention(taskId: String, approval: Approval) {}
    override suspend fun finished(task: AgentTask) {}
}

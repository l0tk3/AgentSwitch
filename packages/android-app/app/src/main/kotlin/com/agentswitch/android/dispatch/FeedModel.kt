package com.agentswitch.android.dispatch

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.agentswitch.android.AppModel
import com.agentswitch.kit.api.APIError
import com.agentswitch.kit.api.AgentSwitchAPI
import com.agentswitch.kit.api.TaskEvent
import com.agentswitch.kit.api.events
import com.agentswitch.kit.feed.ActivityFeed
import com.agentswitch.kit.feed.EventTail
import com.agentswitch.kit.files.TaskFile
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.launch

/**
 * Live tails for the home screen's log: one event stream per active task, at most `ActivityFeed.maxLiveStreams` (the
 * newest); the others show up through the poll. Streams run only while the log is on screen, and a restarted stream
 * resumes after the last event received (shown or not), so nothing is replayed twice.
 * The home screen calls [sync] when the tasks change, sets [visible], and hands [tails] to `DispatchStore.liveTails`.
 */
@Stable
class FeedModel {
    var tails: Map<String, List<TaskEvent>> by mutableStateOf(emptyMap())
        private set

    /**
     * The time of each followed task's latest event, shown or not: a running task quiet for 10 minutes says so
     * (control-v0 §5).
     */
    var lastEventAt: Map<String, Long> by mutableStateOf(emptyMap())
        private set
    private val lastSeq = HashMap<String, Long>()
    private val streams = HashMap<String, Job>()

    /** Set by the home view on appear / disappear; a sync while hidden stops everything instead. */
    var visible = false

    /** The files finished tasks handed back (`out/`, kept artifacts), asked once per task (they do not change after). */
    var files: Map<String, List<TaskFile>> by mutableStateOf(emptyMap())
        private set
    private val asked = HashSet<String>()

    /** Start streams for the tasks that should have one, stop the rest. */
    fun sync(model: AppModel) {
        val api = model.api
        if (!visible || api == null) {
            stopAll()
            return
        }
        val tasks = model.dispatch.tasks
        val wanted = ActivityFeed.liveTaskIds(tasks).toSet()
        for (id in streams.keys.toList()) if (id !in wanted) streams.remove(id)?.cancel()
        for (id in wanted) if (streams[id] == null) start(id, api, model)
        loadFiles(ActivityFeed.timeline(tasks).filter { it.status.isTerminal && it.id !in asked }.map { it.id }, api, model)
    }

    private fun loadFiles(ids: List<String>, api: AgentSwitchAPI, model: AppModel) {
        if (ids.isEmpty()) return
        asked.addAll(ids)
        model.scope.launch {
            for (id in ids) {
                // Asked once: a failure is not retried every poll (the task page lists the files anyway).
                val list = try { api.taskFiles(id) } catch (e: CancellationException) { throw e } catch (_: Exception) { continue }
                files = files + (id to list.filter { it.isDeliverable }.sortedBy { it.path })
            }
        }
    }

    fun stopAll() {
        streams.values.forEach { it.cancel() }
        streams.clear()
    }

    private fun start(id: String, api: AgentSwitchAPI, model: AppModel) {
        val after = lastSeq[id] ?: 0L
        lateinit var job: Job
        job = model.scope.launch {
            try {
                api.events(id, after).collect { event ->
                    lastSeq[id] = maxOf(lastSeq[id] ?: 0L, event.seq)
                    lastEventAt = lastEventAt + (id to maxOf(lastEventAt[id] ?: 0L, event.ts))
                    tails = tails + (id to EventTail.appending(event, tails[id] ?: emptyList()))
                    if (event.touchesApprovals) model.dispatch.refreshApprovals()
                    if (event.endsStream || event.type == "dispatched") model.dispatch.refreshTasks()
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // A dropped stream is not an error to show: the next poll starts it again from the last kept event.
                if (e === APIError.Unauthorized) model.handle(e)
            }
            if (streams[id] === job) streams.remove(id)
            model.dispatch.refreshTasks()
        }
        streams[id] = job
    }
}

package com.agentswitch.android.dispatch

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.agentswitch.android.AppModel
import com.agentswitch.android.BuildConfig
import com.agentswitch.android.demo.DemoData
import com.agentswitch.kit.api.AgentSwitchAPI
import com.agentswitch.kit.api.AgentTask
import com.agentswitch.kit.api.AgentWriting
import com.agentswitch.kit.api.Approval
import com.agentswitch.kit.api.ApprovalDecision
import com.agentswitch.kit.api.ApprovalStatus
import com.agentswitch.kit.api.TargetRef
import com.agentswitch.kit.api.TaskDetail
import com.agentswitch.kit.api.TaskEvent
import com.agentswitch.kit.api.events
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * One task's detail and live event stream. The stream resumes from the last seq it showed, so leaving and coming
 * back (or a dropped connection) never duplicates or loses events.
 */
@Stable
class TaskDetailModel(val taskId: String) {
    var detail: TaskDetail? by mutableStateOf(null)
        private set
    var events: List<TaskEvent> by mutableStateOf(emptyList())
        private set
    var live: Boolean by mutableStateOf(false)
        private set

    /** What its run is writing now (docs/simple-view-v0.md §5.14), at the end of its process; gone once the part is in its events. */
    var writing: AgentWriting? by mutableStateOf(null)
        private set
    var handedOffTo: AgentTask? by mutableStateOf(null)
        private set

    /** True while waiting for the summarizer's spoken script after the task ended. */
    var awaitingSummary: Boolean by mutableStateOf(false)
        private set
    var error: String? by mutableStateOf(null)

    private var stream: Job? = null

    /** Until the Mac answers, what the app already knows of the task, so the page shows at once. */
    private var cached: AgentTask? by mutableStateOf(null)
    private var cachedApprovals: List<Approval> by mutableStateOf(emptyList())

    val task: AgentTask? get() = detail?.task ?: cached
    val pending: List<Approval> get() = (detail?.approvals ?: cachedApprovals).filter { it.status == ApprovalStatus.Pending }

    fun start(model: AppModel) {
        if (detail == null) {
            cached = model.dispatch.tasks.firstOrNull { it.id == taskId }
            cachedApprovals = model.dispatch.approvals.filter { it.taskId == taskId }
        }
        if (BuildConfig.DEBUG && model.api == null && events.isEmpty()) events = DemoData.events[taskId] ?: emptyList()
        val api = model.api
        if (stream != null || api == null) return
        val after = events.lastOrNull()?.seq ?: 0L
        val id = taskId
        val writes: (AgentWriting?) -> Unit = { w -> model.scope.launch { if (writing != w) writing = w } }
        lateinit var job: Job
        job = model.scope.launch {
            reload(api, model)
            live = true
            try {
                api.events(id, after, writing = writes).collect { event ->
                    events = events + event
                    if (event.touchesApprovals || event.endsStream) reload(api, model)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                model.handle(e)
                error = e.message ?: e.javaClass.simpleName
            }
            // A cancelled stream was stopped by the view; a newer one may already be running.
            if (!currentCoroutineContext().isActive) return@launch
            live = false
            writing = null
            model.dispatch.refreshApprovals()
            awaitSummary(api, model)
            if (stream === job) stream = null
        }
        stream = job
    }

    /**
     * The summarizer writes `spoken` / `speech` a few seconds after the stream's last event: look again until they
     * are there (or a minute has passed) so 朗读 reads the script, not the fallback.
     */
    private suspend fun awaitSummary(api: AgentSwitchAPI, model: AppModel) {
        awaitingSummary = true
        try {
            repeat(summaryPolls) {
                val task = task
                if (task == null || !task.status.isTerminal || task.speech != null || task.spoken != null || !currentCoroutineContext().isActive) return
                delay(3_000)
                reload(api, model)
            }
        } finally {
            awaitingSummary = false
        }
    }

    fun stop() {
        stream?.cancel()
        stream = null
        live = false
        writing = null
    }

    suspend fun reload(api: AgentSwitchAPI, model: AppModel) {
        try {
            detail = api.task(taskId)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            model.handle(e)
            error = e.message ?: e.javaClass.simpleName
        }
    }

    suspend fun decide(approval: Approval, decision: ApprovalDecision, model: AppModel) {
        act(model) { it.approve(approval.taskId, approval.id, decision) }
    }

    suspend fun answer(approval: Approval, answers: Map<String, List<String>>, model: AppModel) {
        act(model) { it.answer(approval.taskId, approval.id, answers) }
    }

    suspend fun cancel(model: AppModel) {
        act(model) { it.cancel(taskId) }
    }

    suspend fun handoff(to: TargetRef?, model: AppModel) {
        act(model) {
            val next = it.handoff(taskId, to)
            handedOffTo = next
            model.dispatch.taskCreated(next)
        }
    }

    private suspend fun act(model: AppModel, body: suspend (AgentSwitchAPI) -> Unit) {
        val api = model.api ?: return
        try {
            body(api)
            error = null
            reload(api, model)
            model.dispatch.refreshApprovals()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            model.handle(e)
            error = e.message ?: e.javaClass.simpleName
        }
    }

    companion object {
        const val summaryPolls = 20
    }
}

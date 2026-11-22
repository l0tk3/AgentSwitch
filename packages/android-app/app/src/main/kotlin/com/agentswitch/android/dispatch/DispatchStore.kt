package com.agentswitch.android.dispatch

import com.agentswitch.kit.feed.LiveSummary
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.agentswitch.android.MainTab
import com.agentswitch.android.AppModel
import com.agentswitch.android.platform.Feedback
import com.agentswitch.android.platform.ImagePrep
import com.agentswitch.android.platform.Speaker
import com.agentswitch.android.terminals.PendingAttachment
import com.agentswitch.kit.api.APIError
import com.agentswitch.kit.api.AgentSwitchAPI
import com.agentswitch.kit.api.AgentTask
import com.agentswitch.kit.api.AgentThread
import com.agentswitch.kit.api.Approval
import com.agentswitch.kit.api.ApprovalDecision
import com.agentswitch.kit.api.ApprovalKind
import com.agentswitch.kit.api.ApprovalStatus
import com.agentswitch.kit.api.NewTaskRequest
import com.agentswitch.kit.api.QuotaReading
import com.agentswitch.kit.api.TargetRef
import com.agentswitch.kit.api.Targets
import com.agentswitch.kit.api.TaskEvent
import com.agentswitch.kit.api.acknowledge
import com.agentswitch.kit.assistant.AssistantMessage
import com.agentswitch.kit.assistant.AssistantReply
import com.agentswitch.kit.assistant.Conversation
import com.agentswitch.kit.assistant.ConversationLog
import com.agentswitch.kit.assistant.NewMessage
import com.agentswitch.kit.feed.Cue
import com.agentswitch.kit.feed.CueTracker
import com.agentswitch.kit.feed.MessageDisplay
import com.agentswitch.kit.feed.TaskTitle
import com.agentswitch.kit.feed.deleted
import com.agentswitch.kit.feed.isUnread
import com.agentswitch.kit.files.UploadFile
import com.agentswitch.kit.secrets.BoxSealer
import com.agentswitch.kit.secrets.SecretDraft
import com.agentswitch.kit.secrets.TokenError
import com.agentswitch.kit.secrets.TokenMinter
import com.agentswitch.kit.storage.LocalStore
import com.agentswitch.kit.storage.SavedCiphertext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.UUID

/**
 * What the phone itself gives the Dispatch half that the model cannot make: the sealer for ciphertexts, the cues'
 * sounds and the reading voice. The defaults are silent (sample screens, tests).
 */
class DispatchServices(
    val sealer: BoxSealer = BoxSealer { _, _ -> throw IllegalStateException("no sealer") },
    val feedback: Feedback = Feedback(),
    val speaker: Speaker = Speaker(),
)

/**
 * The Dispatch half of the iPhone's `AppModel`: the tasks, approvals, threads and the conversation with the
 * assistant, the input box (text, files, pin), the message on its way, quota and targets, the read marks, the cues and
 * the saved ciphertexts. Hooked into the model's refresh and reset (`onRefresh`, `onReset`) from `init`.
 * Everything is touched on the main thread; work runs in `model.scope`.
 */
@Stable
class DispatchStore(
    private val model: AppModel,
    private val store: LocalStore?,
    services: DispatchServices = DispatchServices(),
) {
    private val sealer: BoxSealer = services.sealer
    val feedback: Feedback = services.feedback
    val speaker: Speaker = services.speaker

    var tasks: List<AgentTask> by mutableStateOf(emptyList())
        private set

    /** Tasks opened on this phone and when, until the Mac's list says so too (no flicker back to unread in between). */
    private var readLocally: Map<String, Long> = emptyMap()

    /** The Mac records read marks (`POST /tasks/:id/ack`); an older one answers 404 and then no task shows as unread. */
    var readMarksSupported: Boolean by mutableStateOf(true)
        private set
    var approvals: List<Approval> by mutableStateOf(emptyList())
        private set

    /** Every saved ciphertext, for all Macs; [ciphertexts] is what the current Mac can open. */
    private var allCiphertexts: List<SavedCiphertext> by mutableStateOf(emptyList())
    val ciphertexts: List<SavedCiphertext>
        get() {
            val paired = model.macs.servers.map { it.fingerprint }
            return allCiphertexts.filter { it.usable(model.profile?.fingerprint, paired) }
        }
    var targets: Targets? by mutableStateOf(null)
        private set

    /** `GET /quota` as last read (设置 › 用量); null until the Mac has answered once. A failed re-read keeps it. */
    var quota: List<QuotaReading>? by mutableStateOf(null)
        private set
    var sending: Boolean by mutableStateOf(false)
        private set

    /** The conversation with the assistant (the home screen); loaded newest first, then polled for what follows. */
    var conversation: ConversationLog by mutableStateOf(ConversationLog())
        private set
    private var conversationLoaded = false

    /**
     * The Mac has the assistant (a Mac without it answers 404). Then the assistant reports ends and questions in the
     * conversation, and voice mode reads those instead of reading tasks and approvals on its own (not twice).
     */
    var hasAssistant: Boolean by mutableStateOf(false)
        private set

    /** The message on its way, until the Mac answers; one at a time. */
    var outgoing: OutgoingMessage? by mutableStateOf(null)
        private set

    var composeText: String by mutableStateOf("")

    /** Files waiting to go with the next task, already prepared (images shrunk, metadata dropped). */
    var attachments: List<PendingAttachment> by mutableStateOf(emptyList())
        private set

    /** Attachments still being read or prepared; sending waits for them. */
    var preparingAttachments: Int by mutableStateOf(0)
        private set

    /** The executor for the next task only; null lets the router choose (the default). */
    var pin: TargetRef? by mutableStateOf(null)

    private var liveTailsState: Map<String, List<TaskEvent>> by mutableStateOf(emptyMap())

    /** The home screen's live event tails (FeedModel's `tails`, handed in by the home screen): the Live Activity's steps. */
    var liveTails: Map<String, List<TaskEvent>>
        get() = liveTailsState
        set(value) {
            if (value != liveTailsState) {
                liveTailsState = value
                syncLive()
            }
        }

    /** A task to open, from a notification's link (`agentswitch://task/<id>`); the home screen takes it. */
    var openTaskRequest: String? by mutableStateOf(null)

    /** Threads as the router filed the tasks (the home screen labels and strip, the thread page). */
    var threads: List<AgentThread> by mutableStateOf(emptyList())
        private set
    private var cues = CueTracker()

    init {
        allCiphertexts = try { store?.loadCiphertexts() ?: emptyList() } catch (_: Exception) { emptyList() }
        // Swift: connectionChanged also asks for the targets, resume() also agrees on the conversation.
        model.onRefresh {
            refreshAll()
            agreeOnConversation()
            refreshTargets()
        }
        model.onReset { reset() }
    }

    /** Another Mac (or none): nothing of this one's stays; the input box does. */
    private fun reset() {
        tasks = emptyList()
        readLocally = emptyMap()
        readMarksSupported = true
        approvals = emptyList()
        threads = emptyList()
        liveTails = emptyMap()
        conversation = ConversationLog()
        conversationLoaded = false
        hasAssistant = false
        outgoing = null
        cues = CueTracker()
        targets = null
        quota = null
        pin = null
        syncLive()
    }

    // MARK: data

    suspend fun refreshAll() {
        refreshTasks()
        refreshApprovals()
        refreshThreads()
        refreshConversation()
    }

    /**
     * The conversation as the Mac has it now: lines deleted there while this phone was not looking (on the Mac's own
     * page, or by the service tidying its notices) go from here too. New lines keep coming the usual way.
     */
    suspend fun agreeOnConversation() {
        val api = model.api ?: return
        if (!conversationLoaded) return
        val asked = model.session
        val recent = try { api.assistantMessagesLast(Conversation.defaultLimit) } catch (e: CancellationException) { throw e } catch (_: Exception) { return }
        if (asked != model.session) return
        conversation = conversation.agreeing(recent)
    }

    /**
     * First the newest messages, then what came after the last one held. An answer the phone missed (the connection
     * broke after the Mac got the message) confirms the waiting bubble; one that arrives this way is sounded and, in
     * voice mode, read.
     */
    suspend fun refreshConversation() {
        val api = model.api ?: return
        val asked = model.session
        try {
            if (!conversationLoaded) {
                val recent = api.assistantMessagesLast(Conversation.defaultLimit)
                if (asked != model.session) return
                conversation = ConversationLog(recent)
                conversationLoaded = true
                hasAssistant = true
            } else {
                val fresh = api.assistantMessages(conversation.lastSeq)
                if (asked != model.session) return
                val arrived = conversation.newAssistantMessages(fresh)
                conversation = conversation.merging(fresh)
                for (message in arrived) announceMessage(message)
                // A notice may stand for earlier ones the Mac took out as it said it (an install's, after another
                // install): what the Mac has now is read whole, and what it dropped goes here too.
                if (fresh.any { it.kind == AssistantMessage.Kind.Notice }) agreeOnConversation()
            }
            val waiting = outgoing
            if (waiting != null && conversation.contains(waiting.clientId)) outgoing = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: APIError.Http) {
            if (asked != model.session) return
            if (e.status == 404) {
                conversationLoaded = true // a Mac without the assistant: the log shows tasks only
                hasAssistant = false
            } else model.handle(e)
        } catch (e: Exception) {
            if (asked == model.session) model.handle(e)
        }
    }

    /**
     * An assistant message: a sound, and in voice mode its text read aloud. A report of an end or a question has its
     * sound already (the task's own cue); a progress line gets a light one.
     */
    fun announceMessage(message: AssistantMessage) {
        when (message.kind) {
            AssistantMessage.Kind.Notice, AssistantMessage.Kind.Waiting -> {}
            AssistantMessage.Kind.Progress -> feedback.play(Cue.Sent, speaker.isSpeaking)
            else -> feedback.play(Cue.Accepted, speaker.isSpeaking)
        }
        if (feedback.voiceMode) speaker.say(MessageDisplay.readable(message.text), "m${message.seq}")
    }

    suspend fun refreshThreads() {
        if (model.api == null) return
        model.fetch(quiet = true) { it.threads() }?.let { threads = it }
        syncLive()
    }

    /**
     * What is in progress — the tasks, the questions waiting for you, the live tails, the terminals at work or
     * waiting (assistant-v0 §4) — goes to the ongoing notification, and while there is any the Mac is followed from
     * behind (FollowService). The iPhone feeds its Live Activity from the same summary; its last conclusion, kept for
     * a minute there, is the task's own notification here.
     */
    fun syncLive() {
        val follower = model.follower ?: return
        val titles = HashMap<String, String>()
        for (thread in threads) thread.title?.let { titles.putIfAbsent(thread.id, it) }
        follower.sync(LiveSummary.state(tasks, approvals, titles, liveTails, model.terminals.terminals), model.profile?.name ?: "Mac")
    }

    /** From behind (FollowService): the tasks in progress and the questions waiting, which is what is notified of. */
    suspend fun refreshFollowed() {
        if (tasks.none { it.status.isActive }) return
        refreshTasks()
        refreshApprovals()
    }

    /** From a notification: the home screen opens the task. */
    fun openTask(id: String) {
        model.notifier?.clearTask(id)
        model.tab = MainTab.Tasks
        openTaskRequest = id
    }

    /** What a task is called where it is listed (TaskTitle). */
    fun title(of: AgentTask): String = TaskTitle.of(of, thread(of.threadId)?.title, tasks)

    fun thread(id: String?): AgentThread? = if (id == null) null else threads.firstOrNull { it.id == id }

    suspend fun refreshTargets() {
        model.fetch { it.targets() }?.let { targets = it }
    }

    /**
     * Usage per executor, quietly: an older Mac or a failed read leaves the last numbers (or none) and no banner.
     * `force` has the Mac read every executor again instead of answering from its cache (pull to refresh).
     */
    suspend fun refreshQuota(force: Boolean = false) {
        val api = model.api ?: return
        val asked = model.session
        try {
            val fresh = if (force) api.refreshQuota() else api.quota()
            if (asked == model.session) quota = fresh
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (e === APIError.Unauthorized && asked == model.session) model.handle(e)
        }
    }

    suspend fun refreshTasks() {
        val fresh = model.fetch { it.tasks() } ?: return
        val deleted = AgentTask.deleted(tasks, fresh, AgentSwitchAPI.taskListLimit)
        tasks = withLocalReads(fresh)
        if (deleted.isNotEmpty()) reloadConversation()
        announce()
        syncLive()
    }

    /**
     * Endings get a sound; in voice mode a finished task's spoken script is read once it has arrived (the assistant's
     * report reads it instead when the Mac has one).
     */
    private fun announce() {
        for (cue in cues.taskCues(tasks)) feedback.play(cue.cue, speaker.isSpeaking)
        if (!feedback.voiceMode || hasAssistant) {
            cues.newScripts(tasks)
            return
        }
        for (task in cues.newScripts(tasks)) speaker.toggle(task)
    }

    suspend fun refreshApprovals() {
        val fresh = model.fetch { it.approvals() } ?: return
        for (approval in cues.newApprovals(fresh)) {
            feedback.play(Cue.NeedsYou, speaker.isSpeaking)
            if (feedback.voiceMode && !hasAssistant) speaker.say(spokenQuestion(approval), approval.id)
            needsAttention(approval)
        }
        approvals = fresh
        syncLive()
    }

    /**
     * A phone notification for a task that newly needs you (the iPhone's `NotificationSink.needsAttention`, which its
     * app leaves silent): not while the app is in front on the tasks tab, where the log shows it.
     */
    private fun needsAttention(approval: Approval) {
        if (model.inFront && model.tab == MainTab.Tasks) return
        val notifier = model.notifier ?: return
        val task = tasks.firstOrNull { it.id == approval.taskId }
        val body = approval.questionEvidence?.questions?.joinToString("；") { it.text } ?: approval.action
        val name = if (task != null) title(task) else "任务"
        notifier.postTask(approval.taskId, "$name · Needs You", body)
    }

    /** Ended and not opened yet, as far as this Mac keeps read marks. */
    fun isUnread(task: AgentTask): Boolean = readMarksSupported && task.isUnread

    /** Tasks with an open approval or question. */
    val pendingTaskIds: Set<String>
        get() = approvals.filter { it.status == ApprovalStatus.Pending }.map { it.taskId }.toSet()

    /**
     * Opening a task reads it (control-v0 §4): marked here at once, then on the Mac. A Mac without read marks (404)
     * turns the marks off rather than leaving every ended task unread.
     */
    suspend fun acknowledge(task: AgentTask) {
        if (!readMarksSupported || !task.isUnread || (readLocally[task.id] ?: 0L) >= task.updatedAt) return
        val at = maxOf(System.currentTimeMillis(), task.updatedAt)
        readLocally = readLocally + (task.id to at)
        tasks = withLocalReads(tasks)
        val api = model.api ?: return
        try {
            api.acknowledge(task.id)
        } catch (e: CancellationException) {
            throw e
        } catch (e: APIError.Http) {
            if (e.status == 404) readMarksSupported = false
        } catch (e: Exception) {
            if (e === APIError.Unauthorized) model.handle(e)
        }
    }

    /** The Mac's list with this phone's newer read marks laid over it; a mark the Mac has caught up with is dropped. */
    private fun withLocalReads(fresh: List<AgentTask>): List<AgentTask> {
        if (readLocally.isEmpty()) return fresh
        readLocally = readLocally.filter { (id, at) -> fresh.firstOrNull { it.id == id }?.let { (it.acknowledgedAt ?: 0L) < at } ?: true }
        return fresh.map { task ->
            val at = readLocally[task.id]
            if (at != null && (task.acknowledgedAt ?: 0L) < at) task.copy(acknowledgedAt = at) else task
        }
    }

    fun taskCreated(task: AgentTask) {
        tasks = listOf(task) + tasks.filter { it.id != task.id }
    }

    /**
     * The input box's send (assistant-v0 §1.1): the message goes to the assistant, which answers, looks up a task or
     * hands the work to the router. The box empties at once and the message waits in its bubble until the Mac answers;
     * a failure stays there with a resend, which the Mac recognizes by the client id and answers only once.
     */
    suspend fun send(): String? {
        val typed = composeText
        val written = typed.trim()
        // Attachments alone are a task too.
        val text = if (written.isEmpty() && attachments.isNotEmpty()) attachmentsOnlyTask else written
        if (model.api == null || text.isEmpty() || sending || outgoing != null || preparingAttachments != 0) return null
        outgoing = OutgoingMessage(text = text, attachments = attachments, pin = pin)
        if (composeText == typed) composeText = ""
        attachments = emptyList()
        pin = null
        deliver()
        return null
    }

    /** The waiting message again, same client id: the Mac answers a message it already has with its first answer. */
    suspend fun resend() {
        val waiting = outgoing ?: return
        if (waiting.failure == null || sending) return
        outgoing = waiting.failing(null)
        deliver()
    }

    /** Back into the input box to change it; the Mac never got it, or answers the old one only if it is resent. */
    fun editOutgoing() {
        val waiting = outgoing ?: return
        if (waiting.failure == null) return
        if (composeText.trim().isEmpty()) composeText = if (waiting.text == attachmentsOnlyTask) "" else waiting.text
        attachments = waiting.attachments + attachments
        pin = pin ?: waiting.pin
        outgoing = null
    }

    suspend fun deliver() {
        val api = model.api ?: return
        var message = outgoing ?: return
        feedback.play(Cue.Sent, speaker.isSpeaking)
        sending = true
        try {
            if (message.staged == null) {
                try {
                    val ids = if (message.attachments.isEmpty()) emptyList() else api.upload(message.attachments.map { it.file }).map { it.id }
                    message = message.staging(ids)
                    outgoing = message
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    fail("附件上传失败（${e.message ?: e.javaClass.simpleName}）。", e)
                    return
                }
            }
            try {
                received(api.sendMessage(NewMessage(text = message.text, clientId = message.clientId, attachments = message.staged, pin = message.pin)))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                when {
                    e is APIError.Http && e.status == 404 -> sendAsTask(message, api)
                    e is APIError && e.isNetworkFailure -> {
                        fail(unconfirmedSend, e)
                        refreshConversation() // it may have arrived: the stored message confirms it
                    }
                    else -> fail(e.message ?: e.javaClass.simpleName, e)
                }
            }
        } finally {
            sending = false
        }
    }

    fun received(reply: AssistantReply) {
        conversation = conversation.merging(listOf(reply.user, reply.assistant))
        reply.task?.let { taskCreated(it) }
        outgoing = null
        announceMessage(reply.assistant)
    }

    /** A Mac without the assistant (an older daemon): the message becomes a task as before. */
    private suspend fun sendAsTask(message: OutgoingMessage, api: AgentSwitchAPI) {
        try {
            val task = api.createTask(NewTaskRequest(task = message.text, pin = message.pin, attachments = message.staged ?: emptyList()))
            taskCreated(task)
            outgoing = null
            feedback.play(Cue.Accepted, speaker.isSpeaking)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            fail(e.message ?: e.javaClass.simpleName, e)
        }
    }

    private fun fail(reason: String, error: Throwable) {
        feedback.play(Cue.Failed, speaker.isSpeaking)
        if (error === APIError.Unauthorized) model.handle(error)
        outgoing = outgoing?.failing(reason)
    }

    /** Answering in the log: the result shows up in the task's state and the approvals list right after. */
    suspend fun decide(approval: Approval, decision: ApprovalDecision) {
        act { it.approve(approval.taskId, approval.id, decision) }
    }

    suspend fun answer(approval: Approval, answers: Map<String, List<String>>) {
        act { it.answer(approval.taskId, approval.id, answers) }
    }

    private suspend fun act(body: suspend (AgentSwitchAPI) -> Unit) {
        val api = model.api ?: return
        try { body(api) } catch (e: CancellationException) { throw e } catch (e: Exception) { model.handle(e) }
        model.refreshAll()
    }

    /**
     * Adds files to the next task: images are prepared off the main thread; the limits are the Mac's (20 files, 50 MB
     * each) plus 100 MB in all on the phone. Returns what could not be added, if anything.
     * `prepare`: photos, camera shots and pasted images are shrunk and re-encoded without metadata (ImagePrep); a file
     * picked in the file picker goes as it is.
     */
    suspend fun addAttachments(files: List<UploadFile>, prepare: Boolean): String? {
        preparingAttachments += 1
        try {
            val prepared = withContext(Dispatchers.Default) { files.map { it.name to (if (prepare) ImagePrep.prepare(it) else it) } }
            val problems = ArrayList<String>()
            for ((name, file) in prepared) {
                if (file == null) { problems.add("$name 无法读取"); continue }
                val problem = PendingAttachment.problem(file, attachments)
                if (problem != null) { problems.add(problem); continue }
                attachments = attachments + PendingAttachment(file)
            }
            return if (problems.isEmpty()) null else problems.joinToString("；")
        } finally {
            preparingAttachments -= 1
        }
    }

    fun removeAttachment(id: UUID) {
        attachments = attachments.filter { it.id != id }
    }

    fun taskDeleted(id: String) {
        tasks = tasks.filter { it.id != id }
        approvals = approvals.filter { it.taskId != id }
        model.notifier?.clearTask(id)
        reloadConversation()
    }

    /**
     * The conversation again from its newest lines, not only what came after: lines about a deleted task went with it
     * on the Mac (threads-v0 手动删除).
     */
    fun reloadConversation() {
        if (!conversationLoaded || !hasAssistant) return
        conversationLoaded = false
        model.scope.launch { refreshConversation() }
    }

    /** The explicit deletes (log entry, task page, settings): null when done, else the message to show. */
    suspend fun delete(request: DeleteRequest): String? {
        val api = model.api ?: return null
        try {
            when (request) {
                is DeleteRequest.Entry -> {
                    api.deleteEntry(request.entry.seq)
                    for (id in request.entry.createdTaskIds) taskDeleted(id)
                    conversation = conversation.removing(request.entry.seqs)
                    reloadConversation()
                }
                is DeleteRequest.Task -> {
                    api.deleteTask(request.task.id)
                    taskDeleted(request.task.id)
                }
                is DeleteRequest.Topic -> {
                    api.deleteThread(request.topicId)
                    model.refreshAll()
                }
                DeleteRequest.History -> {
                    api.clearHistory()
                    tasks = emptyList()
                    approvals = emptyList()
                    threads = emptyList()
                    conversation = ConversationLog()
                    conversationLoaded = false
                    model.refreshAll()
                }
            }
            return null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            model.handle(e)
            return DeleteRequest.message(e)
        }
    }

    // MARK: ciphertexts

    /** Seals the draft's value to the gate key on this phone; only the ciphertext and note are kept. */
    fun mint(draft: SecretDraft): SavedCiphertext {
        val profile = model.profile
        val gate = profile?.gate ?: throw TokenError.BadPublicKey
        val token = TokenMinter(gate.publicKey, sealer).mint(draft.payload())
        val item = SavedCiphertext(token = token, note = draft.effectiveNote, mac = profile.fingerprint)
        allCiphertexts = listOf(item) + allCiphertexts
        persistCiphertexts()
        return item
    }

    fun deleteCiphertexts(ids: Set<UUID>) {
        allCiphertexts = allCiphertexts.filter { it.id !in ids }
        persistCiphertexts()
    }

    /** Appends a ciphertext to the input box (the screen closes whatever sheet it was picked in). */
    fun insertIntoCompose(token: String) {
        composeText += (if (composeText.isEmpty() || composeText.endsWith(" ")) "" else " ") + token
    }

    private fun persistCiphertexts() {
        try { store?.saveCiphertexts(allCiphertexts) } catch (e: Exception) { model.banner = e.message ?: e.javaClass.simpleName }
    }

    /** The sample screens' state (a debug build's `uiDemo`): the demo conversation and tasks, no network. */
    fun setDemo(
        tasks: List<AgentTask>, threads: List<AgentThread>, approvals: List<Approval>, messages: List<AssistantMessage>,
        quota: List<QuotaReading>,
    ) {
        this.tasks = tasks
        this.threads = threads
        this.approvals = approvals
        this.conversation = ConversationLog(messages)
        this.hasAssistant = true
        this.quota = quota
        this.allCiphertexts = listOf(SavedCiphertext(token = "enc:v1:" + "Q".repeat(120), note = "公司 VPN（vpn/pass）"))
    }

    companion object {
        const val attachmentsOnlyTask = "请查看附件。"
        const val unconfirmedSend = "未收到 Mac 的响应。重发不会导致重复处理。"

        /** What voice mode reads when something needs you: the questions, else the action to approve. */
        fun spokenQuestion(approval: Approval): String {
            val evidence = approval.questionEvidence
            if (evidence != null) return "等你回答：" + evidence.questions.joinToString("。") { it.text }
            return "等你批准：" + approval.action
        }
    }
}

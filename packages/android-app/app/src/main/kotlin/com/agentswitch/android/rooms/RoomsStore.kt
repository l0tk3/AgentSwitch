package com.agentswitch.android.rooms

import android.graphics.Bitmap
import androidx.compose.runtime.Stable
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.agentswitch.kit.api.APIError
import com.agentswitch.kit.api.AgentSwitchAPI
import com.agentswitch.kit.api.RoomAttachTokens
import com.agentswitch.kit.api.RoomDetail
import com.agentswitch.kit.api.RoomFilePath
import com.agentswitch.kit.api.RoomFiles
import com.agentswitch.kit.api.RoomAttentionItem
import com.agentswitch.kit.api.RoomList
import com.agentswitch.kit.api.RoomMessage
import com.agentswitch.kit.api.RoomSummary
import com.agentswitch.kit.api.RoomsUnsupported
import com.agentswitch.kit.api.deleteRoom
import com.agentswitch.kit.api.markRoomRead
import com.agentswitch.kit.api.putRoomFile
import com.agentswitch.kit.api.room
import com.agentswitch.kit.api.roomAttention
import com.agentswitch.kit.api.roomMessages
import com.agentswitch.kit.api.roomFiles
import com.agentswitch.kit.api.rooms
import com.agentswitch.kit.api.say
import kotlinx.coroutines.CancellationException

/**
 * The Rooms tab's data (docs/chatroom-v0.md §10): the rooms on the Mac shown. Read with the version the list has, so
 * an unchanged one costs nothing; often while the tab is on screen, now and then from the other tabs (the tab's
 * badge), seldom from a Mac that has no Chat Room. The iPhone's `RoomsStore`.
 */
@Stable
class RoomsStore {
    var list: RoomList? by mutableStateOf(null)
        private set

    /** The Mac shown is from before Chat Room. */
    var unsupported: Boolean by mutableStateOf(false)
        private set

    /** The last read failed (kept list shown); cleared by the next good one. */
    var error: String? by mutableStateOf(null)

    private var etag: String? = null

    /** Bumped by `reset` (another Mac): a read that started before it is dropped. */
    private var generation = 0

    val rooms: List<RoomSummary> get() = list?.rooms ?: emptyList()

    /** Messages not seen yet: the tab's badge. */
    val unread: Int get() = list?.unread ?: 0

    /** What waits on the user in every room (等你处理), as the Mac last said; null before it was asked. */
    var attention: List<RoomAttentionItem>? by mutableStateOf(null)
        private set
    var attentionError: String? by mutableStateOf(null)
        private set

    /** How many things wait on the user: the list's own count, or the page's when it was read since. */
    val attentionCount: Int get() = list?.attention ?: 0

    suspend fun refreshAttention(api: AgentSwitchAPI?) {
        if (api == null) return
        val asked = generation
        try {
            val items = api.roomAttention()
            if (asked == generation) { attention = items; attentionError = null }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (asked == generation) attentionError = e.message ?: e.javaClass.simpleName
        }
    }

    suspend fun refresh(api: AgentSwitchAPI?) {
        if (api == null) return
        val asked = generation
        try {
            val fresh = api.rooms(etag)
            if (asked != generation) return
            if (fresh != null) { list = fresh.first; etag = fresh.second }
            unsupported = false
            error = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: RoomsUnsupported) {
            if (asked != generation) return
            unsupported = true
            list = RoomList(emptyList())
            etag = null
            error = null
        } catch (e: Exception) {
            if (asked == generation) error = e.message ?: e.javaClass.simpleName
        }
    }

    /** The sample screens' rooms (no Mac): what a room's page opens with, by the room's id. */
    var demoDetails: Map<String, RoomDetail> = emptyMap()
        private set
    var demoFiles: Map<String, RoomFiles> = emptyMap()
        private set

    /** The sample rooms' files as their bytes, by where each would be on the Mac: what a room's page shows and opens. */
    var demoBytes: Map<String, ByteArray> = emptyMap()
        private set

    fun setDemo(list: RoomList, details: Map<String, RoomDetail>, files: Map<String, RoomFiles>, bytes: Map<String, ByteArray> = emptyMap(), attention: List<RoomAttentionItem> = emptyList()) {
        this.list = list
        this.attention = attention
        demoDetails = details
        demoFiles = files
        demoBytes = bytes
    }

    fun reset() {
        generation += 1
        list = null
        attention = null
        etag = null
        unsupported = false
        error = null
    }

    companion object {
        const val pollIntervalMs = 3_000L
        const val backgroundIntervalMs = 20_000L
        const val unsupportedIntervalMs = 60_000L
    }
}

/**
 * A picture picked on this phone, waiting above the box to go with the next message: its bytes as they will be put
 * into the room's shared folder (made ready as the app's other pictures are, ImagePrep), and a small copy to show.
 */
class RoomAttachment(val id: Long, val name: String, val data: ByteArray, val thumbnail: Bitmap?)

/** One room's page: the room as the Mac last gave it, what is being written, and what the user does in it. */
@Stable
class RoomPageModel(val id: String, detail: RoomDetail? = null, files: RoomFiles? = null, val demoBytes: Map<String, ByteArray> = emptyMap()) {
    var detail: RoomDetail? by mutableStateOf(detail)
        private set

    /** The room was deleted (here or elsewhere): the page closes. */
    var gone: Boolean by mutableStateOf(false)
        private set
    var error: String? by mutableStateOf(null)
    private var draftText: String by mutableStateOf("")
    var draft: String
        get() = draftText
        set(value) { if (value != draftText) { draftText = value; tokensChanged() } }

    /** The `[Image #1]` / `[File …]` tokens standing in the box for the pictures (RoomAttachTokens), by each one's id. */
    private val attachTokens = RoomAttachTokens()

    private var replyingTo: Int? by mutableStateOf(null)

    /** The message being answered: its task becomes the next message's. */
    var replyTo: Int?
        get() = replyingTo
        set(value) {
            replyingTo = value
        }

    /**
     * The task the next message is about (2026-11-24 design): inside a task, that task; in `# 全部`, none — unless it
     * begins with `T3` (a task of the list), or answers a message (the Mac gives it the task of what it answers).
     */
    val draftTask: Int?
        get() = narrowedTo ?: if (replyingTo != null) null else Regex("^\\s*T(\\d+)\\b").find(draftText)?.groupValues?.get(1)?.toIntOrNull()?.takeIf { n -> detail?.task(n) != null }

    private var narrowedTo: Int? by mutableStateOf(null)

    /** The timeline as one task's messages (picked in the drawer, or a label tapped); null: `# 全部`. */
    var taskFilter: Int?
        get() = narrowedTo
        set(value) {
            if (value == narrowedTo) return
            narrowedTo?.let { seen(it) }
            narrowedTo = value
            taskMessages = null
            value?.let { seen(it) }
        }

    /** The task's messages as the Mac gave them (`GET /rooms/:id/messages?task=`), the newest 200. */
    var taskMessages: List<RoomMessage>? by mutableStateOf(null)
        private set

    /** Every message the page has had, by number: the room's last ones as it is read again, and the pages above. */
    private var kept: java.util.TreeMap<Int, RoomMessage> = java.util.TreeMap()

    /** What `# 全部` shows: all the page has, oldest first. */
    var allMessages: List<RoomMessage> by mutableStateOf(emptyList())
        private set

    init { detail?.messages?.let { keep(it) } }

    /** The room's first message is among them: the room's beginning is shown above it. */
    val atBeginning: Boolean get() = allMessages.firstOrNull()?.seq?.let { it <= 1 } ?: true

    var loadingOlder: Boolean by mutableStateOf(false)
        private set

    /** Messages about each task after what the user had seen when the page opened (`byTask`). */
    var byTask: Map<Int, Int> by mutableStateOf(emptyMap())
        private set
    private var byTaskAt = -1

    /** Up to which message each task was looked at here: its count starts again from there. */
    private val taskSeen = mutableStateMapOf<Int, Int>()

    /** A message to bring into sight (a quote, a search hit, 等你处理): its number; and the one shown lit a moment. */
    var jumpTo: Int? by mutableStateOf(null)
    var lit: Int? by mutableStateOf(null)

    private fun seen(task: Int) { taskSeen[task] = detail?.room?.lastSeq ?: 0 }

    /** How many messages about a task the user has not seen: since it was last looked at here, or since the page opened. */
    fun unread(task: Int): Int {
        val at = taskSeen[task]
        if (at != null) return allMessages.count { it.task == task && it.seq > at && it.from != com.agentswitch.kit.api.RoomSeat.you }
        return byTask[task] ?: 0
    }

    /** The messages the timeline shows: the task's (the Mac's page and what came since), or all. */
    val shown: List<RoomMessage>
        get() {
            val n = narrowedTo ?: return allMessages
            val fetched = taskMessages ?: return allMessages.filter { it.task == n }
            val newest = fetched.lastOrNull()?.seq ?: 0
            return fetched + allMessages.filter { it.task == n && it.seq > newest }
        }

    /** A message by its number, wherever the page has it. */
    fun message(seq: Int): RoomMessage? = kept[seq] ?: taskMessages?.firstOrNull { it.seq == seq }

    private fun keep(messages: List<RoomMessage>) {
        if (messages.isEmpty()) return
        val next = java.util.TreeMap(kept)
        for (m in messages) next[m.seq] = m
        kept = next
        allMessages = next.values.toList()
    }

    /** The task's own messages read again (the newest 200), and the counts per task when the room has moved on. */
    suspend fun loadTask(api: AgentSwitchAPI?) {
        if (api == null) return
        val n = narrowedTo ?: return
        try {
            val page = api.roomMessages(id, task = n, limit = 200)
            if (narrowedTo == n) taskMessages = page.messages
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.message ?: e.javaClass.simpleName
        }
    }

    suspend fun loadCounts(api: AgentSwitchAPI?) {
        val last = detail?.room?.lastSeq ?: return
        if (api == null || last == byTaskAt || detail?.tasks.isNullOrEmpty()) return
        try {
            byTask = api.roomMessages(id, since = seenAtOpen ?: 0, limit = 1).byTask
            byTaskAt = last
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) { }
    }

    /** The page above the oldest the page has. */
    suspend fun loadOlder(api: AgentSwitchAPI?): Boolean {
        val first = allMessages.firstOrNull()?.seq ?: return false
        if (api == null || first <= 1 || loadingOlder) return false
        loadingOlder = true
        return try {
            val page = api.roomMessages(id, before = first, limit = 200).messages
            keep(page)
            page.isNotEmpty()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.message ?: e.javaClass.simpleName
            false
        } finally {
            loadingOlder = false
        }
    }

    /**
     * A message brought into sight (a quote tapped, a search hit, 等你处理): in the task shown when it is one of its
     * messages, else in `# 全部`, the pages above read until it is there.
     */
    suspend fun jump(api: AgentSwitchAPI?, seq: Int) {
        if (narrowedTo != null && shown.none { it.seq == seq }) taskFilter = null
        var pages = 0
        while (narrowedTo == null && allMessages.none { it.seq == seq } && (allMessages.firstOrNull()?.seq ?: 0) > seq && pages < 25) {
            if (!loadOlder(api)) break
            pages++
        }
        jumpTo = seq
    }
    var sending: Boolean by mutableStateOf(false)
        private set

    /** What the user had seen when the page opened: later messages that name the user are marked until it closes. */
    var seenAtOpen: Int? by mutableStateOf(detail?.room?.readSeq)
        private set

    /** What is in the room's shared folder (§9), as the Mac last listed it: read when its sheet opens. */
    var files: RoomFiles? by mutableStateOf(files)
        private set
    var filesError: String? by mutableStateOf(null)
        private set

    /** The pictures picked for the next message, in the order they were picked. */
    var attachments: List<RoomAttachment> by mutableStateOf(emptyList())
        private set

    /** While the pictures go to the Mac: which one of how many (`2/3`). */
    var uploading: String? by mutableStateOf(null)
        private set

    /** Where a picked picture is on the Mac once it is there: a second try does not put it there again. */
    private val put = HashMap<Long, String>()
    private var nextAttachment = 0L

    /** A message's pictures the Mac would not give (refused, too large, gone): drawn as files, and not asked for again. */
    val noPicture = mutableStateMapOf<String, Boolean>()

    /** Counts the pictures that came after their message was drawn: the timeline keeps its end in sight as they do. */
    var picturesShown: Int by mutableIntStateOf(0)

    private var etag: String? = null
    private var marking = false

    /** The room's shared folder, by where it is on the Mac; empty while it is not known. */
    val folder: String get() = detail?.folder?.ifEmpty { null } ?: files?.folder ?: ""

    val canSend: Boolean get() = !sending && (draft.isNotBlank() || attachments.isNotEmpty())

    /** How many more pictures the next message can take. */
    val attachmentRoom: Int get() = RoomFilePath.maxPerMessage - attachments.size

    /** Picked pictures join the ones waiting; what is over the most a message takes is left out and said. */
    fun attach(picked: List<Pair<String, ByteArray>>, thumbnail: (ByteArray) -> Bitmap?) {
        val taken = picked.take(attachmentRoom.coerceAtLeast(0))
        val made = taken.map { (name, data) -> RoomAttachment(nextAttachment++, name, data, thumbnail(data)) }
        attachments = attachments + made
        // Each stands in the box as its token, at the end of what is written.
        draft = RoomAttachTokens.appended(made.map { attachTokens.add(it.id.toString(), it.name) }, draft)
        if (taken.size < picked.size) error = "一条消息最多带 ${RoomFilePath.maxPerMessage} 个文件，多出的没有添加。"
    }

    fun detach(id: Long) {
        if (sending) return
        attachments = attachments.filter { it.id != id }
        put.remove(id)
        attachTokens.forget(id.toString())?.let { draft = RoomAttachTokens.removing(it, draft) }
    }

    /** A token deleted from the box takes its picture off (not while they are going). */
    private fun tokensChanged() {
        if (sending) return
        if (draftText.isEmpty() && attachments.isEmpty()) { attachTokens.clear(); return }
        val gone = attachTokens.gone(draftText).toSet()
        if (gone.isNotEmpty()) {
            attachments = attachments.filter { it.id.toString() !in gone }
            gone.forEach { put.remove(it.toLong()) }
        }
    }

    /** A file of the shared folder as the Mac last listed it (its size), by where it is on the Mac. */
    fun listed(path: String): com.agentswitch.kit.api.RoomFile? {
        val files = files ?: return null
        val under = RoomFilePath.under(files.folder, path) ?: return null
        return files.files.firstOrNull { it.path == under }
    }

    suspend fun refresh(api: AgentSwitchAPI?) {
        if (api == null || gone) return
        try {
            val fresh = api.room(id, etag)
            if (fresh != null) {
                if (seenAtOpen == null) seenAtOpen = fresh.first.room.readSeq
                detail = fresh.first
                etag = fresh.second
                keep(fresh.first.messages)
            }
            error = null
            markRead(api)
        } catch (e: CancellationException) {
            throw e
        } catch (e: APIError.Http) {
            if (e.status == 404) gone = true else error = e.message
        } catch (e: Exception) {
            error = e.message ?: e.javaClass.simpleName
        }
    }

    /** The shared folder listed again; what was listed stays when the Mac can not be asked. */
    suspend fun loadFiles(api: AgentSwitchAPI?) {
        if (api == null) return
        try {
            files = api.roomFiles(id)
            filesError = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            filesError = e.message ?: e.javaClass.simpleName
        }
    }

    /** While the room is on screen, what is in it is seen. */
    private suspend fun markRead(api: AgentSwitchAPI) {
        val room = detail?.room ?: return
        if (room.lastSeq <= room.readSeq || marking) return
        marking = true
        try { api.markRoomRead(id, room.lastSeq) } catch (e: CancellationException) { throw e } catch (_: Exception) { } finally { marking = false }
    }

    /**
     * The user's words go; the box is emptied once the Mac has them, and the room is read again at once. The pictures
     * picked go first, one by one into the room's shared folder, and the message comes with where they are. When any
     * of it fails, what was written and picked stays for another try. The Mac takes no message without words: pictures
     * alone go with a word saying what they are.
     */
    suspend fun send(api: AgentSwitchAPI?) {
        if (api == null || !canSend) return
        val going = attachments
        val text = draft.trim().ifEmpty { if (going.size == 1) "（图片）" else "（${going.size} 张图片）" }
        sending = true
        var putting = false
        try {
            val paths = ArrayList<String>()
            going.forEachIndexed { i, picture ->
                uploading = "${i + 1}/${going.size}"
                putting = true
                val path = put[picture.id] ?: api.putRoomFile(id, picture.name, picture.data).path.also { put[picture.id] = it }
                // Shown from what is here already when the message comes back.
                picture.thumbnail?.let { RoomPictures.keep(id, path, it) }
                paths += path
            }
            putting = false
            uploading = null
            api.say(text, id, replyTo, paths, draftTask)
            draft = ""
            attachments = emptyList()
            attachTokens.clear()
            put.clear()
            replyTo = null
            etag = null
            refresh(api)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            val why = e.message?.ifEmpty { null } ?: e.javaClass.simpleName
            error = when {
                putting && e is APIError.Http && e.status == 413 -> "图片超过 25 MB，没有发送。"
                putting -> "图片没有传到 Mac，消息没有发送：$why"
                else -> why
            }
        } finally {
            sending = false
            uploading = null
        }
    }

    /** Something done to the room or one of its seats, then the room read again; false and why when the Mac refuses. */
    suspend fun run(api: AgentSwitchAPI?, work: suspend (AgentSwitchAPI) -> Unit): Boolean {
        if (api == null) return false
        return try {
            work(api)
            etag = null
            refresh(api)
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.message ?: e.javaClass.simpleName
            false
        }
    }

    suspend fun delete(api: AgentSwitchAPI?) {
        if (api == null) return
        try { api.deleteRoom(id); gone = true } catch (e: CancellationException) { throw e } catch (e: Exception) { error = e.message ?: e.javaClass.simpleName }
    }

    companion object {
        const val pollIntervalMs = 2_000L
    }
}

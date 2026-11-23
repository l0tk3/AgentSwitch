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
import com.agentswitch.kit.api.RoomDetail
import com.agentswitch.kit.api.RoomFilePath
import com.agentswitch.kit.api.RoomFiles
import com.agentswitch.kit.api.RoomList
import com.agentswitch.kit.api.RoomSummary
import com.agentswitch.kit.api.RoomsUnsupported
import com.agentswitch.kit.api.deleteRoom
import com.agentswitch.kit.api.markRoomRead
import com.agentswitch.kit.api.putRoomFile
import com.agentswitch.kit.api.room
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

    fun setDemo(list: RoomList, details: Map<String, RoomDetail>, files: Map<String, RoomFiles>, bytes: Map<String, ByteArray> = emptyMap()) {
        this.list = list
        demoDetails = details
        demoFiles = files
        demoBytes = bytes
    }

    fun reset() {
        generation += 1
        list = null
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
    var draft: String by mutableStateOf("")

    /** The message being answered. */
    var replyTo: Int? by mutableStateOf(null)
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
        attachments = attachments + taken.map { (name, data) -> RoomAttachment(nextAttachment++, name, data, thumbnail(data)) }
        if (taken.size < picked.size) error = "一条消息最多带 ${RoomFilePath.maxPerMessage} 个文件，多出的没有添加。"
    }

    fun detach(id: Long) {
        if (sending) return
        attachments = attachments.filter { it.id != id }
        put.remove(id)
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
            api.say(text, id, replyTo, paths)
            draft = ""
            attachments = emptyList()
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

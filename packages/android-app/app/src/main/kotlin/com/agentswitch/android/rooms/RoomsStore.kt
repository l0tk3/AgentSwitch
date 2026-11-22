package com.agentswitch.android.rooms

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.agentswitch.kit.api.APIError
import com.agentswitch.kit.api.AgentSwitchAPI
import com.agentswitch.kit.api.RoomDetail
import com.agentswitch.kit.api.RoomList
import com.agentswitch.kit.api.RoomSummary
import com.agentswitch.kit.api.RoomsUnsupported
import com.agentswitch.kit.api.deleteRoom
import com.agentswitch.kit.api.markRoomRead
import com.agentswitch.kit.api.room
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

/** One room's page: the room as the Mac last gave it, what is being written, and what the user does in it. */
@Stable
class RoomPageModel(val id: String, detail: RoomDetail? = null) {
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

    private var etag: String? = null
    private var marking = false

    val canSend: Boolean get() = !sending && draft.isNotBlank()

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

    /** While the room is on screen, what is in it is seen. */
    private suspend fun markRead(api: AgentSwitchAPI) {
        val room = detail?.room ?: return
        if (room.lastSeq <= room.readSeq || marking) return
        marking = true
        try { api.markRoomRead(id, room.lastSeq) } catch (e: CancellationException) { throw e } catch (_: Exception) { } finally { marking = false }
    }

    /** The user's words go; the box is emptied once the Mac has them, and the room is read again at once. */
    suspend fun send(api: AgentSwitchAPI?) {
        if (api == null || !canSend) return
        val text = draft.trim()
        sending = true
        try {
            api.say(text, id, replyTo)
            draft = ""
            replyTo = null
            etag = null
            refresh(api)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.message ?: e.javaClass.simpleName
        } finally {
            sending = false
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

package com.agentswitch.kit.api

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// Chat Room's routes a paired phone may use (docs/chatroom-v0.md §10; the daemon's remote allowlist): the rooms on the
// Mac asked, and the user in them — making a room, seating sessions that run there, speaking, the pinned notes, the task list, the shared folder. The
// lists are sent with the version the page has (`If-None-Match`): an unchanged one is a 304, nothing new. A Mac from
// before Chat Room answers 403 or 404 for `/rooms`: read as "not there" ([RoomsUnsupported]).

/** The Mac asked has no Chat Room (an older AgentSwitch). */
class RoomsUnsupported : Exception("这台 Mac 上的 AgentSwitch 还没有 Chat Room")

@Serializable private class CreateRoomBody(val name: String, val topic: String? = null, val terminals: List<String>? = null)
@Serializable private class UpdateRoomBody(val name: String? = null, val topic: String? = null, val paused: Boolean? = null)
@Serializable private class AddSeatBody(val terminal: String, val canAdd: Boolean? = null)
@Serializable private class SetSeatBody(val canAdd: Boolean)
@Serializable private class SayBody(val text: String, val replyTo: Int? = null, val files: List<String>? = null, val expects: String? = null, val task: Int? = null)
@Serializable private class MuteBody(val muted: Boolean)
@Serializable private class SeatNameBody(val name: String)
@Serializable private class ReadBody(val seq: Int)
@Serializable private class NotesBody(val text: String)
@Serializable private class SeatReply(val seat: RoomSeat)
@Serializable private class SummaryReply(val room: RoomSummary)
@Serializable private class ReadReply(val readSeq: Int = 0)
@Serializable private class NotesReply(val notes: RoomNotes? = null)
@Serializable private class NewTaskBody(val title: String, val detail: String? = null, val owner: String? = null, val after: List<Int>? = null)
@Serializable private class TaskReply(val task: RoomTask)
@Serializable private class Done(val ok: Boolean? = null)
@Serializable private class PokeBody(val handle: String? = null)
@Serializable private class PokeReply(val results: List<RoomPoke> = emptyList())

/** How a 戳一下 went for one member: `given` — the user's message waiting for it was given to it now; else `why` not. */
@Serializable
data class RoomPoke(val handle: String, val given: Boolean = false, val why: String? = null)

/** What the Mac says of a message just taken: the message, and who it still has to reach. */
@Serializable
data class RoomSaid(val message: RoomMessage, private val receipts: Map<String, String> = emptyMap()) {
    val reach: Map<String, RoomReceipt> get() = receipts.entries.mapNotNull { (h, r) -> RoomReceipt.of(r)?.let { h to it } }.toMap()
}

/** The rooms, the one talked in last first; null: unchanged since `etag`. */
suspend fun AgentSwitchAPI.rooms(etag: String?): Pair<RoomList, String?>? =
    try {
        versioned(listOf("rooms"), emptyList(), etag, RoomList.serializer())
    } catch (e: APIError.Http) {
        if (e.status == 403 || e.status == 404) throw RoomsUnsupported() else throw e
    }

/** One room with its seats as they are now and its last messages; null: unchanged since `etag`. */
suspend fun AgentSwitchAPI.room(id: String, etag: String?): Pair<RoomDetail, String?>? =
    versioned(listOf("rooms", id), emptyList(), etag, RoomDetail.serializer())

/** A new room with the sessions named seated in it; `problems` says which could not be. */
suspend fun AgentSwitchAPI.createRoom(name: String, topic: String, terminals: List<String>): RoomDetail =
    post(listOf("rooms"), CreateRoomBody(name, topic.ifEmpty { null }, terminals.ifEmpty { null }), CreateRoomBody.serializer(), RoomDetail.serializer())

/** Only what is given is sent: the Mac takes no field it does not know, and leaves alone what is not named. */
suspend fun AgentSwitchAPI.updateRoom(id: String, name: String? = null, topic: String? = null, paused: Boolean? = null): RoomSummary =
    send("PATCH", listOf("rooms", id), UpdateRoomBody(name, topic, paused), UpdateRoomBody.serializer(), SummaryReply.serializer()).room

suspend fun AgentSwitchAPI.deleteRoom(id: String) {
    perform("DELETE", listOf("rooms", id), emptyList(), null, Done.serializer())
}

/** A session running on the Mac asked takes a seat. */
suspend fun AgentSwitchAPI.seat(terminal: String, room: String, canAdd: Boolean? = null): RoomSeat =
    post(listOf("rooms", room, "seats"), AddSeatBody(terminal, canAdd), AddSeatBody.serializer(), SeatReply.serializer()).seat

/** `Can Add Sessions` for one seat. */
suspend fun AgentSwitchAPI.setSeat(handle: String, room: String, canAdd: Boolean): RoomSeat =
    send("PATCH", listOf("rooms", room, "seats", handle), SetSeatBody(canAdd), SetSeatBody.serializer(), SeatReply.serializer()).seat

suspend fun AgentSwitchAPI.unseat(handle: String, room: String) {
    perform("DELETE", listOf("rooms", room, "seats", handle), emptyList(), null, Done.serializer())
}

/**
 * The user speaks; who it is for is read from the `@names` in the text. `files`: what it comes with, by where each is
 * on the Mac (a picture from the phone is put into the shared folder first, [putRoomFile]).
 */
suspend fun AgentSwitchAPI.say(text: String, room: String, replyTo: Int? = null, files: List<String> = emptyList(), task: Int? = null, expects: String? = null): RoomSaid =
    post(listOf("rooms", room, "messages"), SayBody(text, replyTo, files.ifEmpty { null }, expects, task), SayBody.serializer(), RoomSaid.serializer())

/**
 * Some of what was said (2026-11-24): one task's (`task`), those whose words contain `q` (the newest first, within
 * `task` when given), or the page above `before`. `byTask`: how many there are about each task after `since`.
 */
@Serializable
data class RoomMessagePage(val messages: List<RoomMessage> = emptyList(), @kotlinx.serialization.SerialName("byTask") private val rawByTask: Map<String, Int> = emptyMap()) {
    /** Task number → messages about it after `since`. */
    val byTask: Map<Int, Int> get() = rawByTask.entries.mapNotNull { (k, v) -> k.toIntOrNull()?.let { it to v } }.toMap()
}

suspend fun AgentSwitchAPI.roomMessages(room: String, task: Int? = null, q: String? = null, before: Int? = null, since: Int? = null, limit: Int? = null): RoomMessagePage =
    get(listOf("rooms", room, "messages"), RoomMessagePage.serializer(), listOfNotNull(
        task?.let { URLQueryItem("task", it.toString()) },
        q?.trim()?.ifEmpty { null }?.let { URLQueryItem("q", it) },
        before?.let { URLQueryItem("before", it.toString()) },
        since?.let { URLQueryItem("since", it.toString()) },
        limit?.let { URLQueryItem("limit", it.toString()) },
    ))

/** Everything in every room that waits on the user (等你处理), the newest first. */
suspend fun AgentSwitchAPI.roomAttention(): List<RoomAttentionItem> = get(listOf("rooms", "attention"), RoomAttention.serializer()).items

/** A member muted or unmuted (§6.2): it reads and works, but may not post. */
suspend fun AgentSwitchAPI.setSeatMuted(handle: String, room: String, muted: Boolean): RoomSeat =
    send("PATCH", listOf("rooms", room, "seats", handle), MuteBody(muted), MuteBody.serializer(), SeatReply.serializer()).seat

/** A member's name in this room changed (what `@` calls it); the old one still finds it. */
suspend fun AgentSwitchAPI.renameSeat(handle: String, room: String, name: String): RoomSeat =
    send("PATCH", listOf("rooms", room, "seats", handle), SeatNameBody(name), SeatNameBody.serializer(), SeatReply.serializer()).seat

/** The session behind an ended member brought back (§6.2): the same conversation, the seat as it was. */
suspend fun AgentSwitchAPI.resumeSeat(handle: String, room: String): RoomSeat =
    perform("POST", listOf("rooms", room, "seats", handle, "resume"), emptyList(), null, SeatReply.serializer()).seat

/** How a member's end went: `handingOver` — it writes its handover note first (two minutes at most), then ends. */
@Serializable
data class RoomSeatEnd(val ok: Boolean = false, val closed: Boolean = false, val handingOver: Boolean = false)

/**
 * A member out of the room and its terminal closed, its conversation kept (`close=end`); `delete`: its record deleted
 * too. One with unfinished tasks writes its handover note first, unless `now`.
 */
suspend fun AgentSwitchAPI.endSeat(handle: String, room: String, now: Boolean = false, delete: Boolean = false): RoomSeatEnd =
    perform("DELETE", listOf("rooms", room, "seats", handle), listOfNotNull(URLQueryItem("close", if (delete) "delete" else "end"), if (now) URLQueryItem("now", "1") else null), null, RoomSeatEnd.serializer())

/**
 * 戳一下: the user's message still waiting for a busy member (`sent`/`queued`) given to it now; `handle` null: every
 * member something waits for.
 */
suspend fun AgentSwitchAPI.pokeRoom(room: String, handle: String? = null): List<RoomPoke> =
    post(listOf("rooms", room, "poke"), PokeBody(handle), PokeBody.serializer(), PokeReply.serializer()).results

/** The user has seen up to `seq`. */
suspend fun AgentSwitchAPI.markRoomRead(room: String, seq: Int): Int =
    post(listOf("rooms", room, "read"), ReadBody(seq), ReadBody.serializer(), ReadReply.serializer()).readSeq

/** The user has seen the sessions' rounds go by (`OK`): counted from here again; nothing was stopped (§7). */
suspend fun AgentSwitchAPI.roundsSeen(room: String) {
    perform("POST", listOf("rooms", room, "rounds", "ok"), emptyList(), null, Done.serializer())
}

/** The pinned notes written whole (§9); empty: none. */
suspend fun AgentSwitchAPI.setRoomNotes(room: String, text: String): RoomNotes? =
    send("PUT", listOf("rooms", room, "notes"), NotesBody(text), NotesBody.serializer(), NotesReply.serializer()).notes

/** The user adds a task (§9); `owner`: whose it is from the start, by handle — it stays to do until that seat takes it. */
suspend fun AgentSwitchAPI.addRoomTask(room: String, title: String, detail: String? = null, owner: String? = null, after: List<Int>? = null): RoomTask =
    post(listOf("rooms", room, "tasks"), NewTaskBody(title, detail?.ifEmpty { null }, owner, after?.ifEmpty { null }), NewTaskBody.serializer(), TaskReply.serializer()).task

/**
 * The user changes a task. Only what is given is sent; `clearOwner` sends `owner: null` — nobody's any more (one being
 * done goes back to do).
 */
suspend fun AgentSwitchAPI.setRoomTask(
    room: String, n: Int, state: RoomTaskState? = null, owner: String? = null, clearOwner: Boolean = false,
    title: String? = null, detail: String? = null, note: String? = null,
): RoomTask {
    val body = buildJsonObject {
        state?.let { put("state", it.rawValue) }
        if (clearOwner) put("owner", JsonNull) else owner?.let { put("owner", it) }
        title?.let { put("title", it) }
        detail?.let { put("detail", it) }
        note?.let { put("note", it) }
    }
    return send("PATCH", listOf("rooms", room, "tasks", n.toString()), body, JsonObject.serializer(), TaskReply.serializer()).task
}

suspend fun AgentSwitchAPI.deleteRoomTask(room: String, n: Int) {
    perform("DELETE", listOf("rooms", room, "tasks", n.toString()), emptyList(), null, Done.serializer())
}

/** What is in the room's shared folder (§9), the newest first. */
suspend fun AgentSwitchAPI.roomFiles(room: String): RoomFiles = get(listOf("rooms", room, "files"), RoomFiles.serializer())

/** A file put into a room's shared folder: where it is on the Mac now, and under which name (another, when one was there). */
@Serializable
data class RoomPut(val path: String, val name: String = "", val size: Long = 0)

/**
 * A file of the room's shared folder as its bytes, by its path under the folder ([RoomFilePath.under]). The room's own
 * folder only, whatever the phone may see of the Mac's other files; over 25 MB the Mac answers 413 (`too-large`).
 */
suspend fun AgentSwitchAPI.roomFileContent(room: String, path: String): ByteArray =
    bytes(listOf("rooms", room, "files", "content"), listOf(URLQueryItem("path", path)))

/** A file from this phone (a picture picked here) put into the room's shared folder, as its bytes; sent once. */
suspend fun AgentSwitchAPI.putRoomFile(room: String, name: String, data: ByteArray): RoomPut =
    perform("PUT", listOf("rooms", room, "files", "content"), listOf(URLQueryItem("name", name)), data, RoomPut.serializer(),
        timeout = AgentSwitchAPI.uploadTimeout, contentType = "application/octet-stream")

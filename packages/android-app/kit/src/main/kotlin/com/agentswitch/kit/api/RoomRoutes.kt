package com.agentswitch.kit.api

import kotlinx.serialization.Serializable

// Chat Room's routes a paired phone may use (docs/chatroom-v0.md §10; the daemon's remote allowlist): the rooms on the
// Mac asked, and the user in them — making a room, seating sessions that run there, speaking, the pinned notes. The
// lists are sent with the version the page has (`If-None-Match`): an unchanged one is a 304, nothing new. A Mac from
// before Chat Room answers 403 or 404 for `/rooms`: read as "not there" ([RoomsUnsupported]).

/** The Mac asked has no Chat Room (an older AgentSwitch). */
class RoomsUnsupported : Exception("这台 Mac 上的 AgentSwitch 还没有 Chat Room")

@Serializable private class CreateRoomBody(val name: String, val topic: String? = null, val terminals: List<String>? = null)
@Serializable private class UpdateRoomBody(val name: String? = null, val topic: String? = null, val paused: Boolean? = null)
@Serializable private class AddSeatBody(val terminal: String, val canAdd: Boolean? = null)
@Serializable private class SetSeatBody(val canAdd: Boolean)
@Serializable private class SayBody(val text: String, val replyTo: Int? = null)
@Serializable private class ReadBody(val seq: Int)
@Serializable private class NotesBody(val text: String)
@Serializable private class SeatReply(val seat: RoomSeat)
@Serializable private class SummaryReply(val room: RoomSummary)
@Serializable private class ReadReply(val readSeq: Int = 0)
@Serializable private class NotesReply(val notes: RoomNotes? = null)
@Serializable private class Done(val ok: Boolean? = null)

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

/** The user speaks; who it is for is read from the `@names` in the text. */
suspend fun AgentSwitchAPI.say(text: String, room: String, replyTo: Int? = null): RoomSaid =
    post(listOf("rooms", room, "messages"), SayBody(text, replyTo), SayBody.serializer(), RoomSaid.serializer())

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

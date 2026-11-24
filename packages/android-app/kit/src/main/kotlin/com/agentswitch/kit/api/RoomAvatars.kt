package com.agentswitch.kit.api

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// A session's avatar (the service's `rooms/avatars.ts`, 2026-11-24): two, one for each look — the pixel look shows
// the pixel one, the classic look the classic one — kept by the session, so the same in every room it sits in.
// Unchosen, the pixel one is the seat's face and the classic one its initials on the face's colour.

/**
 * The pixel look's avatar: a 5 × 5 face (`kind: "face"`, drawn as a seat's face is) or a 16 × 16 character
 * (`kind: "grid"`: each character of a row an index into `palette`, written `0-9a-zA-Z`; `.` empty).
 */
@Serializable
data class PixelAvatar(
    val kind: String = "face",
    val id: String? = null,
    val rows: List<String> = emptyList(),
    val color: Int = 0,
    val palette: List<String> = emptyList(),
) {
    val isGrid: Boolean get() = kind == "grid"

    /** A face to draw as a seat's; null for a character. */
    val face: RoomFace? get() = if (kind == "face" && rows.isNotEmpty()) RoomFace(rows, color) else null

    /** A character's lit cells: column, row, colour as `0xRRGGBB`. */
    val pixels: List<Triple<Int, Int, Int>>
        get() {
            if (!isGrid) return emptyList()
            val colours = palette.map { it.removePrefix("#").toIntOrNull(16) }
            return rows.flatMapIndexed { y, row ->
                row.mapIndexedNotNull { x, c ->
                    val i = paletteIndex(c) ?: return@mapIndexedNotNull null
                    colours.getOrNull(i)?.let { Triple(x, y, it) }
                }
            }
        }

    /** The side of the grid: 16 for the characters. */
    val side: Int get() = maxOf(rows.size, rows.maxOfOrNull { it.length } ?: 0)

    companion object {
        private const val digits = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"

        /** A grid cell's palette index; null for `.` (empty) or anything else. */
        fun paletteIndex(c: Char): Int? = digits.indexOf(c).takeIf { it >= 0 }
    }
}

/** The classic look's avatar: one emoji on a round ground of face colour `bg`. */
@Serializable
data class ClassicAvatar(val kind: String = "emoji", val id: String? = null, val emoji: String = "", val bg: Int = 0)

@Serializable
data class RoomAvatar(val pixel: PixelAvatar? = null, val classic: ClassicAvatar? = null) {
    companion object {
        /** The classic look's unchosen avatar: the handle's first one or two letters, upper case (`api` → `AP`). */
        fun initials(handle: String): String =
            handle.filter { it.isLetterOrDigit() }.take(2).uppercase().ifEmpty { handle.take(1).uppercase() }
    }
}

/** The library the pickers offer (`GET /rooms/avatars`): the system's faces, the pixel characters, the emoji. */
@Serializable
data class RoomAvatarLibrary(
    val faces: List<Face> = emptyList(),
    val art: List<Art> = emptyList(),
    val emoji: List<Emoji> = emptyList(),
) {
    @Serializable
    data class Face(val id: String, val rows: List<String> = emptyList(), val color: Int = 0) {
        val avatar: PixelAvatar get() = PixelAvatar("face", id, rows, color)
    }

    @Serializable
    data class Art(val id: String, val palette: List<String> = emptyList(), val rows: List<String> = emptyList()) {
        val avatar: PixelAvatar get() = PixelAvatar("grid", id, rows, palette = palette)
    }

    @Serializable
    data class Emoji(val id: String, val emoji: String = "")
}

/** One look's avatar as the user sets it: back to the seat's own, a library id, a drawn face, one emoji. */
sealed class AvatarChoice {
    abstract val json: JsonElement

    /** Unchosen again: the seat's face, its initials. */
    data object Reset : AvatarChoice() { override val json: JsonElement get() = JsonNull }

    /** `f3`, `p7`; `e12` (with its ground's colour). */
    data class Library(val id: String, val bg: Int? = null) : AvatarChoice() {
        override val json: JsonElement get() = buildJsonObject { put("id", id); bg?.let { put("bg", it) } }
    }

    data class Drawn(val rows: List<String>, val color: Int) : AvatarChoice() {
        override val json: JsonElement get() = buildJsonObject {
            put("rows", buildJsonArray { rows.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } })
            put("color", color)
        }
    }

    data class Emoji(val emoji: String, val bg: Int? = null) : AvatarChoice() {
        override val json: JsonElement get() = buildJsonObject { put("emoji", emoji); bg?.let { put("bg", it) } }
    }
}

@Serializable private class AvatarReply(val avatar: RoomAvatar? = null)

/** The avatar library, for the pickers. */
suspend fun AgentSwitchAPI.roomAvatars(): RoomAvatarLibrary = get(listOf("rooms", "avatars"), RoomAvatarLibrary.serializer())

/**
 * A member's avatar set by the user: its session's, in every room. Only the looks given are sent; [AvatarChoice.Reset]
 * sends `null` (back to the seat's own).
 */
suspend fun AgentSwitchAPI.setSeatAvatar(room: String, handle: String, pixel: AvatarChoice? = null, classic: AvatarChoice? = null): RoomAvatar? {
    val body = JsonObject(buildMap {
        pixel?.let { put("pixel", it.json) }
        classic?.let { put("classic", it.json) }
    })
    return send("PUT", listOf("rooms", room, "seats", handle, "avatar"), body, JsonObject.serializer(), AvatarReply.serializer()).avatar
}

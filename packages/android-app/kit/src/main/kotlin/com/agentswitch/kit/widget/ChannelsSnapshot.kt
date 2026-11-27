package com.agentswitch.kit.widget

import com.agentswitch.kit.api.RoomList
import com.agentswitch.kit.api.RoomSeat
import com.agentswitch.kit.support.KitJson
import kotlinx.serialization.Serializable

/**
 * What the home screen's Channels widget shows (docs/app-v0.md §6; user #754, #763): the Mac's rooms as the app last
 * read them. The widget never talks to the Mac itself; it draws the last copy, as of [savedAt]. Only what is drawn is
 * kept: no address, no token, no message but the last one's first line. The iPhone's `ChannelsSnapshot`.
 */
@Serializable
data class ChannelsSnapshot(
    /** In the order the app lists them: the desk first. */
    val channels: List<Channel> = emptyList(),
    val savedAt: Long = 0,
) {
    @Serializable
    data class Channel(
        val id: String,
        val name: String,
        /** The dispatch desk (调度台). */
        val desk: Boolean = false,
        val paused: Boolean = false,
        /** Messages not seen yet; `forYou`: one of them names the user. */
        val unread: Int = 0,
        val forYou: Boolean = false,
        /** Things in the room that wait on the user's hand (等你处理). */
        val attention: Int = 0,
        /** Who said the last thing (`You` for the user), and its first line; null before anything was said. */
        val from: String? = null,
        val text: String = "",
        /** When the last thing was said (ms); null before anything was. */
        val at: Long? = null,
    ) {
        /** It wants the user: a message that names them not yet seen, or something waiting on their hand. */
        val wantsYou: Boolean get() = (forYou && unread > 0) || attention > 0
    }

    /** How many things wait for the user in all rooms: the small widget's count. */
    val waiting: Int get() = channels.sumOf { if (it.attention > 0) it.attention else if (it.forYou && it.unread > 0) 1 else 0 }

    /** Not seen yet, in all rooms. */
    val unread: Int get() = channels.sumOf { it.unread }

    /** Which channels a widget shows, as its owner set it up. */
    enum class Choice(val rawValue: String) {
        /** All of them, the one spoken in last first. */
        Recent("recent"),
        /** Only those that want the user, the one spoken in last first. */
        Mentions("mentions"),
        /** Those picked, in the order picked. */
        Chosen("chosen");

        companion object {
            fun load(raw: String?): Choice = entries.firstOrNull { it.rawValue == raw } ?: Recent
        }
    }

    /** The channels to draw: at most [limit]. */
    fun pick(choice: Choice, chosen: List<String> = emptyList(), limit: Int): List<Channel> {
        val recent = channels.withIndex().sortedWith { a, b ->
            val x = a.value.at
            val y = b.value.at
            when {
                x != null && y != null && x != y -> y.compareTo(x)
                x == null && y != null -> 1
                x != null && y == null -> -1
                else -> a.index.compareTo(b.index)
            }
        }.map { it.value }
        val picked = when (choice) {
            Choice.Recent -> recent
            Choice.Mentions -> recent.filter { it.wantsYou }
            Choice.Chosen -> {
                val byId = channels.associateBy { it.id }
                chosen.distinct().mapNotNull { byId[it] }
            }
        }
        return picked.take(limit.coerceAtLeast(0))
    }

    fun encode(): String = KitJson.encodeToString(serializer(), this)

    companion object {
        /** The rooms as the Rooms tab lists them (the desk first), as of [now]. */
        fun of(list: RoomList, now: Long): ChannelsSnapshot = ChannelsSnapshot(
            channels = list.rooms.sortedByDescending { it.desk }.map { r ->
                Channel(
                    id = r.id, name = r.name.ifEmpty { r.id }, desk = r.desk, paused = r.paused, unread = r.unread, forYou = r.forYou,
                    attention = r.attention,
                    from = r.last?.let { if (it.from == RoomSeat.you) "You" else it.from },
                    text = r.last?.let { line(it.text) } ?: r.topic,
                    at = r.last?.at?.takeIf { it > 0 },
                )
            },
            savedAt = now,
        )

        fun decode(text: String): ChannelsSnapshot? = try { KitJson.decodeFromString(serializer(), text) } catch (_: Exception) { null }

        /** One line of what was said, as a widget row shows it: Markdown's marks and line breaks gone, and short. */
        fun line(text: String, limit: Int = 120): String {
            var s = text.replace("\r", " ").replace("\n", " ")
            for (mark in listOf("**", "__", "`", "~~")) s = s.replace(mark, "")
            while (s.contains("  ")) s = s.replace("  ", " ")
            s = s.trim()
            return if (s.length > limit) s.take(limit) + "…" else s
        }

        /** `now`, `5m`, `3h`, `2d`: how long ago, short enough for a row. */
        fun ago(at: Long, now: Long): String {
            val s = ((now - at) / 1000).coerceAtLeast(0)
            return when {
                s < 60 -> "now"
                s < 3600 -> "${s / 60}m"
                s < 86_400 -> "${s / 3600}h"
                else -> "${s / 86_400}d"
            }
        }
    }
}

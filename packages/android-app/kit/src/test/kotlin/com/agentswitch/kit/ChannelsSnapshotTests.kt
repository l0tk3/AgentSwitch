package com.agentswitch.kit

import com.agentswitch.kit.api.RoomList
import com.agentswitch.kit.api.RoomSeat
import com.agentswitch.kit.api.RoomSummary
import com.agentswitch.kit.widget.ChannelsSnapshot
import com.agentswitch.kit.widget.ChannelsSnapshot.Channel
import com.agentswitch.kit.widget.ChannelsSnapshot.Choice
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** The Channels widget's copy of the rooms (docs/app-v0.md §6): what is kept, which channels a widget shows, how. */
class ChannelsSnapshotTests {
    private val now = 1_000_000_000L

    @Test
    fun keepsWhatIsDrawnTheDeskFirst() {
        val list = RoomList(listOf(
            RoomSummary(id = "a", name = "接口联调", unread = 2, forYou = true, attention = 1, last = RoomSummary.Last(seq = 4, from = "daemon", text = "**两个**版本\n都验过了", at = now - 60_000)),
            RoomSummary(id = "d", name = "调度台", desk = true, last = RoomSummary.Last(from = RoomSeat.you, text = "开两个会话", at = now - 5_000)),
            RoomSummary(id = "e", name = "", topic = "还没开始"),
        ))
        val s = ChannelsSnapshot.of(list, now)
        assertEquals(listOf("d", "a", "e"), s.channels.map { it.id })
        assertEquals(Channel(id = "d", name = "调度台", desk = true, from = "You", text = "开两个会话", at = now - 5_000), s.channels[0])
        assertEquals("两个版本 都验过了", s.channels[1].text)
        assertEquals(Channel(id = "e", name = "e", text = "还没开始"), s.channels[2])
        assertEquals(1, s.waiting)
        assertEquals(2, s.unread)
        assertEquals(s, ChannelsSnapshot.decode(s.encode()))
        assertNull(ChannelsSnapshot.decode("not json"))
    }

    @Test
    fun picksRecentMentionsOrChosen() {
        val s = ChannelsSnapshot(listOf(
            Channel(id = "d", name = "desk", desk = true, at = 10),
            Channel(id = "a", name = "a", unread = 1, forYou = true, at = 30),
            Channel(id = "b", name = "b", at = null),
            Channel(id = "c", name = "c", attention = 2, at = 20),
            Channel(id = "x", name = "x", unread = 3, at = 40),
        ))
        assertEquals(listOf("x", "a", "c", "d", "b"), s.pick(Choice.Recent, limit = 8).map { it.id })
        assertEquals(listOf("x", "a"), s.pick(Choice.Recent, limit = 2).map { it.id })
        assertEquals(listOf("a", "c"), s.pick(Choice.Mentions, limit = 8).map { it.id })
        assertEquals(listOf("b", "d"), s.pick(Choice.Chosen, chosen = listOf("b", "gone", "d", "b"), limit = 8).map { it.id })
        assertEquals(emptyList(), s.pick(Choice.Recent, limit = -1))
        assertEquals(3, s.waiting)
        assertEquals(Choice.Mentions, Choice.load("mentions"))
        assertEquals(Choice.Recent, Choice.load(null))
    }

    @Test
    fun saysHowLongAgoAndOneLine() {
        assertEquals("now", ChannelsSnapshot.ago(now - 59_000, now))
        assertEquals("5m", ChannelsSnapshot.ago(now - 5 * 60_000, now))
        assertEquals("3h", ChannelsSnapshot.ago(now - 3 * 3_600_000, now))
        assertEquals("2d", ChannelsSnapshot.ago(now - 2 * 86_400_000L, now))
        assertEquals("now", ChannelsSnapshot.ago(now + 10_000, now))
        assertEquals("a b c", ChannelsSnapshot.line("  a\r\n`b`  ~~c~~ "))
        assertEquals("abc…", ChannelsSnapshot.line("abcdef", limit = 3))
    }
}

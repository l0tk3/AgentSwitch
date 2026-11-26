package com.agentswitch.kit

import com.agentswitch.kit.api.RecordUsage
import com.agentswitch.kit.api.TerminalEvent
import com.agentswitch.kit.api.TerminalInfo
import com.agentswitch.kit.api.TerminalMeter
import com.agentswitch.kit.api.UsageLimit
import com.agentswitch.kit.feed.RecordDisplay
import com.agentswitch.kit.support.KitJson
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The line under the reply box (docs/simple-view-v0.md §5.25; the Mac's UsageLineTests): `Context 28% · 5h 12% · 7d 84%`. */
class UsageLineTests {
    private val now = 1_000_000_000_000L

    @Test
    fun testTheStatusLinesNumbersComeFirst() {
        val meter = TerminalMeter(TerminalMeter.Context(28.4, used = 280_000, window = 1_000_000),
            listOf(UsageLimit("5h", 12.0, now + 7_260_000), UsageLimit("7d", 84.0, now + 460_800_000)))
        val line = RecordDisplay.usageLine(RecordUsage(used = 10_000, window = 200_000), meter, now)
        assertEquals("Context 28%", line.context)
        assertEquals("280k / 1M", line.contextHelp)
        assertEquals(listOf("5h 12%", "7d 84%"), line.limits.map { it.text })
        assertEquals(listOf(false, true), line.limits.map { it.near })
        assertEquals(listOf("Resets in 2h 1m", "Resets in 5d 8h"), line.limits.map { it.help })
    }

    @Test
    fun testTheRecordStandsInWhereTheStatusLineSaysNothing() {
        // Codex: the record's fill and allowances; one that started afresh already says no reset.
        val line = RecordDisplay.usageLine(RecordUsage(used = 56_000, window = 200_000, limits = listOf(UsageLimit("5h", 40.0, now - 1))), null, now)
        assertEquals("Context 28%", line.context)
        assertEquals("56k / 200k", line.contextHelp)
        assertEquals(listOf("5h 40%"), line.limits.map { it.text })
        assertNull(line.limits[0].help)
        assertTrue(RecordDisplay.usageLine(null, null, now).isEmpty)
        // A status line that names no allowances leaves the record's.
        assertEquals(listOf("5h 40%"), RecordDisplay.usageLine(RecordUsage(limits = listOf(UsageLimit("5h", 40.0))), TerminalMeter(null), now).limits.map { it.text })
    }

    @Test
    fun testTheMeterIsReadFromTheTerminalAndItsStream() {
        val info = KitJson.decodeFromString(TerminalInfo.serializer(), """{"id":"t1","harness":"claude-code","cwd":"/x","name":"x","status":"idle","createdAt":1,"meter":{"context":{"percent":5,"used":null,"window":null},"limits":[{"label":"5h","percent":26,"resetsAt":null}],"at":3}}""")
        assertEquals(TerminalMeter(TerminalMeter.Context(5.0), listOf(UsageLimit("5h", 26.0))), info.meter)
        assertNull(KitJson.decodeFromString(TerminalInfo.serializer(), """{"id":"t1","harness":"codex","cwd":"/x","name":"x","status":"idle","createdAt":1}""").meter)
        val event = TerminalEvent.parse("meter", """{"meter":{"context":null,"limits":[{"label":"7d","percent":40,"resetsAt":2}]}}""")
        assertEquals(TerminalEvent.Meter(TerminalMeter(null, listOf(UsageLimit("7d", 40.0, 2)))), event)
        assertEquals(listOf(UsageLimit("5h", 3.0)), KitJson.decodeFromString(RecordUsage.serializer(), """{"used":1,"limits":[{"label":"5h","percent":3}]}""").limits)
    }
}

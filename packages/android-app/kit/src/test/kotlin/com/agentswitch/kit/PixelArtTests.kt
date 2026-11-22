package com.agentswitch.kit

import com.agentswitch.kit.design.PixelArt
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/** The pixel mark (docs/ui-v0.md §7.3): the same shape as the terminal page's pixel.js and the Mac's PixelArt, and its states. */
class PixelArtTests {
    @Test
    fun testTheMarkIsTheIconsSwitch() {
        assertEquals(PixelArt.markHeight, PixelArt.markRows.size)
        assertTrue(PixelArt.markRows.all { it.length == PixelArt.markWidth })
        // the source, the lit lane and its end are lit; the other two lanes are not
        val lit = PixelArt.markCells.filter { it.lit }
        assertEquals(9 + 8 + 9, lit.size)
        assertEquals(9, PixelArt.markCells.count { it.end })
        // the busy block runs along lit cells only
        val litPlaces = lit.map { "${it.x},${it.y}" }.toSet()
        assertTrue(PixelArt.laneA.all { litPlaces.contains("${it.x},${it.y}") })
    }

    @Test
    fun testHalfLitPixelsSmoothTheDiagonalSteps() {
        val places = PixelArt.markSmoothing.map { "${it.x},${it.y}" }
        // both inside corners of each step of the two diagonal lanes (the same cells pixel.js finds)
        assertEquals(setOf("5,1", "4,2", "6,2", "3,3", "5,3", "3,7", "5,7", "4,8", "6,8", "5,9"), places.toSet())
        assertEquals(5, PixelArt.markSmoothing.count { it.lit })
    }

    @Test
    fun testStates() {
        assertEquals(PixelArt.MarkState.Idle, PixelArt.markState(reachable = true, waiting = 0, busy = false))
        assertEquals(PixelArt.MarkState.Waiting, PixelArt.markState(reachable = true, waiting = 2, busy = true))
        assertEquals(PixelArt.MarkState.Busy, PixelArt.markState(reachable = true, waiting = 0, busy = true))
        assertEquals(PixelArt.MarkState.Off, PixelArt.markState(reachable = false, waiting = 1, busy = true))
        // off: dithered to half
        val kept = PixelArt.markCells.count { !PixelArt.dithered(it) }
        assertTrue(kept > 0 && kept < PixelArt.markCells.size)
    }

    @Test
    fun testSprites() {
        assertEquals(16, PixelArt.sprite(PixelArt.square).size)
        assertEquals(12, PixelArt.sprite(PixelArt.hollow).size)
        assertEquals(setOf("claude-code", "codex", "opencode", "pi", "grok"), PixelArt.agents.keys)
        assertTrue(PixelArt.agents.values.all { it.size == 5 && it.all { row -> row.length == 5 } })
        // the terminals tab is not Codex's >_ (one icon, one meaning)
        assertNotEquals(PixelArt.terminalWindow, PixelArt.agents["codex"])
    }

    @Test
    fun testTheWordmark() {
        val rows = PixelArt.wordRows("AGENTSWITCH")
        assertEquals(7, rows.size)
        assertTrue(rows.all { it.length == 11 * 5 + 10 })
        assertEquals(".###.", rows[0].take(5))
        assertEquals(PixelArt.wordRows("AGENT"), PixelArt.wordRows("agent?"), "lowercase reads as capitals; unknown letters drop")
        val fine = PixelArt.fine(rows)
        assertEquals(14, fine.size)
        assertEquals(rows[0].length * 2, fine[0].length)
        assertEquals(PixelArt.sprite(rows).size * 4, PixelArt.sprite(fine).size)
        // G, S and C round their corners with half-lit pixels; a block has none
        assertFalse(PixelArt.halfLit(PixelArt.fine(PixelArt.wordRows("C"))).isEmpty())
        assertTrue(PixelArt.halfLit(PixelArt.square).isEmpty())
    }
}

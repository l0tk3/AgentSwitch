package com.agentswitch.kit

import com.agentswitch.kit.design.AgentLogoArt
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** Each agent's logo (the Mac's `AgentLogoArt`, user #590): all six there, every lit cell with a colour. */
class AgentLogoArtTests {
    @Test
    fun testEveryAgentHasItsLogoAndEveryCellItsColour() {
        assertEquals(setOf("claude-code", "codex", "opencode", "pi", "grok", "agy"), AgentLogoArt.art.keys)
        for ((name, art) in AgentLogoArt.art) {
            assertTrue(art.rows.isNotEmpty() && art.rows.any { row -> row.any { it != '.' } }, name)
            for (row in art.rows) for (key in row) if (key != '.') assertTrue(key in art.colours, "$name: $key")
            for (hex in art.colours.values) assertTrue(hex == "ink" || Regex("^[0-9A-F]{6}$").matches(hex), "$name: $hex")
        }
        // Claude Code's pixels are twice as tall as wide (quadrant blocks); its creature is 16 by 5.
        assertEquals(2.0, AgentLogoArt.tall["claude-code"])
        assertEquals(listOf(16, 5), AgentLogoArt.art.getValue("claude-code").let { listOf(it.rows[0].length, it.rows.size) })
    }
}

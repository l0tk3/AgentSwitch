package com.agentswitch.kit

import com.agentswitch.kit.design.ClassicWords
import com.agentswitch.kit.design.InterfaceLook
import com.agentswitch.kit.design.PixelArt
import com.agentswitch.kit.design.symbol
import com.agentswitch.kit.design.symbols
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The interface's look and the classic look's words and symbols on the phone (docs/ui-v0.md §8, 2026-10-04; the user:
 * 蓝色 英文 固定深色 设置各记各的 图标再说).
 */
class InterfaceLookTests {
    @Test
    fun testTheLookIsPixelUnlessClassicIsKept() {
        assertEquals(InterfaceLook.Pixel, InterfaceLook.load(null))
        assertEquals(InterfaceLook.Pixel, InterfaceLook.load(""))
        assertEquals(InterfaceLook.Pixel, InterfaceLook.load("Classic"), "what is not one of the two words is the default")
        assertEquals(InterfaceLook.Pixel, InterfaceLook.load("pixel"))
        assertEquals(InterfaceLook.Classic, InterfaceLook.load("classic"))
        assertEquals("appearance", InterfaceLook.key)
        assertEquals(listOf("Pixel", "Classic"), InterfaceLook.entries.map { it.label })
        assertEquals(listOf("pixel", "classic"), InterfaceLook.entries.map { it.rawValue })
        assertTrue(InterfaceLook.Classic.isClassic)
        assertFalse(InterfaceLook.Pixel.isClassic)
    }

    @Test
    fun testTheClassicLookHasItsOwnWordForAFewShortWords() {
        for ((pixel, classic) in listOf(
            "Busy" to "Working", "Waiting" to "Needs You", "Idle" to "Ready", "Exited" to "Ended",
            "[!] Approval" to "Approval Needed", "[?] Question" to "Question", "? Question" to "Question",
            "On Mac" to "On This Mac", "bypass" to "Bypass", "auto" to "Auto",
            "Approve" to "Approval Needed", "Answer" to "Question",
        )) {
            assertEquals(classic, ClassicWords.word(pixel, InterfaceLook.Classic))
            assertEquals(pixel, ClassicWords.word(pixel, InterfaceLook.Pixel), "the pixel look's words are never changed")
        }
        for (same in listOf("Allow", "Deny", "Take Over", "Hand Back", "Failed", "Done", "Dispatch", "Terminals", "Browser", "On iPhone", "Reply")) {
            assertEquals(same, ClassicWords.word(same, InterfaceLook.Classic))
        }
        assertEquals("1 Needs You", ClassicWords.word("1 Waiting", InterfaceLook.Classic))
        assertEquals("3 Need You", ClassicWords.word("3 Waiting", InterfaceLook.Classic))
        assertEquals("3 Waiting", ClassicWords.word("3 Waiting", InterfaceLook.Pixel))
        assertEquals("Still Waiting", ClassicWords.word("Still Waiting", InterfaceLook.Classic), "a count only")
    }

    @Test
    fun testALineOfWordsIsWrittenWordByWord() {
        assertEquals("Needs You · Run Command", ClassicWords.phrase("Waiting · Run Command", InterfaceLook.Classic))
        assertEquals("Working · Opus 5.5", ClassicWords.phrase("Busy · Opus 5.5", InterfaceLook.Classic))
        assertEquals("Waiting · Run Command", ClassicWords.phrase("Waiting · Run Command", InterfaceLook.Pixel))
    }

    @Test
    fun testAnAgeSaysAgoInTheClassicLook() {
        assertEquals("3h ago", ClassicWords.age("3h", InterfaceLook.Classic))
        assertEquals("5m ago", ClassicWords.age("5m", InterfaceLook.Classic))
        assertEquals("2d ago", ClassicWords.age("2d", InterfaceLook.Classic))
        assertEquals("Now", ClassicWords.age("Now", InterfaceLook.Classic))
        assertEquals("10/3", ClassicWords.age("10/3", InterfaceLook.Classic))
        assertEquals("3m ago", ClassicWords.age("3m ago", InterfaceLook.Classic), "said already")
        assertEquals("3h", ClassicWords.age("3h", InterfaceLook.Pixel))
    }

    @Test
    fun testAButtonHasNoBracketsAndALabelNoSlashesInTheClassicLook() {
        assertEquals("[ Allow ]", ClassicWords.button("Allow", InterfaceLook.Pixel))
        assertEquals("Allow", ClassicWords.button("Allow", InterfaceLook.Classic))
        assertEquals("New Terminal", ClassicWords.button("+ New Terminal", InterfaceLook.Classic))
        assertEquals("[ + New Terminal ]", ClassicWords.button("+ New Terminal", InterfaceLook.Pixel))
        assertEquals("// Status", ClassicWords.label("Status", InterfaceLook.Pixel))
        assertEquals("Status", ClassicWords.label("Status", InterfaceLook.Classic))
    }

    @Test
    fun testEachSpriteHasASymbolOrIsDrawnByHand() {
        assertEquals("circle.fill", PixelArt.symbol(PixelArt.square), "a status square is a dot")
        assertEquals("circle", PixelArt.symbol(PixelArt.hollow))
        assertEquals("lock", PixelArt.symbol(PixelArt.lock))
        assertEquals("photo", PixelArt.symbol(PixelArt.picture))
        assertEquals("terminal", PixelArt.symbol(PixelArt.terminalWindow))
        assertEquals("globe", PixelArt.symbol(PixelArt.globe))
        // The app's own mark and the agents' are drawn by hand: no symbol stands for them.
        assertNull(PixelArt.symbol(PixelArt.markRows))
        for (rows in PixelArt.agents.values) assertNull(PixelArt.symbol(rows))
        assertEquals(PixelArt.symbols.size, PixelArt.symbols.map { it.rows }.toSet().size, "each set of rows is listed once")
    }
}

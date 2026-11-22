package com.agentswitch.kit

import com.agentswitch.kit.design.PixelArt
import com.agentswitch.kit.design.standing
import com.agentswitch.kit.design.stands
import com.agentswitch.kit.live.ShadedMark
import com.agentswitch.kit.live.ShadedSprite
import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The pixel look's shaded icons (docs/ui-v0.md §9, docs/design/concepts/pixel-icons.html): tones of the one ink, no hue. */
class ShadedSpritesTests {
    private val all = ShadedSprite.all

    /**
     * The same number as the Mac's ShadedSpritesTests, the iPhone's and the daemon's uiShaded.test.ts: the copies of the
     * pictures are one set. A picture changed here changes it; change the other copies with it.
     */
    @Test
    fun testThePicturesAreTheOnesTheOtherCopiesHave() {
        assertEquals(3_628_782_494L, ShadedSprite.digest)
        assertEquals(16, all.size)
        assertEquals(all.size, all.map { it.first }.toSet().size)
    }

    @Test
    fun testEverySpriteIsARectangleOfKnownTonesWithinTheBoard() {
        for ((name, sprite) in all) {
            assertFalse(sprite.rows.isEmpty(), name)
            assertTrue(sprite.rows.all { it.length == sprite.width }, "$name: every row is as long as the first")
            assertTrue(sprite.width <= 16, name)
            assertTrue(sprite.height <= 16, name)
            assertEquals(name.endsWith("code") || name == "codex" || name == "pi" || name == "grok", ShadedSprite.agents[name] != null, name)
            for (tone in sprite.rows.joinToString("").toSet()) {
                if (tone == '.') continue
                assertNotNull(ShadedSprite.color(tone, dark = true), "$name: $tone is a tone")
                assertNotNull(ShadedSprite.color(tone, dark = false), "$name: $tone is a tone on a light ground")
            }
            val lit = sprite.rows.joinToString("").count { it != '.' }
            assertEquals(lit, sprite.cells(dark = true).size, name)
            assertEquals(lit, sprite.cells(dark = false).size, name)
        }
    }

    @Test
    fun testTheTonesAreTheInksOnlyAndTurnWithTheGround() {
        assertEquals(0xE9E6DF, ShadedSprite.color('#', dark = true))
        assertEquals(0x16140F, ShadedSprite.color('#', dark = false))
        assertEquals(0xFFFFFF, ShadedSprite.color('W', dark = true))
        assertEquals(0x000000, ShadedSprite.color('W', dark = false), "the strongest tone is the darkest on paper")
        assertNull(ShadedSprite.color('.', dark = true))
        assertNull(ShadedSprite.color('p', dark = true), "no hue: only the ink's tones")
        // Every tone is a grey of the ink's own warmth: no channel far from the others.
        for ((tone, rgb) in ShadedSprite.tonesLight + ShadedSprite.tonesDark) {
            val parts = listOf(rgb shr 16 and 0xFF, rgb shr 8 and 0xFF, rgb and 0xFF)
            assertTrue(parts.max() - parts.min() <= 24, "$tone is a grey")
        }
        assertEquals(ShadedSprite.tonesDark.keys, ShadedSprite.tonesLight.keys)
    }

    @Test
    fun testTheTabBarsSpritesTheLockAndTheAgentsHaveTheirShadedPictures() {
        assertEquals(ShadedSprite.dispatch, ShadedSprite.standing(PixelArt.markRows))
        assertEquals(ShadedSprite.terminals, ShadedSprite.standing(PixelArt.terminalWindow))
        assertEquals(ShadedSprite.browser, ShadedSprite.standing(PixelArt.globe))
        assertEquals(ShadedSprite.lock, ShadedSprite.standing(PixelArt.lock))
        for ((harness, rows) in PixelArt.agents) assertEquals(ShadedSprite.agents[harness], ShadedSprite.standing(rows), harness)
        assertEquals(ShadedSprite.agents.keys, PixelArt.agents.keys)
        assertNull(ShadedSprite.standing(PixelArt.square))
        assertNull(ShadedSprite.standing(PixelArt.hollow))
        assertEquals(ShadedSprite.stands.size, ShadedSprite.stands.map { it.rows }.toSet().size, "each 1-bit sprite stands once")
    }

    @Test
    fun testACellIsAWholeNumberOfPixels() {
        assertEquals(1.5, ShadedSprite.cell(scale = 2.0))
        assertEquals(1.0, ShadedSprite.cell(scale = 1.0))
        assertEquals(4.0 / 3.0, ShadedSprite.cell(scale = 3.0), 1e-9)
        assertEquals(1.0, ShadedSprite.cell(scale = 0.0), "a scale that makes no sense is one")
        // Any size asked for: never more than asked, at least a pixel.
        assertEquals(1.0, ShadedSprite.cell(scale = 2.0, points = 1.0))
        assertEquals(2.0, ShadedSprite.cell(scale = 2.0, points = 2.25))
        assertEquals(5.0 / 3.0, ShadedSprite.cell(scale = 3.0, points = 5.0 / 3.0), 1e-9)
        assertEquals(0.5, ShadedSprite.cell(scale = 2.0, points = 0.2))
        for (scale in listOf(1.0, 2.0, 3.0)) {
            for (points in listOf(0.75, 1.0, 1.5, 5.0 / 3.0, 2.25, 3.0)) {
                val pixels = ShadedSprite.cell(scale = scale, points = points) * scale
                assertTrue(abs(pixels - Math.rint(pixels)) <= 1e-9, "$points pt at $scale×")
                assertTrue(pixels >= 1)
            }
        }
    }

    @Test
    fun testTheMarksStatesSitOnItsPicture() {
        val rows = ShadedMark.picture.rows.map { it.toList() }
        assertEquals(ShadedSprite.stack, ShadedMark.picture)
        // The title bar: the front window's two top rows, twenty-two cells, lit above, dark at its right end.
        val bar = rows.flatMapIndexed { y, row -> row.mapIndexedNotNull { x, c -> if (c != '.' && ShadedMark.isEnd(x, y)) "$x,$y" else null } }
        assertEquals(22, bar.size)
        assertFalse(ShadedMark.isEnd(11, 6), "the window behind shows through the front one's clipped corner")
        assertEquals(ShadedMark.Edge.Light, ShadedMark.edge(rows[6][1]))
        assertEquals(ShadedMark.Edge.Face, ShadedMark.edge(rows[7][5]))
        assertEquals(ShadedMark.Edge.Dark, ShadedMark.edge(rows[7][11]))
        // The block runs along the title bar, two by two cells a step, none twice, all of them the bar's.
        val lane = ShadedMark.lane.flatten()
        assertEquals(5, ShadedMark.lane.size)
        assertTrue(ShadedMark.lane.all { it.size == 4 })
        assertEquals(lane.size, lane.map { "${it.x},${it.y}" }.toSet().size)
        assertTrue(bar.toSet().containsAll(lane.map { "${it.x},${it.y}" }))
        assertTrue(ShadedMark.dithered(1, 0))
        assertFalse(ShadedMark.dithered(1, 1))
    }
}

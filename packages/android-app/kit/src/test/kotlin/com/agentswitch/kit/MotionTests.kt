package com.agentswitch.kit

import com.agentswitch.kit.design.Motion
import com.agentswitch.kit.design.PixelArt
import com.agentswitch.kit.design.motionInterval
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** What moves on screen moves only with something to show, every mark on one beat (docs/ui-v0.md §7.4, 2026-10-03). */
class MotionTests {
    @Test
    fun testStepsCountFromOneEpochSoMarksStepTogether() {
        val at = Motion.epoch + Motion.spinner * 1_000_003
        assertEquals(1_000_003, Motion.step(at, Motion.spinner), "a step's own moment is that step")
        assertEquals(1_000_002, Motion.step(at - 1, Motion.spinner))
        assertEquals(1_000_003, Motion.step(at + Motion.spinner - 1, Motion.spinner))
        // The blink and the caret: two steps a cycle.
        val blink = Motion.epoch + Motion.blink * 40
        assertEquals(0, Motion.step(blink, Motion.blink) % 2)
        assertEquals(1, Motion.step(blink + 600, Motion.blink) % 2)
        assertEquals(listOf(90L, 550L, 140L, 500L), listOf(Motion.spinner, Motion.blink, Motion.run, Motion.caret))
        // Swift's reference date is 2001-01-01T00:00:00Z.
        assertEquals(java.time.Instant.parse("2001-01-01T00:00:00Z").toEpochMilli(), Motion.epoch)
    }

    @Test
    fun testOnlyBusyAndWaitingMarksMove() {
        assertEquals(Motion.run, PixelArt.MarkState.Busy.motionInterval)
        assertEquals(Motion.blink, PixelArt.MarkState.Waiting.motionInterval)
        assertNull(PixelArt.MarkState.Idle.motionInterval)
        assertNull(PixelArt.MarkState.Error.motionInterval)
        assertNull(PixelArt.MarkState.Off.motionInterval)
    }
}

package com.agentswitch.android.platform

import com.agentswitch.kit.live.LiveState
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** When the Mac is followed from behind (FollowService.kt). */
class FollowRuleTest {
    private fun row(needsYou: Boolean) = LiveState.Row(id = "t1", title = "终端", step = "进行中", startedAt = 0, needsYou = needsYou, kind = LiveState.Row.Kind.Terminal)
    private val working = LiveState(rows = listOf(row(false)), running = 1, waiting = 0)
    private val waiting = LiveState(rows = listOf(row(true)), running = 0, waiting = 1)
    private val both = LiveState(rows = listOf(row(true), row(false)), running = 1, waiting = 1)

    @Test
    fun nothingInProgressIsNotFollowed() {
        assertFalse(FollowRule().follows(null, now = 1_000))
    }

    @Test
    fun workIsFollowedForAsLongAsItRuns() {
        val rule = FollowRule(lingerMs = 60_000)
        assertTrue(rule.follows(working, now = 0))
        assertTrue(rule.follows(working, now = 10 * 3_600_000L))
        assertTrue(rule.follows(both, now = 11 * 3_600_000L))
    }

    @Test
    fun aWaitIsFollowedForTheLingerAndNoLonger() {
        val rule = FollowRule(lingerMs = 60_000)
        assertTrue(rule.follows(waiting, now = 1_000))
        assertTrue(rule.follows(waiting, now = 60_999))
        assertFalse(rule.follows(waiting, now = 61_000))
        assertFalse(rule.follows(waiting, now = 500_000))
    }

    @Test
    fun workBeginningAgainStartsTheLingerAfresh() {
        val rule = FollowRule(lingerMs = 60_000)
        assertTrue(rule.follows(waiting, now = 0))
        assertFalse(rule.follows(waiting, now = 70_000))
        // Answered (on the Mac, or here): at work again, then waiting again.
        assertTrue(rule.follows(working, now = 80_000))
        assertTrue(rule.follows(waiting, now = 90_000))
        assertTrue(rule.follows(waiting, now = 149_999))
        assertFalse(rule.follows(waiting, now = 150_000))
    }

    @Test
    fun nothingInProgressForgetsTheWait() {
        val rule = FollowRule(lingerMs = 60_000)
        assertTrue(rule.follows(waiting, now = 0))
        assertFalse(rule.follows(null, now = 30_000))
        assertTrue(rule.follows(waiting, now = 100_000))
    }

    @Test
    fun aClockSetBackDoesNotFollowForLonger() {
        val rule = FollowRule(lingerMs = 60_000)
        assertTrue(rule.follows(waiting, now = 100_000))
        assertFalse(rule.follows(waiting, now = 50_000))
    }

    @Test
    fun theCountsNameTheOnesWaitingFirst() {
        assertEquals("1 Needs You · 1 Busy", Follower.counts(both))
        assertEquals("1 Busy", Follower.counts(working))
        assertEquals("1 Needs You", Follower.counts(waiting))
    }
}

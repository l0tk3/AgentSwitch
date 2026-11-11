package com.agentswitch.kit.design

import kotlin.math.floor

/**
 * When what moves on screen moves (docs/ui-v0.md §7.4, 2026-10-03; user: 是不是还得优化一下 cpu/gpu 占用): the spinner,
 * the blinking square, the mark's running block, the caret — only while the app is in front (scene phase active) and
 * they have something to show. While shown they look and step as before; steps count from one epoch, so every mark on
 * screen steps at the same moment (one redraw for all of them, not one each). As the Mac's `Motion`.
 *
 * Times are milliseconds (Swift: seconds as `TimeInterval`); an instant is milliseconds since 1970.
 */
object Motion {
    /** The spinner `⠋⠙⠹…`: a frame every 0.09 s. */
    const val spinner: Long = 90L
    /** What waits for you blinks in two steps over 1.1 s. */
    const val blink: Long = 550L
    /** The block running along the mark's lit lane. */
    const val run: Long = 140L
    /** A prompt's block caret: 1 s a cycle, in two steps. */
    const val caret: Long = 500L
    /** The moment every step counts from: Swift's reference date, 2001-01-01 00:00:00 UTC, in milliseconds since 1970. */
    const val epoch: Long = 978_307_200_000L

    /**
     * The step a motion repeating every `every` ms is on at `atMs` (ms since 1970). A step's own moment counts as that
     * step (a timeline entry falls exactly on it; the division must not land a hair short).
     */
    fun step(atMs: Long, every: Long): Int =
        floor((atMs - epoch).toDouble() / every.toDouble() + 1e-6).toInt()
}

/**
 * How often the mark changes: the block runs while busy, the lane's end blinks while something waits; idle, off and
 * error are still pictures. Milliseconds.
 */
val PixelArt.MarkState.motionInterval: Long?
    get() = when (this) {
        PixelArt.MarkState.Busy -> Motion.run
        PixelArt.MarkState.Waiting -> Motion.blink
        PixelArt.MarkState.Idle, PixelArt.MarkState.Error, PixelArt.MarkState.Off -> null
    }

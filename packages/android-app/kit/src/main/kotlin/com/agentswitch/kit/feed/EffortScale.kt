package com.agentswitch.kit.feed

import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * How hard an agent thinks as a place on a line (the effort slider, docs/terminal-v0.md §1 思考强度): the levels a
 * model takes are its stops, lowest first, the first at the line's start and the last at its end.
 */
object EffortScale {
    /** Where `level` is among `levels`; null when it is none of them (none chosen, or a level the model does not take). */
    fun index(level: String?, levels: List<String>): Int? =
        level?.let { l -> levels.indexOf(l).takeIf { it >= 0 } }

    /** The stop nearest to `x` on a line `width` long with `count` stops. */
    fun stop(x: Double, width: Double, count: Int): Int {
        if (count <= 1 || width <= 0) return 0
        return min(max(roundHalfAwayFromZero(x / width * (count - 1).toDouble()), 0), count - 1)
    }

    /** Where stop `index` is on that line. */
    fun place(index: Int, width: Double, count: Int): Double =
        if (count > 1) width * min(max(index, 0), count - 1).toDouble() / (count - 1).toDouble() else 0.0

    /** How lively the line is at stop `index`: still at the lowest, all of it at the highest. */
    fun heat(index: Int, count: Int): Double =
        if (count > 1) min(max(index, 0), count - 1).toDouble() / (count - 1).toDouble() else 0.0

    /** The stop a step to the left or right of `index` lands on (null: none chosen — the first step chooses `start`). */
    fun step(index: Int?, delta: Int, start: Int?, count: Int): Int? {
        if (count <= 0) return null
        if (index == null) return min(max(start ?: 0, 0), count - 1)
        return min(max(index + delta, 0), count - 1)
    }

    /** Swift's `rounded()`: halves away from zero (Kotlin's `round` takes them to even). */
    private fun roundHalfAwayFromZero(v: Double): Int =
        (if (v < 0) -floor(-v + 0.5) else floor(v + 0.5)).toInt()
}

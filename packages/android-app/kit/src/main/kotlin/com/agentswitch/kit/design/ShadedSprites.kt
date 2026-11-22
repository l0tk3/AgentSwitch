package com.agentswitch.kit.design

/**
 * The pixel look's shaded icons (docs/ui-v0.md §9): the pictures are the `live` package's, so the Live Activity draws the
 * same ones; here, which picture stands for which of the app's 1-bit sprites.
 */
typealias ShadedSprite = com.agentswitch.kit.live.ShadedSprite
typealias ShadedMark = com.agentswitch.kit.live.ShadedMark

/** The shaded picture that stands for a 1-bit sprite in the pixel look, by its rows; null for one that has none. */
fun com.agentswitch.kit.live.ShadedSprite.Companion.standing(rows: List<String>): ShadedSprite? = stands.firstOrNull { it.rows == rows }?.sprite

/** One 1-bit sprite (by its rows) and the shaded picture that stands for it. */
data class Stand(val rows: List<String>, val sprite: ShadedSprite)

private val standsTable: List<Stand> = listOf(
    Stand(PixelArt.markRows, ShadedSprite.dispatch), Stand(PixelArt.terminalWindow, ShadedSprite.terminals),
    Stand(PixelArt.globe, ShadedSprite.browser), Stand(PixelArt.lock, ShadedSprite.lock),
) + PixelArt.agents.keys.sorted().mapNotNull { harness ->
    ShadedSprite.agents[harness]?.let { Stand(PixelArt.agents.getValue(harness), it) }
}

/** The tab bar's three (the app's mark, the terminal window, the globe), the lock, each agent's mark. */
internal val com.agentswitch.kit.live.ShadedSprite.Companion.stands: List<Stand> get() = standsTable

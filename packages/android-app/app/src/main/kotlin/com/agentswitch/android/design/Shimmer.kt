package com.agentswitch.android.design

import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.dp
import kotlin.math.floor

/** One pass of the band across the words, in milliseconds. */
private const val shimmerLap = 1900L

/**
 * Words for something still going (what the agent is doing now, a run of work not ended): quiet, with a band of the
 * ink's full colour running across them (docs/simple-view-v0.md §5.1; 2026-10-07, user, of the agents' own apps:
 * 思考过程中的闪烁能不能加上). The classic look's band is soft; the pixel look's is a block that moves in steps (18
 * a lap). Still when animations are removed, and it ticks only while the app is in front (`rememberBeat`).
 * The band is painted over the words with `SrcIn`, so it shows only where the words are.
 */
fun Modifier.shimmer(on: Boolean = true): Modifier = composed {
    val still = reduceMotion()
    if (!on || still) return@composed this
    val classic = LocalLook.current.isClassic
    // 30 frames a second in the classic look; the pixel look changes only when its block steps.
    rememberBeat(if (classic) 33L else shimmerLap / 18)
    val whole = (System.currentTimeMillis() % shimmerLap).toFloat() / shimmerLap
    val part = if (classic) whole else floor(whole * 18) / 18
    val ink = Theme.ink
    graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }.drawWithContent {
        drawContent()
        val band = if (classic) maxOf(44.dp.toPx(), size.width * 0.34f) else 24.dp.toPx()
        val x = -band + (size.width + band) * part
        if (classic) {
            drawRect(
                Brush.horizontalGradient(listOf(ink.copy(alpha = 0f), ink, ink.copy(alpha = 0f)), startX = x, endX = x + band),
                Offset(x, 0f), Size(band, size.height), blendMode = BlendMode.SrcIn,
            )
        } else {
            drawRect(ink, Offset(x, 0f), Size(band, size.height), blendMode = BlendMode.SrcIn)
        }
    }
}

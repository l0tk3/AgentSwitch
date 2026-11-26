package com.agentswitch.android.design

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.agentswitch.kit.design.AgentLogoArt
import com.agentswitch.kit.feed.ModelName

/**
 * An agent's logo (the Mac's `AgentLogo`, user #590): the one its own command-line program draws on its start screen
 * (`AgentLogoArt`), in its own colours, in both looks — on a soft rounded tile in the classic look, in a square frame in
 * the pixel look. `bare`: the art alone (the new-terminal tiles).
 */
@Composable
fun AgentLogo(harness: String, modifier: Modifier = Modifier, size: Dp = 36.dp, bare: Boolean = false) {
    val classic = LocalLook.current.isClassic
    val ink = Theme.ink
    val art = AgentLogoArt.art[harness] ?: AgentLogoArt.art.getValue("pi")
    val tall = (AgentLogoArt.tall[harness] ?: 1.0).toFloat()
    val colours = remember(art, ink) { art.colours.mapValues { (_, hex) -> if (hex == "ink") ink else hexColour(hex) } }
    val ground = when {
        bare -> Modifier
        classic -> Modifier.background(Theme.raised, RoundedCornerShape(12.dp))
        else -> Modifier.border(1.dp, Theme.line)
    }
    Box(modifier.size(size).then(ground).semantics { contentDescription = ModelName.harness(harness) }) {
        Canvas(Modifier.fillMaxSize().padding(if (bare) 0.dp else size * 0.18f)) {
            val wide = art.rows.maxOf { it.length }
            val high = art.rows.size
            val cell = minOf(this.size.width / wide, this.size.height / (high * tall))
            val left = this.size.width / 2 - cell * wide / 2
            val top = this.size.height / 2 - cell * tall * high / 2
            for ((y, row) in art.rows.withIndex()) {
                for ((x, key) in row.withIndex()) {
                    if (key == '.') continue
                    // A hair over a cell, so neighbouring cells meet without a seam.
                    drawRect(colours[key] ?: ink, Offset(left + x * cell, top + y * cell * tall), Size(cell + 0.6f, cell * tall + 0.6f))
                }
            }
        }
    }
}

/** `RRGGBB` as the program drew it. */
private fun hexColour(hex: String): Color {
    val v = hex.toLong(16)
    return Color(red = ((v shr 16) and 0xFF).toInt(), green = ((v shr 8) and 0xFF).toInt(), blue = (v and 0xFF).toInt())
}

package com.agentswitch.android.design

import android.graphics.BlurMaskFilter
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.agentswitch.kit.design.Motion
import com.agentswitch.kit.design.PixelArt
import com.agentswitch.kit.design.motionInterval
import com.agentswitch.kit.design.standing
import com.agentswitch.kit.live.ShadedMark
import com.agentswitch.kit.live.ShadedSprite
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.roundToInt

// The pixel side of the visual language (docs/ui-v0.md §7), as on the iPhone (ios-app App/Sources/Design/PixelViews.swift):
// marks on whole-pixel cells, status squares, the app's mark. Text people read is left to the system font.

/** A cell of `points` dp as a whole number of this screen's pixels (a sprite's cells are never blurred across pixels). */
@Composable
private fun wholeCell(points: Dp): Float {
    val density = LocalDensity.current.density
    return max(1f, (points.value * density).roundToInt().toFloat())
}

/**
 * A 1-bit sprite on whole-pixel cells, in one colour.
 *
 * `strength`: set where the pixel look draws the sprite's shaded picture instead (docs/ui-v0.md §9: a lock, an agent's
 * mark, the globe) and how strongly — 1 for the one in use, less for the others. `picture`: the shaded picture where it
 * is not the one that stands for `rows`. `onDark`: the ground the shaded picture sits on, where it is not the page's.
 */
@Composable
fun PixelSprite(
    rows: List<String>,
    modifier: Modifier = Modifier,
    pixel: Dp = 2.dp,
    color: Color = Theme.ink,
    strength: Float? = null,
    shadow: Boolean = true,
    cell: Double = 1.5,
    picture: ShadedSprite? = null,
    onDark: Boolean? = null,
) {
    if (LocalLook.current.isClassic) {
        val icon = ClassicIconKind.of(rows)
        if (icon != null) {
            val columns = rows.firstOrNull()?.length ?: 0
            ClassicIcon(icon, (columns * pixel.value).dp, (rows.size * pixel.value).dp, color, modifier)
            return
        }
    }
    val shaded = if (!LocalLook.current.isClassic && strength != null) picture ?: ShadedSprite.standing(rows) else null
    if (shaded != null && strength != null) {
        ShadedSpriteView(shaded, modifier, strength, shadow, cell, onDark)
        return
    }
    val px = wholeCell(pixel)
    val density = LocalDensity.current.density
    val columns = rows.firstOrNull()?.length ?: 0
    val lit = PixelArt.sprite(rows)
    // A status square is a small key: a light edge above and left, a dark one below and right (§9). A hollow one is
    // the key's empty seat: dark above and left, light below and right.
    val key = rows == PixelArt.square
    val seat = rows == PixelArt.hollow
    Canvas(modifier.size((columns * px / density).dp, (rows.size * px / density).dp).clearAndSetSemantics { }) {
        for (at in lit) drawRect(color, Offset(at.x * px, at.y * px), Size(px, px))
        if (key || seat) keyEdges(side = columns * px, edge = max(1f, (px / 2).roundToInt().toFloat()), raised = key)
    }
}

/** A status square's edges: a key has a light one above and left and a dark one below and right; its empty seat the other way round. */
private fun DrawScope.keyEdges(side: Float, edge: Float, raised: Boolean) {
    val light = Color.White.copy(alpha = if (raised) 0.45f else 0.3f)
    val shade = Color.Black.copy(alpha = 0.35f)
    val above = if (raised) light else shade
    val below = if (raised) shade else light
    drawRect(above, Offset(0f, 0f), Size(side - edge, edge))
    drawRect(above, Offset(0f, edge), Size(edge, side - 2 * edge))
    drawRect(below, Offset(edge, side - edge), Size(side - edge, edge))
    drawRect(below, Offset(side - edge, edge), Size(edge, side - 2 * edge))
}

/** The hard shadow of a shaded picture: a step off the ground. */
private fun shadowColor(dark: Boolean): Color = colorOf(if (dark) 0x2C2A28 else 0xCFC9BC)

/**
 * A shaded sprite (docs/ui-v0.md §9, ShadedSprite): each cell a whole number of pixels, in its tone of the ink, over a
 * hard shadow a cell down and right.
 */
@Composable
fun ShadedSpriteView(
    sprite: ShadedSprite,
    modifier: Modifier = Modifier,
    strength: Float = 1f,
    shadow: Boolean = true,
    cell: Double = 1.5,
    onDark: Boolean? = null,
) {
    val dark = onDark ?: Theme.isDark
    val density = LocalDensity.current.density
    val px = (ShadedSprite.cell(density.toDouble(), cell) * density).roundToInt().coerceAtLeast(1).toFloat()
    val pad = if (shadow) 1 else 0
    val cells = sprite.cells(dark)
    Canvas(
        modifier
            .size((ceil((sprite.width + pad) * px) / density).dp, (ceil((sprite.height + pad) * px) / density).dp)
            .alpha(strength)
            .clearAndSetSemantics { },
    ) {
        if (shadow) for (c in cells) drawRect(shadowColor(dark), Offset((c.x + 1) * px, (c.y + 1) * px), Size(px, px))
        for (c in cells) drawRect(colorOf(c.rgb), Offset(c.x * px, c.y * px), Size(px, px))
    }
}

/**
 * The app's mark in a state: its shaded picture (§10) with the state on the front window's title bar — cyan with a
 * light block running along it while busy (a fading trail and a little glow; still when animations are removed), amber
 * while something waits (it blinks) and red on an error, every other cell gone when off. `depth`: the hard shadow.
 * Only a busy or waiting mark moves, and only while the app is in front (ui-v0 §7.4, 2026-10-03).
 */
@Composable
fun PixelMarkView(state: PixelArt.MarkState, modifier: Modifier = Modifier, pixel: Dp = 2.dp, depth: Boolean = true) {
    if (LocalLook.current.isClassic) {
        ClassicMarkView(state, (PixelArt.markHeight * pixel.value).dp, modifier)
        return
    }
    val interval = state.motionInterval
    val frame = if (interval != null) rememberBeat(interval) else 0
    val dark = Theme.isDark
    val density = LocalDensity.current.density
    // Five sixths of the old mark's cell: the picture as wide as the 14-cell mark was.
    val px = (ShadedSprite.cell(density.toDouble(), pixel.value * 5.0 / 6.0) * density).roundToInt().coerceAtLeast(1).toFloat()
    val picture = ShadedMark.picture
    val side = (ceil((picture.width + (if (depth) 1 else 0)) * px) / density).dp
    val end: Color? = when (state) {
        PixelArt.MarkState.Waiting -> Theme.waiting
        PixelArt.MarkState.Error -> Theme.failed
        PixelArt.MarkState.Busy -> Theme.busy
        else -> null
    }
    val endLit = if (state == PixelArt.MarkState.Waiting && frame % 2 == 1) 0.25f else 1f
    val off = state == PixelArt.MarkState.Off
    val lane = ShadedMark.lane
    // The block at this frame with its fading trail.
    val block: List<Pair<Int, Float>> = if (state == PixelArt.MarkState.Busy && lane.isNotEmpty()) {
        val fade = if (depth) listOf(0 to 1f, 1 to 0.55f, 2 to 0.25f) else listOf(0 to 1f)
        fade.map { (back, alpha) -> (((frame - back) % lane.size) + lane.size) % lane.size to alpha }
    } else emptyList()
    val rows = picture.rows
    val cells = picture.cells(dark).filter { !off || !ShadedMark.dithered(it.x, it.y) }
    Canvas(modifier.size(side, side).clearAndSetSemantics { }) {
        val head = block.firstOrNull()
        if (depth && head != null) {
            // A little glow under the running block.
            drawIntoCanvas { canvas ->
                val paint = Paint().apply { color = Color.White.copy(alpha = 0.7f) }
                paint.asFrameworkPaint().apply { maskFilter = BlurMaskFilter(px * 1.6f, BlurMaskFilter.Blur.NORMAL); this.color = Color.White.copy(alpha = 0.7f).toArgb() }
                for (at in lane[head.first]) canvas.drawRect(at.x * px, at.y * px, (at.x + 1) * px, (at.y + 1) * px, paint)
            }
        }
        if (depth) for (c in cells) drawRect(shadowColor(dark), Offset((c.x + 1) * px, (c.y + 1) * px), Size(px, px))
        for (c in cells) {
            val at = Offset(c.x * px, c.y * px)
            if (end == null || !ShadedMark.isEnd(c.x, c.y)) {
                drawRect(colorOf(c.rgb), at, Size(px, px))
                continue
            }
            drawRect(end.copy(alpha = endLit), at, Size(px, px))
            when (ShadedMark.edge(rows[c.y][c.x])) {
                ShadedMark.Edge.Light -> drawRect(Color.White.copy(alpha = 0.45f * endLit), at, Size(px, px))
                ShadedMark.Edge.Dark -> drawRect(Color.Black.copy(alpha = 0.35f * endLit), at, Size(px, px))
                ShadedMark.Edge.Face -> Unit
            }
        }
        for ((step, alpha) in block) for (at in lane[step]) drawRect(Color.White.copy(alpha = alpha), Offset(at.x * px, at.y * px), Size(px, px))
    }
}

/** A square status mark: a small key, in a status colour; hollow for what has ended. */
@Composable
fun StatusSquare(color: Color, modifier: Modifier = Modifier, hollow: Boolean = false, pixel: Dp = 2.dp) {
    PixelSprite(if (hollow) PixelArt.hollow else PixelArt.square, modifier, pixel, color)
}

/** The mark of something that waits for you: its square, blinking on the shared beat (1.1 s a cycle, two steps). */
@Composable
fun WaitingSquare(modifier: Modifier = Modifier, pixel: Dp = 2.dp) {
    if (LocalLook.current.isClassic) {
        ClassicWaitingDot(modifier)
        return
    }
    val step = rememberBeat(Motion.blink)
    PixelSprite(PixelArt.square, modifier.alpha(if (step % 2 == 1) 0.25f else 1f), pixel, Theme.waiting)
}

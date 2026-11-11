package com.agentswitch.android.design

import android.graphics.Bitmap
import android.graphics.BlurMaskFilter
import android.graphics.Typeface
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.ShaderBrush
import androidx.compose.ui.graphics.ImageShader
import androidx.compose.ui.graphics.TileMode
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentswitch.kit.design.Motion
import com.agentswitch.kit.design.PixelArt
import kotlinx.coroutines.delay
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

// The rest of the desktop terminal window's motion, on the phone (docs/design/implemented/phone.html, the effects
// table; ios-app App/Sources/Design/Effects.swift): the waiting blink, the block caret, rows drawn line by line and
// wiped out, a screen's refresh, scanlines, the dither, and the wordmark's reveal. All in steps, never eased; still
// when the system has animations removed.
// The classic look (§8 动效) has none of these: what waits is a dot whose ring breathes (ClassicWaitingDot), a caret
// is a thin bar, rows are simply there, a screen is not drawn in, and a floating layer has a soft shadow.

/**
 * What waits for you blinks: 1.1 s a cycle in two steps (under three times a second), every blinker on one clock. It
 * ticks only while it blinks and the app is in front (ui-v0 §7.4, 2026-10-03; `rememberBeat` does both).
 */
fun Modifier.waitingBlink(on: Boolean = true): Modifier = composed {
    if (!on || LocalLook.current.isClassic) return@composed this
    val step = rememberBeat(Motion.blink)
    alpha(if (step % 2 == 1) 0.25f else 1f)
}

/**
 * A prompt's block caret: 1 s a cycle, in two steps; still (shown) when animations are removed and while the app is
 * not in front (ui-v0 §7.4, 2026-10-03). In the classic look the system's thin caret in the accent.
 */
@Composable
fun BlockCaret(modifier: Modifier = Modifier, width: Dp = 8.dp, height: Dp = 17.dp, color: Color = Theme.ink) {
    val classic = LocalLook.current.isClassic
    val step = rememberBeat(Motion.caret)
    val shown = step % 2 == 0
    val signal = Theme.signal
    Canvas(modifier.size(if (classic) 2.dp else width, height).clearAndSetSemantics { }) {
        if (!shown) return@Canvas
        if (classic) {
            drawRoundRect(signal, size = size, cornerRadius = androidx.compose.ui.geometry.CornerRadius(size.width / 2))
        } else {
            drawRect(color, size = size)
        }
    }
}

/**
 * Drawn line by line: a row that arrives with an unfold shows at its turn (22 ms a line), in one step.
 * `active`: the row came with the unfold just made (otherwise it is simply there).
 */
fun Modifier.stepIn(index: Int, active: Boolean): Modifier = composed {
    var shown by remember { mutableStateOf(!active) }
    val still = reduceMotion()
    val classic = LocalLook.current.isClassic
    LaunchedEffect(Unit) {
        if (shown) return@LaunchedEffect
        if (!still && !classic) delay(22L * index)
        shown = true
    }
    alpha(if (shown || classic) 1f else 0f)
}

/** Wiped out top down in five steps (0.2 s) once `on` turns true; it stays gone. */
fun Modifier.wipeOut(on: Boolean): Modifier = composed {
    val steps = 5
    var step by remember { mutableIntStateOf(if (on) steps else 0) }
    val still = reduceMotion()
    var first by remember { mutableStateOf(true) }
    LaunchedEffect(on) {
        if (first) { first = false; return@LaunchedEffect }
        if (!on) { step = 0; return@LaunchedEffect }
        if (still) { step = steps; return@LaunchedEffect }
        for (s in 1..steps) { delay(40); step = s }
    }
    drawWithContent {
        val cut = size.height * step / steps
        clipRect(top = cut) { this@drawWithContent.drawContent() }
    }
}

/**
 * A screen drawn afresh (the desktop's terminal switch — a refresh, not a glitch): it comes in top down in 13 steps
 * (0.26 s), a scanline at its edge, each time `trigger` changes. `ground` covers what has not come in yet.
 */
fun Modifier.screenRefresh(trigger: Any?, ground: Color): Modifier = composed {
    val steps = 13
    var step by remember { mutableStateOf<Int?>(null) }
    val still = reduceMotion()
    val classic = LocalLook.current.isClassic
    var first by remember { mutableStateOf(true) }
    LaunchedEffect(trigger) {
        if (first) { first = false; return@LaunchedEffect }
        if (still || classic) return@LaunchedEffect
        try {
            for (s in 0 until steps) { step = s; delay(20) }
        } finally {
            // Cut short, the cover would stay over what comes back.
            step = null
        }
    }
    drawWithContent {
        drawContent()
        val s = step ?: return@drawWithContent
        val edge = (size.height * s / steps).roundToInt().toFloat()
        drawRect(ground, Offset(0f, edge), Size(size.width, size.height - edge))
        val line = 2.dp.toPx()
        drawRect(Color.White.copy(alpha = 0.9f), Offset(0f, min(edge, size.height - line)), Size(size.width, line))
    }
}

/** Scanlines behind a list (the desktop's sidebar): a 1 dp line every 3 dp at 4 % ink. Nothing in the classic look. */
@Composable
fun Scanlines(modifier: Modifier = Modifier) {
    if (LocalLook.current.isClassic) return
    val ink = Theme.ink.copy(alpha = 0.04f)
    Canvas(modifier.clearAndSetSemantics { }) {
        val one = max(1f, density.roundToInt().toFloat())
        var y = 0f
        while (y < size.height) {
            drawRect(ink, Offset(0f, y), Size(size.width, one))
            y += one * 3
        }
    }
}

/** A tile of the 50 % checkerboard, one cell a whole pixel of this screen (1 dp, or the nearest whole pixel). */
private fun checkerTile(cell: Int, color: Int): ImageBitmap {
    val side = cell * 2
    val bitmap = Bitmap.createBitmap(side, side, Bitmap.Config.ARGB_8888)
    for (y in 0 until side) for (x in 0 until side) {
        if ((x / cell + y / cell) % 2 == 0) bitmap.setPixel(x, y, color)
    }
    return bitmap.asImageBitmap()
}

/** The brush that paints the checkerboard (row 0 starts lit at x = 0, as the Swift's), from the drawing's own origin. */
@Composable
private fun rememberCheckerBrush(color: Color): ShaderBrush {
    val cell = max(1, LocalDensity.current.density.roundToInt())
    val argb = color.toArgb()
    return remember(cell, argb) { ShaderBrush(ImageShader(checkerTile(cell, argb), TileMode.Repeated, TileMode.Repeated)) }
}

/** A 50 % checkerboard of 1 dp cells: a floating layer's hard shadow, and (as a mask) what cannot be used. */
@Composable
fun Checker(modifier: Modifier = Modifier, color: Color = Theme.inkDim) {
    val brush = rememberCheckerBrush(color)
    Canvas(modifier.clearAndSetSemantics { }) { drawRect(brush) }
}

/**
 * The dithered hard shadow of a floating layer: size it as the layer and put it 6 dp down and right (`offset`).
 * Nothing in the classic look: its layers have a soft shadow of their own (`floatingShadow()`).
 */
@Composable
fun DitherShadow(modifier: Modifier = Modifier) {
    if (LocalLook.current.isClassic) return
    Checker(modifier)
}

/** Half of it dithered away: an agent that is not installed. In the classic look it is faint instead. */
fun Modifier.dithered(on: Boolean = true): Modifier = composed {
    if (LocalLook.current.isClassic) return@composed alpha(if (on) 0.4f else 1f)
    if (!on) return@composed this
    val brush = rememberCheckerBrush(Color.Black)
    graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }
        .drawWithContent {
            drawContent()
            drawRect(brush, blendMode = BlendMode.DstIn)
        }
}

/** The classic look's soft shadow under a floating layer (the pixel look's is the dithered one behind it). */
fun Modifier.floatingShadow(shape: androidx.compose.ui.graphics.Shape = androidx.compose.ui.graphics.RectangleShape): Modifier = composed {
    if (LocalLook.current.isClassic) {
        shadow(18.dp, shape, clip = false, ambientColor = Color.Black.copy(alpha = 0.28f), spotColor = Color.Black.copy(alpha = 0.28f))
    } else this
}

// MARK: the wordmark

private const val rampChars = " .:-=+*#%@█"
private const val noiseEnds = 1.1
private const val lcdEnds = 1.38

private fun hash(x: Int, y: Int, frame: Int): Int {
    var h = (x * 73_856_093) xor (y * 19_349_663) xor (frame * 83_492_791)
    h = h * 1_103_515_245 + 12_345
    return (h ushr 8) and 0x7FFFFFFF
}

/**
 * The wordmark AGENTSWITCH (ui-v0 §7.2.10): ink letters with 2-cell strokes over a signal offset of one fine cell,
 * half-lit pixels in the steps. `reveal`: as it first shows, it resolves out of glyph noise cell by cell (1.1 s, 45 ms
 * a frame), shows one frame of the screen seen up close (LCD stripes, 0.28 s), then settles. A reveal that is cut
 * short (animations removed, the app not in front) simply shows the settled mark. `cell`: a stroke is this wide.
 */
@Composable
fun Wordmark(modifier: Modifier = Modifier, word: String = "AGENTSWITCH", cell: Dp = 4.dp, reveal: Boolean = false) {
    if (LocalLook.current.isClassic) {
        ClassicWordmark(modifier, cell)
        return
    }
    val rows = remember(word) { PixelArt.wordRows(word) }
    val cols = rows.firstOrNull()?.length ?: 0
    val density = LocalDensity.current.density
    // A cell of whole, even pixels, so the half cells of the settled mark are whole pixels too.
    val px = max(2, ((cell.value * density).roundToInt() / 2) * 2).toFloat()
    val still = reduceMotion()
    var start by remember { mutableStateOf<Long?>(null) }
    val settleAt = remember(word) { List(rows.size * cols) { 0.12 + Math.random() * 0.76 } }
    LaunchedEffect(Unit) {
        if (!reveal || still) return@LaunchedEffect
        start = System.currentTimeMillis()
        delay((lcdEnds * 1000).toLong())
        start = null
    }
    val ink = Theme.ink
    val signal = Theme.signal
    val line = Theme.line
    val begun = start
    // The reveal ticks every frame (45 ms) while it runs, and only while the app is in front.
    val tick = if (begun != null) rememberBeat(45) else 0
    Canvas(
        modifier.size(((cols + 1) * px / density).dp, ((rows.size + 1) * px / density).dp)
            .semantics { contentDescription = "AgentSwitch" },
    ) {
        if (begun == null) {
            settled(rows, px, ink, signal)
        } else {
            val seconds = (System.currentTimeMillis() - begun) / 1000.0
            @Suppress("UNUSED_EXPRESSION") tick
            if (seconds < noiseEnds) noise(rows, px, seconds, settleAt, ink, signal, line) else lcd(rows, px)
        }
    }
}

/** The classic look: the app's mark in the accent and its name, still. */
@Composable
private fun ClassicWordmark(modifier: Modifier, cell: Dp) {
    Row(modifier.semantics { contentDescription = "AgentSwitch" }, horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(cell * 2.5f), verticalAlignment = Alignment.CenterVertically) {
        val signal = Theme.signal
        Canvas(Modifier.size(width = cell * 8 * 14 / 11, height = cell * 8)) {
            drawClassicMark(androidx.compose.ui.geometry.Rect(Offset.Zero, size), lit = signal, dim = signal.copy(alpha = 0.5f))
        }
        Text("AgentSwitch", color = Theme.ink, style = plain(1).copy(fontSize = (cell.value * 6).sp, fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold))
    }
}

private fun DrawScope.settled(rows: List<String>, px: Float, ink: Color, signal: Color) {
    val fine = PixelArt.fine(rows)
    val f = px / 2
    val cells = PixelArt.sprite(fine)
    for (c in cells) drawRect(signal, Offset((c.x + 1) * f, (c.y + 1) * f), Size(f, f))
    for (c in PixelArt.halfLit(fine)) drawRect(ink.copy(alpha = 0.42f), Offset(c.x * f, c.y * f), Size(f, f))
    for (c in cells) drawRect(ink, Offset(c.x * f, c.y * f), Size(f, f))
}

/**
 * Cells not settled yet show a glyph from the ramp, new each frame (the letters' cells from all of it, the rest from
 * its faint end); a settled cell flashes the signal colour for 90 ms, then turns ink.
 */
private fun DrawScope.noise(rows: List<String>, px: Float, seconds: Double, settleAt: List<Double>, ink: Color, signal: Color, faint: Color) {
    val frame = (seconds / 0.045).toInt()
    val cols = rows.first().length
    val lit = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
        color = ink.toArgb(); textSize = px * 1.3f; textAlign = android.graphics.Paint.Align.CENTER; typeface = Typeface.MONOSPACE
    }
    val dim = android.graphics.Paint(lit).apply { color = faint.toArgb() }
    val baseline = -(lit.ascent() + lit.descent()) / 2
    drawIntoCanvas { canvas ->
        for ((y, row) in rows.withIndex()) for ((x, c) in row.withIndex()) {
            val on = c == '#'
            val at = settleAt.getOrElse(y * cols + x) { 0.0 }
            if (seconds >= at) {
                if (on) drawRect(if (seconds - at < 0.09) signal else ink, Offset(x * px, y * px), Size(px, px))
            } else {
                val pick = hash(x, y, frame)
                val glyph = if (on) rampChars[pick % rampChars.length] else rampChars[pick % 4]
                canvas.nativeCanvas.drawText(glyph.toString(), x * px + px / 2, y * px + px / 2 + baseline, if (on) lit else dim)
            }
        }
    }
}

/** The screen up close: each lit cell as red, green and blue stripes over a soft glow. */
private fun DrawScope.lcd(rows: List<String>, px: Float) {
    val cells = PixelArt.sprite(rows)
    drawIntoCanvas { canvas ->
        val paint = android.graphics.Paint().apply {
            color = Color.White.copy(alpha = 0.5f).toArgb()
            maskFilter = BlurMaskFilter(px * 0.6f, BlurMaskFilter.Blur.NORMAL)
        }
        for (c in cells) canvas.nativeCanvas.drawRect(c.x * px, c.y * px, (c.x + 1) * px, (c.y + 1) * px, paint)
    }
    val stripe = px / 3
    val colours = listOf(Color(1f, 0.23f, 0.23f), Color(0.23f, 1f, 0.48f), Color(0.23f, 0.48f, 1f))
    for (c in cells) for ((i, colour) in colours.withIndex()) {
        drawRect(colour, Offset(c.x * px + i * stripe + stripe * 0.12f, c.y * px + px * 0.06f), Size(stripe * 0.76f, px * 0.88f))
    }
}

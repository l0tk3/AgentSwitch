package com.agentswitch.android.design

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.ClipOp
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.agentswitch.kit.design.Motion
import com.agentswitch.kit.design.PixelArt
import com.agentswitch.kit.design.symbol
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

// The classic look's side of the shared parts (docs/ui-v0.md §8, 2026-10-04; docs/design/concepts/classic.html), as in
// the Mac app: what PixelViews.kt draws in place of its pixels when the look is classic — line icons, dots, the
// system's spinner, thin bars. No page uses these directly: the pages ask for the shared parts, which decide.

/**
 * What stands for a pixel sprite: a symbol of the kit's `PixelArt.symbols` table (the iPhone draws them with SF
 * Symbols; here they are lines drawn with `Canvas`), the app's own mark, an agent's mark (the only ones drawn by hand
 * on the iPhone, too).
 */
sealed interface ClassicIconKind {
    data class Symbol(val name: String) : ClassicIconKind
    data object Lanes : ClassicIconKind
    data class Agent(val harness: String) : ClassicIconKind

    companion object {
        /** The icon for a sprite's rows; null for one the classic look has none for (it draws the pixels). */
        fun of(rows: List<String>): ClassicIconKind? {
            PixelArt.symbol(rows)?.let { return Symbol(it) }
            if (rows == PixelArt.markRows) return Lanes
            return PixelArt.agents.entries.firstOrNull { it.value == rows }?.key?.let { Agent(it) }
        }
    }
}

/**
 * The icon in the sprite's frame (`width` × `height`). A dot fills its square, as the pixel square did; a line icon is
 * a little larger than the sprite's height.
 */
@Composable
fun ClassicIcon(kind: ClassicIconKind, width: Dp, height: Dp, color: Color, modifier: Modifier = Modifier) {
    Canvas(modifier.size(width, height).clearAndSetSemantics { }) {
        val frame = Rect(Offset.Zero, size)
        when (kind) {
            is ClassicIconKind.Symbol -> drawSymbol(kind.name, frame, color)
            ClassicIconKind.Lanes -> drawClassicLanes(frame, lit = color, dim = color.copy(alpha = 0.5f))
            is ClassicIconKind.Agent -> drawClassicAgent(kind.harness, frame, color)
        }
    }
}

/** A line icon by its SF Symbol name, in the unit square centred on `frame`. */
private fun DrawScope.drawSymbol(name: String, frame: Rect, color: Color) {
    val side = min(frame.width, frame.height)
    val dot = name.startsWith("circle")
    // A dot fills its square (0.92 of it); a line icon is a little larger than the sprite's height.
    val box = if (dot) side * 0.92f else max(side * 1.08f, 10.dp.toPx())
    val o = Offset(frame.center.x - box / 2, frame.center.y - box / 2)
    fun p(x: Float, y: Float) = Offset(o.x + x * box, o.y + y * box)
    val line = max(1f, box * 0.085f)
    val stroke = Stroke(line, cap = StrokeCap.Round, join = StrokeJoin.Round)
    fun rounded(l: Float, t: Float, r: Float, b: Float, radius: Float) =
        Path().apply { addRoundRect(RoundRect(Rect(p(l, t), p(r, b)), CornerRadius(radius * box))) }
    when (name) {
        "circle.fill" -> drawCircle(color, box / 2, frame.center)
        "circle" -> drawCircle(color, box / 2 - line / 2, frame.center, style = Stroke(max(1f, box * 0.1f)))
        "lock" -> {
            drawPath(rounded(0.2f, 0.45f, 0.8f, 0.9f, 0.1f), color, style = stroke)
            val shackle = Path().apply {
                moveTo(p(0.33f, 0.45f).x, p(0.33f, 0.45f).y)
                lineTo(p(0.33f, 0.32f).x, p(0.33f, 0.32f).y)
                cubicTo(p(0.33f, 0.1f).x, p(0.33f, 0.1f).y, p(0.67f, 0.1f).x, p(0.67f, 0.1f).y, p(0.67f, 0.32f).x, p(0.67f, 0.32f).y)
                lineTo(p(0.67f, 0.45f).x, p(0.67f, 0.45f).y)
            }
            drawPath(shackle, color, style = stroke)
        }
        "photo" -> {
            drawPath(rounded(0.08f, 0.18f, 0.92f, 0.82f, 0.1f), color, style = stroke)
            drawCircle(color, box * 0.07f, p(0.32f, 0.4f))
            val hill = Path().apply {
                moveTo(p(0.1f, 0.75f).x, p(0.1f, 0.75f).y)
                for ((x, y) in listOf(0.4f to 0.5f, 0.6f to 0.68f, 0.72f to 0.58f, 0.9f to 0.76f)) lineTo(p(x, y).x, p(x, y).y)
            }
            drawPath(hill, color, style = stroke)
        }
        "terminal" -> {
            drawPath(rounded(0.06f, 0.18f, 0.94f, 0.82f, 0.1f), color, style = stroke)
            val prompt = Path().apply {
                moveTo(p(0.24f, 0.38f).x, p(0.24f, 0.38f).y); lineTo(p(0.39f, 0.5f).x, p(0.39f, 0.5f).y); lineTo(p(0.24f, 0.62f).x, p(0.24f, 0.62f).y)
                moveTo(p(0.5f, 0.64f).x, p(0.5f, 0.64f).y); lineTo(p(0.72f, 0.64f).x, p(0.72f, 0.64f).y)
            }
            drawPath(prompt, color, style = stroke)
        }
        "globe" -> {
            drawCircle(color, box * 0.42f, p(0.5f, 0.5f), style = stroke)
            drawOval(color, p(0.29f, 0.08f), Size(box * 0.42f, box * 0.84f), style = stroke)
            drawLine(color, p(0.08f, 0.5f), p(0.92f, 0.5f), line)
        }
        else -> drawCircle(color, box * 0.3f, frame.center)
    }
}

/**
 * The app's mark as lines (docs/ui-v0.md §10): three windows one behind another, the front one's title bar in `end` —
 * where a state shows. The Live Activity draws the same one (LiveLook).
 */
fun DrawScope.drawClassicMark(rect: Rect, lit: Color, dim: Color, end: Color? = null) {
    // 14 × 11 cells: three windows one behind another, each with its title bar; the front one's is the lit part, and
    // it has its three dots, a prompt and a cursor.
    val u = min(rect.width / 14, rect.height / 11)
    val origin = Offset(rect.center.x - 7 * u, rect.center.y - 5.5f * u)
    val line = max(1f, 0.95f * u)
    fun window(x: Float, y: Float) = Rect(origin.x + x * u, origin.y + y * u, origin.x + (x + 9) * u, origin.y + (y + 6.2f) * u)
    fun shape(r: Rect, grow: Float = 0f): Path = Path().apply {
        addRoundRect(RoundRect(r.inflate(grow), CornerRadius(1.5f * u + grow)))
    }
    fun band(r: Rect, height: Float): Path = Path().apply { addRect(Rect(r.left, r.top, r.right, r.top + height)) }
    val frames = listOf(window(5f, 0f), window(2.5f, 2.4f), window(0f, 4.8f))
    // A window behind shows its title bar and its edge where the one before it leaves it clear, a gap between them;
    // the furthest is the faintest.
    for ((i, strength) in listOf(0 to 0.62f, 1 to 1f)) {
        clipPath(shape(frames[i + 1], 0.8f * u), ClipOp.Difference) {
            clipPath(shape(frames[i])) {
                drawPath(band(frames[i], 1.5f * u), dim.copy(alpha = dim.alpha * strength))
                clipPath(band(frames[i], 1.5f * u), ClipOp.Difference) {
                    drawPath(shape(frames[i], -line / 2), dim.copy(alpha = dim.alpha * strength), style = Stroke(line))
                }
            }
        }
    }
    val front = frames[2]
    fun at(x: Float, y: Float) = Offset(front.left + x * u, front.top + y * u)
    // Its edge below the title bar only: the bar's dots are holes, and nothing shows through them.
    clipPath(band(front, 2.2f * u), ClipOp.Difference) {
        drawPath(shape(front, -line / 2), lit, style = Stroke(line))
    }
    val prompt = Path().apply {
        moveTo(at(1.9f, 2.9f).x, at(1.9f, 2.9f).y); lineTo(at(2.95f, 3.75f).x, at(2.95f, 3.75f).y); lineTo(at(1.9f, 4.6f).x, at(1.9f, 4.6f).y)
        moveTo(at(4.0f, 4.6f).x, at(4.0f, 4.6f).y); lineTo(at(5.7f, 4.6f).x, at(5.7f, 4.6f).y)
    }
    drawPath(prompt, lit, style = Stroke(0.75f * u, cap = StrokeCap.Round, join = StrokeJoin.Round))
    val title = Path().apply {
        fillType = PathFillType.EvenOdd
        addPath(band(front, 2.2f * u))
        for (i in 0 until 3) addOval(Rect(at(1.19f + 1.2f * i, 0.79f), Size(0.72f * u, 0.72f * u)))
    }
    clipPath(shape(front)) { drawPath(title, end ?: lit) }
}

/**
 * The Dispatch tab's icon as lines: one source switched onto three lanes, the pixel picture with the squares rounded
 * and the steps curved; the top lane is the lit one.
 */
fun DrawScope.drawClassicLanes(rect: Rect, lit: Color, dim: Color, end: Color? = null) {
    val u = min(rect.width / 14, rect.height / 11)   // the pixel mark's grid: 14 × 11 cells
    val origin = Offset(rect.center.x - 7 * u, rect.center.y - 5.5f * u)
    fun point(x: Float, y: Float) = Offset(origin.x + x * u, origin.y + y * u)
    fun block(x: Float, y: Float) = Path().apply { addRoundRect(RoundRect(Rect(point(x, y), Size(3 * u, 3 * u)), CornerRadius(0.85f * u))) }
    val stroke = Stroke(max(1f, 0.95f * u), cap = StrokeCap.Round)
    fun lane(y: Float) = Path().apply {
        moveTo(point(3f, 5.5f).x, point(3f, 5.5f).y)
        cubicTo(point(7.4f, 5.5f).x, point(7.4f, 5.5f).y, point(6.6f, y).x, point(6.6f, y).y, point(11f, y).x, point(11f, y).y)
    }
    // The two fainter lanes and their squares as one picture, drawn once in a layer and laid down with the faint
    // colour's own opacity: drawn each by itself, the faint colour lay twice where a lane ran into its square and
    // where the two lanes leave the source together, and showed there as brighter patches (2026-10-07, user:
    // 线和方块在交界处重叠上了 有点难看).
    val solid = dim.copy(alpha = 1f)
    drawIntoCanvas { canvas ->
        canvas.saveLayer(Rect(rect.left - u, rect.top - u, rect.right + u, rect.bottom + u), Paint().apply { alpha = dim.alpha })
        drawPath(lane(5.5f), solid, style = stroke)
        drawPath(lane(9.5f), solid, style = stroke)
        drawPath(block(11f, 4f), solid)
        drawPath(block(11f, 8f), solid)
        canvas.restore()
    }
    drawPath(lane(1.5f), lit, style = stroke)
    drawPath(block(0f, 4f), lit)
    drawPath(block(11f, 0f), end ?: lit)
}

/**
 * The app's mark in a state (PixelMarkView's classic side): the front window's title bar in the accent while busy,
 * amber while something waits for you, red on an error, the whole mark faint when off; while busy the system's
 * spinner beside it.
 */
@Composable
fun ClassicMarkView(state: PixelArt.MarkState, height: Dp, modifier: Modifier = Modifier) {
    val end: Color? = when (state) {
        PixelArt.MarkState.Waiting -> Theme.waiting
        PixelArt.MarkState.Error -> Theme.failed
        PixelArt.MarkState.Busy -> Theme.busy
        else -> null
    }
    val ink = Theme.ink
    Row(modifier.clearAndSetSemantics { }, horizontalArrangement = Arrangement.spacedBy(height * 0.3f), verticalAlignment = Alignment.CenterVertically) {
        Canvas(Modifier.size(width = height * 14 / 11, height = height).alpha(if (state == PixelArt.MarkState.Off) 0.4f else 1f)) {
            drawClassicMark(Rect(Offset.Zero, size), lit = ink, dim = ink.copy(alpha = 0.45f), end = end)
        }
        if (state == PixelArt.MarkState.Busy) ClassicSpinner(size = max(12f, height.value * 0.8f).toInt())
    }
}

/** The agents' marks as lines, each from its own logo: Claude Code's spark, Codex's >_, OpenCode's brackets, pi's π, Grok's ring with the stroke that runs out of it. */
fun DrawScope.drawClassicAgent(harness: String, rect: Rect, color: Color) {
    val s = min(rect.width, rect.height)
    val origin = Offset(rect.center.x - s / 2, rect.center.y - s / 2)
    fun p(x: Float, y: Float) = Offset(origin.x + x * s, origin.y + y * s)
    val path = Path()
    fun Path.move(x: Float, y: Float) = p(x, y).let { moveTo(it.x, it.y) }
    fun Path.line(x: Float, y: Float) = p(x, y).let { lineTo(it.x, it.y) }
    when (harness) {
        "claude-code" -> for (k in 0 until 4) {
            val angle = k * Math.PI.toFloat() / 4
            val dx = cos(angle) * 0.44f
            val dy = sin(angle) * 0.44f
            path.move(0.5f - dx, 0.5f - dy); path.line(0.5f + dx, 0.5f + dy)
        }
        "codex" -> {
            path.move(0.12f, 0.2f); path.line(0.46f, 0.5f); path.line(0.12f, 0.8f)
            path.move(0.56f, 0.82f); path.line(0.9f, 0.82f)
        }
        "opencode" -> {
            path.move(0.38f, 0.1f); path.line(0.14f, 0.1f); path.line(0.14f, 0.9f); path.line(0.38f, 0.9f)
            path.move(0.62f, 0.1f); path.line(0.86f, 0.1f); path.line(0.86f, 0.9f); path.line(0.62f, 0.9f)
        }
        "grok" -> {
            // The ring, open where the stroke leaves it at the upper right (angles run with the clock, from the right);
            // the stroke from the middle out past it; its tail below the ring at the lower left.
            val c = p(0.5f, 0.5f)
            val r = s * 0.3f
            path.arcTo(Rect(c.x - r, c.y - r, c.x + r, c.y + r), -20f, 310f, true)
            path.move(0.5f, 0.5f); path.line(0.9f, 0.1f)
            path.move(0.1f, 0.9f); path.line(0.29f, 0.71f)
        }
        else -> {
            path.move(0.1f, 0.24f); path.line(0.9f, 0.24f)
            path.move(0.34f, 0.24f); path.line(0.3f, 0.86f)
            path.move(0.66f, 0.24f)
            path.cubicTo(p(0.64f, 0.62f).x, p(0.64f, 0.62f).y, p(0.68f, 0.86f).x, p(0.68f, 0.86f).y, p(0.86f, 0.84f).x, p(0.86f, 0.84f).y)
        }
    }
    drawPath(path, color, style = Stroke(max(1f, s * 0.11f), cap = StrokeCap.Round, join = StrokeJoin.Round))
}

/**
 * The system's spinner at the size of a line's mark; a still ring when animations are removed (and nothing turns
 * while the app is not in front, since nothing is drawn then: ui-v0 §7.4). `size`: the glyph size of the braille
 * spinner it stands for, 13 in a line of words.
 */
@Composable
fun ClassicSpinner(modifier: Modifier = Modifier, size: Int = 13, color: Color = Theme.secondaryInk) {
    val side = max(9, Math.round(size * 0.9f)).dp
    if (reduceMotion()) {
        Canvas(modifier.size(side).clearAndSetSemantics { }) {
            val w = 1.5.dp.toPx()
            val inset = w / 2 + 1.dp.toPx()
            drawArc(color, 0.12f * 360f + 270f, 0.76f * 360f, false, Offset(inset, inset), Size(this.size.width - 2 * inset, this.size.height - 2 * inset), style = Stroke(w, cap = StrokeCap.Round))
        }
    } else {
        CircularProgressIndicator(modifier.size(side), color = color, strokeWidth = 1.5.dp)
    }
}

/**
 * Waiting for you: an amber dot whose ring breathes (the blinking square's classic side); still when animations are
 * removed.
 */
@Composable
fun ClassicWaitingDot(modifier: Modifier = Modifier, color: Color = Theme.waiting, side: Dp = 8.dp) {
    val still = reduceMotion()
    val step = rememberBeat(Motion.blink)
    val out by animateFloatAsState(if (!still && step % 2 == 1) 1f else 0f, tween(Motion.blink.toInt(), easing = FastOutSlowInEasing), label = "ring")
    Canvas(modifier.size(side).clearAndSetSemantics { }) {
        val r = size.width / 2
        drawCircle(color, r)
        if (!still) {
            val ringWidth = max(1f, size.width * 0.16f)
            val scale = 1.3f + 0.6f * out
            drawCircle(color.copy(alpha = 0.5f * (1f - out)), r * scale - ringWidth / 2, style = Stroke(ringWidth))
        }
    }
}

/** A thin bar for a part of a whole (CharMeter's classic side). */
@Composable
fun ClassicBar(fraction: Double, modifier: Modifier = Modifier, color: Color = Theme.done, width: Dp = 60.dp, height: Dp = 4.dp) {
    val track = Theme.inkDim.copy(alpha = 0.35f)
    Canvas(modifier.size(width, height).clearAndSetSemantics { }) {
        val r = CornerRadius(size.height / 2)
        drawRoundRect(track, size = size, cornerRadius = r)
        val w = size.width * fraction.coerceIn(0.0, 1.0).toFloat()
        if (w > 0f) drawRoundRect(color, size = Size(w, size.height), cornerRadius = r)
    }
}

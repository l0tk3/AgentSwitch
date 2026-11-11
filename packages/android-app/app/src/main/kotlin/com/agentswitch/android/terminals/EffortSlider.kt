package com.agentswitch.android.terminals

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.drag
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.setProgress
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.agentswitch.android.design.LocalLook
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.lookWord
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.reduceMotion
import com.agentswitch.kit.feed.EffortDisplay
import com.agentswitch.kit.feed.EffortScale
import kotlinx.coroutines.delay
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin

// How hard the agent thinks, chosen on a line (docs/terminal-v0.md §1 思考强度; 2026-10-07, user: 思考强度改成滑块调节
// 加上和官方差不多的特效，新建的时候也这样选): the levels its model takes are the line's stops, lowest first. In the
// classic look a slider of this app's own: a rounded rectangle for the line, a rounded oblong for the knob, and in the
// filled part particles of light drifting forward — clearly more and clearly quicker with each level, and at the
// highest level, the scale's end, each with a short tail, the highest level in a colour of its own (violet). Its
// story, all the user's words on 2026-10-07: first a thick pill with a round knob and stars, after Codex's own
// (太大了，而且和codex的一模一样); then bars that rise like a signal's strength (太丑了，改成滑块吧还是，然后一个
// 圆角矩形+圆角长方形滑块，里面加上流动特效); now this, at the bars' small size. In the pixel look a row of cells: a
// bright one running along the lit ones, and at the top the row in violet, twinkling. A tick under the finger at each
// stop (left out here: no haptics on this phone's app); nothing moves under Remove Animations. The Mac draws the same
// line (packages share nothing but the service's API).

/** The room the line is drawn in: the knob's height (the pixel look's cells with their ticks). */
private const val LINE_HEIGHT = 34

/** The line itself. `level`: the level chosen; null: none — the model's default. `fallback`: what that default is. */
@Composable
fun EffortSlider(levels: List<String>, level: String?, modifier: Modifier = Modifier, fallback: String? = null, enabled: Boolean = true, choose: (String) -> Unit) {
    val classic = LocalLook.current.isClassic
    val still = reduceMotion()
    val density = LocalDensity.current.density
    var dragging by remember { mutableStateOf<Int?>(null) }
    val chosen = EffortScale.index(level, levels)
    val resting = chosen ?: EffortScale.index(fallback, levels)
    val at = dragging ?: resting
    val inset = if (classic) 9f else 15f
    val moving = !still && enabled && (at ?: 0) > 0
    // The clock the line's motion reads in its draw (not in composition: the line alone is redrawn, 30 times a second,
    // and only while the app is in front and there is a level above the lowest).
    var clock by remember { mutableLongStateOf(0L) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(moving, lifecycle) {
        if (!moving) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            while (true) {
                clock = System.nanoTime() / 1_000_000L
                delay(33)
            }
        }
    }
    val levelsNow by rememberUpdatedState(levels)
    val chooseNow by rememberUpdatedState(choose)
    val colors = Theme.palette
    val signal = Theme.signal
    val ink = Theme.ink
    val top = Theme.top
    val topDeep = Theme.topDeep
    val name = at?.let { EffortDisplay.name(levels[it]) } ?: "Default"
    Column(
        modifier.alpha(if (enabled) 1f else 0.45f).semantics {
            contentDescription = "Level"
            stateDescription = name
            if (enabled) setProgress { value ->
                val next = value.toInt().coerceIn(0, max(0, levelsNow.size - 1))
                levelsNow.getOrNull(next)?.let(chooseNow)
                true
            }
        },
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Canvas(
            Modifier.fillMaxWidth().height(LINE_HEIGHT.dp).pointerInput(enabled, levels.size, inset) {
                if (!enabled) return@pointerInput
                awaitEachGesture {
                    val down = awaitFirstDown()
                    val width = (size.width - inset * 2 * density).toDouble()
                    fun stopAt(x: Float) = EffortScale.stop((x - inset * density).toDouble(), width, levelsNow.size)
                    var stop = stopAt(down.position.x)
                    dragging = stop
                    down.consume()
                    drag(down.id) { change ->
                        stop = stopAt(change.position.x)
                        dragging = stop
                        change.consume()
                    }
                    dragging = null
                    levelsNow.getOrNull(stop)?.let(chooseNow)
                }
            },
        ) {
            drawEffort(
                this, levels.size, at, firm = dragging != null || chosen != null, time = clock / 1000.0, moving = moving,
                classic = classic, inset = inset * density, signal = signal, ink = ink, top = top, topDeep = topDeep,
            )
        }
    }
}

/** A number in 0 ..< 1 that is always the same for the same star. */
private fun chance(seed: Double): Double {
    val v = sin(seed) * 43758.5453
    return v - floor(v)
}

private fun drawEffort(
    g: DrawScope, count: Int, at: Int?, firm: Boolean, time: Double, moving: Boolean, classic: Boolean, inset: Float,
    signal: Color, ink: Color, top: Color, topDeep: Color,
) = with(g) {
    val width = (size.width - inset * 2).toDouble()
    val mid = size.height / 2 - 1.dp.toPx()
    fun x(index: Int): Float = inset + EffortScale.place(index, width, count).toFloat()
    val knob = at?.let(::x)
    val heat = at?.let { EffortScale.heat(it, count) } ?: 0.0
    val isTop = heat >= 1 && count > 1
    val colour = if (isTop) top else signal
    val dp = 1.dp.toPx()

    if (classic) {
        // A rounded rectangle for the line and a rounded oblong for the knob, particles of light streaming in the filled part.
        val thick = 20 * dp
        val radius = 6.5f * dp
        val trackTop = mid - thick / 2
        drawRoundRect(ink.copy(alpha = 0.1f), Offset(0f, trackTop), Size(size.width, thick), CornerRadius(radius))
        // The stops still ahead, faintly: where a level is.
        for (index in 0 until count) {
            if (at != null && index <= at) continue
            drawRoundRect(ink.copy(alpha = 0.26f), Offset(x(index) - 0.75f * dp, mid - 3.5f * dp), Size(1.5f * dp, 7 * dp), CornerRadius(0.75f * dp))
        }
        if (knob == null) return@with
        // Filled up to the knob.
        val fillWidth = knob
        val shape = Path().apply { addRoundRect(androidx.compose.ui.geometry.RoundRect(Rect(0f, trackTop, fillWidth, trackTop + thick), CornerRadius(radius))) }
        val colors = if (isTop) listOf(topDeep, top) else listOf(colour.copy(alpha = 0.7f), colour)
        val a = if (firm) 1f else 0.38f
        clipPath(shape) {
            drawRect(Brush.horizontalGradient(colors, startX = 0f, endX = max(fillWidth, 1f)), Offset(0f, trackTop), Size(fillWidth, thick), alpha = a)
            if (moving && fillWidth > 16 * dp) {
                // Particles of light drifting forward in the filled part, on one scale from the lowest level to the
                // highest: each level up there are clearly more of them, clearly quicker and a little brighter, and
                // the highest level is that scale's end — with a short tail behind each, there alone. The user's
                // words on 2026-10-07, in turn: slanted bands of light (太难看了 改成粒子流光效果吧); tails and speed at
                // every level (粒子流光应该克制一些 最高档位之前粒子慢一些而且没拖尾 … 到最高挡位速度和粒子数量最大并且加上拖尾);
                // then the levels below the top told apart by almost nothing and the top a world of its own
                // (最高档位和其他档位差的有点太大了 之前几个档位基本看不出来区别).
                val longest = if (isTop) 13.0 * dp else 0.0
                val run = fillWidth + longest
                val motes = (1 + 15 * heat.pow(1.25)).let { Math.round(it).toInt() }
                val speed = (3.0 + 34.0 * heat.pow(1.4)) * dp
                for (mote in 0 until motes) {
                    val seed = mote * 12.9898 + 4.1
                    val pace = speed * (0.65 + 0.7 * chance(seed * 2.3))
                    val px = ((chance(seed) * run + time * pace) % run).toFloat()
                    val py = trackTop + 4 * dp + (chance(seed * 1.7 + 3.1) * (thick - 4.0 * dp * 2)).toFloat()
                    val twinkle = 0.55 + 0.45 * sin(time * (1.1 + 2.4 * chance(seed * 0.61)) + seed)
                    val r = ((0.8 + 0.8 * chance(seed * 0.37)) * (0.85 + 0.3 * heat) * dp).toFloat()
                    val glow = (0.2 + 0.3 * heat + (0.24 + 0.16 * heat) * twinkle).toFloat()
                    if (isTop) {
                        val tail = (longest * (0.4 + 0.6 * chance(seed * 0.83))).toFloat()
                        drawLine(
                            Brush.horizontalGradient(listOf(Color.White.copy(alpha = 0f), Color.White.copy(alpha = glow * 0.7f)), startX = px - tail, endX = px),
                            Offset(px - tail, py), Offset(px, py), strokeWidth = r * 1.5f, cap = StrokeCap.Round,
                        )
                    }
                    drawCircle(Color.White.copy(alpha = glow), r, Offset(px, py))
                }
            }
        }
        // The knob: an oblong standing over the line, white; hollow while it only shows the model's own level.
        val grip = Rect(knob - 6.5f * dp, mid - 15 * dp, knob + 6.5f * dp, mid + 15 * dp)
        drawRoundRect(Color.Black.copy(alpha = 0.28f), grip.topLeft + Offset(0f, 1.4f * dp), grip.size, CornerRadius(4.5f * dp))
        drawRoundRect(Color.White.copy(alpha = if (firm) 1f else 0.8f), grip.topLeft, grip.size, CornerRadius(4.5f * dp))
        drawRoundRect(Color.Black.copy(alpha = 0.12f), grip.topLeft, grip.size, CornerRadius(4.5f * dp), style = Stroke(0.5f * dp))
    } else {
        // A row of cells; the lit ones up to the knob, a bright one running along them.
        val cell = 7 * dp
        val gap = 2 * dp
        val tall = 22 * dp
        val cells = max(1, ((size.width + gap) / (cell + gap)).toInt())
        val lit = knob?.let { min(cells, (it / (cell + gap)).toInt() + 1) } ?: 0
        val lap = 2.8 - 1.9 * heat
        val runner = if (moving && lit > 1) ((time % lap) / lap * lit).toInt() else -1
        val frame = (time * 9).toInt()
        val strength = if (firm) (0.55 + 0.45 * heat).toFloat() else 0.3f
        for (index in 0 until cells) {
            val left = index * (cell + gap)
            if (index >= lit) {
                drawRect(ink.copy(alpha = 0.13f), Offset(left, mid - tall / 2), Size(cell, tall))
                continue
            }
            if (index == runner) {
                drawRect(ink, Offset(left, mid - tall / 2), Size(cell, tall))
                continue
            }
            // At the highest the row twinkles: a cell or two dim for a moment.
            val dim = isTop && moving && chance(index * 7.31 + frame * 1.93) > 0.9
            drawRect(colour.copy(alpha = if (dim) strength * 0.4f else strength), Offset(left, mid - tall / 2), Size(cell, tall))
        }
        for (index in 0 until count) {
            drawRect(ink.copy(alpha = 0.4f), Offset(x(index) - 0.5f * dp, mid + tall / 2 + 2 * dp), Size(1 * dp, 3 * dp))
        }
        if (knob == null) return@with
        val bar = Rect(knob - 2 * dp, mid - tall / 2 - 3 * dp, knob + 2 * dp, mid + tall / 2 + 3 * dp)
        if (firm) drawRect(ink, bar.topLeft, bar.size)
        else drawRect(ink.copy(alpha = 0.6f), bar.topLeft + Offset(0.5f * dp, 0.5f * dp), Size(bar.width - dp, bar.height - dp), style = Stroke(dp))
    }
}

/**
 * The slider with its words: the agent's own word for it and the level over the line — the highest level in its own
 * colour; `Default` puts the choice back where there is one to put back. No sentence about what a level is
 * (2026-10-07, user: 描述没有必要): only a line the caller has to say (what choosing does, why it cannot be chosen now).
 * `note`: a line of its own under the slider. `reset`: back to none chosen (absent where a level is always in force: a
 * running terminal). `heading`: the agent's word for it, as the page around writes its labels.
 */
@Composable
fun EffortPicker(
    levels: List<String>,
    level: String?,
    modifier: Modifier = Modifier,
    fallback: String? = null,
    enabled: Boolean = true,
    note: String? = null,
    reset: (() -> Unit)? = null,
    choose: (String) -> Unit,
    heading: @Composable () -> Unit,
) {
    val highest = level != null && level == levels.lastOrNull() && levels.size > 1
    Column(modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            heading()
            Spacer(Modifier.weight(1f))
            if (level != null && reset != null) {
                Text(lookWord("Default"), Modifier.clickable(role = Role.Button, onClick = reset).padding(vertical = 2.dp), color = Theme.secondaryInk, style = mono(12))
            }
            Text(
                level?.let { EffortDisplay.name(it) } ?: fallback?.let { "Default · ${EffortDisplay.name(it)}" } ?: "Default",
                color = if (level == null) Theme.secondaryInk else if (highest) Theme.top else Theme.signal,
                style = mono(13, FontWeight.Medium), maxLines = 1,
            )
        }
        EffortSlider(levels, level, Modifier.fillMaxWidth(), fallback, enabled, choose)
        if (note != null) Text(note, color = Theme.inkDim, style = com.agentswitch.android.design.plain(12))
    }
}

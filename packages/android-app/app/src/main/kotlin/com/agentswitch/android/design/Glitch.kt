package com.agentswitch.android.design

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ColorMatrix
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.graphics.drawscope.ContentDrawScope
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// One burst when something changes (docs/ui-v0.md §7.2.9; ios-app App/Sources/Design/Glitch.swift), the web page's
// `.glitch` on a native view: 0.29 s in steps — sideways jolts, bands of the view cut away, the cyan and signal copies
// pulled apart, one inverted frame. Never a loop, always ends on the untouched picture. The content is drawn again
// for each part of a frame (`drawContent()` into a clip, a tinted layer, an inverting layer): the view's own picture
// is not copied into a bitmap, so there is nothing to fall back from below API 31 and nothing to keep in step.
// Nothing when the system has animations removed, and none in the classic look (§8 动效).

/** One frame of a burst. */
data class GlitchFrame(
    val dx: Float = 0f,
    val dy: Float = 0f,
    /** The band that stays, as fractions cut from the top and the bottom. */
    val top: Float = 0f,
    val bottom: Float = 0f,
    /** How far the cyan and signal copies stand off, left and right (dp). */
    val split: Float = 0f,
    val invert: Boolean = false,
)

/** terminal.css `@keyframes glitch`, as (start in milliseconds, frame); the last one (null) ends it. */
private val burst: List<Pair<Long, GlitchFrame?>> = listOf(
    36L to GlitchFrame(dx = -4f, top = 0.12f, bottom = 0.52f, split = 3f),
    72L to GlitchFrame(dx = 5f, top = 0.58f, bottom = 0.08f, split = 3f),
    108L to GlitchFrame(dx = -2f, dy = 1f, top = 0.30f, bottom = 0.36f, split = -4f),
    144L to GlitchFrame(invert = true),
    180L to GlitchFrame(split = 1f),
    252L to GlitchFrame(dx = 2f, top = 0.70f, split = 1f),
    288L to null,
)

/** The lighter burst a busy row gets: the bands and the split copies, no inverted frame, 0.14 s. */
private val runningBurst: List<Pair<Long, GlitchFrame?>> = listOf(
    0L to GlitchFrame(dx = -3f, top = 0.14f, bottom = 0.46f, split = 3f),
    50L to GlitchFrame(dx = 3f, top = 0.56f, bottom = 0.10f, split = -2f),
    100L to GlitchFrame(split = 1f),
    140L to null,
)

private val invertFilter = ColorFilter.colorMatrix(
    ColorMatrix(floatArrayOf(-1f, 0f, 0f, 0f, 255f, 0f, -1f, 0f, 0f, 255f, 0f, 0f, -1f, 0f, 255f, 0f, 0f, 0f, 1f, 0f)),
)

private suspend fun play(frames: List<Pair<Long, GlitchFrame?>>, show: (GlitchFrame?) -> Unit) {
    var elapsed = 0L
    try {
        for ((at, next) in frames) {
            delay(at - elapsed)
            elapsed = at
            show(next)
        }
    } finally {
        // Cut short, a burst must not keep its last frame (2026-10-01, user: 正在工作的 session 怎么只显示了半截).
        show(null)
    }
}

/** A tinted copy of the content (SwiftUI's `colorMultiply`), pulled `dx` sideways, over what is drawn so far. */
private fun ContentDrawScope.drawCopy(color: Color, dx: Float, alpha: Float) {
    val room = 32.dp.toPx()
    val paint = Paint().apply { colorFilter = ColorFilter.tint(color, BlendMode.Modulate); this.alpha = alpha }
    drawIntoCanvas { canvas ->
        canvas.saveLayer(Rect(-room, -room, size.width + room, size.height + room), paint)
        translate(left = dx) { this@drawCopy.drawContent() }
        canvas.restore()
    }
}

/** One frame on the view: the split copies behind it, the jolt, the band that stays, the inversion. */
private fun ContentDrawScope.drawFrame(f: GlitchFrame, busy: Color, signal: Color) {
    val room = 32.dp.toPx()
    val pad = 8.dp.toPx()
    val density = 1.dp.toPx()
    fun picture() {
        translate(left = f.dx * density, top = f.dy * density) {
            if (f.split != 0f) {
                this@drawFrame.drawCopy(busy, f.split * density, 0.9f)
                this@drawFrame.drawCopy(signal, -f.split * density, 0.9f)
            }
            this@drawFrame.drawContent()
        }
    }
    fun banded() {
        if (f.top > 0f || f.bottom > 0f) {
            // Room for the jolts and the split copies beside the view.
            clipRect(left = -pad, top = f.top * size.height, right = size.width + pad, bottom = size.height - f.bottom * size.height) { picture() }
        } else {
            picture()
        }
    }
    if (f.invert) {
        val paint = Paint().apply { colorFilter = invertFilter }
        drawIntoCanvas { canvas ->
            canvas.saveLayer(Rect(-room, -room, size.width + room, size.height + room), paint)
            banded()
            canvas.restore()
        }
    } else {
        banded()
    }
}

/** What draws a frame (or nothing, for the untouched picture) over a view's content. */
private fun Modifier.glitched(frame: () -> GlitchFrame?, busy: Color, signal: Color): Modifier = drawWithContent {
    val f = frame()
    if (f == null) drawContent() else drawFrame(f, busy, signal)
}

/**
 * A glitch burst each time `on` changes (to a value `whenChanged` accepts, if given; and as the view appears, with
 * `onAppear`: a box that only exists while open). The burst runs once and ends on the untouched picture.
 */
fun <T> Modifier.glitch(on: T, onAppear: Boolean = false, whenChanged: ((T) -> Boolean)? = null): Modifier = composed {
    val classic = LocalLook.current.isClassic
    val still = reduceMotion()
    val scope = rememberCoroutineScope()
    var frame by remember { mutableStateOf<GlitchFrame?>(null) }
    var run by remember { mutableStateOf<Job?>(null) }
    var first by remember { mutableStateOf(true) }
    LaunchedEffect(on) {
        val appearing = first
        first = false
        val wanted = if (appearing) onAppear else whenChanged?.invoke(on) ?: true
        if (!wanted || still || classic) return@LaunchedEffect
        run?.cancel()
        run = scope.launch { play(burst) { frame = it } }
    }
    DisposableEffect(Unit) { onDispose { run?.cancel(); frame = null } }
    glitched({ frame }, Theme.busy, Theme.signal)
}

/**
 * While something runs, a short burst now and then (2026-10-01, user: 正在运行中的都改成这个效果（glitch 动效）; ui-v0
 * §7.2.9): the bands and the split copies, no inverted frame, 0.14 s every 3 to 7 seconds, so the full burst stays the
 * sign that something happened (it waits for you, it ended). Nothing when animations are removed, while the app is
 * not in front (ui-v0 §7.4, 2026-10-03) or in the classic look.
 */
fun Modifier.runningGlitch(running: Boolean): Modifier = composed {
    val classic = LocalLook.current.isClassic
    val still = reduceMotion()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var frame by remember { mutableStateOf<GlitchFrame?>(null) }
    LaunchedEffect(running && !still && !classic, lifecycle) {
        if (!(running && !still && !classic)) { frame = null; return@LaunchedEffect }
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            while (true) {
                delay((3000L..7000L).random())
                play(runningBurst) { frame = it }
            }
        }
    }
    glitched({ frame }, Theme.busy, Theme.signal)
}

/** A tap target that glitches once per tap needs only this: a counter to hand to [glitch] (`on = count`). */
@Composable
fun rememberGlitchCount(): androidx.compose.runtime.MutableIntState = remember { androidx.compose.runtime.mutableIntStateOf(0) }

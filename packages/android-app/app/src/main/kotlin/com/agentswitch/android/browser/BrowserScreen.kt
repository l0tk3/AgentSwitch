package com.agentswitch.android.browser

import android.graphics.Bitmap
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.border
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.PointerEvent
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.changedToUp
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.mono
import com.agentswitch.kit.browser.BrowserLayout
import com.agentswitch.kit.browser.Point
import com.agentswitch.kit.browser.Size
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.math.hypot
import kotlin.math.roundToInt

// A tab's live picture and what a finger does on it (docs/browser-v0.md §1 操作; the iPhone's `BrowserScreenView` and
// `BrowserScreen`, a UIKit view with gesture recognisers): the newest frame where the layout puts it, and what the agent
// just did outlined over it — a cyan box around the element with a label (`codex · click "Merge"`), as the demo page
// draws it.
//
// Points are the view's own, in dp, as on the iPhone (the layout's `area` is the view's size in points; a touch is where
// the finger is in the view in points): the page measures the view and sets `page.area`, and everything the callbacks
// say is in dp of this view. A tap clicks, a long press (0.5 s) is the right button, one finger dragging scrolls the
// page (a flick carries on a little), two fingers zoom and move the picture on the phone only.

/**
 * The picture, the outline and the touches. `onDrag`: a drag's movement since the last call, and where the finger is;
 * `onPinch`: the zoom by a pinch (relative to the last call) about a point; `onPan`: the picture moved by two fingers.
 */
@Composable
fun BrowserScreen(
    picture: Bitmap?,
    layout: BrowserLayout?,
    action: BrowserPageModel.ActionShown?,
    onTap: (Point) -> Unit,
    onLongPress: (Point) -> Unit,
    onDrag: (Size, Point) -> Unit,
    onPinch: (Double, Point) -> Unit,
    onPan: (Size) -> Unit,
    modifier: Modifier = Modifier,
) {
    val density = LocalDensity.current.density
    val scope = rememberCoroutineScope()
    val tap by rememberUpdatedState(onTap)
    val long by rememberUpdatedState(onLongPress)
    val drag by rememberUpdatedState(onDrag)
    val pinch by rememberUpdatedState(onPinch)
    val pan by rememberUpdatedState(onPan)
    val coast = remember { arrayOfNulls<Job>(1) }
    val image = remember(picture) { picture?.asImageBitmap() }

    Box(
        modifier.clipToBounds().semantics { contentDescription = "页面画面" }
            .pointerInput(density) {
                val slop = viewConfiguration.touchSlop
                val holdMs = 500L
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    coast[0]?.cancel()
                    val start = down.position
                    fun dp(o: Offset) = Point((o.x / density).toDouble(), (o.y / density).toDouble())
                    // What the first moments are: a tap (up soon, still), a drag (moved), a long press (held), two fingers.
                    var phase = 0   // 1 up, 2 drag, 3 two fingers
                    var last = start
                    val first = withTimeoutOrNull(holdMs) {
                        while (true) {
                            val event = awaitPointerEvent()
                            if (event.changes.count { it.pressed } >= 2) { phase = 3; return@withTimeoutOrNull }
                            val change = event.changes.firstOrNull { it.id == down.id } ?: event.changes.first()
                            if (change.changedToUp()) { phase = 1; return@withTimeoutOrNull }
                            if (hypot(change.position.x - start.x, change.position.y - start.y) > slop) {
                                last = change.position
                                phase = 2
                                return@withTimeoutOrNull
                            }
                        }
                    }
                    if (first == null) {
                        // Held: the right button; the rest of the touch is not read as anything else.
                        long(dp(start))
                        while (true) {
                            val event = awaitPointerEvent()
                            if (event.changes.none { it.pressed }) break
                        }
                        return@awaitEachGesture
                    }
                    when (phase) {
                        1 -> tap(dp(start))
                        2 -> {
                            val tracker = androidx.compose.ui.input.pointer.util.VelocityTracker()
                            tracker.addPosition(down.uptimeMillis, start)
                            var from = start
                            var now = last
                            drag(Size(((now.x - from.x) / density).toDouble(), ((now.y - from.y) / density).toDouble()), dp(now))
                            from = now
                            var twoFingers = false
                            while (true) {
                                val event = awaitPointerEvent()
                                if (event.changes.count { it.pressed } >= 2) { twoFingers = true; break }
                                val change = event.changes.first()
                                tracker.addPosition(change.uptimeMillis, change.position)
                                if (change.changedToUp() || !change.pressed) {
                                    val v = tracker.calculateVelocity()
                                    val vx = v.x / density
                                    val vy = v.y / density
                                    if (hypot(vx, vy) > 300) {
                                        val at = dp(change.position)
                                        // A flick carries on, slowing: a few more turns, smaller each time.
                                        coast[0] = scope.launch {
                                            var sx = vx * 0.05
                                            var sy = vy * 0.05
                                            for (i in 0 until 8) {
                                                if (!isActive) break
                                                drag(Size(sx.toDouble(), sy.toDouble()), at)
                                                sx *= 0.7
                                                sy *= 0.7
                                                delay(50)
                                            }
                                        }
                                    }
                                    break
                                }
                                now = change.position
                                drag(Size(((now.x - from.x) / density).toDouble(), ((now.y - from.y) / density).toDouble()), dp(now))
                                from = now
                            }
                            if (twoFingers) twoFingerLoop(density, pinch, pan)
                        }
                        3 -> twoFingerLoop(density, pinch, pan)
                    }
                }
            },
    ) {
        if (layout != null && layout.picture.width > 0) {
            if (image != null) {
                val origin = layout.zoom.apply(layout.picture.origin)
                val scale = layout.zoom.scale
                Canvas(Modifier.fillMaxSize()) {
                    drawImage(
                        image,
                        dstOffset = IntOffset((origin.x * density).roundToInt(), (origin.y * density).roundToInt()),
                        dstSize = IntSize((layout.picture.width * scale * density).roundToInt(), (layout.picture.height * scale * density).roundToInt()),
                        filterQuality = FilterQuality.Medium,
                    )
                }
            }
            if (action != null && image != null) {
                // outline-offset 3 px, the label sitting on the box's top-left corner (the demo page's .hit)
                val r = layout.screenRect(action.box, action.frameScale)
                val left = ((r.x - 3) * density).roundToInt()
                val top = ((r.y - 3) * density).roundToInt()
                val w = ((r.width + 6) * density).roundToInt().coerceAtLeast(1)
                val h = ((r.height + 6) * density).roundToInt().coerceAtLeast(1)
                Box(
                    Modifier.layout { m, c ->
                        val p = m.measure(c.copy(minWidth = w, maxWidth = w, minHeight = h, maxHeight = h))
                        layout(p.width, p.height) { p.place(left, top) }
                    }.border(2.dp, Theme.busy, RectangleShape),
                )
                val areaWidth = (layout.area.width * density).toFloat()
                Text(
                    action.said, maxLines = 1,
                    modifier = Modifier.layout { m, c ->
                        val room = (areaWidth - 8 * density).roundToInt().coerceAtLeast(1)
                        val p = m.measure(c.copy(minWidth = 0, maxWidth = room))
                        val x = (left + 1 * density).coerceAtLeast(4 * density).coerceAtMost((areaWidth - p.width - 4 * density).coerceAtLeast(0f))
                        val y = if (top - p.height >= 0) top - p.height else top + h
                        layout(p.width, p.height) { p.place(x.roundToInt(), y) }
                    }.background(Theme.busy).padding(horizontal = 6.dp, vertical = 1.dp),
                    color = androidx.compose.ui.graphics.Color.Black, style = mono(10, FontWeight.SemiBold),
                )
            }
        }
    }
}

/** Pinch and the two-finger move go together: the zoom about the fingers' middle, and the middle's own movement. */
private suspend fun androidx.compose.ui.input.pointer.AwaitPointerEventScope.twoFingerLoop(
    density: Float, pinch: (Double, Point) -> Unit, pan: (Size) -> Unit,
) {
    var lastSpan = 0f
    var lastMid: Offset? = null
    while (true) {
        val event: PointerEvent = awaitPointerEvent(PointerEventPass.Main)
        val down = event.changes.filter { it.pressed }
        if (down.size < 2) {
            if (down.isEmpty()) return
            // One finger of the two left: nothing more is read until all are up.
            while (true) { if (awaitPointerEvent().changes.none { it.pressed }) return }
        }
        val a = down[0].position
        val b = down[1].position
        val span = hypot(a.x - b.x, a.y - b.y)
        val mid = Offset((a.x + b.x) / 2, (a.y + b.y) / 2)
        if (lastSpan > 0f && span > 0f) {
            pinch((span / lastSpan).toDouble(), Point((mid.x / density).toDouble(), (mid.y / density).toDouble()))
            lastMid?.let { pan(Size(((mid.x - it.x) / density).toDouble(), ((mid.y - it.y) / density).toDouble())) }
        }
        lastSpan = span
        lastMid = mid
        down.forEach { if (it.positionChange() != Offset.Zero) it.consume() }
    }
}

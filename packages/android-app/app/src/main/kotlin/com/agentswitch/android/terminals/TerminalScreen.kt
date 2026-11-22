package com.agentswitch.android.terminals

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.reduceMotion
import com.agentswitch.android.terminal.TerminalDisplayView

/**
 * The controller's view in Compose, and touch (terminal-v0 §1 second round; the iPhone's `TerminalScreen`): the view
 * ([TerminalDisplayView]) does the gestures itself — a drag scrolls this screen's history, or the program by wheel
 * notches when it is full screen or tracks the mouse (a flick carries on a little); a pinch changes the text size; a tap
 * and a press held are told here with their place (the view's own pixels). This puts it into the page, attaches it to
 * the controller (the page model owns that, the view comes and goes with the composition) and draws the link the
 * finger took: the signal colour at 40 %, held [TerminalScreenController.FLASH_DELAY_MS], faded over
 * [TerminalScreenController.FLASH_FADE_MS] (at once when the system has animations removed), then
 * `controller.flashEnded`.
 *
 * `onPinchEnded`: the text size (sp) the pinch ended at: the page keeps it. `onOrigin`: where the screen's top left is
 * in the window (pixels), so a menu can be placed by a link whose frame the controller gives in the view's pixels.
 */
@Composable
fun TerminalScreen(
    controller: TerminalScreenController,
    modifier: Modifier = Modifier,
    onPinchEnded: (Float) -> Unit = {},
    onWheel: (Boolean, Int) -> Unit = { _, _ -> },
    onTap: (Float, Float) -> Unit = { _, _ -> },
    onHold: (Float, Float) -> Unit = { _, _ -> },
    onOrigin: (Offset) -> Unit = {},
) {
    val pinched by rememberUpdatedState(onPinchEnded)
    val wheeled by rememberUpdatedState(onWheel)
    val tapped by rememberUpdatedState(onTap)
    val held by rememberUpdatedState(onHold)
    val origin by rememberUpdatedState(onOrigin)
    // Clipped: the view paints its whole canvas (`drawColor`), which a Compose layer does not cut to the view's bounds.
    Box(modifier.clipToBounds().padding(horizontal = 6.dp)) {
        AndroidView(
            factory = { context ->
                TerminalDisplayView(context, controller.fontSize).also { view ->
                    view.onTap = { x, y -> tapped(x, y) }
                    view.onHold = { x, y -> held(x, y) }
                    view.onWheel = { up, count -> wheeled(up, count) }
                    view.onPinchEnded = { size ->
                        // The view changed its own size while pinching: the controller is told where it ended.
                        controller.setFontSize(size)
                        pinched(controller.fontSize)
                    }
                    controller.attach(view)
                }
            },
            modifier = Modifier.fillMaxSize().onGloballyPositioned { origin(it.boundsInRoot().topLeft) },
            onRelease = { controller.detach(it) },
        )
        LinkFlashLayer(controller)
    }
}

/** The link just touched, lit up for a moment. */
@Composable
private fun LinkFlashLayer(controller: TerminalScreenController) {
    val flash = controller.flash
    val alpha = remember { Animatable(0f) }
    val still = reduceMotion()
    LaunchedEffect(flash?.serial) {
        val now = flash ?: return@LaunchedEffect
        if (still) {
            controller.flashEnded(now.serial)
            return@LaunchedEffect
        }
        alpha.snapTo(0.4f)
        kotlinx.coroutines.delay(TerminalScreenController.FLASH_DELAY_MS)
        alpha.animateTo(0f, tween(TerminalScreenController.FLASH_FADE_MS.toInt()))
        controller.flashEnded(now.serial)
    }
    if (flash == null) return
    val color = Theme.signal
    Canvas(Modifier.fillMaxSize()) {
        for (r in flash.rects) drawRect(color.copy(alpha = alpha.value), Offset(r.left, r.top), Size(r.width(), r.height()))
    }
}

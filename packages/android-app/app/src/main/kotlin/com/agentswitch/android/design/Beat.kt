package com.agentswitch.android.design

import android.provider.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay

/**
 * The beats things move on (the kit's `Motion`, in milliseconds): every spinner turns on the same beat, every waiting
 * mark blinks together, because each asks the clock which step it is rather than counting its own.
 */
object Beat {
    const val spinner = 90L
    const val blink = 550L
    const val run = 140L
    const val caret = 500L

    fun step(nowMs: Long, every: Long): Int = ((nowMs / every) % Int.MAX_VALUE).toInt()
}

/** Whether the user asked the system to remove animations (Settings › Accessibility): then nothing here moves. */
@Composable
fun reduceMotion(): Boolean {
    val context = LocalContext.current
    return remember {
        Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
    }
}

/**
 * The step of a beat now, kept current while the app is in front (docs/ui-v0.md §7.4 省电: nothing ticks behind).
 * Still at the first step when animations are removed.
 */
@Composable
fun rememberBeat(every: Long): Int {
    if (reduceMotion()) return 0
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val step by produceState(Beat.step(System.currentTimeMillis(), every), every, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            while (true) {
                val now = System.currentTimeMillis()
                value = Beat.step(now, every)
                delay(every - now % every)
            }
        }
    }
    return step
}

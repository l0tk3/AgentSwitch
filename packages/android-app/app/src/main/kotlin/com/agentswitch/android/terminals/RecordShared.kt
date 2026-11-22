package com.agentswitch.android.terminals

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import com.agentswitch.kit.api.RecordFile

// What a terminal's page and a session's record share without belonging to either.

/**
 * Where an answer's file opens (docs/simple-view-v0.md §5.16): the terminal page lays its Files browser over itself
 * with the file's preview on top; elsewhere (a past session's page) the Files tab goes to its folder. Null: nowhere
 * yet — the chip only copies its path.
 */
val LocalOpenMacFile = staticCompositionLocalOf<((RecordFile) -> Unit)?> { null }

/** The reply being written to each terminal, kept while its page is closed (for as long as the app runs). */
object ReplyDrafts {
    val text = HashMap<String, String>()
}

/**
 * The conversation's text size on this phone (Settings › Appearance › Text Size): steps up or down from the size the
 * system is set to. The terminal's own size is its pinch.
 */
object RecordTextSize {
    const val key = "record.textStep"
    val steps = -3..4

    /** How much larger or smaller text is drawn at `step`: the iPhone's text sizes, from xSmall to the first of the larger ones. */
    fun factor(step: Int): Float = factors[(step.coerceIn(steps.first, steps.last)) - steps.first]

    private val factors = floatArrayOf(0.82f, 0.88f, 0.94f, 1f, 1.12f, 1.24f, 1.35f, 1.6f)
}

/** What is under this is read at the conversation's own text size. */
@Composable
fun RecordTextSized(step: Int, content: @Composable () -> Unit) {
    val density = LocalDensity.current
    if (step == 0) { content(); return }
    CompositionLocalProvider(LocalDensity provides Density(density.density, density.fontScale * RecordTextSize.factor(step)), content = content)
}

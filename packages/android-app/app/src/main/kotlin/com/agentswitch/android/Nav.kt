package com.agentswitch.android

import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.staticCompositionLocalOf

/**
 * The pages over the tabs: a page of one thing (a terminal, a task) pushed from the right, and a sheet (pairing, a new
 * terminal) risen from the bottom — both cover the whole screen, tab bar included, as on the iPhone. The system's back
 * gesture takes the top one away.
 */
@Stable
class Nav {
    class Entry(val key: String, val sheet: Boolean, val content: @Composable () -> Unit) {
        /** Seen coming in, and going out before it is taken off the stack. */
        val visible = MutableTransitionState(false).apply { targetState = true }
    }

    val stack = mutableStateListOf<Entry>()

    /** A page of one thing, pushed over what is there. A page with the same key already on top is left as it is. */
    fun push(key: String, content: @Composable () -> Unit) {
        if (stack.lastOrNull()?.key == key) return
        stack.add(Entry(key, sheet = false, content))
    }

    /** A sheet, risen over what is there. */
    fun present(key: String, content: @Composable () -> Unit) {
        if (stack.any { it.key == key && it.visible.targetState }) return
        stack.add(Entry(key, sheet = true, content))
    }

    /** Takes the top page or sheet away; false when nothing is over the tabs. */
    fun pop(): Boolean {
        val top = stack.lastOrNull { it.visible.targetState } ?: return false
        top.visible.targetState = false
        return true
    }

    /** Takes the page or sheet with this key away, wherever it is, and everything over it. */
    fun dismiss(key: String) {
        val at = stack.indexOfLast { it.key == key }
        if (at < 0) return
        for (i in at until stack.size) stack[i].visible.targetState = false
    }

    /** Back to the tabs. */
    fun popToRoot() {
        for (entry in stack) entry.visible.targetState = false
    }

    /** An entry that has finished going out is dropped. */
    fun settled(entry: Entry) {
        if (!entry.visible.targetState && entry.visible.isIdle) stack.remove(entry)
    }

    val isEmpty: Boolean get() = stack.none { it.visible.targetState }
}

val LocalNav = staticCompositionLocalOf<Nav> { error("no Nav in this composition") }
val LocalAppModel = staticCompositionLocalOf<AppModel> { error("no AppModel in this composition") }
val LocalSettings = staticCompositionLocalOf<AppSettings> { error("no AppSettings in this composition") }

/** The page's own way back: its bar's `Back` or `Cancel` calls this. */
@Composable
fun rememberBack(): () -> Unit {
    val nav = LocalNav.current
    return { nav.pop() }
}

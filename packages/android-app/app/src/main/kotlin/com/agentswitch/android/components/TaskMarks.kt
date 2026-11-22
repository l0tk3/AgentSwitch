package com.agentswitch.android.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.agentswitch.android.design.BrailleSpinner
import com.agentswitch.android.design.LocalLook
import com.agentswitch.android.design.StatusSquare
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.WaitingSquare
import com.agentswitch.android.design.lookWord
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.kit.api.AgentTask
import com.agentswitch.kit.api.TaskStatus
import com.agentswitch.kit.feed.Staleness
import kotlinx.coroutines.delay

// A task's small marks, wherever a task is listed (the iPhone's Theme.swift, PixelViews.swift, Components.swift,
// Components/TaskMarks.swift).

/** A task's status colour: only ever with its mark or its word. */
@Composable
@ReadOnlyComposable
fun taskColor(status: TaskStatus): Color = when (status) {
    TaskStatus.Done -> Theme.done
    TaskStatus.Failed -> Theme.failed
    TaskStatus.WaitingApproval, TaskStatus.Partial, TaskStatus.Blocked -> Theme.waiting
    TaskStatus.Routing, TaskStatus.Running -> Theme.busy
    else -> Theme.secondaryInk
}

/**
 * A task's status in pixels: the braille spinner while it runs, a square while it waits (blinking) or once done,
 * hollow once it ended otherwise (cancelled, incomplete, failed keep their colour).
 * In the classic look: the system's spinner, a dot (its ring breathing while it waits), a ring.
 */
@Composable
fun StatusMark(status: TaskStatus, modifier: Modifier = Modifier) {
    when (status) {
        TaskStatus.Routing, TaskStatus.Running -> BrailleSpinner(modifier)
        TaskStatus.Queued, TaskStatus.Cancelled -> StatusSquare(taskColor(status), modifier, hollow = true)
        is TaskStatus.Other -> StatusSquare(taskColor(status), modifier, hollow = true)
        TaskStatus.WaitingApproval -> WaitingSquare(modifier)
        else -> StatusSquare(taskColor(status), modifier)
    }
}

/**
 * A status: its pixel mark and its word, in the status colour. `waiting` overrides (a pending question on a running
 * task).
 */
@Composable
fun StatusLabel(task: AgentTask, modifier: Modifier = Modifier, waiting: Boolean = false) {
    val status = if (waiting) TaskStatus.WaitingApproval else task.status
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        StatusMark(status)
        Text(lookWord(if (waiting) TaskStatus.WaitingApproval.label else task.statusLabel), color = if (waiting) Theme.waiting else taskColor(task.status), style = mono(12, FontWeight.Medium), maxLines = 1)
    }
}

/** The status of a task where a small mark is enough (lists, links): the mark and word of [StatusLabel]. */
@Composable
fun StatusBadge(task: AgentTask, modifier: Modifier = Modifier) = StatusLabel(task, modifier)

/**
 * Ended and not opened yet (control-v0 §5): a small signal-coloured square at the trailing end, so it is never
 * mistaken for the status mark. No new status colour.
 */
@Composable
fun UnreadDot(modifier: Modifier = Modifier) {
    val classic = LocalLook.current.isClassic
    Box(modifier.size(if (classic) 8.dp else 6.dp).background(Theme.signal, if (classic) CircleShape else RectangleShape).semantics { contentDescription = "未读" })
}

/**
 * "N 分钟无更新" for a running task that has gone quiet (control-v0 §5); the status word stays as it is. Checked again
 * every half minute while shown, only for a task that can go quiet and while the app is in front (ui-v0 §7.4,
 * 2026-10-03). `separated` puts the " · " of a status line in front.
 */
@Composable
fun StaleNote(task: AgentTask, modifier: Modifier = Modifier, lastEventAt: Long? = null, waiting: Boolean = false, separated: Boolean = false) {
    val ticking = (task.status == TaskStatus.Running || task.status == TaskStatus.Routing) && !waiting
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val now by produceState(System.currentTimeMillis(), ticking, lifecycle) {
        if (!ticking) return@produceState
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            while (true) {
                value = System.currentTimeMillis()
                delay(30_000)
            }
        }
    }
    val minutes = Staleness.minutes(task, lastEventAt = lastEventAt, now = now, waiting = waiting) ?: return
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        if (separated) Text("·", color = Theme.inkDim, style = mono(12))
        Text(Staleness.text(minutes), color = Theme.secondaryInk, style = mono(12), maxLines = 1)
    }
}

/** Dismissable error line: nothing while `message` is null. */
@Composable
fun ErrorText(message: String?, onClose: () -> Unit, modifier: Modifier = Modifier) {
    if (message == null) return
    Row(modifier, verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        StatusSquare(Theme.failed, Modifier.padding(top = 5.dp))
        Text(message, Modifier.weight(1f), color = Theme.ink, style = plain(13))
        Text("×", Modifier.clickable(role = Role.Button, onClickLabel = "close", onClick = onClose).padding(horizontal = 6.dp), color = Theme.secondaryInk, style = mono(15))
    }
}

package com.agentswitch.android.dispatch

import android.text.format.Formatter
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.components.StaleNote
import com.agentswitch.android.components.StatusLabel
import com.agentswitch.android.components.UnreadDot
import com.agentswitch.android.components.inlineAnnotated
import com.agentswitch.android.design.HairRule
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.PixelBox
import com.agentswitch.android.design.card
import com.agentswitch.android.design.framed
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.android.terminals.LookGlyph
import com.agentswitch.android.terminals.LookSymbol
import com.agentswitch.android.terminals.relativeTime
import com.agentswitch.kit.api.AgentTask
import com.agentswitch.kit.api.Approval
import com.agentswitch.kit.api.TaskEvent
import com.agentswitch.kit.feed.LiveSummary
import com.agentswitch.kit.feed.Markdown
import com.agentswitch.kit.feed.Speech
import com.agentswitch.kit.feed.isInterrupted
import com.agentswitch.kit.files.TaskFile

const val feedResultLines = 5
const val feedScriptLines = 4
const val feedFilesShown = 4

/**
 * One task as a card (docs/ui-v0.md): its title (the thread's, else what was asked), a status line (mark, word, model,
 * time), then what it is doing or what came of it; a question or approval waiting for you sits in the same card, under
 * a line. Tapping the upper part opens the task. Under the reply that created it, what you said is already above:
 * `showsRequest` false leaves it out. `files`: what the executor handed back (FeedModel looks once per finished task);
 * a tap on one is `openFile` (the task files' opener is the task page's; without it the task opens). `openThread`
 * null on the topic page itself. Long press: open, topic, read aloud, delete.
 */
@Composable
fun FeedEntry(
    task: AgentTask,
    tail: List<TaskEvent>,
    pending: List<Approval>,
    open: () -> Unit,
    modifier: Modifier = Modifier,
    showsRequest: Boolean = true,
    files: List<TaskFile> = emptyList(),
    lastEventAt: Long? = null,
    delete: (DeleteRequest) -> Unit = {},
    openThread: ((String) -> Unit)? = null,
    openFile: ((TaskFile) -> Unit)? = null,
) {
    val model = LocalAppModel.current
    val dispatch = model.dispatch
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Theme.Space.m)) {
        if (showsRequest) UserBubble(task.task, attachments = task.attachments?.size ?: 0)
        Column(Modifier.fillMaxWidth().card().padding(14.dp), verticalArrangement = Arrangement.spacedBy(Theme.Space.m)) {
            Summary(task, tail, pending, lastEventAt, open) {
                val rows = ArrayList<PixelBox.Action>()
                rows += PixelBox.Action("Open") { open() }
                val threadId = task.threadId
                if (threadId != null && openThread != null) rows += PixelBox.Action("Topic") { openThread(threadId) }
                if (task.status.isTerminal) {
                    val speaking = dispatch.speaker.speakingKey == task.id
                    rows += PixelBox.Action(if (speaking) "Stop" else "Read Aloud") { dispatch.speaker.toggle(task) }
                }
                // Not while it runs: the Mac refuses.
                if (!task.status.isActive) rows += PixelBox.Action("Delete", PixelBox.Action.Role.Destructive) { delete(DeleteRequest.Task(task)) }
                rows
            }
            if (!task.status.isActive && files.isNotEmpty()) FileList(files, open, openFile)
            for (approval in pending) {
                HairRule()
                ApprovalCard(
                    approval,
                    onDecide = { decision -> dispatch.decide(approval, decision) },
                    onAnswer = { answers -> dispatch.answer(approval, answers) },
                )
            }
        }
    }
}

@Composable
private fun Summary(task: AgentTask, tail: List<TaskEvent>, pending: List<Approval>, lastEventAt: Long?, open: () -> Unit, menu: () -> List<PixelBox.Action>) {
    val dispatch = LocalAppModel.current.dispatch
    val wash = Theme.code
    Column(Modifier.fillMaxWidth().longPressMenu(onClick = open, actions = menu), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Theme.Space.s), verticalAlignment = Alignment.CenterVertically) {
            Text(codeSpanText(dispatch.title(task)), Modifier.weight(1f), color = Theme.ink, style = plain(15, FontWeight.SemiBold), maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(relativeTime(task.updatedAt), color = Theme.inkDim, style = mono(11), maxLines = 1)
            if (dispatch.isUnread(task)) UnreadDot()
        }
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            StatusLabel(task, waiting = pending.isNotEmpty())
            task.modelName?.let { name ->
                Text("·", color = Theme.inkDim, style = mono(12))
                Text(name, color = Theme.secondaryInk, style = mono(12), maxLines = 1)
            }
            StaleNote(task, lastEventAt = lastEventAt, waiting = pending.isNotEmpty(), separated = true)
        }
        if (task.status.isActive) {
            LiveSummary.currentStep(task, tail)?.let { Text(it, color = Theme.secondaryInk, style = plain(15), maxLines = 2, overflow = TextOverflow.Ellipsis) }
        } else {
            val script = task.speech?.let { Speech.speakable(it) }?.takeIf { it.isNotEmpty() }
            val result = task.result
            if (script != null) {
                Text(script, color = if (dispatch.speaker.speakingKey == task.id) Theme.signal else Theme.ink, style = plain(15), maxLines = feedScriptLines, overflow = TextOverflow.Ellipsis)
            } else if (!result.isNullOrEmpty()) {
                Text(inlineAnnotated(Markdown.flattened(result), {}, Color.Unspecified, wash), color = Theme.ink, style = plain(15), maxLines = feedResultLines, overflow = TextOverflow.Ellipsis)
            }
            // A restart of the Mac's service is not the task failing: said plainly, not in red.
            val error = task.error
            if (!error.isNullOrEmpty() && task.status != com.agentswitch.kit.api.TaskStatus.Done) {
                Text(
                    inlineAnnotated(Markdown.flattened(error), {}, Color.Unspecified, wash),
                    color = if (task.isInterrupted) Theme.secondaryInk else Theme.failed, style = plain(13), maxLines = 3, overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

/** The files handed back, each its own row (outside the card's open area, so a tap reaches it). */
@Composable
private fun FileList(files: List<TaskFile>, open: () -> Unit, openFile: ((TaskFile) -> Unit)?) {
    val context = LocalContext.current
    Column(Modifier.fillMaxWidth().framed(Theme.line, Theme.Radius.control).padding(horizontal = 10.dp)) {
        for (file in files.take(feedFilesShown)) {
            Row(
                Modifier.fillMaxWidth().clickable(role = Role.Button) { if (openFile != null) openFile(file) else open() }.padding(vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(file.name, Modifier.weight(1f), color = Theme.ink, style = plain(13), maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
                Text(Formatter.formatShortFileSize(context, file.size), color = Theme.inkDim, style = mono(11), maxLines = 1)
                LookGlyph("›", LookSymbol.ChevronRight, color = Theme.inkDim, size = 12)
            }
        }
        if (files.size > feedFilesShown) {
            Text("+${files.size - feedFilesShown} Files", Modifier.clickable(role = Role.Button, onClick = open).padding(vertical = 4.dp), color = Theme.secondaryInk, style = mono(11))
        }
    }
}

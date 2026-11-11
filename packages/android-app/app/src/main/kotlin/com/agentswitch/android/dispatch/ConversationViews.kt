package com.agentswitch.android.dispatch

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.components.LocalOpenLink
import com.agentswitch.android.components.MarkdownView
import com.agentswitch.android.components.StatusLabel
import com.agentswitch.android.components.StatusMark
import com.agentswitch.android.components.TypedText
import com.agentswitch.android.components.UnreadDot
import com.agentswitch.android.components.inlineAnnotated
import com.agentswitch.android.components.taskColor
import com.agentswitch.android.design.BrailleSpinner
import com.agentswitch.android.design.LocalLook
import com.agentswitch.android.design.PixelBox
import com.agentswitch.android.design.PixelBoxEffect
import com.agentswitch.android.design.SquareButton
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.framed
import com.agentswitch.android.design.grounded
import com.agentswitch.android.design.lookWord
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.android.terminals.LookGlyph
import com.agentswitch.android.terminals.LookSymbol
import com.agentswitch.kit.api.AgentTask
import com.agentswitch.kit.assistant.AssistantMessage
import com.agentswitch.kit.feed.ActivityFeed
import com.agentswitch.kit.feed.LinkAction
import com.agentswitch.kit.feed.Markdown
import com.agentswitch.kit.feed.MessageDisplay
import com.agentswitch.kit.feed.TappedLink
import com.agentswitch.kit.feed.codeSpans
import kotlinx.coroutines.launch

/** A title or a request with its backtick spans on the code wash (the Swift's `Markdown.codeSpans(_).codeWashed()`). */
@Composable
internal fun codeSpanText(text: String): AnnotatedString {
    val wash = Theme.code
    return remember(text, wash) { inlineAnnotated(Markdown.codeSpans(text), {}, Color.Unspecified, wash) }
}

/**
 * A press-and-hold menu for a view (the iPhone's `contextMenu`; here a `PixelBox` menu under the view). `onClick`
 * is what a plain tap does. The rows are asked for when the menu opens.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun Modifier.longPressMenu(head: String? = null, onClick: (() -> Unit)? = null, actions: () -> List<PixelBox.Action>): Modifier {
    var bounds by remember { mutableStateOf(Rect.Zero) }
    var anchor by remember { mutableStateOf<Rect?>(null) }
    PixelBoxEffect(anchor, { anchor = null }) { at -> PixelBox(head = head, cancel = null, actions = actions(), anchor = at) }
    return this.onGloballyPositioned { bounds = it.boundsInRoot() }.combinedClickable(
        interactionSource = remember { MutableInteractionSource() }, indication = null,
        onClick = { onClick?.invoke() }, onLongClick = { anchor = bounds },
    )
}

/**
 * What you said, on the right, in a raised square box (the signal colour is not for text backgrounds), as you typed it
 * with its code drawn as code (TypedText). Ciphertexts show as a lock mark; the Mac's legend is not shown. In the
 * classic look a round bubble (docs/ui-v0.md §8).
 */
@Composable
fun UserBubble(text: String, modifier: Modifier = Modifier, attachments: Int = 0, faded: Boolean = false) {
    val classic = LocalLook.current.isClassic
    Box(modifier.fillMaxWidth().padding(start = 56.dp), contentAlignment = Alignment.CenterEnd) {
        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(Theme.Space.xs)) {
            // Ink on a quiet ground in both looks: the classic look's bubble is the raised grey, round.
            TypedText(
                MessageDisplay.readable(text),
                Modifier.alpha(if (faded) 0.55f else 1f)
                    .grounded(Theme.raised, Theme.Radius.bubble).framed(if (classic) Color.Transparent else Theme.line, Theme.Radius.bubble)
                    .padding(horizontal = 14.dp, vertical = if (classic) 9.dp else 10.dp),
            )
            if (attachments > 0) Text("$attachments attached", color = Theme.secondaryInk, style = mono(11))
        }
    }
}

/**
 * AgentSwitch's side of the conversation: plain text on the left, no bubble (docs/ui-v0.md: not a chat robot). A notice
 * carries a small dot in the state of the task it is about; the tasks an answer created hang under it as cards, the
 * ones it only talks about as small links. Long press: read aloud, copy, its links (open in the Mac's browser, copy),
 * delete (the whole entry).
 */
@Composable
fun AssistantBubble(
    message: AssistantMessage,
    created: List<AgentTask>,
    entry: @Composable (AgentTask) -> Unit,
    open: (String) -> Unit,
    delete: (DeleteRequest) -> Unit,
    modifier: Modifier = Modifier,
) {
    val model = LocalAppModel.current
    val dispatch = model.dispatch
    val classic = LocalLook.current.isClassic
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    val openLink = LocalOpenLink.current
    val speakKey = "m${message.seq}"
    val speaking = dispatch.speaker.speakingKey == speakKey
    fun waiting(task: AgentTask) = ActivityFeed.pending(dispatch.approvals, task.id).isNotEmpty()
    fun toggleSpeech() { if (speaking) dispatch.speaker.stop() else dispatch.speaker.say(MessageDisplay.readable(message.text), speakKey) }

    fun menu(): List<PixelBox.Action> {
        val rows = ArrayList<PixelBox.Action>()
        rows += PixelBox.Action(if (speaking) "Stop" else "Read Aloud") { toggleSpeech() }
        rows += PixelBox.Action("Copy") { clipboard.setText(AnnotatedString(MessageDisplay.readable(message.text))) }
        val links = Markdown.links(message.text)
        for (link in links) {
            val name = if (links.size == 1) "" else " ${link.display}"
            for (action in link.actions) {
                if (action == LinkAction.ShowInFiles) continue
                if (links.size > 1 && action != LinkAction.OpenInBrowser) continue
                rows += PixelBox.Action(action.label(link) + name) { performLink(context, action, link, openLink) { clipboard.setText(AnnotatedString(link.text)) } }
            }
        }
        rows += PixelBox.Action("Delete", PixelBox.Action.Role.Destructive) { delete(DeleteRequest.Entry(dispatch.conversation.entry(message))) }
        return rows
    }

    val task = if (message.kind == AssistantMessage.Kind.Notice) message.taskIds.firstOrNull()?.let { id -> dispatch.tasks.firstOrNull { it.id == id } } else null
    val mentioned = if (message.createdTasks || message.unprompted) emptyList() else message.taskIds.mapNotNull { id -> dispatch.tasks.firstOrNull { it.id == id } }
    val isAnswer = message.kind == AssistantMessage.Kind.Reply || message.kind == AssistantMessage.Kind.Status

    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Theme.Space.m)) {
        if (task != null) {
            // A task's end, further down than its card: one line — its state, its title, the word — that opens it.
            Row(
                Modifier.fillMaxWidth().longPressMenu(onClick = { open(task.id) }) { menu() },
                horizontalArrangement = Arrangement.spacedBy(Theme.Space.s), verticalAlignment = Alignment.CenterVertically,
            ) {
                StatusMark(task.status)
                Text(codeSpanText(dispatch.title(task)), color = Theme.secondaryInk, style = plain(15), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                Text(lookWord(task.status.label), color = taskColor(task.status), style = mono(11), maxLines = 1)
                Spacer(Modifier.weight(1f))
                LookGlyph("›", LookSymbol.ChevronRight, color = Theme.inkDim, size = 12)
            }
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(Theme.Space.m)) {
                Row(Modifier.fillMaxWidth().longPressMenu { menu() }, horizontalArrangement = Arrangement.spacedBy(Theme.Space.s)) {
                    // A notice or progress line: the state of its task; nothing for plain answers.
                    if (message.unprompted) {
                        val t = message.taskIds.firstOrNull()?.let { id -> dispatch.tasks.firstOrNull { it.id == id } }
                        val dot = if (t == null) Theme.secondaryInk else if (waiting(t)) Theme.waiting else taskColor(t.status)
                        Box(Modifier.padding(top = 9.dp).size(6.dp).background(dot, if (classic) CircleShape else RectangleShape))
                    }
                    // Model output: Markdown, as on the Mac (its code as code).
                    MarkdownView(message.text, Modifier.weight(1f).alpha(if (message.unprompted) 0.7f else 1f))
                }
                if (isAnswer) {
                    Row(
                        Modifier.clickable(role = Role.Button) { toggleSpeech() }.padding(vertical = 2.dp),
                        horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically,
                    ) {
                        val tint = if (speaking) Theme.signal else Theme.secondaryInk
                        if (speaking) Box(Modifier.size(9.dp).background(tint, RectangleShape)) else SpeakerGlyph(tint)
                        Text(if (speaking) "Stop" else "Read Aloud", color = tint, style = mono(12))
                    }
                }
            }
        }
        for (t in created) entry(t)
        for (t in mentioned) TaskLink(t, waiting = waiting(t)) { open(t.id) }
    }
}

private fun performLink(context: android.content.Context, action: LinkAction, link: TappedLink, openLink: (String) -> Unit, copy: () -> Unit) {
    when (action) {
        LinkAction.OpenInBrowser -> openLink(link.text)
        LinkAction.Copy -> copy()
        LinkAction.OpenInSafari -> link.safari?.let {
            try { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(it)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (_: Exception) {}
        }
        LinkAction.ShowInFiles -> {}
    }
}

/** `speaker.wave.2`, drawn: the cone and two waves. */
@Composable
private fun SpeakerGlyph(color: Color) {
    Canvas(Modifier.size(14.dp).clearAndSetSemantics { }) {
        val s = size.width
        val body = Path().apply {
            moveTo(s * 0.08f, s * 0.38f); lineTo(s * 0.26f, s * 0.38f); lineTo(s * 0.5f, s * 0.18f)
            lineTo(s * 0.5f, s * 0.82f); lineTo(s * 0.26f, s * 0.62f); lineTo(s * 0.08f, s * 0.62f); close()
        }
        drawPath(body, color)
        val stroke = Stroke(s * 0.09f, cap = StrokeCap.Round)
        drawArc(color, -45f, 90f, false, Offset(s * 0.38f, s * 0.28f), Size(s * 0.3f, s * 0.44f), style = stroke)
        drawArc(color, -45f, 90f, false, Offset(s * 0.34f, s * 0.12f), Size(s * 0.6f, s * 0.76f), style = stroke)
    }
}

/** A task an answer talks about: its state and its words, one line. */
@Composable
fun TaskLink(task: AgentTask, modifier: Modifier = Modifier, waiting: Boolean = false, open: () -> Unit) {
    val dispatch = LocalAppModel.current.dispatch
    val classic = LocalLook.current.isClassic
    Row(
        modifier.fillMaxWidth()
            .grounded(if (classic) Theme.panel else Color.Transparent, Theme.Radius.card).framed(if (classic) Color.Transparent else Theme.line, Theme.Radius.card)
            .clickable(role = Role.Button, onClick = open).padding(horizontal = Theme.Space.m, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(Theme.Space.s), verticalAlignment = Alignment.CenterVertically,
    ) {
        StatusLabel(task, waiting = waiting)
        Text(codeSpanText(dispatch.title(task)), Modifier.weight(1f), color = Theme.ink, style = plain(15), maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (dispatch.isUnread(task)) UnreadDot()
        LookGlyph("›", LookSymbol.ChevronRight, color = Theme.inkDim)
    }
}

/**
 * The message on its way: faded while it is being sent; on failure, why, with a resend (the same message to the Mac)
 * or back into the box to change it.
 */
@Composable
fun OutgoingBubble(message: OutgoingMessage, modifier: Modifier = Modifier) {
    val model = LocalAppModel.current
    val dispatch = model.dispatch
    Column(modifier.fillMaxWidth(), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(Theme.Space.s)) {
        UserBubble(message.text, attachments = message.attachments.size, faded = message.failure == null)
        val failure = message.failure
        if (failure != null) {
            Text(failure, color = Theme.failed, style = plain(13), textAlign = androidx.compose.ui.text.style.TextAlign.End)
            Row(horizontalArrangement = Arrangement.spacedBy(Theme.Space.m)) {
                SquareButton("Edit", { dispatch.editOutgoing() }, expand = false, enabled = !dispatch.sending)
                SquareButton("Resend", { model.scope.launch { dispatch.resend() } }, prominent = true, expand = false, enabled = !dispatch.sending)
            }
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                BrailleSpinner(color = Theme.secondaryInk)
                Text(if (message.staged == null && message.attachments.isNotEmpty()) "Uploading" else "Sending", color = Theme.secondaryInk, style = mono(11))
            }
        }
    }
}

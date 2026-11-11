package com.agentswitch.android.dispatch

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.LocalNav
import com.agentswitch.android.components.ErrorText
import com.agentswitch.android.components.StatusMark
import com.agentswitch.android.components.UnreadDot
import com.agentswitch.android.components.inlineAnnotated
import com.agentswitch.android.design.BarBack
import com.agentswitch.android.design.BarWord
import com.agentswitch.android.design.BrailleSpinner
import com.agentswitch.android.design.HairRule
import com.agentswitch.android.design.PixelBox
import com.agentswitch.android.design.PixelBoxEffect
import com.agentswitch.android.design.NavBar
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.framed
import com.agentswitch.android.design.grounded
import com.agentswitch.android.design.LocalLook
import com.agentswitch.android.design.lookPhrase
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.android.rememberBack
import com.agentswitch.android.terminals.relativeTime
import com.agentswitch.kit.api.AgentThread
import com.agentswitch.kit.api.TaskStatus
import com.agentswitch.kit.api.ThreadDetail
import com.agentswitch.kit.feed.ActivityFeed
import com.agentswitch.kit.feed.Attention
import com.agentswitch.kit.feed.Markdown
import com.agentswitch.kit.feed.MessageDisplay
import com.agentswitch.kit.feed.ModelName
import com.agentswitch.kit.feed.Staleness
import com.agentswitch.kit.feed.isUnread
import com.agentswitch.kit.feed.waitsForYou
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

val AgentThread.displayTitle: String get() = title ?: "未命名话题"

/** Ended tasks stay in the strip while unread, for this long and at most this many. */
private const val unreadWindowMs = 12L * 3600 * 1000
private const val maxUnread = 3

private class StripItem(val threadId: String, val task: com.agentswitch.kit.api.AgentTask, val title: String, val waiting: Boolean, val unread: Boolean)

/**
 * The strip above the conversation (assistant-v0 §2, control-v0 §5): one chip per thread that needs a look, in the order
 * of who needs you — waiting for you, then ended and not opened yet (the newest few), then in progress. Each chip is the
 * thread's title and its state; the waiting colour when something needs you, the unread dot when it ended unseen. On a
 * solid ground with a hairline under it. An unread chip opens the task itself (which reads it); the others open the thread.
 */
@Composable
fun ActiveThreadsStrip(lastEventAt: Map<String, Long>, openThread: (String) -> Unit, openTask: (String) -> Unit, modifier: Modifier = Modifier) {
    val dispatch = LocalAppModel.current.dispatch
    val pending = dispatch.pendingTaskIds
    val now = System.currentTimeMillis()
    val tasks = dispatch.tasks
    val unread = tasks.filter { dispatch.isUnread(it) && it.threadId != null && it.updatedAt > now - unreadWindowMs }
        .sortedByDescending { it.updatedAt }.take(maxUnread)
    val candidates = tasks.filter { (it.status.isActive || it.waitsForYou) && it.threadId != null } + unread.filter { !it.waitsForYou }
    val seen = HashSet<String>()
    // The most pressing task of each thread stands for it.
    val items = Attention.sorted(candidates, pending, dispatch.readMarksSupported).mapNotNull { task ->
        val id = task.threadId ?: return@mapNotNull null
        if (!seen.add(id)) return@mapNotNull null
        val waiting = Attention.rank(task, pending) == Attention.Rank.NeedsYou
        val title = dispatch.thread(id)?.displayTitle ?: MessageDisplay.readable(task.task).take(18)
        StripItem(id, task, title, waiting, !waiting && dispatch.isUnread(task))
    }
    if (items.isEmpty()) return
    Column(modifier.fillMaxWidth().background(Theme.base)) {
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = Theme.Space.l, vertical = Theme.Space.s),
            horizontalArrangement = Arrangement.spacedBy(Theme.Space.s),
        ) {
            for (item in items) androidx.compose.runtime.key(item.threadId) {
                Chip(item, lastEventAt) { if (item.unread) openTask(item.task.id) else openThread(item.threadId) }
            }
        }
        HairRule()
    }
}

@Composable
private fun Chip(item: StripItem, lastEventAt: Map<String, Long>, onClick: () -> Unit) {
    val classic = LocalLook.current.isClassic
    val state = if (item.waiting) TaskStatus.WaitingApproval.label else {
        val stale = Staleness.minutes(item.task, lastEventAt[item.task.id])?.let { Staleness.text(it) }
        listOfNotNull(item.task.statusLabel, stale ?: item.task.modelName).joinToString(" · ")
    }
    Row(
        Modifier.widthIn(max = 210.dp)
            .grounded(if (classic) Theme.panel else Color.Transparent, 10.dp).framed(if (classic) Color.Transparent else Theme.line, 10.dp)
            .clickable(role = Role.Button, onClick = onClick).padding(horizontal = Theme.Space.m, vertical = 7.dp),
        horizontalArrangement = Arrangement.spacedBy(Theme.Space.s), verticalAlignment = Alignment.CenterVertically,
    ) {
        StatusMark(if (item.waiting) TaskStatus.WaitingApproval else item.task.status)
        Column(Modifier.weight(1f, fill = false), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text(item.title, color = Theme.ink, style = plain(13, FontWeight.SemiBold), maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(lookPhrase(state), color = if (item.waiting) Theme.waiting else Theme.secondaryInk, style = mono(11), maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (item.unread) UnreadDot()
    }
}

/**
 * The thread page: its goal and progress from the summarizer, then its tasks in order (the log's entries), live while
 * shown; delete the whole thread from the menu.
 */
@Composable
fun ThreadView(threadId: String) {
    val model = LocalAppModel.current
    val dispatch = model.dispatch
    val nav = LocalNav.current
    val back = rememberBack()
    var detail by remember { mutableStateOf<ThreadDetail?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var deleting by remember { mutableStateOf<DeleteRequest?>(null) }
    var menu by remember { mutableStateOf<Rect?>(null) }
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    var bounds by remember { mutableStateOf(Rect.Zero) }

    suspend fun load() {
        val api = model.api ?: return
        try {
            detail = api.thread(threadId)
            error = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            model.handle(e)
            error = e.message ?: e.javaClass.simpleName
        }
    }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { while (true) { load(); delay(HomePollMs) } }
    }
    PixelBoxEffect(menu, { menu = null }) { at ->
        PixelBox(cancel = null, anchor = at, actions = listOf(PixelBox.Action("Delete Topic", PixelBox.Action.Role.Destructive) {
            deleting = DeleteRequest.Topic(threadId, detail?.thread?.title)
        }))
    }
    DeleteConfirmation(deleting, { deleting = null }, { error = it }) { deleted ->
        if (deleted is DeleteRequest.Topic) back() else scope.launch { load() }
    }

    Column(Modifier.fillMaxSize().background(Theme.base)) {
        NavBar(
            detail?.thread?.displayTitle ?: "话题",
            leading = { BarBack(back) },
            trailing = {
                Box(Modifier.onGloballyPositioned { bounds = it.boundsInRoot() }) { BarWord("⋯", { menu = bounds }) }
            },
        )
        val shown = detail?.tasks?.sortedBy { it.createdAt } ?: emptyList()
        LazyColumn(
            Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(Theme.Space.item),
        ) {
            detail?.let { d -> item { Header(d) } }
            if (error != null) item { ErrorText(error, { error = null }) }
            items(shown, key = { it.id }) { task ->
                FeedEntry(
                    task, tail = emptyList(), pending = ActivityFeed.pending(dispatch.approvals, task.id),
                    open = { nav.push("task/${task.id}") { TaskDetailView(task.id) } }, delete = { deleting = it },
                )
            }
            if (detail == null && error == null) item { Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { BrailleSpinner(color = Theme.secondaryInk) } }
        }
    }
}

@Composable
private fun Header(detail: ThreadDetail) {
    val thread = detail.thread
    val wash = Theme.code
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Theme.Space.s)) {
        Text(thread.displayTitle, color = Theme.ink, style = plain(20, FontWeight.SemiBold))
        val meta = listOfNotNull(
            "${thread.taskCount ?: 0} 个任务", thread.lastTarget?.let { ModelName.display(it.model) },
            if (thread.status == "archived") "已归档" else null, relativeTime(thread.lastActivity ?: thread.updatedAt),
        ).joinToString(" · ")
        Text(meta, color = Theme.secondaryInk, style = plain(13))
        detail.summary?.goal?.takeIf { it.isNotEmpty() }?.let { LabeledLine("目标", it) }
        detail.summary?.progress?.takeIf { it.isNotEmpty() }?.let { LabeledLine("进展", it) }
    }
}

/** `目标  …`: a small grey label and its text (the topic's summary, model output: Markdown, its code on the wash). */
@Composable
fun LabeledLine(label: String, text: String, modifier: Modifier = Modifier) {
    val wash = Theme.code
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(Theme.Space.s)) {
        Text(label, Modifier.width(30.dp), color = Theme.secondaryInk, style = plain(13, FontWeight.Medium))
        Text(remember(text, wash) { inlineAnnotated(Markdown.inline(text), {}, Color.Unspecified, wash) }, Modifier.weight(1f), color = Theme.ink, style = plain(15))
    }
}

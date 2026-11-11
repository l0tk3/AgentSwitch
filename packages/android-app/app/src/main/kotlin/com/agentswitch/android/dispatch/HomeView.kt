package com.agentswitch.android.dispatch

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.pulltorefresh.PullToRefreshDefaults
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.findRootCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.LocalNav
import com.agentswitch.android.MainTab
import com.agentswitch.android.components.ErrorText
import com.agentswitch.android.design.BarWord
import com.agentswitch.android.design.LocalLook
import com.agentswitch.android.design.NavBar
import com.agentswitch.android.design.PixelBox
import com.agentswitch.android.design.PixelMarkView
import com.agentswitch.android.design.PixelSprite
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.android.onboarding.MacSwitcher
import com.agentswitch.android.terminals.ConnectionBanner
import com.agentswitch.android.terminals.LookGlyph
import com.agentswitch.android.terminals.LookSymbol
import com.agentswitch.android.terminals.LookSymbolIcon
import com.agentswitch.kit.api.AgentTask
import com.agentswitch.kit.api.TaskStatus
import com.agentswitch.kit.assistant.Conversation
import com.agentswitch.kit.assistant.AssistantMessage
import com.agentswitch.kit.api.ApprovalStatus
import com.agentswitch.kit.design.PixelArt
import com.agentswitch.kit.feed.ActivityFeed
import com.agentswitch.kit.feed.MessageDisplay
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.max
import kotlin.math.roundToInt

/** How often the log is read again while it is on screen (no push in v0; the live streams cover the active tasks in between). */
const val HomePollMs = 6000L

/**
 * The one screen (app-v0 §5, assistant-v0 §1.1): the conversation with the assistant, oldest first — your messages, its
 * answers, each task under the answer that created it, tasks made elsewhere on their own — and the input box. Threads
 * are never chosen here; the router files every task. A tab's root.
 *
 * What differs from the iPhone: the keyboard lifts the input bar by what covers it above the tab bar (the tab bar
 * is under the keyboard), the long-press menus are `PixelBox` menus, and a task's files open the task (the
 * files' opener is the task page's).
 */
@Composable
fun HomeView() {
    val model = LocalAppModel.current
    val dispatch = model.dispatch
    val nav = LocalNav.current
    val scope = rememberCoroutineScope()
    val feed = remember { FeedModel() }
    var deleting by remember { mutableStateOf<DeleteRequest?>(null) }
    val focusManager = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val clipboard = LocalClipboardManager.current
    fun hideKeyboard() { focusManager.clearFocus(); keyboard?.hide() }

    fun open(id: String) { hideKeyboard(); nav.push("task/$id") { TaskDetailView(id) } }
    fun openThread(id: String) { hideKeyboard(); nav.push("thread/$id") { ThreadView(id) } }

    // Polling and the live streams run only while the log is on screen and the app in front.
    val visible = model.tab == MainTab.Tasks && nav.isEmpty
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(visible, lifecycle) {
        if (!visible) { feed.visible = false; feed.stopAll(); return@LaunchedEffect }
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            feed.visible = true
            try {
                while (true) {
                    dispatch.refreshAll()
                    feed.sync(model)
                    delay(HomePollMs)
                }
            } finally {
                feed.visible = false
                feed.stopAll()
            }
        }
    }
    LaunchedEffect(dispatch.tasks) { feed.sync(model) }
    LaunchedEffect(feed.tails) { dispatch.liveTails = feed.tails }
    // A notification's link: the request may be there before this screen is.
    LaunchedEffect(dispatch.openTaskRequest) {
        val id = dispatch.openTaskRequest ?: return@LaunchedEffect
        dispatch.openTaskRequest = null
        if (!nav.isEmpty) nav.popToRoot()
        open(id)
    }
    DeleteConfirmation(deleting, { deleting = null }, { model.banner = it })

    // The conversation: what the Mac said, minus a "waits for you" line while its question is open in the task's card
    // (it would say the same thing twice); it shows as history once answered.
    val openTasks = dispatch.approvals.filter { it.status == ApprovalStatus.Pending }.map { it.taskId }.toSet()
    val timeline = remember(dispatch.conversation, dispatch.tasks, openTasks) {
        val messages = dispatch.conversation.messages.filter { m -> !(m.kind == AssistantMessage.Kind.Waiting && m.taskIds.any { it in openTasks }) }
        Conversation.timeline(messages, ActivityFeed.timeline(dispatch.tasks))
    }
    val shown = timeline.flatMap { item ->
        when (item) {
            is Conversation.Item.User -> emptyList()
            is Conversation.Item.Assistant -> item.created.map { it.id }
            is Conversation.Item.Task -> listOf(item.task.id)
        }
    }.toSet()
    val looseCount = ActivityFeed.looseApprovals(dispatch.approvals, shown).size

    // The keyboard covers the tab bar too: lift by what covers the page itself.
    val density = LocalDensity.current
    val imeBottom = WindowInsets.ime.getBottom(density)
    var below by remember { mutableIntStateOf(0) }
    val lift = max(0, imeBottom - below)

    Column(
        Modifier.fillMaxSize().background(Theme.base)
            .onGloballyPositioned { c ->
                val root = c.findRootCoordinates()
                below = max(0, (root.size.height - (c.positionInRoot().y + c.size.height)).roundToInt())
            }
            .padding(bottom = with(density) { lift.toDp() }),
    ) {
        HomeBar()
        ActiveThreadsStrip(feed.lastEventAt, openThread = { openThread(it) }, openTask = { open(it) })
        // Above the conversation, not in it: the conversation opens at its end, where a line at its top is out of sight
        // exactly when the Mac cannot be reached.
        if (model.connection.endpoint == null) {
            Box(Modifier.fillMaxWidth().background(Theme.base).padding(horizontal = Theme.Space.l, vertical = Theme.Space.s)) { ConnectionBanner() }
        }
        if (looseCount > 0) LooseApprovalsButton(looseCount) { hideKeyboard(); nav.present("approvals") { ApprovalsView() } }

        val listState = rememberLazyListState()
        val pullState = rememberPullToRefreshState()
        var refreshing by remember { mutableStateOf(false) }
        val lastId = timeline.lastOrNull()?.id
        var first by remember { mutableStateOf(true) }
        // A new message, answer or task: follow it down; the first time, open at its end.
        LaunchedEffect(lastId, dispatch.outgoing?.id) {
            val n = listState.layoutInfo.totalItemsCount
            if (first) { first = false; listState.scrollToItem(Int.MAX_VALUE / 2) }
            else if (n > 0) listState.animateScrollToItem(n - 1)
        }
        LaunchedEffect(lift > 0) { if (lift > 0) listState.scrollToItem(Int.MAX_VALUE / 2) }
        LaunchedEffect(listState.isScrollInProgress) { if (listState.isScrollInProgress) keyboard?.hide() }

        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = { scope.launch { refreshing = true; try { dispatch.refreshAll() } finally { refreshing = false } } },
            modifier = Modifier.weight(1f).fillMaxWidth(),
            state = pullState,
            indicator = { PullToRefreshDefaults.Indicator(pullState, refreshing, Modifier.align(Alignment.TopCenter), containerColor = Theme.raised, color = Theme.signal) },
        ) {
            LazyColumn(
                Modifier.fillMaxSize().pointerInput(Unit) { detectTapGestures { hideKeyboard() } },
                state = listState,
                contentPadding = PaddingValues(horizontal = Theme.Space.l, vertical = Theme.Space.m),
                verticalArrangement = Arrangement.spacedBy(Theme.Space.item),
            ) {
                model.banner?.let { banner -> item(key = "banner") { ErrorText(banner, { model.banner = null }) } }
                if (timeline.isEmpty() && dispatch.outgoing == null) {
                    item(key = "empty") {
                        // Nothing yet: one line (ui-v0 §7.4; the input box says the rest).
                        Text("发送任务或问题", Modifier.fillMaxWidth().padding(top = 60.dp), color = Theme.secondaryInk, style = plain(15))
                    }
                }
                items(timeline, key = { it.id }) { item ->
                    @Composable
                    fun entry(task: AgentTask, showsRequest: Boolean) = FeedEntry(
                        task, tail = feed.tails[task.id] ?: emptyList(), pending = ActivityFeed.pending(dispatch.approvals, task.id),
                        open = { open(task.id) }, showsRequest = showsRequest, files = feed.files[task.id] ?: emptyList(),
                        lastEventAt = feed.lastEventAt[task.id], delete = { deleting = it }, openThread = { openThread(it) },
                    )
                    when (item) {
                        is Conversation.Item.User -> {
                            // Long press: delete what you said with its answers (and the tasks they created).
                            val message = item.message
                            UserBubble(message.text, Modifier.longPressMenu {
                                listOf(
                                    PixelBox.Action("Copy") { clipboard.setText(AnnotatedString(MessageDisplay.readable(message.text))) },
                                    PixelBox.Action("Delete", PixelBox.Action.Role.Destructive) { deleting = DeleteRequest.Entry(dispatch.conversation.entry(message)) },
                                )
                            })
                        }
                        is Conversation.Item.Assistant -> AssistantBubble(item.message, item.created, entry = { entry(it, false) }, open = { open(it) }, delete = { deleting = it })
                        is Conversation.Item.Task -> entry(item.task, true)
                    }
                }
                dispatch.outgoing?.let { outgoing -> item(key = "outgoing") { OutgoingBubble(outgoing) } }
            }
        }
        InputBar()
    }
}

/** The bar: the app's mark in the state of the Mac and the tasks beside the title (the Mac's name, or its switcher), `Files` at the right. */
@Composable
private fun HomeBar() {
    val model = LocalAppModel.current
    val nav = LocalNav.current
    val classic = LocalLook.current.isClassic
    val name = model.profile?.name ?: "AgentSwitch"
    NavBar(
        name,
        mark = { HomeMark() },
        titleContent = if (model.macs.servers.size > 1) ({ MacSwitcher() }) else null,
        trailing = {
            // Every task's files together, and their removal (2026-11-11).
            if (classic) {
                Box(
                    Modifier.clickable(role = Role.Button, onClickLabel = "Files") { nav.push("keptfiles") { KeptFilesView() } }.padding(10.dp),
                ) { LookSymbolIcon(LookSymbol.Folder, side = 22.dp, color = Theme.signal) }
            } else {
                BarWord("Files", { nav.push("keptfiles") { KeptFilesView() } }, color = Theme.secondaryInk)
            }
        },
    )
}

/**
 * The mark: off (dithered) while the Mac is out of reach, waiting while something waits for you, busy while a task
 * runs, else idle.
 */
@Composable
private fun HomeMark() {
    val model = LocalAppModel.current
    val dispatch = model.dispatch
    val waiting = dispatch.approvals.count { it.status == ApprovalStatus.Pending }
    val state = PixelArt.markState(
        reachable = model.connection.endpoint != null, waiting = waiting,
        busy = dispatch.tasks.any { it.status == TaskStatus.Routing || it.status == TaskStatus.Running },
    )
    val word = when (state) {
        PixelArt.MarkState.Idle -> "idle"
        PixelArt.MarkState.Busy -> "busy"
        PixelArt.MarkState.Waiting -> "waiting"
        PixelArt.MarkState.Error -> "failed"
        PixelArt.MarkState.Off -> "Mac not reachable"
    }
    Box(Modifier.semantics { contentDescription = "AgentSwitch: $word" }) { PixelMarkView(state, pixel = androidx.compose.ui.unit.Dp(2f)) }
}

/** Pending approvals of tasks that are no longer in the log, behind one button at the top. */
@Composable
private fun LooseApprovalsButton(count: Int, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().background(Theme.base).clickable(role = Role.Button, onClick = onClick).padding(vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically,
    ) {
        PixelSprite(PixelArt.square, pixel = androidx.compose.ui.unit.Dp(2f), color = Theme.waiting)
        Text("$count More Waiting", color = Theme.waiting, style = mono(12, FontWeight.Medium))
        LookGlyph("›", LookSymbol.ChevronRight, color = Theme.waiting, size = 12)
    }
}

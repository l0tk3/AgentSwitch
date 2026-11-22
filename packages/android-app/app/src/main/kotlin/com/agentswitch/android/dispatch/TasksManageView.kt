package com.agentswitch.android.dispatch

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.LocalNav
import com.agentswitch.android.components.ErrorText
import com.agentswitch.android.components.StaleNote
import com.agentswitch.android.components.StatusLabel
import com.agentswitch.android.components.UnreadDot
import com.agentswitch.android.demo.DemoData
import com.agentswitch.android.demo.LocalDemoScreen
import com.agentswitch.android.design.BarBack
import com.agentswitch.android.design.FormRow
import com.agentswitch.android.design.FormSection
import com.agentswitch.android.design.NavBar
import com.agentswitch.android.design.PixelBox
import com.agentswitch.android.design.PixelBoxEffect
import com.agentswitch.android.design.PlainField
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.android.terminals.LookGlyph
import com.agentswitch.android.terminals.LookSymbol
import com.agentswitch.android.terminals.LookSymbolIcon
import com.agentswitch.android.terminals.relativeTime
import com.agentswitch.kit.api.AgentTask
import com.agentswitch.kit.feed.Attention
import com.agentswitch.kit.feed.MessageDisplay

private class RowMenu(val task: AgentTask, val anchor: Rect)

/**
 * Settings › History: every recent task, the ones that need you first (control-v0 §5: 等你处理 → 已完成未读 → 进行中 →
 * the rest, each newest first); a `Delete` word on each row (or a long press, which opens a menu with `Delete` where
 * the iPhone swipes) deletes a finished one, active tasks are cancelled from their page first. The search field looks
 * through the Mac's task history (`GET /search`), not only this list. A page: push it with `LocalNav`.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun TasksManageView() {
    val model = LocalAppModel.current
    val nav = LocalNav.current
    val dispatch = model.dispatch
    var error by remember { mutableStateOf<String?>(null) }
    var deleting by remember { mutableStateOf<DeleteRequest?>(null) }
    var menu by remember { mutableStateOf<RowMenu?>(null) }
    val demoQuery = if (LocalDemoScreen.current == "search") DemoData.searchQuery else ""
    var query by remember { mutableStateOf(demoQuery) }
    val search = remember { TaskSearch() }

    LaunchedEffect(query) { search.run(query, model) }
    LaunchedEffect(Unit) { if (model.api != null) dispatch.refreshTasks() }
    DeleteConfirmation(deleting, onDismiss = { deleting = null }, onError = { error = it })
    PixelBoxEffect(menu, { menu = null }) { m ->
        PixelBox(cancel = null, anchor = m.anchor, actions = listOf(PixelBox.Action("Delete", PixelBox.Action.Role.Destructive) { deleting = DeleteRequest.Task(m.task) }))
    }

    Column(Modifier.fillMaxSize().background(Theme.base)) {
        NavBar("History", leading = { BarBack({ nav.pop() }, "Settings") })
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom))
                .padding(horizontal = 16.dp, vertical = 8.dp),
        ) {
            SearchField(query, { query = it })
            ErrorText(error, { error = null }, Modifier.padding(top = 12.dp))
            if (search.isActive(query)) {
                TaskSearchResults(search)
            } else if (dispatch.tasks.isEmpty()) {
                Box(Modifier.fillMaxWidth().padding(top = 48.dp), contentAlignment = Alignment.Center) { Text("无任务", color = Theme.secondaryInk, style = plain(17)) }
            } else {
                FormSection {
                    val sorted = Attention.sorted(dispatch.tasks, dispatch.pendingTaskIds, dispatch.readMarksSupported)
                    sorted.forEachIndexed { i, task ->
                        var bounds by remember { mutableStateOf(Rect.Zero) }
                        FormRow(
                            Modifier.onGloballyPositioned { bounds = it.boundsInRoot() }
                                .combinedClickable(onLongClick = { if (!task.status.isActive) menu = RowMenu(task, bounds) }, onClick = { nav.push("task:${task.id}") { TaskDetailView(task.id) } }),
                            first = i == 0,
                        ) {
                            TaskRow(task, Modifier.weight(1f))
                            LookGlyph("›", LookSymbol.ChevronRight, color = Theme.inkDim, size = 13)
                            Text(
                                "Delete",
                                Modifier.clickable(enabled = !task.status.isActive, role = Role.Button, onClickLabel = "删除") { deleting = DeleteRequest.Task(task) }.padding(vertical = 8.dp),
                                color = if (task.status.isActive) Theme.secondaryInk else Theme.failed, style = mono(12),
                            )
                        }
                    }
                }
            }
        }
    }
}

/** The search field under the bar (the iPhone's `searchable`): a magnifier, the words, a clear mark. */
@Composable
private fun SearchField(query: String, onChange: (String) -> Unit) {
    Row(
        Modifier.fillMaxWidth().background(Theme.raised, com.agentswitch.android.design.lookShape(10.dp)).padding(horizontal = 10.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        LookSymbolIcon(LookSymbol.Magnifier, side = 16.dp, color = Theme.secondaryInk)
        PlainField(query, onChange, Modifier.weight(1f), placeholder = "搜索任务和结果", style = plain(16))
        if (query.isNotEmpty()) Text("×", Modifier.clickable(role = Role.Button, onClickLabel = "clear") { onChange("") }.padding(horizontal = 6.dp), color = Theme.secondaryInk, style = mono(15))
    }
}

/** One task as a row of a list: its status, model and when over what was asked, and its summary or error under it. */
@Composable
fun TaskRow(task: AgentTask, modifier: Modifier = Modifier) {
    val dispatch = LocalAppModel.current.dispatch
    val waiting = task.id in dispatch.pendingTaskIds
    Column(modifier.padding(vertical = 2.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            StatusLabel(task, waiting = waiting)
            val name = task.modelName
            if (name != null) Text(name, Modifier.weight(1f), color = Theme.secondaryInk, style = plain(12), maxLines = 1, overflow = TextOverflow.Ellipsis)
            else Box(Modifier.weight(1f))
            Text(relativeTime(task.updated), color = Theme.secondaryInk, style = plain(12))
            if (dispatch.isUnread(task)) UnreadDot()
        }
        Text(MessageDisplay.readable(task.task), color = Theme.ink, style = plain(15), maxLines = 2, overflow = TextOverflow.Ellipsis)
        StaleNote(task, waiting = waiting)
        val line = task.spoken ?: task.error
        if (line != null) Text(line, color = Theme.secondaryInk, style = plain(13), maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

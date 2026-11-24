package com.agentswitch.android.rooms

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.LocalNav
import com.agentswitch.android.design.BarBack
import com.agentswitch.android.design.BarWord
import com.agentswitch.android.design.BrailleSpinner
import com.agentswitch.android.design.HairRule
import com.agentswitch.android.design.LocalLook
import com.agentswitch.android.design.NavBar
import com.agentswitch.android.design.PlainField
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.android.terminals.LookSymbol
import com.agentswitch.android.terminals.LookSymbolIcon
import com.agentswitch.android.terminals.relativeTime
import com.agentswitch.kit.api.RoomAttentionItem
import com.agentswitch.kit.api.RoomMessage
import com.agentswitch.kit.api.RoomSearch
import com.agentswitch.kit.api.RoomTask
import com.agentswitch.kit.api.roomMessages
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// The second design's two finding pages (2026-11-24): a room's search (⌕), and 等你处理 — everything in every room that
// waits on the user's hand.

/**
 * A room's search (the design's ⌕): the words asked for, the hits the newest first — who, when, the task, a stretch
 * around the hit with the hit lit. Inside a task only that task's messages are searched. A tap goes to the message in
 * the timeline, with those before and after it.
 */
@Composable
fun RoomSearchSheet(model: RoomPageModel, pick: (Int) -> Unit) {
    val app = LocalAppModel.current
    val nav = LocalNav.current
    val classic = LocalLook.current.isClassic
    val focus = remember { FocusRequester() }
    var query by remember { mutableStateOf("") }
    var hits by remember { mutableStateOf<List<RoomMessage>?>(null) }
    var searching by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val task = model.taskFilter
    val detail = model.detail

    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    // Asked a moment after the typing stops.
    LaunchedEffect(query, task) {
        val q = query.trim()
        if (q.isEmpty()) { hits = null; error = null; return@LaunchedEffect }
        delay(300)
        val api = app.api ?: run {
            // A sample screen (no Mac): what the page has.
            hits = model.shown.filter { it.text.contains(q, ignoreCase = true) }.reversed()
            return@LaunchedEffect
        }
        searching = true
        try {
            hits = api.roomMessages(model.id, task = task, q = q, limit = 100).messages
            error = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.message ?: e.javaClass.simpleName
        } finally {
            searching = false
        }
    }

    Column(Modifier.fillMaxSize().background(Theme.base)) {
        Column(Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.statusBars)) {
            Row(Modifier.fillMaxWidth().height(52.dp).padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                if (classic) LookSymbolIcon(LookSymbol.Magnifier, side = 16.dp, color = Theme.inkDim)
                else Text("/", color = Theme.signal, style = mono(15, FontWeight.Bold))
                PlainField(
                    query, { query = it }, Modifier.weight(1f).focusRequester(focus),
                    placeholder = task?.let { "搜索 " + RoomTask.word(it, detail?.task(it)?.title) } ?: "搜索 ${detail?.room?.name ?: "房间"}",
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, imeAction = ImeAction.Search),
                )
                if (searching) BrailleSpinner(color = Theme.secondaryInk)
                BarWord("Cancel", { nav.pop() }, color = agentInk)
            }
            HairRule()
        }
        error?.let { Text(it, Modifier.padding(horizontal = Theme.Space.l, vertical = 8.dp), color = Theme.failed, style = plain(13)) }
        val found = hits
        when {
            found == null -> Text(
                if (task != null) "只搜这个任务里的消息。回到 # 全部 搜整个房间。" else "搜整个房间的消息。",
                Modifier.padding(Theme.Space.l), color = Theme.secondaryInk, style = plain(13),
            )
            found.isEmpty() && !searching -> Text("没有找到。", Modifier.padding(Theme.Space.l), color = Theme.secondaryInk, style = plain(13))
            else -> LazyColumn(Modifier.fillMaxSize()) {
                items(found, key = { it.seq }) { m ->
                    SearchHit(m, query, detail?.seat(m.from)?.face, task == null) { nav.pop(); pick(m.seq) }
                    HairRule()
                }
            }
        }
    }
}

@Composable
private fun SearchHit(m: RoomMessage, query: String, face: com.agentswitch.kit.api.RoomFace?, showTask: Boolean, tap: () -> Unit) {
    val classic = LocalLook.current.isClassic
    val snippet = remember(m.text, query) { RoomSearch.snippet(m.text, query) }
    val lit = Theme.signal
    Row(
        Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = tap).padding(horizontal = 14.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        RoomFaceView(face, you = m.from == com.agentswitch.kit.api.RoomSeat.you, side = 24.dp)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                Text(RoomWords.who(m.from), color = Theme.ink, style = if (classic) plain(14, FontWeight.SemiBold) else mono(13, FontWeight.SemiBold), maxLines = 1)
                if (showTask) m.task?.let { TaskTag(it) }
                Text("${RoomWords.day(m.at)} ${RoomWords.time(m.at)}", color = Theme.inkDim, style = mono(11), maxLines = 1)
            }
            Text(
                buildAnnotatedString {
                    append(snippet.text)
                    for (r in snippet.hits) addStyle(SpanStyle(color = lit, fontWeight = FontWeight.Bold, background = lit.copy(alpha = 0.14f)), r.first, r.last + 1)
                },
                color = Theme.secondaryInk, style = plain(13), maxLines = 3, overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/**
 * 等你处理 (2026-11-24 design, 已定 3): everything in every room that waits on the user's hand, the newest first, one
 * line each — a member's screen asking, a permission, a task stuck, a question put to the user, sessions talking long
 * alone. A tap opens the room there: the member's card, the task, the message.
 */
@Composable
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
fun RoomAttentionPage() {
    val app = LocalAppModel.current
    val nav = LocalNav.current
    val store = app.rooms
    val scope = rememberCoroutineScope()
    var refreshing by remember { mutableStateOf(false) }
    LaunchedEffect(app.api) {
        while (true) {
            store.refreshAttention(app.api)
            delay(RoomsStore.pollIntervalMs * 2)
        }
    }
    fun open(item: RoomAttentionItem) {
        val card = if (item.kind == "trust" || item.kind == "asks" || item.kind == "permission") item.handle else null
        nav.push("room:${item.room}") { RoomPage(item.room, openTask = item.task, openSeq = item.seq, openCard = card) }
    }
    Column(Modifier.fillMaxSize().background(Theme.base)) {
        NavBar("等你处理", leading = { BarBack({ nav.pop() }, "Rooms") })
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = { scope.launch { refreshing = true; try { store.refreshAttention(app.api); store.refresh(app.api) } finally { refreshing = false } } },
            modifier = Modifier.weight(1f).fillMaxWidth(),
        ) {
            val items = store.attention
            LazyColumn(Modifier.fillMaxSize()) {
                item("top") {
                    store.attentionError?.let { Text(it, Modifier.padding(horizontal = Theme.Space.l, vertical = 10.dp), color = Theme.failed, style = plain(13)) }
                    if (items != null && items.isEmpty()) Text("没有等你处理的事。", Modifier.padding(horizontal = Theme.Space.l).padding(top = 40.dp), color = Theme.secondaryInk, style = plain(14))
                    if (items == null && app.api == null) Text("未连接 Mac。", Modifier.padding(Theme.Space.l), color = Theme.secondaryInk, style = plain(14))
                }
                items(items ?: emptyList(), key = { "${it.room}:${it.kind}:${it.handle}:${it.task}:${it.seq}" }) { item ->
                    Row(
                        Modifier.fillMaxWidth().clickable(role = Role.Button) { open(item) }.padding(horizontal = Theme.Space.l, vertical = 11.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(item.line, color = if (item.urgent) Theme.waiting else Theme.ink, style = plain(15, FontWeight.Medium), maxLines = 2, overflow = TextOverflow.Ellipsis)
                            Text(item.roomName.ifEmpty { item.room }, color = Theme.secondaryInk, style = mono(11), maxLines = 1)
                        }
                        if (item.at > 0) Text(relativeTime(item.at), color = Theme.inkDim, style = mono(11), maxLines = 1)
                        Text("›", color = Theme.inkDim, style = plain(18))
                    }
                    HairRule()
                }
                item("end") { Spacer(Modifier.height(Theme.Space.m)) }
            }
        }
    }
}

/** 等你处理's entry in the rooms list's bar (已定 3): an inbox with how many things wait; nothing marked when none. */
@Composable
fun AttentionEntry(count: Int, open: () -> Unit) {
    val classic = LocalLook.current.isClassic
    Box(
        Modifier.clickable(role = Role.Button, onClickLabel = "等你处理", onClick = open).padding(horizontal = 8.dp, vertical = 10.dp),
        contentAlignment = Alignment.Center,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("等你处理", color = if (count > 0) Theme.waiting else if (classic) Theme.signal else Theme.secondaryInk, style = if (classic) plain(14) else mono(13))
            if (count > 0) {
                if (classic) {
                    Box(Modifier.background(Theme.waiting, androidx.compose.foundation.shape.CircleShape).padding(horizontal = 6.dp, vertical = 1.dp)) {
                        Text(count.toString(), color = androidx.compose.ui.graphics.Color.White, style = plain(11, FontWeight.Bold), maxLines = 1)
                    }
                } else Text("[$count]", color = Theme.waiting, style = mono(12, FontWeight.Bold), maxLines = 1)
            }
        }
    }
}

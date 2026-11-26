package com.agentswitch.android.rooms

import com.agentswitch.android.design.deckPart
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.LocalNav
import com.agentswitch.android.design.BarWord
import com.agentswitch.android.design.ClassicIcon
import com.agentswitch.android.design.ClassicIconKind
import com.agentswitch.android.design.ShadedSpriteView
import com.agentswitch.kit.live.ShadedSprite
import com.agentswitch.android.design.HairRule
import com.agentswitch.android.design.LocalLook
import com.agentswitch.android.design.NavBar
import com.agentswitch.android.design.Scanlines
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.android.onboarding.MacTabSubtitle
import com.agentswitch.android.terminals.ConnectionBanner
import com.agentswitch.kit.api.RoomSummary
import kotlinx.coroutines.launch

/**
 * The `Rooms` tab (docs/chatroom-v0.md §10; 2026-11-22, user: 空出来的放这个chatroom): the rooms on the Mac shown, the
 * one talked in last first — its name, who said the last thing and what, how many messages are not seen yet (amber
 * when one of them names the user) — and from each its page. `New` makes one. The list is read by the tabs' root
 * (MainTabs), often while this tab is on screen.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RoomsTab() {
    val model = LocalAppModel.current
    val nav = LocalNav.current
    val classic = LocalLook.current.isClassic
    val store = model.rooms
    val scope = rememberCoroutineScope()
    var refreshing by remember { mutableStateOf(false) }

    fun open(id: String, at: RoomOpening? = null) {
        nav.push("room:$id") { RoomPage(id, openTask = at?.task, openSeq = at?.seq, openCard = at?.card) }
    }

    // A room asked for from elsewhere (a new one just made, a 等你处理 notification).
    LaunchedEffect(model.openRoomRequest) {
        val id = model.openRoomRequest ?: return@LaunchedEffect
        model.openRoomRequest = null
        val at = model.openRoomAt
        model.openRoomAt = null
        open(id, at)
    }

    val folds = remember { RoomFolds(model.settings) }
    // What waits on the user, for `Mentions`: read while the list is on screen (as the Mac's list does).
    LaunchedEffect(model.api) {
        while (true) {
            if (store.attention == null || store.attentionDue()) store.refreshAttention(model.api)
            kotlinx.coroutines.delay(RoomsStore.pollIntervalMs)
        }
    }

    Column(Modifier.fillMaxSize().background(Theme.base)) {
        NavBar(
            "Rooms",
            subtitle = { MacTabSubtitle() },
            trailing = {
                val can = store.list != null && !store.unsupported
                if (classic) {
                    Box(
                        Modifier.clickable(can, role = Role.Button, onClickLabel = "New") { nav.present("roomnew") { RoomSessionsSheet(RoomSessionsPurpose.Create) } }.padding(horizontal = 12.dp, vertical = 10.dp),
                        contentAlignment = Alignment.Center,
                    ) { Text("+", color = if (can) Theme.signal else Theme.inkDim, style = plain(26, FontWeight.Light)) }
                } else {
                    BarWord("New", { nav.present("roomnew") { RoomSessionsSheet(RoomSessionsPurpose.Create) } }, enabled = can)
                }
            },
        )
        Box(Modifier.weight(1f).fillMaxWidth()) {
            Scanlines(Modifier.fillMaxSize())
            PullToRefreshBox(
                isRefreshing = refreshing,
                onRefresh = { scope.launch { refreshing = true; try { store.refresh(model.api) } finally { refreshing = false } } },
                modifier = Modifier.fillMaxSize(),
            ) {
                val rooms = store.rooms
                LazyColumn(Modifier.fillMaxSize()) {
                    item("top") {
                        Column(Modifier.fillMaxWidth().padding(top = Theme.Space.m)) {
                            if (model.connection.endpoint == null) ConnectionBanner(Modifier.padding(horizontal = Theme.Space.l).padding(bottom = Theme.Space.m))
                            store.error?.let { Text(it, Modifier.padding(horizontal = Theme.Space.l).padding(bottom = Theme.Space.m), color = Theme.failed, style = plain(13)) }
                            if (store.unsupported) {
                                Text("这台 Mac 上的 AgentSwitch 还没有 Chat Room。请先在 Mac 上更新。", Modifier.padding(horizontal = Theme.Space.l).padding(top = 40.dp), color = Theme.secondaryInk, style = plain(13))
                            } else if (store.list != null && rooms.isEmpty()) {
                                Text("尚无房间。点 New 新建一个，把正在运行的会话拉进来。", Modifier.padding(horizontal = Theme.Space.l).padding(top = 40.dp), color = Theme.secondaryInk, style = plain(13))
                            }
                        }
                    }
                    // Three groups that fold (the Mac's, user #488, #492): what waits on the user's hand — 等你处理's
                    // list, a row each —, the dispatch desk, and the channels.
                    val mentions = mentionsOf(store.attention.orEmpty(), rooms)
                    if (mentions.isNotEmpty()) {
                        item("g:mentions") { RoomGroupHead("Mentions", mentions.size, hot = true, folded = folds.mentions) { folds.mentions = !folds.mentions } }
                        if (!folds.mentions) itemsIndexed(mentions, key = { _, m -> "m:${m.id}" }) { index, m ->
                            MentionRow(m, index == mentions.size - 1, groupCard(index, mentions.size)) {
                                val item = m.item
                                if (item != null) open(item.room, RoomOpening(task = item.task, seq = item.seq, card = item.card))
                                else open(m.room)
                            }
                        }
                    }
                    val desks = rooms.filter { it.desk }
                    if (desks.isNotEmpty()) {
                        item("g:dispatch") { RoomGroupHead("Dispatch", desks.sumOf { it.unread }, hot = desks.any { it.forYou && it.unread > 0 }, folded = folds.dispatch) { folds.dispatch = !folds.dispatch } }
                        if (!folds.dispatch) itemsIndexed(desks, key = { _, r -> r.id }) { index, room ->
                            RoomListRow(room, index, index == desks.size - 1, groupCard(index, desks.size).clickable { open(room.id) })
                        }
                    }
                    val topics = rooms.filter { !it.desk }
                    if (topics.isNotEmpty()) {
                        item("g:topics") { RoomGroupHead("Topics", topics.sumOf { it.unread }, hot = topics.any { it.forYou && it.unread > 0 }, folded = folds.topics) { folds.topics = !folds.topics } }
                        if (!folds.topics) itemsIndexed(topics, key = { _, r -> r.id }) { index, room ->
                            RoomListRow(room, index, index == topics.size - 1, groupCard(index, topics.size).clickable { open(room.id) })
                        }
                    }
                    item("end") { Spacer(Modifier.padding(bottom = Theme.Space.m)) }
                }
            }
        }
    }
}

/** Which of the list's groups are folded, as this phone left them. */
private class RoomFolds(private val settings: com.agentswitch.android.AppSettings?) {
    private fun kept(key: String) = mutableStateOf(settings?.bool(key, false) ?: false)
    private val m = kept("rooms.fold.mentions")
    private val d = kept("rooms.fold.dispatch")
    private val t = kept("rooms.fold.topics")
    var mentions: Boolean get() = m.value; set(v) { m.value = v; settings?.putBool("rooms.fold.mentions", v) }
    var dispatch: Boolean get() = d.value; set(v) { d.value = v; settings?.putBool("rooms.fold.dispatch", v) }
    var topics: Boolean get() = t.value; set(v) { t.value = v; settings?.putBool("rooms.fold.topics", v) }
}

/** A row of `Mentions`: what waits on the user in a channel (an item of 等你处理), or a channel with a message for the
 *  user and nothing else waiting there. */
private data class Mention(val id: String, val room: String, val roomName: String, val line: String, val urgent: Boolean, val item: com.agentswitch.kit.api.RoomAttentionItem?)

private fun mentionsOf(attention: List<com.agentswitch.kit.api.RoomAttentionItem>, rooms: List<RoomSummary>): List<Mention> {
    val waiting = attention.map { Mention("${it.room}:${it.kind}:${it.handle}:${it.task}:${it.seq}", it.room, it.roomName.ifEmpty { it.room }, it.line, it.urgent, it) }
    val held = attention.map { it.room }.toSet()
    val said = rooms.filter { it.forYou && it.unread > 0 && it.id !in held }.map { Mention("said|${it.id}", it.id, it.name, it.lastLine, false, null) }
    return waiting + said
}

/** Each group on a card that floats on the page: a grouped list's round card in the classic look, a deck with a frame
 *  and a hard shadow in the pixel look (docs/ui-v0.md §9.2, user #644) — drawn row by row, as the list lays them out. */
@Composable
private fun groupCard(index: Int, count: Int): Modifier {
    val classic = LocalLook.current.isClassic
    return Modifier.padding(start = Theme.Space.l, end = if (classic) Theme.Space.l else Theme.Space.l - 3.dp)
        .then(Modifier.deckPart(index == 0, index == count - 1))
}

/** A group's head: the mark that folds it, its name, how much is new in it — amber when some of it is for the user. */
@Composable
private fun RoomGroupHead(title: String, count: Int, hot: Boolean, folded: Boolean, toggle: () -> Unit) {
    val classic = LocalLook.current.isClassic
    Row(
        Modifier.fillMaxWidth().clickable(role = Role.Button, onClickLabel = if (folded) "Expand" else "Collapse", onClick = toggle)
            .padding(horizontal = Theme.Space.l).padding(top = 14.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        com.agentswitch.android.terminals.LookGlyph(if (folded) "▸" else "▾", if (folded) com.agentswitch.android.terminals.LookSymbol.ChevronRight else com.agentswitch.android.terminals.LookSymbol.ChevronDown, Modifier.width(12.dp), color = Theme.inkDim, size = 12)
        com.agentswitch.android.design.SectionLabel(title, Modifier.weight(1f))
        if (count > 0) {
            if (classic) {
                Box(
                    Modifier.defaultMinSize(minWidth = 18.dp, minHeight = 18.dp).background(if (hot) Theme.waiting else Theme.raised, CircleShape).padding(horizontal = 5.dp),
                    contentAlignment = Alignment.Center,
                ) { Text(count.toString(), color = if (hot) Color.White else Theme.secondaryInk, style = plain(11, FontWeight.Bold), maxLines = 1) }
            } else Text("[$count]", color = if (hot) Theme.waiting else Theme.secondaryInk, style = mono(12), maxLines = 1)
        }
    }
}

/** A row of `Mentions`: `@`, the channel, and under it who waits and for what. */
@Composable
private fun MentionRow(m: Mention, last: Boolean, modifier: Modifier, open: () -> Unit) {
    val classic = LocalLook.current.isClassic
    Column(modifier.fillMaxWidth().clickable(role = Role.Button, onClick = open)) {
        Row(Modifier.fillMaxWidth().padding(horizontal = Theme.Space.l, vertical = 11.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("@", Modifier.width(16.dp), color = Theme.waiting, style = if (classic) plain(16) else mono(15), textAlign = androidx.compose.ui.text.style.TextAlign.Center)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(m.roomName, color = Theme.ink, style = plain(15, FontWeight.SemiBold), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(m.line, color = if (m.urgent) Theme.waiting else Theme.secondaryInk, style = plain(13), maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
        if (!last) HairRule(Modifier.padding(start = 42.dp))
    }
}

/** Where a room opens when asked from elsewhere (a 等你处理 notification): the task, the message, a member's card. */
data class RoomOpening(val task: Int? = null, val seq: Int? = null, val card: String? = null)

/** One room's line in the list. */
@Composable
private fun RoomListRow(room: RoomSummary, index: Int, last: Boolean, modifier: Modifier) {
    val classic = LocalLook.current.isClassic
    Column(modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth().padding(horizontal = Theme.Space.l, vertical = 11.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (room.desk) DeskMark()
                else if (!classic) Text("%02d".format(index + 1), color = Theme.inkDim, style = mono(14))
                Text(room.name, Modifier.weight(1f), color = Theme.ink, style = plain(15, FontWeight.SemiBold), maxLines = 1, overflow = TextOverflow.Ellipsis)
                // The sessions have been talking among themselves (§7): told, not stopped. Amber: it is for the user to look.
                if (room.paused) Text("Paused", color = Theme.inkDim, style = mono(11), maxLines = 1)
                if (room.desk && room.name != "调度台") DeskBadge()
                if (room.unread > 0) UnreadCount(room.unread, room.forYou)
            }
            Text(room.lastLine, color = Theme.secondaryInk, style = plain(13), maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (!last) HairRule(Modifier.padding(start = Theme.Space.l))
    }
}

/** The dispatch desk's mark (调度台): the Dispatch tab's picture, small, where the others have their number. */
@Composable
private fun DeskMark() {
    if (LocalLook.current.isClassic) ClassicIcon(ClassicIconKind.Lanes, 18.dp, 16.dp, Theme.signal)
    else Box(Modifier.size(width = 22.dp, height = 18.dp), contentAlignment = Alignment.Center) { ShadedSpriteView(ShadedSprite.dispatch, shadow = false, cell = 1.0) }
}

/** `调度台`, said beside a desk whose name is another. */
@Composable
private fun DeskBadge() {
    val classic = LocalLook.current.isClassic
    Text(
        "调度台",
        Modifier.background(if (classic) Theme.signal.copy(alpha = 0.14f) else Color.Transparent, RoundedCornerShape(if (classic) 5.dp else 0.dp))
            .then(if (classic) Modifier else Modifier.border(1.dp, Theme.line)).padding(horizontal = 5.dp, vertical = 1.dp),
        color = if (classic) Theme.signal else Theme.secondaryInk, style = plain(11, FontWeight.Medium), maxLines = 1,
    )
}

/** How many are not seen yet: amber when one of them names the user (amber is what waits for you), quiet otherwise. */
@Composable
private fun UnreadCount(count: Int, forYou: Boolean) {
    if (LocalLook.current.isClassic) {
        Box(
            Modifier.defaultMinSize(minWidth = 17.dp, minHeight = 17.dp).background(if (forYou) Theme.waiting else Theme.inkDim, CircleShape).padding(horizontal = 5.dp),
            contentAlignment = Alignment.Center,
        ) { Text(count.toString(), color = Color.White, style = plain(11, FontWeight.Bold), maxLines = 1) }
    } else {
        Text("[$count]", color = if (forYou) Theme.waiting else Theme.secondaryInk, style = mono(11), maxLines = 1)
    }
}

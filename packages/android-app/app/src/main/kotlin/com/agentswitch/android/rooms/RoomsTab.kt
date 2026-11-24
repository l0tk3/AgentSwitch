package com.agentswitch.android.rooms

import androidx.compose.foundation.background
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

    fun open(id: String) = nav.push("room:$id") { RoomPage(id) }

    // A room asked for from elsewhere (a new one just made).
    LaunchedEffect(model.openRoomRequest) {
        val id = model.openRoomRequest ?: return@LaunchedEffect
        model.openRoomRequest = null
        open(id)
    }

    Column(Modifier.fillMaxSize().background(Theme.base)) {
        NavBar(
            "Rooms",
            subtitle = { MacTabSubtitle() },
            trailing = {
                val can = store.list != null && !store.unsupported
                // 等你处理 (2026-11-24 已定 3): its own entry, an inbox with a count, not at the list's bottom.
                if (can) AttentionEntry(store.attentionCount) { nav.push("roomattention") { RoomAttentionPage() } }
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
                    itemsIndexed(rooms, key = { _, r -> r.id }) { index, room ->
                        val first = index == 0
                        val last = index == rooms.size - 1
                        // The classic look: a standard grouped list's card, round at its two ends.
                        val card = if (classic) {
                            Modifier.padding(horizontal = Theme.Space.l).clip(
                                RoundedCornerShape(
                                    topStart = if (first) 12.dp else 0.dp, topEnd = if (first) 12.dp else 0.dp,
                                    bottomStart = if (last) 12.dp else 0.dp, bottomEnd = if (last) 12.dp else 0.dp,
                                ),
                            ).background(Theme.panel)
                        } else Modifier
                        RoomListRow(room, index, last, card.clickable { open(room.id) })
                    }
                    item("end") { Spacer(Modifier.padding(bottom = Theme.Space.m)) }
                }
            }
        }
    }
}

/** One room's line in the list. */
@Composable
private fun RoomListRow(room: RoomSummary, index: Int, last: Boolean, modifier: Modifier) {
    val classic = LocalLook.current.isClassic
    Column(modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth().padding(horizontal = Theme.Space.l, vertical = 11.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (!classic) Text("%02d".format(index + 1), color = Theme.inkDim, style = mono(14))
                Text(room.name, Modifier.weight(1f), color = Theme.ink, style = plain(15, FontWeight.SemiBold), maxLines = 1, overflow = TextOverflow.Ellipsis)
                // The sessions have been talking among themselves (§7): told, not stopped. Amber: it is for the user to look.
                room.rounds?.let { Text("$it Rounds", color = Theme.waiting, style = mono(11), maxLines = 1) }
                if (room.paused) Text("Paused", color = Theme.inkDim, style = mono(11), maxLines = 1)
                if (room.unread > 0) UnreadCount(room.unread, room.forYou)
            }
            Text(room.lastLine, color = Theme.secondaryInk, style = plain(13), maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (!(classic && last)) HairRule(Modifier.padding(start = if (classic) Theme.Space.l else 0.dp))
    }
}

/** How many are not seen yet: amber when one of them names the user (amber is what waits for you), quiet otherwise. */
@Composable
private fun UnreadCount(count: Int, forYou: Boolean) {
    if (LocalLook.current.isClassic) {
        Box(
            Modifier.defaultMinSize(minWidth = 17.dp, minHeight = 17.dp).background(if (forYou) Theme.waiting else Theme.inkDim, CircleShape).padding(horizontal = 5.dp),
            contentAlignment = Alignment.Center,
        ) { Text(count.toString(), color = Color.White, style = plain(10, FontWeight.Bold), maxLines = 1) }
    } else {
        Text("[$count]", color = if (forYou) Theme.waiting else Theme.secondaryInk, style = mono(11), maxLines = 1)
    }
}

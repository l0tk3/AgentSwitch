package com.agentswitch.android.rooms

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.design.NavBar
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.plain

/**
 * The Dispatch tab while the old dispatch is off (OldDispatch): the new dispatch, the Chat Room the Mac flags as the
 * dispatch desk (调度台, `desk` in GET /rooms) shown as its room page, titled `Dispatch`. The rooms list is the one the
 * tabs' root polls (MainTabs). No desk room: the dispatch is not turned on — that is done on the Mac only.
 */
@Composable
fun DispatchDeskTab() {
    val store = LocalAppModel.current.rooms
    val desk = store.rooms.firstOrNull { it.desk }
    if (desk != null) {
        key(desk.id) { RoomPage(desk.id, desk = true) }
        return
    }
    Column(Modifier.fillMaxSize().background(Theme.base)) {
        NavBar("Dispatch")
        // Nothing said until the list has been read once (or the Mac has no Chat Room at all).
        if (store.list == null && !store.unsupported) return@Column
        Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
            Column(
                Modifier.padding(horizontal = Theme.Space.l),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text("调度还没打开", color = Theme.ink, style = plain(17, FontWeight.SemiBold), textAlign = TextAlign.Center)
                Text("在 Mac 的 Settings › Dispatch 里打开。", color = Theme.secondaryInk, style = plain(14), textAlign = TextAlign.Center)
            }
        }
    }
}

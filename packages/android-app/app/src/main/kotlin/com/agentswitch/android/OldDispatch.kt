package com.agentswitch.android

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.agentswitch.android.design.BarBack
import com.agentswitch.android.design.NavBar
import com.agentswitch.android.design.ShadedSpriteView
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.dithered
import com.agentswitch.android.design.plain
import com.agentswitch.kit.live.ShadedSprite

/**
 * The old dispatch (the Dispatch tab: the compose box the router sends to an executor, the assistant, task pages,
 * threads, approvals and answers from a task, History and Models in Settings) is off (2026-11-24, the repo owner's
 * decision): disabled, not deleted, until the new dispatch built on Chat Rooms replaces it. The Mac refuses its routes
 * with 410 `old_dispatch_off`. Every entry into it in the app reads [OFF]; set it to false to bring it all back.
 */
object OldDispatch {
    const val OFF = true

    /** What the entries say instead. */
    const val NOTE = "旧调度已停用，新调度测试中。"
}

/** Where a page of the old dispatch would open: its title, the mark dithered, and the note; `Back` when pushed. */
@Composable
fun DispatchOffPage(title: String = "Dispatch Off", modifier: Modifier = Modifier, onBack: (() -> Unit)? = null) {
    Column(modifier.fillMaxSize().background(Theme.base)) {
        NavBar(title, leading = { if (onBack != null) BarBack(onBack) })
        Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
            Column(
                Modifier.padding(horizontal = Theme.Space.l),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Box(Modifier.dithered()) { ShadedSpriteView(ShadedSprite.dispatch, strength = 1f, shadow = false, cell = 3.0) }
                Text(OldDispatch.NOTE, color = Theme.secondaryInk, style = plain(14), textAlign = TextAlign.Center)
            }
        }
    }
}

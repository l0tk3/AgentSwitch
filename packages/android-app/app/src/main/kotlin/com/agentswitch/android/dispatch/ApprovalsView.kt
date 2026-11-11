package com.agentswitch.android.dispatch

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.LocalNav
import com.agentswitch.android.design.BarWord
import com.agentswitch.android.design.Centered
import com.agentswitch.android.design.NavBar
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.plain
import com.agentswitch.android.rememberBack
import com.agentswitch.android.terminals.ConnectionBanner
import com.agentswitch.kit.api.ApprovalStatus
import com.agentswitch.kit.feed.MessageDisplay
import kotlinx.coroutines.delay

/**
 * Every pending approval and question across tasks (`GET /approvals`), answerable in place. Opened from the home
 * screen's `N More Waiting` when some belong to tasks that are no longer in the log. A sheet.
 */
@Composable
fun ApprovalsView() {
    val model = LocalAppModel.current
    val dispatch = model.dispatch
    val nav = LocalNav.current
    val back = rememberBack()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) { dispatch.refreshApprovals(); delay(10_000) }
        }
    }
    // Only open ones: a withdrawn or answered request has no card (control-v0 §4).
    val pending = dispatch.approvals.filter { it.status == ApprovalStatus.Pending }
    Column(Modifier.fillMaxSize().background(Theme.base)) {
        NavBar("Waiting", trailing = { BarWord("Done", back) })
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).windowInsetsPadding(WindowInsets.safeDrawing.only(androidx.compose.foundation.layout.WindowInsetsSides.Bottom + androidx.compose.foundation.layout.WindowInsetsSides.Horizontal))
                .padding(horizontal = 16.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            ConnectionBanner()
            if (pending.isEmpty()) Centered("无待处理事项", Modifier.padding(top = 40.dp))
            for (approval in pending) {
                Column(Modifier.fillMaxWidth().background(Theme.raised, com.agentswitch.android.design.lookShape(12.dp)).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    ApprovalCard(approval, onDecide = { dispatch.decide(approval, it) }, onAnswer = { dispatch.answer(approval, it) })
                    val task = dispatch.tasks.firstOrNull { it.id == approval.taskId }
                    Text(
                        task?.let { "任务：${MessageDisplay.readable(it.task)}" } ?: "打开任务 ${approval.taskId}",
                        Modifier.fillMaxWidth().clickable(role = Role.Button) { nav.push("task/${approval.taskId}") { TaskDetailView(approval.taskId) } },
                        color = Theme.secondaryInk, style = plain(13), maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

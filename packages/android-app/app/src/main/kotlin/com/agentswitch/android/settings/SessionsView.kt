package com.agentswitch.android.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.components.ErrorText
import com.agentswitch.android.demo.DemoData
import com.agentswitch.android.demo.LocalDemo
import com.agentswitch.android.design.BarBack
import com.agentswitch.android.design.BrailleSpinner
import com.agentswitch.android.design.FormRow
import com.agentswitch.android.design.FormSection
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.lookWord
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.android.rememberBack
import com.agentswitch.android.terminals.relativeTime
import com.agentswitch.kit.api.APIError
import com.agentswitch.kit.api.SessionGroups
import com.agentswitch.kit.api.SessionSummary
import com.agentswitch.kit.api.sessions
import com.agentswitch.kit.feed.MessageDisplay
import com.agentswitch.kit.support.PathDisplay
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay

/**
 * Settings › Coding Sessions (control-v0 §3): Claude Code, Codex and OpenCode sessions on the Mac, one group per folder,
 * the latest first; read only. Loaded on appear and on a pull; while one of them is running the list is fetched again
 * every 10 s. The Mac reads the executors' own records; nothing here changes them.
 */
@Composable
fun SessionsView() {
    val model = LocalAppModel.current
    val open = rememberOpen()
    var sessions by remember { mutableStateOf<List<SessionSummary>>(emptyList()) }
    var loaded by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var unsupported by remember { mutableStateOf(false) }
    val demo = LocalDemo.current

    suspend fun load() {
        val api = model.api
        if (api == null) {
            if (demo) sessions = DemoData.sessions
            loaded = true
            return
        }
        try {
            sessions = api.sessions()
            error = null
            unsupported = false
        } catch (e: CancellationException) {
            throw e
        } catch (e: APIError.Http) {
            if (e.status == 404) unsupported = true else { model.handle(e); error = e.message }
        } catch (e: Exception) {
            model.handle(e)
            error = e.message ?: e.javaClass.simpleName
        }
        loaded = true
    }
    LaunchedEffect(model.api) {
        load()
        // Only a running session changes by itself; a quiet list is fetched again on a pull.
        while (sessions.any { it.active }) { delay(10_000); load() }
    }
    SettingsPage("Coding Sessions", onRefresh = { load() }, leading = { BarBack(rememberBack(), "Settings") }) {
        error?.let { FormSection { FormRow(first = true) { ErrorText(it, { error = null }) } } }
        if (!loaded) Box(Modifier.fillMaxWidth().padding(top = 60.dp), contentAlignment = Alignment.Center) { BrailleSpinner(color = Theme.secondaryInk) }
        if (unsupported) Empty("此 Mac 不支持查看编码会话", "在 Mac 上更新 AgentSwitch 后重试。")
        else if (loaded && sessions.isEmpty()) Empty("无编码会话", "在 Mac 上使用 Claude Code、Codex 或 OpenCode 时，会话将显示在此处。")
        for (group in SessionGroups.grouped(sessions)) {
            FormSection(if (group.folder.isEmpty()) "Unknown Folder" else middle(PathDisplay.short(group.folder))) {
                for ((i, session) in group.sessions.withIndex()) {
                    FormRow(first = i == 0, onClick = { open(SettingsRoute.Session(session)) }) {
                        SessionRow(session, Modifier.weight(1f))
                        com.agentswitch.android.terminals.LookSymbolIcon(com.agentswitch.android.terminals.LookSymbol.ChevronRight, side = 13.dp, color = Theme.inkDim, bold = true)
                    }
                }
            }
        }
    }
}

@Composable
private fun Empty(title: String, detail: String) {
    Column(Modifier.fillMaxWidth().padding(top = 60.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(title, color = Theme.ink, style = plain(20, FontWeight.SemiBold), textAlign = TextAlign.Center)
        Text(detail, color = Theme.secondaryInk, style = plain(15), textAlign = TextAlign.Center)
    }
}

/** One session: what it is about, then the executor, branch and when; Busy with its spinner while it runs. */
@Composable
private fun SessionRow(session: SessionSummary, modifier: Modifier) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(MessageDisplay.readable(session.displayTitle), color = Theme.ink, style = plain(15), maxLines = 2, overflow = TextOverflow.Ellipsis)
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            if (session.active) {
                BrailleSpinner()
                Text(lookWord("Busy"), color = Theme.busy, style = mono(12, FontWeight.Medium))
                Text("·", color = Theme.inkDim, style = plain(12))
            }
            Text(
                listOfNotNull(session.harnessName, session.branch, relativeTime(session.updated)).joinToString(" · "),
                color = Theme.secondaryInk, style = plain(12), maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/** A folder as a one-line label: its middle left out when it is long (the iPhone's `truncationMode(.middle)`). */
private fun middle(path: String, max: Int = 36): String = if (path.length <= max) path else path.take(max / 2 - 1) + "…" + path.takeLast(max / 2)

package com.agentswitch.android.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.pulltorefresh.PullToRefreshDefaults
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.agentswitch.android.LocalNav
import com.agentswitch.android.design.FormRow
import com.agentswitch.android.design.NavBar
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.android.terminals.LookSymbol
import com.agentswitch.android.terminals.LookSymbolIcon
import com.agentswitch.kit.api.SessionSummary
import kotlinx.coroutines.launch

/** Where Settings can lead: the Mac's details, the history, the Mac's coding sessions and one of them, and the pages of its groups. */
sealed class SettingsRoute(val key: String) {
    data object Mac : SettingsRoute("settings/mac")
    data object Tasks : SettingsRoute("settings/tasks")
    data object Sessions : SettingsRoute("settings/sessions")
    data class Session(val summary: SessionSummary) : SettingsRoute("settings/session/${summary.id}")
    data object Context : SettingsRoute("settings/context")
    data object Ciphertexts : SettingsRoute("settings/ciphertexts")
    data object Models : SettingsRoute("settings/models")
    data object Voice : SettingsRoute("settings/voice")
}

/** A page of Settings (or its tab): the bar, then grouped rows; `onRefresh` makes it a pull to refresh. */
@Composable
internal fun SettingsPage(
    title: String,
    modifier: Modifier = Modifier,
    tab: Boolean = false,
    onRefresh: (suspend () -> Unit)? = null,
    leading: @Composable RowScope.() -> Unit = {},
    trailing: @Composable RowScope.() -> Unit = {},
    scroll: androidx.compose.foundation.ScrollState = rememberScrollState(),
    content: @Composable ColumnScope.() -> Unit,
) {
    val body: @Composable () -> Unit = {
        // A tab sits above the tab bar, which has taken the bottom inset; a page over the tabs has not.
        val insets = if (tab) WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal) else WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal + WindowInsetsSides.Bottom)
        Column(
            Modifier.fillMaxSize().verticalScroll(scroll).windowInsetsPadding(insets).padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 24.dp),
            content = content,
        )
    }
    Column(modifier.fillMaxSize().background(Theme.base)) {
        NavBar(title, leading = leading, trailing = trailing)
        if (onRefresh == null) body() else {
            val scope = rememberCoroutineScope()
            var refreshing by remember { mutableStateOf(false) }
            val state = rememberPullToRefreshState()
            PullToRefreshBox(
                isRefreshing = refreshing,
                onRefresh = { scope.launch { refreshing = true; try { onRefresh() } finally { refreshing = false } } },
                modifier = Modifier.fillMaxSize(),
                state = state,
                indicator = { PullToRefreshDefaults.Indicator(state, refreshing, Modifier.align(Alignment.TopCenter), containerColor = Theme.raised, color = Theme.signal) },
            ) { body() }
        }
    }
}

/** A row that leads to a page: its word, what it says now, and the chevron. Dim and still when `enabled` is false. */
@Composable
internal fun NavRow(label: String, first: Boolean = false, value: String? = null, enabled: Boolean = true, monoValue: Boolean = true, onClick: () -> Unit) {
    FormRow(Modifier.alpha(if (enabled) 1f else 0.4f), first = first, onClick = if (enabled) onClick else null) {
        Text(label, color = Theme.ink, style = plain(16), maxLines = 1)
        Spacer(Modifier.weight(1f))
        if (value != null) Text(value, color = Theme.secondaryInk, style = if (monoValue) mono(13) else plain(16), maxLines = 1)
        LookSymbolIcon(LookSymbol.ChevronRight, side = 13.dp, color = Theme.inkDim, bold = true)
    }
}

/** A row with a switch (the system's own control, tinted by the theme). */
@Composable
internal fun ToggleRow(label: String, checked: Boolean, first: Boolean = false, enabled: Boolean = true, onChange: (Boolean) -> Unit) {
    FormRow(Modifier.alpha(if (enabled) 1f else 0.4f), first = first, onClick = if (enabled) ({ onChange(!checked) }) else null) {
        Text(label, Modifier.weight(1f), color = Theme.ink, style = plain(16))
        Switch(checked = checked, onCheckedChange = if (enabled) onChange else null, enabled = enabled)
    }
}

/** A row of one button-like word (`Add Mac`, `Choose Route Again`). */
@Composable
internal fun ActionRow(label: String, first: Boolean = false, enabled: Boolean = true, color: androidx.compose.ui.graphics.Color = Theme.ink, onClick: () -> Unit) {
    FormRow(Modifier.alpha(if (enabled) 1f else 0.4f), first = first, onClick = if (enabled) onClick else null) {
        Text(label, color = color, style = plain(16))
    }
}

/** A sentence in a group (a footnote line). */
@Composable
internal fun NoteRow(text: String, first: Boolean = false, color: androidx.compose.ui.graphics.Color = Theme.secondaryInk) {
    FormRow(first = first) { Text(text, Modifier.weight(1f), color = color, style = plain(13)) }
}

/** The system's segmented control, in the theme's colours. */
@Composable
internal fun Segmented(labels: List<String>, selected: Int, onSelect: (Int) -> Unit, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth().clip(RoundedCornerShape(9.dp)).background(Theme.base).padding(2.dp)) {
        for ((i, label) in labels.withIndex()) {
            Box(
                Modifier.weight(1f).height(32.dp).clip(RoundedCornerShape(7.dp))
                    .background(if (i == selected) Theme.line else androidx.compose.ui.graphics.Color.Transparent)
                    .clickable(role = Role.RadioButton) { onSelect(i) },
                contentAlignment = Alignment.Center,
            ) { Text(label, color = Theme.ink, style = plain(15, if (i == selected) FontWeight.SemiBold else FontWeight.Normal)) }
        }
    }
}

/** `−  |  +`, the system's stepper. */
@Composable
internal fun Stepper(onMinus: () -> Unit, onPlus: () -> Unit, canMinus: Boolean, canPlus: Boolean) {
    Row(Modifier.clip(RoundedCornerShape(8.dp)).background(Theme.base).height(32.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.width(46.dp).fillMaxSize().clickable(canMinus, role = Role.Button, onClickLabel = "Smaller", onClick = onMinus), contentAlignment = Alignment.Center) {
            Text("−", color = if (canMinus) Theme.ink else Theme.inkDim, style = plain(20))
        }
        Box(Modifier.width(1.dp).height(16.dp).background(Theme.line))
        Box(Modifier.width(46.dp).fillMaxSize().clickable(canPlus, role = Role.Button, onClickLabel = "Larger", onClick = onPlus), contentAlignment = Alignment.Center) {
            Text("+", color = if (canPlus) Theme.ink else Theme.inkDim, style = plain(20))
        }
    }
}

/** Pushes a page of Settings over the tabs. */
@Composable
internal fun rememberOpen(): (SettingsRoute) -> Unit {
    val nav = LocalNav.current
    return { route -> nav.push(route.key) { RouteContent(route) } }
}

@Composable
internal fun RouteContent(route: SettingsRoute) {
    val model = com.agentswitch.android.LocalAppModel.current
    when (route) {
        SettingsRoute.Mac -> model.profile?.let { MacDetailsView(it) }
        SettingsRoute.Tasks -> com.agentswitch.android.dispatch.TasksManageView()
        SettingsRoute.Sessions -> SessionsView()
        is SettingsRoute.Session -> com.agentswitch.android.terminals.SessionTranscriptView(route.summary)
        SettingsRoute.Context -> ContextEditorView()
        SettingsRoute.Ciphertexts -> CiphertextsView()
        SettingsRoute.Models -> ModelsView()
        SettingsRoute.Voice -> SpeechVoiceView()
    }
}

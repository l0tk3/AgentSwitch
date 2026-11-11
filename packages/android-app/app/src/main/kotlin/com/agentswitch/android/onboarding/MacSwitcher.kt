package com.agentswitch.android.onboarding

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.agentswitch.android.AppModel
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.design.LocalLook
import com.agentswitch.android.design.PixelBox
import com.agentswitch.android.design.PixelBoxEffect
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.android.terminals.LookSymbol
import com.agentswitch.android.terminals.LookSymbolIcon

// The Mac a page shows, and the way to switch to another (AddMacSheet.swift lines 30–121). On the iPhone these are
// system `Menu`s; here the app's own pixel menu, placed under the line that opened it (the brief: the `⋯` and context
// menus are PixelBox menus on Android).

/**
 * The paired Macs as a menu's rows — the current one checked — and `Add Mac` under them (the Swift's `MacSwitchRows`).
 * The check is a `✓` before the name, the others are indented to match.
 */
fun macSwitchActions(model: AppModel): List<PixelBox.Action> {
    val current = model.profile?.fingerprint
    val rows = model.macs.servers.map { mac ->
        PixelBox.Action(if (mac.fingerprint == current) "✓ ${mac.name}" else "   ${mac.name}") { model.switchTo(mac.fingerprint) }
    }
    return rows + PixelBox.Action("+ Add Mac") { model.addingMac = true }
}

/** Where a menu opened from `anchor` is placed: its rows are the Macs. */
@Composable
private fun MacMenu(anchor: Rect?, onDismiss: () -> Unit) {
    val model = LocalAppModel.current
    PixelBoxEffect(anchor, onDismiss) { at -> PixelBox(cancel = null, actions = macSwitchActions(model), anchor = at, width = 220.dp) }
}

/** The current Mac as the home screen's title, with the other paired Macs to switch to. */
@Composable
fun MacSwitcher(modifier: Modifier = Modifier) {
    val model = LocalAppModel.current
    var anchor by remember { mutableStateOf<Rect?>(null) }
    var bounds by remember { mutableStateOf(Rect.Zero) }
    val name = model.profile?.name ?: "AgentSwitch"
    Row(
        modifier.onGloballyPositioned { bounds = it.boundsInRoot() }
            .semantics { contentDescription = "切换 Mac，当前为 ${model.profile?.name ?: "Mac"}" }
            .clickable(role = Role.Button) { anchor = bounds },
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(name, color = Theme.ink, style = plain(17, FontWeight.SemiBold), maxLines = 1)
        LookSymbolIcon(LookSymbol.ChevronDown, side = 9.dp, color = Theme.secondaryInk, bold = true)
    }
    MacMenu(anchor) { anchor = null }
}

/**
 * Which Mac a page shows, as the small line under its title (`@ Mac mini`; `On Mac mini` in the classic look, as the
 * Files pages write it). With more than one Mac paired the line is the menu to switch to another — the one Dispatch's
 * title has, on every page (docs/mesh-v0.md §5.1; 2026-11-10, user: 手机上现在选择连接的机器只能在dispatch里选，
 * 这样不好，在terminal里应该也能选才对). `switches = false`: the line alone (a page that is not a tab's first).
 */
@Composable
fun MacLine(modifier: Modifier = Modifier, switches: Boolean = true) {
    val model = LocalAppModel.current
    val classic = LocalLook.current.isClassic
    val name = model.profile?.name ?: "Mac"
    val words: @Composable () -> Unit = {
        Text(
            if (classic) "On $name" else "@ $name", color = if (classic) Theme.secondaryInk else Theme.signal,
            style = mono(11), maxLines = 1,
        )
    }
    if (switches && model.macs.servers.size > 1) {
        var anchor by remember { mutableStateOf<Rect?>(null) }
        var bounds by remember { mutableStateOf(Rect.Zero) }
        Row(
            modifier.onGloballyPositioned { bounds = it.boundsInRoot() }
                .semantics { contentDescription = "切换 Mac，当前为 $name" }
                // Room for a finger around a line this small.
                .clickable(role = Role.Button) { anchor = bounds }
                .padding(horizontal = 10.dp, vertical = 3.dp),
            horizontalArrangement = Arrangement.spacedBy(3.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            words()
            LookSymbolIcon(LookSymbol.ChevronDown, side = 8.dp, color = Theme.secondaryInk, bold = true)
        }
        MacMenu(anchor) { anchor = null }
    } else {
        Row(modifier) { words() }
    }
}

/**
 * Under a bar's title: the Mac the tab shows, to switch by, when more than one Mac is paired; nothing with one. Pass it
 * as `NavBar`'s `subtitle` — the bar writes the title itself.
 */
@Composable
fun MacTabSubtitle() {
    if (LocalAppModel.current.macs.servers.size > 1) MacLine()
}

/**
 * A tab's own title with, when more than one Mac is paired, the Mac it shows under it to switch by. One Mac: the title
 * alone, as before. `mark`: something before the title. (`NavBar` writes its own title: it takes [MacTabSubtitle].)
 */
@Composable
fun MacTabTitle(title: String, modifier: Modifier = Modifier, mark: @Composable () -> Unit = {}) {
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        Row(horizontalArrangement = Arrangement.spacedBy(7.dp), verticalAlignment = Alignment.CenterVertically) {
            mark()
            Text(title, color = Theme.ink, style = plain(17, FontWeight.SemiBold), maxLines = 1)
        }
        MacTabSubtitle()
    }
}

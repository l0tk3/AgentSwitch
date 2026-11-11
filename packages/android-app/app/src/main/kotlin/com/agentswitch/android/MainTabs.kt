package com.agentswitch.android

import androidx.compose.foundation.layout.Spacer
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.layout
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.agentswitch.android.browser.BrowserStore
import com.agentswitch.android.design.HairRule
import com.agentswitch.android.browser.BrowserTab
import com.agentswitch.android.dispatch.HomeView
import com.agentswitch.android.files.FilesTab
import com.agentswitch.android.design.LocalLook
import com.agentswitch.android.design.ShadedSpriteView
import com.agentswitch.android.design.folder
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.plain
import com.agentswitch.android.settings.SettingsTab
import com.agentswitch.android.terminals.TerminalsStore
import com.agentswitch.android.terminals.TerminalsTab
import com.agentswitch.kit.live.ShadedSprite
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay

/**
 * The entries side by side (docs/terminal-v0.md §1, browser-v0 §1): `Terminals`, `Dispatch` (the conversation),
 * `Files`, `Browser` and `Settings`; their icons are the shaded pictures (docs/ui-v0.md §9: tones of the ink, no hue),
 * whole for the tab in use, fainter for the others.
 *
 * No push: while the app is open the Mac is followed from every tab.
 */
@Composable
fun MainTabs() {
    val model = LocalAppModel.current
    // Where the Mac is now, asked again now and then for as long as this connection lasts (the connection itself
    // asked once when it was made).
    LaunchedEffect(model.connection.endpoint) {
        if (model.connection.endpoint == null) return@LaunchedEffect
        while (true) {
            delay(AppModel.addressRefreshIntervalMs)
            model.refreshAddresses()
        }
    }
    // The terminals are followed from every tab while the app is on screen (the badge, the notifications).
    WhileStarted(model.connection.endpoint) {
        while (true) {
            model.refreshTerminals()
            delay(TerminalsStore.pollIntervalMs)
        }
    }
    // The Mac's browser tabs, from every tab: the badge counts the agents waiting for you; more often on the Browser tab,
    // rarely when the Mac has no browser (RootView.swift).
    WhileStarted(Pair(model.connection.endpoint, model.tab)) {
        while (true) {
            model.browser.refreshList(model.browserAPI)
            delay(
                if (model.browser.unsupported) BrowserStore.unsupportedIntervalMs
                else if (model.tab == MainTab.Browser) BrowserStore.pollIntervalMs else BrowserStore.backgroundIntervalMs,
            )
        }
    }
    val barHidden = remember { mutableStateOf(false) }
    CompositionLocalProvider(LocalTabBarHidden provides barHidden) {
    Column(Modifier.fillMaxSize().background(Theme.base)) {
        Box(Modifier.weight(1f).fillMaxWidth()) {
            // A tab once opened stays as it was left — its scroll, its search, what was typed — while another is
            // shown (the iPhone's tabs do): it is kept in the composition and only not placed.
            val opened = remember { mutableStateListOf<MainTab>() }
            if (model.tab !in opened) opened.add(model.tab)
            for (tab in opened.toList()) {
                key(tab) {
                    KeptTab(shown = tab == model.tab) {
                        when (tab) {
                            MainTab.Terminals -> TerminalsTab()
                            MainTab.Tasks -> HomeView()
                            MainTab.Files -> FilesTab()
                            MainTab.Browser -> BrowserTab()
                            MainTab.Settings -> SettingsTab()
                        }
                    }
                }
            }
        }
        // The Files tab takes the bar away while selecting and on a file's page (the iPhone's
        // `.toolbar(.hidden, for: .tabBar)`): what is left is the room of the system's own bar.
        if (model.tab == MainTab.Files && barHidden.value) Spacer(Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.navigationBars))
        else TabBar(model.tab, badges = mapOf(MainTab.Terminals to model.terminals.waiting, MainTab.Browser to model.browser.waiting)) { model.tab = it }
    }
    }
}

/** Whether the tab that is shown wants the tab bar gone for now; a tab sets it and clears it as it leaves. */
val LocalTabBarHidden = staticCompositionLocalOf<MutableState<Boolean>> { mutableStateOf(false) }

private class TabItem(val tab: MainTab, val word: String, val picture: ShadedSprite)

private val tabItems = listOf(
    TabItem(MainTab.Terminals, "Terminals", ShadedSprite.terminals),
    TabItem(MainTab.Tasks, "Dispatch", ShadedSprite.dispatch),
    TabItem(MainTab.Files, "Files", ShadedSprite.folder),
    TabItem(MainTab.Browser, "Browser", ShadedSprite.browser),
    TabItem(MainTab.Settings, "Settings", ShadedSprite.settings),
)

/** The bar under the tabs: a picture and a word each, a count on a red disc where something waits for you. */
@Composable
private fun TabBar(current: MainTab, badges: Map<MainTab, Int>, onSelect: (MainTab) -> Unit) {
    val classic = LocalLook.current.isClassic
    Column(Modifier.fillMaxWidth().background(Theme.base)) {
        HairRule()
        Row(Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.navigationBars).height(58.dp), horizontalArrangement = Arrangement.SpaceEvenly) {
            for (item in tabItems) {
                val on = item.tab == current
                Column(
                    Modifier.weight(1f).fillMaxSize()
                        .clickable(remember { MutableInteractionSource() }, null, role = Role.Tab) { onSelect(item.tab) }
                        .semantics { selected = on },
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) {
                    Box(Modifier.size(width = 44.dp, height = 28.dp), contentAlignment = Alignment.Center) {
                        ShadedSpriteView(item.picture, strength = if (on) 1f else 0.55f, shadow = false, cell = 1.6)
                        val count = badges[item.tab] ?: 0
                        if (count > 0) {
                            Box(
                                Modifier.align(Alignment.TopEnd).offset(x = 4.dp, y = (-3).dp).size(17.dp).background(Color(0xFFFF3B30), CircleShape),
                                contentAlignment = Alignment.Center,
                            ) { Text(if (count > 9) "9+" else count.toString(), color = Color.White, style = plain(11, FontWeight.SemiBold)) }
                        }
                    }
                    Text(
                        item.word, Modifier.padding(top = 3.dp),
                        color = if (on) (if (classic) Theme.signal else Theme.ink) else Theme.secondaryInk,
                        style = plain(10, if (on) FontWeight.SemiBold else FontWeight.Medium), maxLines = 1,
                    )
                }
            }
        }
    }
}


/**
 * `block` runs while the app is on screen and stops when it is not (and when `key` changes): nothing is asked of the
 * Mac behind the user's back, and the phone's battery is left alone (docs/ui-v0.md §7.4 省电).
 */
@Composable
fun WhileStarted(key: Any?, block: suspend () -> Unit) {
    val lifecycle = androidx.lifecycle.compose.LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(key, lifecycle) {
        lifecycle.repeatOnLifecycle(androidx.lifecycle.Lifecycle.State.STARTED) { block() }
    }
}

/** A tab's page: measured always, placed (so drawn and touched) only while it is the one shown. */
@Composable
private fun KeptTab(shown: Boolean, content: @Composable () -> Unit) {
    Box(
        Modifier.fillMaxSize().layout { measurable, constraints ->
            val placeable = measurable.measure(constraints)
            layout(placeable.width, placeable.height) { if (shown) placeable.place(0, 0) }
        },
    ) { content() }
}

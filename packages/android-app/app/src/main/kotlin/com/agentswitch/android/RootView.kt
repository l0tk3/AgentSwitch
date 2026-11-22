package com.agentswitch.android

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import com.agentswitch.android.browser.LinkedPage
import com.agentswitch.android.browser.rememberOpenLink
import com.agentswitch.android.components.LocalOpenLink
import com.agentswitch.android.design.AgentSwitchTheme
import com.agentswitch.android.design.PixelBoxHost
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.reduceMotion
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import com.agentswitch.android.onboarding.AddMacSheet
import com.agentswitch.android.onboarding.OnboardingView
import com.agentswitch.android.onboarding.PairConfirmView
import com.agentswitch.android.platform.AppLock
import com.agentswitch.android.platform.LockView

/**
 * Onboarding until a Mac is paired, then the tabs; the pages and sheets over them; the floating boxes over everything.
 * Drawn in the look kept in the settings (docs/ui-v0.md §8), and again when it changes.
 */
@Composable
fun RootView(model: AppModel, settings: AppSettings) {
    val nav = remember { Nav() }
    AgentSwitchTheme(settings.look) {
        // The lock (Settings › Security): locked, the app's views are not in the composition at all, so no sheet, box or
        // pushed page can stay on top of it. It locks when the app goes behind.
        val lock = remember { AppLock.of(settings) }
        LifecycleEventEffect(Lifecycle.Event.ON_STOP) { lock.lockIfEnabled() }
        if (lock.locked) { LockView(lock); return@AgentSwitchTheme }
        // Only web links open from model output (Markdown's inline parser also drops other schemes): an agentswitch://
        // link in a result must not start pairing with a Mac someone else chose. They open in the Mac's shared browser,
        // the page over where the link was (browser-v0 §1 入口; LinkOpener); without it, in the phone's browser.
        CompositionLocalProvider(LocalAppModel provides model, LocalSettings provides settings, LocalNav provides nav, LocalOpenLink provides rememberOpenLink(model)) {
            PixelBoxHost {
                Box(Modifier.fillMaxSize().background(Theme.base)) {
                    if (model.isPaired) MainTabs() else OnboardingView()
                    Pages(nav)
                    // A tapped link's page, over where the link was (LinkOpener).
                    model.linkedPage?.let { tab -> key(tab.id) { LinkedPage(tab) } }
                }
            }
            // A pairing link from a tap or a scan: who it says it is, before anything is sent.
            val link = model.incomingPairingLink
            LaunchedEffect(link) {
                if (link != null) nav.present("pair") { PairConfirmView(link) }
            }
            LaunchedEffect(model.addingMac) {
                if (model.addingMac) nav.present("addmac") { AddMacSheet() }
            }
            BackHandler(enabled = !nav.isEmpty) { nav.pop() }
        }
    }
}

/** The pages and sheets over the tabs, each coming in from its side and going out the way it came. */
@Composable
private fun Pages(nav: Nav) {
    val still = reduceMotion()
    for (entry in nav.stack.toList()) {
        key(entry) {
            val spec = if (still) snap() else tween<androidx.compose.ui.unit.IntOffset>(220)
            AnimatedVisibility(
                visibleState = entry.visible,
                enter = if (entry.sheet) slideInVertically(spec) { it } else slideInHorizontally(spec) { it },
                exit = if (entry.sheet) slideOutVertically(spec) { it } else slideOutHorizontally(spec) { it },
            ) {
                // A page takes every touch on it: nothing under it is tapped through its gaps.
                Box(Modifier.fillMaxSize().background(Theme.base).clickable(remember { MutableInteractionSource() }, null) { }) {
                    entry.content()
                }
            }
            LaunchedEffect(entry.visible.currentState, entry.visible.targetState) { nav.settled(entry) }
        }
    }
}

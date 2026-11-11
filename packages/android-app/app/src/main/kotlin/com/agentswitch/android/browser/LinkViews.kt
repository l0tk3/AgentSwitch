package com.agentswitch.android.browser

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.unit.dp
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import com.agentswitch.android.AppModel
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.design.PixelBox
import com.agentswitch.android.design.PixelBoxEffect
import com.agentswitch.android.design.Theme
import com.agentswitch.kit.api.BrowserTabInfo
import com.agentswitch.kit.feed.LinkAction
import com.agentswitch.kit.feed.Markdown
import com.agentswitch.kit.feed.TappedLink
import kotlinx.coroutines.launch

// The views of link opening (the iPhone's Links/LinkOpener.swift below the model's half, which is `LinkOpener.kt`): what a
// held link offers, the page of a link tapped outside the Browser tab, and the root's hook that opens a tapped web link.

/** The phone's own browser opens `address` (the Swift's Safari). */
fun openInPhoneBrowser(context: Context, address: String) {
    try {
        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(address)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    } catch (_: Exception) { /* no browser to open it */ }
}

/**
 * What the root does with a link tapped anywhere (RootView.swift's `openURL`): only web links open from model output
 * (an `agentswitch://` link in a result must not start pairing with a Mac someone else chose); they open in the Mac's
 * shared browser, the page over where the link was (LinkOpener); without it, in the phone's browser, with why.
 */
@Composable
fun rememberOpenLink(model: AppModel): (String) -> Unit {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    return remember(model, context) {
        { url: String ->
            if (Markdown.isWebLink(url)) {
                TappedLink.fromAddress(url)?.let { link ->
                    scope.launch { model.open(link, openExternal = { openInPhoneBrowser(context, it) })?.let { model.banner = it } }
                }
            }
        }
    }
}

/**
 * A text's links in a long press's menu (Dispatch's record, a task's result, a session's transcript): each link's
 * actions under its address — one link as a menu headed by it, several as a menu of them, each opening its own. `anchor`
 * is the row it belongs to (window pixels); `onDismiss` is called when the menu is gone.
 */
@Composable
fun LinkMenu(text: String, anchor: Rect, onDismiss: () -> Unit) {
    val model = LocalAppModel.current
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    val scope = rememberCoroutineScope()
    val links = remember(text) { Markdown.links(text) }
    var chosen by remember { mutableStateOf<TappedLink?>(null) }

    fun actions(link: TappedLink): List<PixelBox.Action> = link.actions.map { action ->
        PixelBox.Action(action.label(link)) {
            scope.launch {
                // Copying needs no word here (the menu closing is the answer); a failure is said on the home screen.
                val said = model.perform(action, link, copy = { clipboard.setText(AnnotatedString(it)) }, openExternal = { openInPhoneBrowser(context, it) })
                if (said != null && action != LinkAction.Copy) model.banner = said
            }
        }
    }

    val single = links.singleOrNull()
    PixelBoxEffect(if (single != null) single else null, onDismiss = onDismiss) { link ->
        PixelBox(head = link.display, cancel = null, anchor = anchor, width = 260.dp, actions = actions(link))
    }
    if (links.size > 1) {
        PixelBoxEffect(if (chosen == null) links else null, onDismiss = { if (chosen == null) onDismiss() }) { all ->
            PixelBox(cancel = null, anchor = anchor, width = 260.dp, actions = all.map { link -> PixelBox.Action(link.display) { chosen = link } })
        }
        PixelBoxEffect(chosen, onDismiss = { chosen = null; onDismiss() }) { link ->
            PixelBox(head = link.display, cancel = null, anchor = anchor, width = 260.dp, actions = actions(link))
        }
    }
}

/**
 * A long press on a text with links offers them (a text without any keeps its own long press: selecting): `onMenu` is
 * given where the view is, for [LinkMenu].
 */
@OptIn(ExperimentalFoundationApi::class)
fun Modifier.linkMenu(text: String, onMenu: (Rect) -> Unit): Modifier = composed {
    if (Markdown.links(text).isEmpty()) return@composed this
    var bounds by remember { mutableStateOf(Rect.Zero) }
    this.onGloballyPositioned { bounds = it.boundsInRoot() }.combinedClickable(onClick = {}, onLongClick = { onMenu(bounds) })
}

/**
 * A link's page over where the link was: the tab's page as the Browser tab shows it, with `Done` where its way back
 * would be. Closing the tab from its menu closes this too; `Done` leaves the tab open on the Browser tab. Shown by the
 * root over everything while `model.linkedPage` is set.
 */
@Composable
fun LinkedPage(tab: BrowserTabInfo) {
    val model = LocalAppModel.current
    // The system's back is `Done`.
    BackHandler { model.linkedPage = null }
    // A page takes every touch on it: nothing under it is tapped through its gaps.
    Box(Modifier.fillMaxSize().background(Theme.base).clickable(remember { MutableInteractionSource() }, null) { }) {
        BrowserPage(tab, linked = true)
    }
}

package com.agentswitch.android.browser

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.demo.LocalDemo
import com.agentswitch.android.design.BarWord
import com.agentswitch.android.design.BrailleSpinner
import com.agentswitch.android.design.NavBar
import com.agentswitch.android.design.PixelSprite
import com.agentswitch.android.design.PlainField
import com.agentswitch.android.design.SectionLabel
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.framed
import com.agentswitch.android.design.glitch
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.android.rememberBack
import com.agentswitch.android.terminals.LookGlyph
import com.agentswitch.android.terminals.LookSymbol
import com.agentswitch.kit.api.BrowserTabInfo
import com.agentswitch.kit.api.BrowserTarget
import com.agentswitch.kit.api.MacPath
import com.agentswitch.kit.api.openBrowserTab
import com.agentswitch.kit.browser.BrowserAddress
import com.agentswitch.kit.design.PixelArt
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * `New` in the Browser tab (docs/browser-v0.md §1): the address — a URL, a path of the Mac's (`~/x/index.html`) or a
 * local server (`localhost:5173`, or its port alone) — then what was opened from this phone before and the servers
 * listening on the Mac (read afresh as the sheet opens). The Mac checks every address (its own data, credentials and
 * ports are refused, with why); the tab opens on the Mac and its page here (`opened`).
 */
@Composable
fun NewBrowserTabSheet(opened: (BrowserTabInfo) -> Unit) {
    val model = LocalAppModel.current
    val back = rememberBack()
    val store = model.browser
    val scope = rememberCoroutineScope()
    var address by remember { mutableStateOf("") }
    var opening by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val focus = remember { FocusRequester() }
    val demo = LocalDemo.current

    LaunchedEffect(Unit) { store.refreshServers(model.browserAPI) }
    // The sample screens do not bring the keyboard up (the iPhone's `uiDemo` check).
    LaunchedEffect(Unit) { if (!demo) focus.requestFocus() }

    /** Opens it on the Mac; a refusal or a missing file stays here with the Mac's reason. */
    fun open(target: BrowserTarget?, typed: String?) {
        val api = model.browserAPI
        if (target == null || api == null || opening) return
        opening = true
        scope.launch {
            try {
                val tab = api.openBrowserTab(target)
                if (typed != null) store.remember(typed)
                back()
                opened(tab)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = e.message ?: e.javaClass.simpleName
            } finally {
                opening = false
            }
        }
    }
    val typedTarget = BrowserAddress.target(address)

    Column(Modifier.fillMaxSize().background(Theme.base).imePadding()) {
        NavBar(
            "New Tab",
            leading = { BarWord("Cancel", back) },
            trailing = { BarWord("Open", { open(typedTarget, address) }, enabled = typedTarget != null && !opening) },
        )
        Column(
            Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).navigationBarsPadding().padding(Theme.Space.l),
            verticalArrangement = Arrangement.spacedBy(Theme.Space.xl),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(Theme.Space.s)) {
                SectionLabel("Address")
                Row(
                    Modifier.fillMaxWidth().framed(Theme.line, Theme.Radius.control).padding(horizontal = 12.dp, vertical = 10.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("❯", color = Theme.signal, style = mono(14))
                    PlainField(
                        address, { address = it }, Modifier.weight(1f).focusRequester(focus),
                        placeholder = "网址、Mac 上的路径或 localhost:5173", style = mono(14),
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go),
                        keyboardActions = KeyboardActions(onGo = { open(typedTarget, address) }),
                    )
                    if (opening) BrailleSpinner(color = Theme.secondaryInk)
                }
                error?.let { Text(it, Modifier.glitch(it, onAppear = true), color = Theme.failed, style = plain(13)) }
            }
            if (store.recent.isNotEmpty()) {
                Column {
                    SectionLabel("Recent", Modifier.padding(bottom = 4.dp))
                    for (typed in store.recent) {
                        Choice(opening, { open(BrowserAddress.target(typed), typed) }) {
                            Text(typed, color = Theme.ink, style = mono(13), maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
                        }
                    }
                }
            }
            Column {
                SectionLabel("Local Servers on ${model.profile?.name ?: "Mac"}", Modifier.padding(bottom = 4.dp))
                if (store.servers.isEmpty()) Text("Mac 上没有正在监听的本地服务。", Modifier.padding(vertical = 6.dp), color = Theme.secondaryInk, style = plain(13))
                for (server in store.servers) {
                    Choice(opening, { open(BrowserTarget.Port(server.port), null) }) {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            PixelSprite(PixelArt.square, pixel = 2.dp, color = Theme.done)
                            Text("localhost:${server.port}", color = Theme.ink, style = mono(13), maxLines = 1)
                            Text(
                                listOf(server.name, MacPath.tilde(server.cwd)).filter { it.isNotEmpty() }.joinToString(" · "),
                                Modifier.weight(1f, fill = false), color = Theme.secondaryInk, style = mono(11), maxLines = 1, overflow = TextOverflow.MiddleEllipsis,
                            )
                        }
                    }
                }
            }
        }
    }
}

/** One line to pick: its label, and `›` at the end. */
@Composable
private fun Choice(disabled: Boolean, onClick: () -> Unit, label: @Composable () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(enabled = !disabled, role = Role.Button, onClick = onClick).padding(vertical = 9.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) { label() }
        LookGlyph("›", LookSymbol.ChevronRight, color = Theme.inkDim)
    }
}

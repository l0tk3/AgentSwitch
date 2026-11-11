package com.agentswitch.android.browser

import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.pulltorefresh.PullToRefreshDefaults
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentswitch.android.AppModel
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.LocalNav
import com.agentswitch.android.Nav
import com.agentswitch.android.design.BarWord
import com.agentswitch.android.design.BrailleSpinner
import com.agentswitch.android.design.HairRule
import com.agentswitch.android.design.LocalLook
import com.agentswitch.android.design.NavBar
import com.agentswitch.android.design.PixelBox
import com.agentswitch.android.design.PixelBoxEffect
import com.agentswitch.android.design.PixelSprite
import com.agentswitch.android.design.Scanlines
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.glitch
import com.agentswitch.android.design.labelWord
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.android.design.runningGlitch
import com.agentswitch.android.design.waitingBlink
import com.agentswitch.android.onboarding.MacTabSubtitle
import com.agentswitch.android.terminals.ConnectionBanner
import com.agentswitch.android.terminals.LookGlyph
import com.agentswitch.android.terminals.LookSymbol
import com.agentswitch.android.design.ClassicWaitingDot
import com.agentswitch.kit.api.BrowserLocalServer
import com.agentswitch.kit.api.BrowserPlaceKind
import com.agentswitch.kit.api.BrowserTabInfo
import com.agentswitch.kit.api.BrowserTabOwner
import com.agentswitch.kit.api.BrowserTabStatus
import com.agentswitch.kit.api.BrowserTarget
import com.agentswitch.kit.api.MacPath
import com.agentswitch.kit.api.closeBrowserTab
import com.agentswitch.kit.api.openBrowserTab
import com.agentswitch.kit.design.PixelArt
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

// The Browser tab (docs/browser-v0.md §1, demo page `docs/design/implemented/browser.html`): the tabs of the browser on
// the Mac grouped by who holds them — terminals' agents (`// codex · AgentSwitch`), dispatched tasks (their title), then
// yours (`// You`). Each row: the status (the spinner while an agent works on it, a blinking amber square while it waits
// for you, with why; hollow when idle), the title and where it is. A tap opens it; a long press opens its menu, a swipe
// to the left closes it. Under them the servers listening on the Mac. `New` opens a new tab.
//
// What differs from the iPhone: a swipe left on a row reveals `Close Tab` as the list's trailing swipe action does (a
// full swipe closes); the page of a tab is a page over the tabs (`Nav`), not a push in the tab's own stack; no haptics.

/** What the tab keeps (the iPhone's `@State`s) and does. */
@Stable
private class BrowserTabState(val model: AppModel, val nav: Nav) {
    var creating by mutableStateOf(false)
    var menu by mutableStateOf<RowMenu?>(null)
    var closing by mutableStateOf<BrowserTabInfo?>(null)
    var opening by mutableStateOf<Int?>(null)

    /** Why closing or opening failed: a box over whatever is open. */
    var failure by mutableStateOf<String?>(null)
    val scope get() = model.scope

    fun push(tab: BrowserTabInfo) = nav.push("browser/${tab.id}") { BrowserPage(tab) }

    fun newTab() {
        nav.present("newbrowsertab") {
            NewBrowserTabSheet { tab ->
                model.browser.add(tab)
                push(tab)
            }
        }
    }

    fun askToClose(tab: BrowserTabInfo) {
        if (tab.owner.isAgent) closing = tab else scope.launch { close(tab) }
    }

    suspend fun close(tab: BrowserTabInfo) {
        val api = model.browserAPI ?: return
        try {
            api.closeBrowserTab(tab.id)
            model.browser.remove(tab.id)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            failure = e.message ?: e.javaClass.simpleName
        }
    }

    suspend fun openServer(server: BrowserLocalServer) {
        val api = model.browserAPI ?: return
        opening = server.port
        try {
            val tab = api.openBrowserTab(BrowserTarget.Port(server.port))
            model.browser.add(tab)
            push(tab)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            failure = e.message ?: e.javaClass.simpleName
        } finally {
            opening = null
        }
    }

    /** `new`, or a tab (a demo screen, later a notification) in place of the page open now. */
    fun openRequested() {
        val id = model.openBrowserRequest ?: return
        if (id == "new") {
            model.openBrowserRequest = null
            newTab()
            return
        }
        val list = model.browser.list ?: return
        model.openBrowserRequest = null
        list.tabs.firstOrNull { it.id == id }?.let { push(it) }
    }
}

/** A menu opened by a long press: the tab and where its row is (window pixels). */
@Stable
private class RowMenu(val tab: BrowserTabInfo, val anchor: Rect)

/** The Mac's browser tabs by holder, its local servers, a new tab; a tab opens its page. A tab's root. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BrowserTab() {
    val model = LocalAppModel.current
    val nav = LocalNav.current
    val classic = LocalLook.current.isClassic
    val store = model.browser
    val state = remember(model) { BrowserTabState(model, nav) }
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    var refreshing by remember { mutableStateOf(false) }
    val pullState = rememberPullToRefreshState()

    // The list itself is read from every tab (MainTabs). The servers once as the tab comes on screen (and on pulling
    // down, and in `New`): listing them runs `lsof` on the Mac, not worth a timer.
    LaunchedEffect(model.connection.endpoint) {
        store.refreshBrowsers(model.api)
        store.refreshServers(model.browserAPI)
    }
    // A tab to open: once the list is there, and when the request comes.
    LaunchedEffect(model.openBrowserRequest, store.list == null) { state.openRequested() }

    PixelBoxEffect(state.menu, onDismiss = { state.menu = null }) { m ->
        PixelBox(
            cancel = null, anchor = m.anchor,
            actions = listOf(
                PixelBox.Action("Copy URL") { clipboard.setText(AnnotatedString(m.tab.url)) },
                PixelBox.Action("Close Tab", PixelBox.Action.Role.Destructive) { state.askToClose(m.tab) },
            ),
        )
    }
    PixelBoxEffect(state.closing, onDismiss = { state.closing = null }) { tab ->
        PixelBox(
            head = "Close Tab", tone = PixelBox.Tone.Red,
            message = "关闭「${tab.displayTitle}」？${tab.owner.label} 正在使用此标签，关闭后它对此标签的操作将失败。",
            actions = listOf(PixelBox.Action("Close", PixelBox.Action.Role.Primary) { state.scope.launch { state.close(tab) } }),
        )
    }
    PixelBoxEffect(state.failure, onDismiss = { state.failure = null }) { message ->
        PixelBox(head = "Error", tone = PixelBox.Tone.Red, message = message, cancel = null, actions = listOf(PixelBox.Action("OK", PixelBox.Action.Role.Primary) {}))
    }

    Column(Modifier.fillMaxSize().background(Theme.base)) {
        NavBar(
            "Browser",
            subtitle = { MacTabSubtitle() },
            mark = { PixelSprite(PixelArt.globe, pixel = 1.dp, color = Theme.ink, strength = 1f, shadow = false, cell = 1.0) },
            trailing = {
                val enabled = model.api != null && !store.unsupported
                if (classic) PlusButton(enabled) { state.newTab() } else BarWord("New", { state.newTab() }, enabled = enabled)
            },
        )
        Box(Modifier.weight(1f).fillMaxWidth()) {
            Scanlines(Modifier.fillMaxSize())
            PullToRefreshBox(
                isRefreshing = refreshing,
                onRefresh = {
                    scope.launch {
                        refreshing = true
                        try {
                            store.refreshBrowsers(model.api)
                            store.refreshList(model.browserAPI)
                            store.refreshServers(model.browserAPI)
                        } finally { refreshing = false }
                    }
                },
                modifier = Modifier.fillMaxSize(),
                state = pullState,
                indicator = { PullToRefreshDefaults.Indicator(pullState, refreshing, Modifier.align(Alignment.TopCenter), containerColor = Theme.raised, color = Theme.signal) },
            ) {
                LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(horizontal = Theme.Space.l)) {
                    if (model.connection.endpoint == null) item(key = "banner") { ConnectionBanner(Modifier.padding(top = Theme.Space.m)) }
                    if (store.unsupported) {
                        item(key = "unsupported") {
                            Text("此 Mac 上的 AgentSwitch 未提供浏览器：版本过旧，或浏览器已关闭。", Modifier.padding(top = Theme.Space.m), color = Theme.secondaryInk, style = plain(13))
                        }
                    } else store.error?.let { item(key = "error") { Text(it, Modifier.padding(top = Theme.Space.m), color = Theme.failed, style = plain(13)) } }
                    // Which browser the list is of, when the Mac has more than the shared one (docs/profiles-v0.md §5.4).
                    if (store.browsers.size > 1) item(key = "chooser") { Chooser(model) }
                    if (store.list != null && store.tabs.isEmpty()) {
                        item(key = "empty") { Text("还没有打开的标签。", Modifier.padding(vertical = 24.dp), color = Theme.secondaryInk, style = plain(13)) }
                    }
                    for (group in store.list?.groups ?: emptyList()) {
                        item(key = "g:${group.id}") { GroupLabel(group.owner, model) }
                        items(group.tabs, key = { "t:${it.id}" }) { tab ->
                            SwipeToClose(onClose = { state.askToClose(tab) }) {
                                TabRow(tab, model, open = { state.push(tab) }, menu = { anchor -> state.menu = RowMenu(tab, anchor) })
                            }
                        }
                    }
                    if (store.servers.isNotEmpty()) {
                        item(key = "servers") {
                            Column {
                                HairRule(Modifier.padding(top = Theme.Space.l))
                                GroupWords("Local Servers on ${model.profile?.name ?: "Mac"}", Modifier.padding(top = Theme.Space.m, bottom = 4.dp))
                            }
                        }
                        items(store.servers, key = { "s:${it.port}" }) { server ->
                            ServerRow(server, opening = state.opening == server.port, enabled = state.opening == null) { state.scope.launch { state.openServer(server) } }
                        }
                    }
                }
            }
        }
    }
}

/** `+` in the bar (the classic look's `New`). */
@Composable
private fun PlusButton(enabled: Boolean, onClick: () -> Unit) {
    Box(
        Modifier.clickable(enabled, role = Role.Button, onClickLabel = "New Tab", onClick = onClick).padding(horizontal = 12.dp, vertical = 10.dp),
        contentAlignment = Alignment.Center,
    ) { Text("+", color = if (enabled) Theme.signal else Theme.inkDim, style = plain(26, FontWeight.Light)) }
}

/** The browsers there are, the one shown marked: a tap shows another's tabs. */
@Composable
private fun Chooser(model: AppModel) {
    val store = model.browser
    val scope = rememberCoroutineScope()
    Column(Modifier.padding(top = Theme.Space.s)) {
        for (choice in store.browsers) {
            val selected = choice.key == store.key
            Row(
                Modifier.fillMaxWidth().semantics { stateDescription = if (selected) "selected" else "" }
                    .clickable(role = Role.Button) {
                        store.show(choice.key)
                        scope.launch { store.refreshList(model.browserAPI) }
                    }.padding(vertical = 9.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(if (selected) "■" else "□", Modifier.width(14.dp), color = if (selected) Theme.signal else Theme.secondaryInk, style = mono(11))
                Text(
                    choice.name, Modifier.weight(1f, fill = false), color = if (selected) Theme.ink else Theme.secondaryInk,
                    style = plain(15, if (selected) FontWeight.SemiBold else FontWeight.Normal), maxLines = 1,
                )
                Spacer(Modifier.weight(1f))
                choice.exit?.let { Text(it.text, color = Theme.secondaryInk, style = mono(11), maxLines = 1, overflow = TextOverflow.Ellipsis) }
            }
        }
        HairRule()
    }
}

/** `// codex · AgentSwitch` with the agent's mark, `// 登录财务平台下载对账单`, `// You`. */
@Composable
private fun GroupLabel(owner: BrowserTabOwner, model: AppModel) {
    Row(Modifier.padding(top = Theme.Space.l, bottom = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        val rows = if (owner.isAgent) model.harness(owner)?.let { PixelArt.agents[it] } else null
        if (rows != null) PixelSprite(rows, pixel = 2.dp, color = Theme.secondaryInk, strength = 0.8f, shadow = false)
        GroupWords(owner.label)
    }
}

/** `// label`, close-set; a plain small heading in the classic look. */
@Composable
private fun GroupWords(text: String, modifier: Modifier = Modifier) {
    val classic = LocalLook.current.isClassic
    Text(
        labelWord(text), modifier, color = Theme.secondaryInk, maxLines = 1,
        style = mono(if (classic) 13 else 11, if (classic) FontWeight.SemiBold else FontWeight.Normal).copy(letterSpacing = if (classic) 0.sp else 0.4.sp),
    )
}

/** A swipe to the left shows `Close Tab`; far enough, it closes (the list's trailing swipe action with a full swipe). */
@Composable
private fun SwipeToClose(onClose: () -> Unit, content: @Composable () -> Unit) {
    val scope = rememberCoroutineScope()
    val density = LocalDensity.current.density
    val offset = remember { Animatable(0f) }
    val reveal = 88 * density
    Box(Modifier.fillMaxWidth()) {
        if (offset.value < -1f) Box(Modifier.matchParentSize().background(Theme.failed), contentAlignment = Alignment.CenterEnd) {
            Text("Close Tab", Modifier.padding(end = 12.dp), color = Theme.base, style = mono(11, FontWeight.SemiBold), maxLines = 1)
        }
        Box(
            Modifier.offset { IntOffset(offset.value.roundToInt(), 0) }.background(Theme.base).pointerInput(Unit) {
                detectHorizontalDragGestures(
                    onDragEnd = {
                        scope.launch {
                            if (offset.value < -reveal * 1.6f) onClose()
                            offset.animateTo(0f)
                        }
                    },
                    onDragCancel = { scope.launch { offset.animateTo(0f) } },
                ) { change, drag ->
                    change.consume()
                    scope.launch { offset.snapTo((offset.value + drag).coerceIn(-reveal * 2.2f, 0f)) }
                }
            },
        ) { content() }
    }
}

/**
 * A tab's state in pixels: the spinner while an agent works on it, a blinking amber square while it waits for you,
 * hollow when idle.
 */
@Composable
fun BrowserStatusMark(status: BrowserTabStatus) {
    when (status) {
        BrowserTabStatus.Busy -> BrailleSpinner()
        BrowserTabStatus.Waiting ->
            if (LocalLook.current.isClassic) ClassicWaitingDot() else PixelSprite(PixelArt.square, pixel = 2.dp, color = Theme.waiting, modifier = Modifier.waitingBlink())
        else -> PixelSprite(PixelArt.hollow, pixel = 2.dp, color = Theme.inkDim)
    }
}

/**
 * One tab: its status, its title, and where it is (why it waits first, in amber). A tap opens it; a long press lights
 * the row and opens its menu by it.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun TabRow(tab: BrowserTabInfo, model: AppModel, open: () -> Unit, menu: (Rect) -> Unit) {
    val source = remember { MutableInteractionSource() }
    val held = source.collectIsPressedAsState().value
    var bounds by remember { mutableStateOf(Rect.Zero) }
    val site = if (tab.kind == BrowserPlaceKind.Blank) "about:blank" else tab.site
    val place = buildAnnotatedString {
        tab.waitingReason?.let { withStyle(SpanStyle(color = Theme.waiting)) { append("$it · ") } }
        append(site)
    }
    Row(
        Modifier.fillMaxWidth()
            .runningGlitch(tab.status == BrowserTabStatus.Busy)
            .glitch(tab.status, whenChanged = { it == BrowserTabStatus.Waiting })
            .background(if (held) Theme.raised else Color.Transparent)
            .onGloballyPositioned { bounds = it.boundsInRoot() }
            .combinedClickable(source, null, role = Role.Button, onClick = open, onLongClick = { menu(bounds) })
            .padding(vertical = 7.dp, horizontal = 4.dp)
            .semantics(mergeDescendants = true) { stateDescription = tab.status.label },
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(Modifier.width(12.dp).padding(top = 4.dp)) { BrowserStatusMark(tab.status) }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(tab.displayTitle, color = Theme.ink, style = plain(15, FontWeight.SemiBold), maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(place, color = Theme.secondaryInk, style = mono(11), maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
        }
        Box(Modifier.padding(top = 2.dp)) { LookGlyph("›", LookSymbol.ChevronRight, color = Theme.inkDim) }
    }
}

/** `■ localhost:5173 · vite · ~/Projects/site`. */
@Composable
private fun ServerRow(server: BrowserLocalServer, opening: Boolean, enabled: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(enabled = enabled, role = Role.Button, onClickLabel = "在新标签中打开", onClick = onClick).padding(vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        if (opening) BrailleSpinner(color = Theme.secondaryInk) else PixelSprite(PixelArt.square, pixel = 2.dp, color = Theme.done)
        Text(
            listOf("localhost:${server.port}", server.name, MacPath.tilde(server.cwd)).filter { it.isNotEmpty() }.joinToString(" · "),
            Modifier.weight(1f), color = Theme.secondaryInk, style = mono(11), maxLines = 1, overflow = TextOverflow.MiddleEllipsis,
        )
    }
}

/** The agent's name as people call it (`Codex`, `Claude Code`), else the owner's label. */
fun AppModel.agentName(owner: BrowserTabOwner): String = owner.agentName(harness(owner))

/** The agent behind a tab: its terminal's or its task's, else as its label names it. */
fun AppModel.harness(owner: BrowserTabOwner): String? = when (owner.kind) {
    BrowserTabOwner.Kind.Terminal -> terminals.terminals.firstOrNull { it.id == owner.id }?.harness ?: owner.namedHarness
    BrowserTabOwner.Kind.Task -> dispatch.tasks.firstOrNull { it.id == owner.id }?.harness ?: owner.namedHarness
    else -> owner.namedHarness
}

package com.agentswitch.android.browser

import com.agentswitch.android.settings.CiphertextsView
import com.agentswitch.android.settings.CiphertextPicker
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.LocalNav
import com.agentswitch.android.LocalSettings
import com.agentswitch.android.demo.LocalDemo
import com.agentswitch.android.demo.LocalDemoScreen
import com.agentswitch.android.design.BarBack
import com.agentswitch.android.design.BarWord
import com.agentswitch.android.design.BrailleSpinner
import com.agentswitch.android.design.Checker
import com.agentswitch.android.design.DitherShadow
import com.agentswitch.android.design.HairRule
import com.agentswitch.android.design.LocalLook
import com.agentswitch.android.design.PixelBox
import com.agentswitch.android.design.PixelBoxEffect
import com.agentswitch.android.design.PixelSprite
import com.agentswitch.android.design.PlainField
import com.agentswitch.android.design.SquareButton
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.buttonWord
import com.agentswitch.android.design.framed
import com.agentswitch.android.design.glitch
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.android.design.screenRefresh
import com.agentswitch.android.design.waitingBlink
import com.agentswitch.android.platform.PhoneScreen
import com.agentswitch.android.terminals.KeyCap
import com.agentswitch.android.terminals.KeyCapBox
import com.agentswitch.kit.api.BrowserClosedReason
import com.agentswitch.kit.api.BrowserKey
import com.agentswitch.kit.api.BrowserHistoryAction
import com.agentswitch.kit.api.BrowserPlaceKind
import com.agentswitch.kit.api.BrowserStreamOptions
import com.agentswitch.kit.api.BrowserTabInfo
import com.agentswitch.kit.api.BrowserTabStatus
import com.agentswitch.kit.browser.BrowserAddress
import com.agentswitch.kit.browser.BrowserPageZoom
import com.agentswitch.kit.browser.BrowserStreamPolicy
import com.agentswitch.kit.browser.Size
import com.agentswitch.kit.design.PixelArt
import com.agentswitch.kit.api.MacPath
import com.agentswitch.kit.live.ShadedSprite
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * One tab on the phone (docs/browser-v0.md §1, demo page `docs/design/implemented/browser.html`; the iPhone's
 * `BrowserPage`): the address on top (the lock and the place; tap to edit) with `⋯` (Copy URL, Reload, Close Tab); under
 * it who holds the tab — the agent and what it is doing, or `You`; the live picture, the agent's last action outlined
 * on it; the bar at the bottom — `‹ › ↻`, the keyboard, the zoom (`100%`), and on an agent's tab `[ Take Over ]` / `[
 * Hand Back ]`. Typing brings the system keyboard and the key bar (`esc tab ⏎ ⌫ ← →`, as the terminal page's caps, and
 * on your own tabs `⚿ Fill Ciphertext`); the zoom key opens the zoom row in its place (`− 100% +`, BrowserZoomBar).
 *
 * `linked`: the page of a link tapped outside the Browser tab (`LinkedPage`): `Done` leads the bar in place of the way
 * back.
 *
 * What differs from the iPhone: the keyboard resizes the page (`imePadding`) and the picture area with it (the model
 * lifts the picture); `Reload` is left out of `⋯` while the tab cannot be driven rather than shown dim (a menu row has
 * no dim state); the Swift page has no upload, and neither has this; no haptics.
 */
@Composable
fun BrowserPage(tab: BrowserTabInfo, linked: Boolean = false) {
    val model = LocalAppModel.current
    val nav = LocalNav.current
    val settings = LocalSettings.current
    val context = LocalContext.current
    val density = LocalDensity.current.density
    val scope = rememberCoroutineScope()
    val demo = LocalDemo.current
    val demoScreen = if (demo) LocalDemoScreen.current else null
    val clipboard = LocalClipboardManager.current
    val store = model.browser
    val page = remember(tab.id) { BrowserPageModel(tab, PhoneScreen.id(settings), scope) }

    var editing by remember { mutableStateOf(false) }
    var address by remember { mutableStateOf("") }
    var composing by remember { mutableStateOf("") }
    var confirmClose by remember { mutableStateOf(false) }
    /** On screen (another tab of the app hides it without leaving it): only then does coming back to the app restart the stream. */
    var visible by remember { mutableStateOf(false) }
    /** The zoom row is open over the bar (browser-v0 §1 页面缩放, 2026-10-03): never together with the key bar, closed when the page is left. */
    var zooming by remember { mutableStateOf(false) }
    /** The link's speed the picture was last asked by (Tailscale; null: not measured, or it told nothing): a new zoom asks again by the same. */
    var mbps by remember { mutableStateOf<Double?>(null) }
    var menuAnchor by remember { mutableStateOf<Rect?>(null) }

    fun leave() { if (linked) model.linkedPage = null else nav.pop() }

    /**
     * What the stream asks for on this link: the local network the screen's device pixels; Tailscale by the speed
     * measured (browser-v0 §1 iPhone; `mbps` null — not measured yet, or nothing to tell — the slow way); either way
     * times the zoom this phone sets the page at.
     */
    fun streamOptions(speed: Double?): BrowserStreamOptions {
        val m = context.resources.displayMetrics
        return BrowserStreamPolicy.options(
            kind = model.connection.endpoint?.kind, mbps = speed, screenPixels = Size(m.widthPixels.toDouble(), m.heightPixels.toDouble()),
            screenScale = m.density.toDouble(), zoom = page.streamZoom,
        )
    }

    /** Over Tailscale: the link measured (or the measure from the last minute on this address), and the stream asked again when the picture it allows differs. */
    fun measure() {
        val endpoint = model.connection.endpoint
        if (!BrowserStreamPolicy.measures(endpoint?.kind)) return
        scope.launch {
            val measured = store.speed(model.browserAPI, endpoint)
            if (!visible || model.connection.endpoint != endpoint) return@launch
            mbps = measured
            page.retune(streamOptions(measured))
        }
    }

    DisposableEffect(page) {
        visible = true
        page.agentName = model.agentName(page.tab.owner)
        page.store = store
        page.screenScale = density.toDouble()
        page.demoScreen = demoScreen
        val known = store.knownSpeed(model.connection.endpoint)?.mbps
        mbps = known
        page.start(model.browserAPI, streamOptions(known))
        measure()
        onDispose {
            visible = false
            zooming = false
            page.stop()
        }
    }
    // In the background the stream ends and the tab goes back; in front again, the stream comes back.
    LifecycleEventEffect(Lifecycle.Event.ON_STOP) { page.suspend() }
    LifecycleEventEffect(Lifecycle.Event.ON_START) { if (visible) { page.resume(); measure() } }
    LaunchedEffect(page.closed) {
        if (page.closed != null) {
            zooming = false
            store.remove(page.id)
        }
    }
    // The zoom this phone sets the page at changes what the stream asks (a page zoomed in is fewer CSS pixels across the
    // same screen, one zoomed out more): asked again, as after a measure.
    LaunchedEffect(page.streamZoom) { page.retune(streamOptions(mbps)) }
    // The zoom row and the key bar never show together: a keyboard coming up (the page's, the address bar's) closes the row.
    LaunchedEffect(page.typing) { if (page.typing) zooming = false }
    LaunchedEffect(editing) { if (editing) zooming = false }
    // The sample screens that open a box or the zoom row, as a tap would, once the page has come in and its picture is drawn.
    LaunchedEffect(demoScreen) {
        when (demoScreen) {
            "browserclose" -> { delay(1500); confirmClose = true }
            "browserzoom" -> { delay(1500); zooming = true }
            "browserzoomwatch" -> { delay(1500); zooming = true; page.zoomIn(); page.zoomIn() }
        }
    }

    suspend fun close() {
        if (page.close()) {
            store.remove(page.id)
            leave()
        }
    }

    PixelBoxEffect(confirmClose, onDismiss = { confirmClose = false }) {
        PixelBox(
            head = "Close Tab", tone = PixelBox.Tone.Red,
            message = "关闭「${page.tab.displayTitle}」？${page.agentName} 正在使用此标签，关闭后它对此标签的操作将失败。",
            actions = listOf(PixelBox.Action("Close", PixelBox.Action.Role.Primary) { scope.launch { close() } }),
        )
    }
    PixelBoxEffect(menuAnchor, onDismiss = { menuAnchor = null }) { anchor ->
        PixelBox(
            cancel = null, anchor = anchor,
            actions = buildList {
                add(PixelBox.Action("Copy URL") { clipboard.setText(AnnotatedString(page.tab.url)) })
                if (page.canDrive) add(PixelBox.Action("Reload") { scope.launch { page.history(BrowserHistoryAction.Reload) } })
                add(PixelBox.Action("Close Tab", PixelBox.Action.Role.Destructive) {
                    if (page.tab.owner.isAgent) confirmClose = true else scope.launch { close() }
                })
            },
        )
    }
    fun fillCiphertext() {
        if (model.dispatch.ciphertexts.isEmpty()) nav.present("makeCiphertext") { CiphertextsView(sheet = true) }
        else nav.present("fillCiphertext") {
            CiphertextPicker(title = "Fill Ciphertext") { token -> scope.launch { if (!page.fill(token)) store.fillUnavailable = true } }
        }
    }

    Column(Modifier.fillMaxSize().background(Theme.base).imePadding()) {
        PageBar(page, linked, editing, address, onAddress = { address = it },
            onEdit = { editing = it }, onBack = { leave() }, onMore = { menuAnchor = it }, store = store)
        HolderLine(page, model)
        HairRule()
        ScreenArea(page, editing, onTap = { editing = false }, onBack = { leave() }, modifier = Modifier.weight(1f))
        Controls(
            page, store, composing, zooming,
            onComposing = { composing = it },
            onZooming = { zooming = it }, onEditing = { editing = it },
            onFill = { page.typing = false; fillCiphertext() },
        )
    }
}

// MARK: the bar and the address

@Composable
private fun PageBar(
    page: BrowserPageModel, linked: Boolean, editing: Boolean, address: String, onAddress: (String) -> Unit,
    onEdit: (Boolean) -> Unit, onBack: () -> Unit, onMore: (Rect) -> Unit, store: BrowserStore,
) {
    val classic = LocalLook.current.isClassic
    var more by remember { mutableStateOf(Rect.Zero) }
    Column(Modifier.fillMaxWidth().background(Theme.base).windowInsetsPadding(WindowInsets.statusBars)) {
        Row(Modifier.fillMaxWidth().height(48.dp), verticalAlignment = Alignment.CenterVertically) {
            // `Done` alone leads the bar of a link's page; elsewhere the way back is the chevron.
            if (linked) Box(Modifier.padding(start = 4.dp)) { BarWord("Done", onBack) } else Box(Modifier.padding(start = 8.dp)) { BarBack(onBack, "") }
            Box(Modifier.weight(1f).padding(horizontal = 4.dp)) { AddressBar(page, editing, address, onAddress, onEdit, store) }
            Box(
                Modifier.padding(end = 4.dp).size(width = 44.dp, height = 48.dp).onGloballyPositioned { more = it.boundsInRoot() }
                    .clickable(role = Role.Button, onClickLabel = "more") { onMore(more) },
                contentAlignment = Alignment.Center,
            ) {
                if (classic) EllipsisGlyph(Theme.signal) else Text("⋯", color = Theme.ink, style = mono(17))
            }
        }
    }
}

@Composable
private fun AddressBar(page: BrowserPageModel, editing: Boolean, address: String, onAddress: (String) -> Unit, onEdit: (Boolean) -> Unit, store: BrowserStore) {
    val scope = rememberCoroutineScope()
    val shown = BrowserAddress.display(page.tab.url)
    val focus = remember { FocusRequester() }
    var hadFocus by remember { mutableStateOf(false) }
    Box(
        Modifier.fillMaxWidth().defaultMinSize(minHeight = 1.dp).framed(Theme.line, Theme.Radius.control).padding(horizontal = 8.dp, vertical = 5.dp),
    ) {
        if (editing) {
            LaunchedEffect(Unit) { focus.requestFocus() }
            PlainField(
                address, onAddress,
                Modifier.fillMaxWidth().focusRequester(focus).onFocusChanged {
                    if (it.isFocused) hadFocus = true else if (hadFocus) { hadFocus = false; onEdit(false) }
                },
                placeholder = "网址、Mac 上的路径或 localhost:5173", style = mono(13),
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go),
                keyboardActions = KeyboardActions(onGo = {
                    val typed = address
                    onEdit(false)
                    store.remember(typed)
                    scope.launch { page.navigate(typed) }
                }),
            )
        } else {
            Row(
                Modifier.fillMaxWidth().semantics { contentDescription = "地址 ${shown.text}" }.clickable(role = Role.Button) {
                    if (!page.canDrive) return@clickable
                    page.typing = false
                    onAddress(if (page.tab.url == "about:blank") "" else page.tab.url)
                    onEdit(true)
                },
                horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically,
            ) {
                if (page.tab.loading) BrailleSpinner(color = Theme.secondaryInk)
                else if (shown.secure) PixelSprite(PixelArt.lock, pixel = 2.dp, color = Theme.secondaryInk, strength = 0.7f, shadow = false, picture = ShadedSprite.lockSmall)
                Text(shown.text.ifEmpty { "about:blank" }, Modifier.weight(1f), color = Theme.ink, style = mono(12), maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
            }
        }
    }
}

// MARK: who holds it

/** The agent and what it is doing; `You` (taken over from it, at the phone's size); or the screen that has it. */
@Composable
private fun HolderLine(page: BrowserPageModel, model: com.agentswitch.android.AppModel) {
    val tab = page.tab
    val holder = page.heldElsewhere
    Row(
        Modifier.fillMaxWidth().height(26.dp).padding(horizontal = Theme.Space.m)
            .glitch(tab.status, whenChanged = { it == BrowserTabStatus.Waiting }).glitch(tab.heldBy),
        horizontalArrangement = Arrangement.spacedBy(7.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        if (page.mine && tab.owner.isAgent) {
            PixelSprite(PixelArt.square, pixel = 2.dp, color = Theme.signal)
            Text(
                buildAnnotatedString {
                    append("You")
                    withStyle(SpanStyle(color = Theme.secondaryInk)) { append(" · Taken Over from ${page.agentName}") }
                },
                color = Theme.signal, style = mono(11), maxLines = 1,
            )
            Spacer(Modifier.weight(1f))
            if (page.phoneSized) Text("Phone Size", color = Theme.secondaryInk, style = mono(11))
        } else if (holder != null) {
            PixelSprite(PixelArt.square, pixel = 2.dp, color = Theme.inkDim)
            Text(holder.label, color = Theme.secondaryInk, style = mono(11))
            Spacer(Modifier.weight(1f))
            if (tab.owner.isAgent) Text(tab.owner.label, color = Theme.inkDim, style = mono(11), maxLines = 1)
        } else if (tab.owner.isAgent) {
            PixelSprite(PixelArt.agents[model.harness(tab.owner) ?: ""] ?: PixelArt.square, pixel = 2.dp, color = Theme.secondaryInk, strength = 0.8f, shadow = false)
            Text(tab.owner.label, color = Theme.secondaryInk, style = mono(11), maxLines = 1, overflow = TextOverflow.Ellipsis)
            AgentDoing(tab, Modifier.weight(1f))
        } else {
            // Your own tab: this phone's while it is open here (a solid square), or nobody's for now.
            PixelSprite(if (page.mine) PixelArt.square else PixelArt.hollow, pixel = 2.dp, color = if (page.mine) Theme.signal else Theme.inkDim)
            Text("You", color = if (page.mine) Theme.signal else Theme.secondaryInk, style = mono(11))
            Spacer(Modifier.weight(1f))
            Text(placeNote(tab, model), color = Theme.inkDim, style = mono(11), maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
        }
    }
}

@Composable
private fun AgentDoing(tab: BrowserTabInfo, modifier: Modifier) {
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(7.dp, Alignment.End), verticalAlignment = Alignment.CenterVertically) { AgentDoingContent(tab) }
}

@Composable
private fun androidx.compose.foundation.layout.RowScope.AgentDoingContent(tab: BrowserTabInfo) {
    when (tab.status) {
        BrowserTabStatus.Busy -> {
            BrailleSpinner()
            tab.action?.let { Text(it.description.ifEmpty { it.tool }, Modifier.weight(1f, fill = false), color = Theme.secondaryInk, style = mono(11), maxLines = 1, overflow = TextOverflow.Ellipsis) }
        }
        BrowserTabStatus.Waiting -> {
            if (LocalLook.current.isClassic) com.agentswitch.android.design.ClassicWaitingDot() else PixelSprite(PixelArt.square, pixel = 2.dp, color = Theme.waiting, modifier = Modifier.waitingBlink())
            Text(tab.waitingReason ?: "Waiting", Modifier.weight(1f, fill = false), color = Theme.waiting, style = mono(11), maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        else -> Text(tab.status.label, color = Theme.inkDim, style = mono(11))
    }
}

/** Your own tab's line: what is open on the Mac. */
private fun placeNote(tab: BrowserTabInfo, model: com.agentswitch.android.AppModel): String = when (tab.kind) {
    BrowserPlaceKind.File -> "Mac 上的文件"
    BrowserPlaceKind.Local -> {
        val port = tab.site.split(":").lastOrNull()?.toIntOrNull() ?: 0
        val server = model.browser.server(port)
        if (server == null) tab.site else listOf(server.name, MacPath.tilde(server.cwd)).filter { it.isNotEmpty() }.joinToString(" · ")
    }
    BrowserPlaceKind.Web, BrowserPlaceKind.Blank -> ""
}

// MARK: the picture

@Composable
private fun ScreenArea(page: BrowserPageModel, editing: Boolean, onTap: () -> Unit, onBack: () -> Unit, modifier: Modifier = Modifier) {
    val density = LocalDensity.current.density
    Box(
        modifier.fillMaxWidth().clipToBounds().onSizeChanged { page.area = Size(it.width / density.toDouble(), it.height / density.toDouble()) },
        contentAlignment = Alignment.TopCenter,
    ) {
        BrowserScreen(
            picture = page.picture, layout = page.layout, action = page.actionShown,
            onTap = { point -> onTap(); page.tap(point) },
            onLongPress = { page.longPress(it) },
            onDrag = { delta, at -> page.drag(delta, at) },
            onPinch = { scale, at -> page.pinch(scale, at) },
            onPan = { page.pan(it) },
            modifier = Modifier.fillMaxSize().screenRefresh(page.refreshes, Theme.base),
        )
        if (page.frameSize == null && page.closed == null) {
            Row(Modifier.padding(top = 60.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                BrailleSpinner(color = Theme.secondaryInk)
                Text("Connecting", color = Theme.secondaryInk, style = mono(12))
            }
        }
        Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.Top) {
            if (page.connection == BrowserPageModel.Connection.Reconnecting) Chip { BrailleSpinner(color = Theme.secondaryInk); Text("Reconnecting", color = Theme.ink, style = mono(11)) }
            Spacer(Modifier.weight(1f))
            if (page.zoom.isZoomed) {
                Box(Modifier.semantics { contentDescription = "恢复原始大小" }.clickable(role = Role.Button) { page.resetZoom() }) {
                    Chip { Text(page.zoom.times.dropLast(1), color = Theme.ink, style = mono(11)); Text("×", color = Theme.secondaryInk, style = mono(11)) }
                }
            }
        }
        page.closed?.let { ClosedCover(it, onBack) }
    }
}

@Composable
private fun Chip(content: @Composable () -> Unit) {
    Row(
        Modifier.background(Theme.base).framed(Theme.ink, Theme.Radius.card).padding(horizontal = 6.dp, vertical = 2.dp),
        horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically,
    ) { content() }
}

/** The tab is gone (closed elsewhere, the browser quit): why, over the last picture, dithered. */
@Composable
private fun ClosedCover(reason: BrowserClosedReason, onBack: () -> Unit) {
    Box(Modifier.fillMaxSize().background(Theme.base.copy(alpha = 0.5f)).clickable(remember { MutableInteractionSource() }, null) { }, contentAlignment = Alignment.Center) {
        Checker(Modifier.fillMaxSize(), color = Theme.base)
        Box(Modifier.padding(horizontal = 28.dp).glitch(reason, onAppear = true)) {
            DitherShadow(Modifier.matchParentSize().offset(6.dp, 6.dp))
            Column(Modifier.fillMaxWidth().background(Theme.base).framed(Theme.ink, Theme.Radius.card)) {
                Row(
                    Modifier.fillMaxWidth().defaultMinSize(minHeight = 24.dp).background(Theme.ink).padding(horizontal = 10.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically,
                ) {
                    PixelSprite(PixelArt.square, pixel = 2.dp, color = Theme.base)
                    Text("Closed", color = Theme.base, style = mono(12, FontWeight.SemiBold))
                }
                Text(reason.said, Modifier.padding(horizontal = 12.dp).padding(top = 12.dp), color = Theme.ink, style = plain(16))
                Row(Modifier.fillMaxWidth().padding(12.dp), horizontalArrangement = Arrangement.End) {
                    SquareButton("Back", onBack, prominent = true, expand = false)
                }
            }
        }
    }
}

// MARK: the bars

/** What an input needs, as the terminal page's caps (⏎ the one solid key). */
private val keys: List<Pair<BrowserKey, String>> = listOf(
    BrowserKey.Escape to "esc", BrowserKey.Tab to "tab", BrowserKey.Enter to "⏎", BrowserKey.Backspace to "⌫",
    BrowserKey.ArrowLeft to "←", BrowserKey.ArrowRight to "→",
)

@Composable
private fun Controls(
    page: BrowserPageModel, store: BrowserStore, composing: String, zooming: Boolean,
    onComposing: (String) -> Unit, onZooming: (Boolean) -> Unit, onEditing: (Boolean) -> Unit, onFill: () -> Unit,
) {
    Box(Modifier.fillMaxWidth().background(Theme.base)) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding()) {
            val words = page.error ?: page.note
            if (words != null) {
                Row(Modifier.fillMaxWidth().padding(horizontal = Theme.Space.l, vertical = 6.dp).glitch(words, onAppear = true), verticalAlignment = Alignment.CenterVertically) {
                    Text(words, Modifier.weight(1f), color = if (page.error != null) Theme.failed else Theme.secondaryInk, style = plain(13), maxLines = 3, overflow = TextOverflow.Ellipsis)
                    if (page.error != null) {
                        Box(Modifier.size(32.dp).clickable(role = Role.Button, onClickLabel = "close") { page.error = null }, contentAlignment = Alignment.Center) { CrossGlyph(Theme.secondaryInk) }
                    }
                }
            }
            if (page.typing) {
                KeyBar(page, store, composing, onFill)
            } else if (zooming) {
                BrowserZoomBar(
                    page.zoomPercent, page.canZoomOut, page.canZoomIn, pictureOnly = !page.zoomsPage,
                    onOut = { page.zoomOut() }, onReset = { page.zoomToStandard() }, onIn = { page.zoomIn() },
                )
            }
            Box(Modifier.fillMaxWidth().height(1.dp).background(Theme.line))
            BottomBar(page, zooming, onZooming, onEditing)
        }
        BrowserTypingField(
            typing = page.typing, onTyping = { page.typing = it }, onComposing = onComposing,
            onText = { page.type(it) }, onKey = { page.press(it) }, modifier = Modifier.align(Alignment.TopStart),
        )
    }
}

@Composable
private fun KeyBar(page: BrowserPageModel, store: BrowserStore, composing: String, onFill: () -> Unit) {
    // The keyboard goes away from the bar's own key under this one.
    Row(
        Modifier.fillMaxWidth().background(Theme.raised.copy(alpha = 0.5f)).horizontalScroll(rememberScrollState()).padding(horizontal = Theme.Space.m, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        for ((key, label) in keys) KeyCap(label, { page.press(key) }, solid = key == BrowserKey.Enter, compact = true)
        // Your own tabs only: an agent sees its page again after the hand-back (the Mac refuses it there).
        if (!store.fillUnavailable && page.canFill) {
            KeyCapBox(onFill, Modifier.border(1.dp, Theme.signal, RectangleShape).semantics { contentDescription = "从密文填入" }, compact = true) {
                Row(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
                    PixelSprite(PixelArt.lock, pixel = 2.dp, color = Theme.signal, strength = 0.9f, shadow = false, picture = ShadedSprite.lockSmall)
                    Text("Fill Ciphertext", color = Theme.signal, style = mono(12), maxLines = 1)
                }
            }
        }
        if (composing.isNotEmpty()) Text(composing, Modifier.padding(start = 4.dp), color = Theme.secondaryInk, style = mono(13), maxLines = 1)
    }
}

/** `‹ › ↻`, the keyboard, the zoom, and `[ Take Over ]` / `[ Hand Back ]` where the tab is an agent's or another screen's. */
@Composable
private fun BottomBar(page: BrowserPageModel, zooming: Boolean, onZooming: (Boolean) -> Unit, onEditing: (Boolean) -> Unit) {
    val scope = rememberCoroutineScope()
    val tab = page.tab
    val showsHold = tab.owner.isAgent || page.heldElsewhere != null
    // With the hold button the five keys keep a fixed width and it takes the rest — narrow enough to leave it room on a
    // 375 dp phone (52 while there were four); without it they share the bar.
    val fixed = if (showsHold) 46.dp else null
    val tint = if (page.canDrive) Theme.ink else Theme.inkDim
    Row(Modifier.fillMaxWidth().height(46.dp).padding(horizontal = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        BarKey("‹", "back", fixed, page.canDrive, 19) { scope.launch { page.history(BrowserHistoryAction.Back) } }
        BarKey("›", "forward", fixed, page.canDrive, 19) { scope.launch { page.history(BrowserHistoryAction.Forward) } }
        BarKey("↻", "reload", fixed, page.canDrive, 19) { scope.launch { page.history(BrowserHistoryAction.Reload) } }
        Box(
            keySlot(fixed).clickable(enabled = page.canDrive, role = Role.Button, onClickLabel = "keyboard") { onEditing(false); page.typing = !page.typing },
            contentAlignment = Alignment.Center,
        ) { KeyboardGlyph(tint, down = page.typing) }
        val percent = page.zoomPercent
        val closed = page.closed != null
        Box(
            keySlot(fixed).semantics { contentDescription = "缩放 $percent%" }
                .clickable(enabled = !closed, role = Role.Button) { onEditing(false); page.typing = false; onZooming(!zooming) },
            contentAlignment = Alignment.Center,
        ) {
            Text("$percent%", color = if (closed) Theme.inkDim else if (percent == BrowserPageZoom.standard) Theme.ink else Theme.signal, style = mono(12), maxLines = 1)
        }
        if (showsHold) {
            Box(Modifier.weight(1f), contentAlignment = Alignment.Center) {
                val waiting = tab.status == BrowserTabStatus.Waiting && !page.mine
                HoldButton(if (page.mine) "Hand Back" else "Take Over", waiting, enabled = !page.holding && page.closed == null) {
                    scope.launch { if (page.mine) page.handBack() else page.takeOver() }
                }
            }
        }
    }
}

/** A key of the bar: a fixed width where the hold button takes the rest, else its share of the bar. */
@Composable
private fun androidx.compose.foundation.layout.RowScope.keySlot(fixed: androidx.compose.ui.unit.Dp?): Modifier =
    (if (fixed != null) Modifier.width(fixed) else Modifier.weight(1f)).height(44.dp)

@Composable
private fun androidx.compose.foundation.layout.RowScope.BarKey(glyph: String, label: String, fixed: androidx.compose.ui.unit.Dp?, enabled: Boolean, size: Int, onClick: () -> Unit) {
    Box(
        keySlot(fixed).semantics { contentDescription = label }.clickable(enabled = enabled, role = Role.Button, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Text(glyph, color = if (enabled) Theme.ink else Theme.inkDim, style = mono(size), maxLines = 1) }
}

/**
 * `[ Take Over ]` on the bar: ink words, filled while pressed (the demo page's .act); amber while the agent waits for
 * you, as a primary button.
 */
@Composable
private fun HoldButton(word: String, waiting: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val source = remember { MutableInteractionSource() }
    val pressed = source.collectIsPressedAsState().value && enabled
    Text(
        buttonWord(word),
        Modifier.alpha(if (enabled) 1f else 0.45f)
            .background(if (pressed) Theme.signal else if (waiting) Theme.waiting else Color.Transparent)
            .clickable(source, null, enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = 4.dp, vertical = 3.dp),
        color = if (pressed || waiting) Theme.base else Theme.ink,
        style = mono(12, FontWeight.SemiBold).copy(fontSize = 12.5.sp), maxLines = 1, softWrap = false,
    )
}

// MARK: glyphs

/** `keyboard` and `keyboard.chevron.compact.down`: a keyboard's key rows, with a chevron under them while it is up. */
@Composable
private fun KeyboardGlyph(color: Color, down: Boolean) {
    Canvas(Modifier.size(width = 22.dp, height = 18.dp)) {
        val w = 1.4.dp.toPx()
        val body = if (down) 0.62f else 0.9f
        drawRoundRect(color, Offset(w / 2, w / 2), androidx.compose.ui.geometry.Size(size.width - w, size.height * body - w / 2), CornerRadius(2.dp.toPx()), Stroke(w))
        val dot = 1.6.dp.toPx()
        for (r in 0 until 2) for (c in 0 until 5) drawRect(color, Offset(4.dp.toPx() + c * 3.2.dp.toPx(), 3.5.dp.toPx() + r * 3.6.dp.toPx()), androidx.compose.ui.geometry.Size(dot, dot))
        if (!down) {
            drawLine(color, Offset(size.width * 0.3f, size.height * 0.68f), Offset(size.width * 0.7f, size.height * 0.68f), w, StrokeCap.Round)
        } else {
            drawLine(color, Offset(size.width * 0.32f, size.height * 0.82f), Offset(size.width * 0.5f, size.height * 0.98f), w, StrokeCap.Round)
            drawLine(color, Offset(size.width * 0.68f, size.height * 0.82f), Offset(size.width * 0.5f, size.height * 0.98f), w, StrokeCap.Round)
        }
    }
}

@Composable
private fun CrossGlyph(color: Color) {
    if (LocalLook.current.isClassic) {
        Canvas(Modifier.size(9.dp)) {
            val w = 1.8.dp.toPx()
            drawLine(color, Offset(0f, 0f), Offset(size.width, size.height), w, StrokeCap.Round)
            drawLine(color, Offset(size.width, 0f), Offset(0f, size.height), w, StrokeCap.Round)
        }
    } else {
        Text("×", color = color, style = com.agentswitch.android.design.code(15), maxLines = 1)
    }
}

@Composable
private fun EllipsisGlyph(color: Color) {
    Canvas(Modifier.size(24.dp)) {
        val w = 1.5.dp.toPx()
        drawCircle(color, size.minDimension / 2 - w, style = Stroke(w))
        for (i in -1..1) drawCircle(color, 1.5.dp.toPx(), Offset(size.width / 2 + i * 5.dp.toPx(), size.height / 2))
    }
}

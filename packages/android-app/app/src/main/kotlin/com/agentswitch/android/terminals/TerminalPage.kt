package com.agentswitch.android.terminals

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.LocalNav
import com.agentswitch.android.files.MacFilesSheet
import com.agentswitch.kit.api.MacPick
import com.agentswitch.android.LocalSettings
import com.agentswitch.android.design.AgentSwitchTheme
import com.agentswitch.android.design.BarBack
import com.agentswitch.android.design.BrailleSpinner
import com.agentswitch.android.design.ClassicWaitingDot
import com.agentswitch.android.design.DitherShadow
import com.agentswitch.android.design.HairRule
import com.agentswitch.android.design.LocalLook
import com.agentswitch.android.design.PixelBox
import com.agentswitch.android.design.PixelBoxEffect
import com.agentswitch.android.design.PixelSprite
import com.agentswitch.android.design.PlainField
import com.agentswitch.android.design.SquareButton
import com.agentswitch.android.design.SquareIconButton
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.framed
import com.agentswitch.android.design.glitch
import com.agentswitch.android.design.grounded
import com.agentswitch.android.design.lookWord
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.android.design.screenRefresh
import com.agentswitch.android.design.waitingBlink
import com.agentswitch.android.demo.DemoData
import com.agentswitch.android.demo.LocalDemo
import com.agentswitch.android.demo.LocalDemoScreen
import com.agentswitch.android.platform.PhoneScreen
import com.agentswitch.kit.api.TerminalDaybreak
import com.agentswitch.kit.api.TerminalInfo
import com.agentswitch.kit.api.TerminalKey
import com.agentswitch.kit.api.TerminalModelMenu
import com.agentswitch.kit.api.TerminalModelOption
import com.agentswitch.kit.api.TerminalStatus
import com.agentswitch.kit.design.PixelArt
import com.agentswitch.kit.feed.EffortDisplay
import com.agentswitch.kit.feed.LinkAction
import com.agentswitch.kit.feed.ModelName
import com.agentswitch.kit.feed.RecordDisplay
import com.agentswitch.kit.feed.ScreenLink
import com.agentswitch.kit.feed.SlashCommand
import com.agentswitch.kit.feed.TappedLink
import com.agentswitch.kit.feed.TerminalDraft
import com.agentswitch.kit.feed.TerminalTree
import com.agentswitch.kit.files.UploadFile
import com.agentswitch.kit.live.ShadedSprite
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.math.abs

/**
 * One terminal on the phone (docs/terminal-v0.md §1; the iPhone's `TerminalPage`): the live screen (drag to scroll —
 * the wheel notches sent show at its right; pinch for the text size; tap to put the keyboard away; a tap on a link — an
 * address, a path of the Mac's — opens it, a long press on one offers its menu), drawn in top down with a scanline as
 * it comes, permission requests as cards over its top, the key bar and the reply box under it. A reply goes as typed
 * or, from the lock, through the Mac's sealer in the sealed box; `/` lists the agent's commands; keys go by name. The
 * menu renames or closes it (asked first; the record may go too). What needs you — a permission, the exit, an error —
 * glitches once; the questions are pixel boxes. The other view of the same session is its record (the simple view,
 * docs/simple-view-v0.md): its body is another file's (`TerminalRecordView`), the page around it is this one.
 *
 * `terminal` is the terminal as the list had it when the page was opened.
 *
 * What differs from the iPhone: the keyboard resizes the page (`imePadding`), the system pickers bring the `+` menu's
 * camera (a preview-sized picture: no file provider is declared), photos and files; `Files on Mac` waits for the Files
 * tab's own sheet (a path on the screen, and `Show in Files`, go to the Files tab instead); a web link opens in the
 * phone's browser, a Mac file's link in the Files tab; no haptics.
 */
@Composable
fun TerminalPage(terminal: TerminalInfo) {
    val settings = LocalSettings.current
    val look = LocalLook.current
    val demo = LocalDemo.current
    val demoScreen = if (demo) LocalDemoScreen.current else null
    val scope = rememberCoroutineScope()
    val id = terminal.id
    var viewMode by remember(id) { mutableStateOf(TerminalViewMode.saved(settings, id, demoScreen)) }
    val page = remember(id) {
        val size = settings.float("terminal.fontSize", 10f)
        if (demo) TerminalPageModel.demo(terminal, DemoData.terminalScreen(demoScreen), DemoData.slashCommands, scope, size, showsScreen = viewMode == TerminalViewMode.Terminal)
        else TerminalPageModel(terminal, size, viewMode == TerminalViewMode.Terminal, PhoneScreen.id(settings), scope)
    }
    val record = remember(id) { SessionRecordModel(demo = if (demo) { h, sid -> DemoData.sessionRecord(h, sid, demoScreen) } else null) }
    // The page of a terminal is dark in light mode too (docs/ui-v0.md §3b): one theme for the page, whichever mode it is
    // in, so the state under it stays when the mode changes.
    val systemDark = isSystemInDarkTheme()
    // The bars of the phone read light on the terminal's dark ground in light mode too.
    val view = LocalView.current
    val darkPage = viewMode == TerminalViewMode.Terminal
    DisposableEffect(darkPage, systemDark) {
        val window = (view.context as? android.app.Activity)?.window
        val controller = window?.let { WindowCompat.getInsetsController(it, view) }
        val before = controller?.isAppearanceLightStatusBars to controller?.isAppearanceLightNavigationBars
        if (darkPage && controller != null) {
            controller.isAppearanceLightStatusBars = false
            controller.isAppearanceLightNavigationBars = false
        }
        onDispose {
            if (darkPage && controller != null) {
                before.first?.let { controller.isAppearanceLightStatusBars = it }
                before.second?.let { controller.isAppearanceLightNavigationBars = it }
            }
        }
    }
    AgentSwitchTheme(look, dark = if (viewMode == TerminalViewMode.Simple) systemDark else true) {
        PageContent(terminal, page, record, viewMode) { mode ->
            viewMode = mode
            mode.save(settings, id)
            page.show(mode == TerminalViewMode.Terminal)
        }
    }
}

/** A menu to show by its anchor (`PixelBox` as a menu). */
private class PageMenu(val head: String?, val anchor: Rect, val width: Dp = PixelBox.menuWidth, val actions: List<PixelBox.Action>)

/** A held link's menu: the link and where it is (window pixels). */
private class LinkMenu(val hit: ScreenLink, val anchor: Rect)

/** Said over the screen for a moment (`Link Copied`): each saying is its own, even the same words again. */
private class Said(val words: String)

private val keys: List<Pair<TerminalKey, String>> = listOf(
    TerminalKey.Enter to "⏎", TerminalKey.Backspace to "⌫", TerminalKey.Up to "↑", TerminalKey.Down to "↓", TerminalKey.One to "1",
    TerminalKey.Two to "2", TerminalKey.Three to "3", TerminalKey.Y to "y", TerminalKey.N to "n", TerminalKey.Esc to "esc",
    TerminalKey.Tab to "tab", TerminalKey.ShiftTab to "⇧tab", TerminalKey.Left to "←", TerminalKey.Right to "→",
    TerminalKey.PageUp to "pgup", TerminalKey.PageDown to "pgdn", TerminalKey.CtrlC to "^C",
)

@Composable
private fun PageContent(opened: TerminalInfo, page: TerminalPageModel, record: SessionRecordModel, mode: TerminalViewMode, setMode: (TerminalViewMode) -> Unit) {
    val model = LocalAppModel.current
    val settings = LocalSettings.current
    val nav = LocalNav.current
    val look = LocalLook.current
    val context = LocalContext.current
    val demoScreen = if (LocalDemo.current) LocalDemoScreen.current else null
    val scope = rememberCoroutineScope()
    val focusManager = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val classic = look.isClassic
    val id = opened.id
    val simple = mode == TerminalViewMode.Simple

    var reply by remember { mutableStateOf(ReplyDrafts.text[id].orEmpty().let { TextFieldValue(it, TextRange(it.length)) }) }
    var replying by remember { mutableStateOf(false) }
    var sealing by remember { mutableStateOf(false) }
    var showKeys by remember { mutableStateOf(false) }
    var verbose by remember { mutableStateOf(settings.bool("record.verbose", false)) }
    val textStep = remember { readStep(settings) }
    var menu by remember { mutableStateOf<PageMenu?>(null) }
    var renaming by remember { mutableStateOf(false) }
    var confirmClose by remember { mutableStateOf(false) }
    var linkMenu by remember { mutableStateOf<LinkMenu?>(null) }
    var said by remember { mutableStateOf<Said?>(null) }
    var wheeled by remember { mutableIntStateOf(0) }
    var wheelStamp by remember { mutableIntStateOf(0) }
    var screenOrigin by remember { mutableStateOf(Offset.Zero) }
    val focus = remember { FocusRequester() }

    val listed = model.terminals.terminals.firstOrNull { it.id == page.id } ?: opened
    val workdir = listed.workdir
    val recordSession = page.recordSession ?: listed.agentSessionId
    val prompting = page.status == TerminalStatus.Waiting && page.permissions.isEmpty()
    val canDeleteRecord = page.ownsRecord && page.harness == "claude-code"
    val status = if (page.permissions.isEmpty()) page.status else TerminalStatus.Waiting

    // MARK: what the page watches

    DisposableEffect(page) {
        page.start(model.api, model.terminals.style)
        model.viewedTerminal = page.id
        model.notifier?.prepare()
        onDispose {
            page.stop()
            if (model.viewedTerminal == page.id) model.viewedTerminal = null
        }
    }
    // The Mac's colours, when they arrive after the page.
    LaunchedEffect(model.terminals.style) { model.terminals.style?.let { page.screen.apply(it) } }
    // In the background the stream ends and the size goes back to the Mac; in front again, it is this phone's.
    LifecycleEventEffect(Lifecycle.Event.ON_STOP) { page.suspend() }
    LifecycleEventEffect(Lifecycle.Event.ON_START) { page.resume() }
    // The title's git: the list (read from every tab) follows a `cd`; the folders' git is otherwise read only on the terminals tab.
    LaunchedEffect(Unit) {
        while (true) {
            model.terminals.refreshGit(model.api)
            delay(10_000)
        }
    }
    // The record of the terminal's session: read when the page opens in the simple view and when the agent says which
    // session it is; again whenever the Mac says it changed, and on a timer besides (OpenCode's sessions share one
    // database, and an older Mac says nothing).
    LaunchedEffect(listed.harness, recordSession, simple) {
        if (!simple) return@LaunchedEffect
        record.follow(listed.harness, recordSession)
        record.refresh(model.api)
        while (true) {
            delay(if (page.recordRev == null) (if (page.status == TerminalStatus.Working) 3_000 else 10_000) else 20_000)
            record.refresh(model.api)
        }
    }
    LaunchedEffect(page.recordRev) { if (simple && page.recordRev != null) record.refresh(model.api) }
    LaunchedEffect(page.status) { if (simple) record.refresh(model.api) }
    LaunchedEffect(page.removed) {
        if (page.removed) {
            TerminalViewMode.forget(settings, page.id)
            model.terminals.remove(page.id)
            nav.pop()
        }
    }
    // The reply box is for this phone: the size is its own.
    LaunchedEffect(replying) { if (replying) page.userActed() }
    // A placeholder deleted from the box takes its file out; the reply is kept while the page is closed.
    LaunchedEffect(reply.text) {
        page.keepDraftFiles(reply.text)
        if (reply.text.isEmpty()) ReplyDrafts.text.remove(id) else ReplyDrafts.text[id] = reply.text
    }
    LaunchedEffect(said) {
        if (said == null) return@LaunchedEffect
        delay(1400)
        said = null
    }
    LaunchedEffect(wheelStamp) {
        if (wheelStamp == 0) return@LaunchedEffect
        delay(700)
        wheeled = 0
    }

    fun say(words: String) { said = Said(words) }
    fun focusReply() { focus.requestFocus(); keyboard?.show() }
    fun hideKeyboard() { focusManager.clearFocus(); keyboard?.hide() }
    fun show(next: TerminalViewMode) {
        if (next == mode) return
        hideKeyboard()
        setMode(next)
    }

    // MARK: files in the reply

    /** Picked files: kept for the reply, their placeholders put where the caret is; nothing is sent yet. */
    fun addFiles(files: List<UploadFile>) {
        val tokens = page.addDraftFiles(files)
        if (tokens.isEmpty()) return
        reply = reply.withTokens(tokens, replying)
        focusReply()
    }

    val takePicture = rememberLauncherForActivityResult(ActivityResultContracts.TakePicturePreview()) { bitmap: Bitmap? ->
        if (bitmap == null) return@rememberLauncherForActivityResult
        val out = java.io.ByteArrayOutputStream()
        if (bitmap.compress(Bitmap.CompressFormat.JPEG, 92, out)) addFiles(listOf(UploadFile("photo.jpg", "image/jpeg", out.toByteArray())))
    }
    val askCamera = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) takePicture.launch(null) else page.error = "没有相机权限，无法拍照。"
    }
    val pickPhotos = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(5)) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        scope.launch {
            val files = withContext(Dispatchers.IO) {
                uris.mapIndexedNotNull { i, uri -> readPicture(context, uri, "photo-${i + 1}") }
            }
            if (files.isNotEmpty()) addFiles(files)
        }
    }
    val pickFiles = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        scope.launch {
            val (files, skipped) = withContext(Dispatchers.IO) { readFiles(context, uris) }
            if (skipped.isNotEmpty()) page.error = "未发送：${skipped.joinToString("、")}（超过 50 MB 或无法读取）"
            if (files.isNotEmpty()) addFiles(files)
        }
    }

    /** Files of the Mac's, from the Files tab or its sheet: placeholders in the reply, their paths go to the agent. */
    fun takeMacFiles(picks: List<MacPick>) {
        val tokens = page.addMacFiles(picks)
        if (tokens.isEmpty()) return
        reply = reply.withTokens(tokens, replying)
        focusReply()
    }

    /** `+` › Files on Mac: the Files browser as a sheet at the terminal's folder (`FilesSession.Mode.Sheet`). */
    fun presentMacFiles() {
        nav.present("filessheet") {
            MacFilesSheet(terminal = id, start = workdir, onPick = { picks -> nav.dismiss("filessheet"); takeMacFiles(picks) }, onClose = { nav.dismiss("filessheet") })
        }
    }

    fun pasteImages() {
        val images = pastedImages(context)
        if (images.isEmpty()) { page.error = "剪贴板中无图片"; return }
        addFiles(images)
    }

    fun capture() {
        if (context.checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) takePicture.launch(null)
        else askCamera.launch(Manifest.permission.CAMERA)
    }

    // MARK: sending

    val canSend = !page.sending && page.status != TerminalStatus.Exited && reply.text.isNotBlank()
    val stops = simple && page.status == TerminalStatus.Working && page.permissions.isEmpty() && reply.text.isBlank() && !page.sending

    suspend fun send(text: String, sealed: Boolean) {
        if (page.send(text, sealed)) {
            if (reply.text == text) reply = TextFieldValue("")
            if (sealed) sealing = false
        }
    }

    fun close(deleteRecord: Boolean = false) {
        scope.launch {
            if (page.close(deleteRecord)) {
                model.terminals.remove(page.id)
                nav.pop()
            }
        }
    }

    // MARK: links

    /** A path on the screen, in the Files tab at where it is (the Files browser over this page is not written yet). */
    fun showInFiles(hit: ScreenLink) {
        val first = (listOf(hit.link) + hit.alternates).firstNotNullOfOrNull { (it as? TappedLink.File)?.path } ?: return
        model.showInFiles(first)
        nav.pop()
    }

    fun openOnPhone(address: String) {
        try {
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(address)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Exception) {
            page.error = e.message ?: e.toString()
        }
    }

    /**
     * One of a link's actions. A web address opens in the phone's browser (the Mac's shared browser is not on the phone
     * yet); a Mac file's `Open in Browser` does nothing yet; a copy is said on the screen for a moment.
     */
    fun run(action: LinkAction, hit: ScreenLink) {
        val link = hit.link
        when (action) {
            LinkAction.ShowInFiles -> showInFiles(hit)
            LinkAction.Copy -> {
                (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("link", link.text))
                say(LinkAction.copied(link))
            }
            LinkAction.OpenInSafari -> link.safari?.let { openOnPhone(it) }
            LinkAction.OpenInBrowser -> if (link is TappedLink.Web) openOnPhone(link.address)
        }
    }

    /**
     * A tap on the screen: on a link (or within a finger's slop of one), it opens — also when the program tracks the
     * mouse, which would only get a click it has no use for. Else a click there when the program tracks the mouse
     * (Claude Code's full screen: its options), the keyboard staying as it is; else the keyboard goes away.
     */
    fun tapped(x: Float, y: Float) {
        page.userActed()
        val hit = page.screen.link(x, y, workdir, tap = true)
        if (hit != null) {
            page.screen.flash(hit)
            run(hit.link.actions[0], hit)
            return
        }
        val cell = page.screen.clickCell(x, y)
        if (cell != null) scope.launch { page.click(cell.first, cell.second) } else hideKeyboard()
    }

    fun anchorOf(hit: ScreenLink): Rect {
        val f = page.screen.frame(hit)
        return Rect(f.left + screenOrigin.x, f.top + screenOrigin.y, f.right + screenOrigin.x, f.bottom + screenOrigin.y)
    }

    /** A press held on a link: its menu by it (its whole address, then its actions). */
    fun held(x: Float, y: Float) {
        val hit = page.screen.link(x, y, workdir) ?: return
        page.screen.flash(hit)
        linkMenu = LinkMenu(hit, anchorOf(hit))
    }

    fun wheel(up: Boolean, count: Int) {
        page.wheel(up, count)
        if (!page.wheelWorks) return
        wheeled += if (up) count else -count
        wheelStamp += 1
    }

    // MARK: the model, its level, Daybreak

    val daybreak: Boolean? = page.daybreakNow ?: listed.daybreak
    val currentModel = RecordDisplay.model(now = page.modelNow ?: listed.modelNow, record = record.usage?.model, started = listed.model)
    val currentEffort = EffortDisplay.level(asked = page.effortAsked, record = record.usage?.effort, started = listed.effort)
    val levelTaken = TerminalModelMenu.levelTakenWhileWorking(page.harness, listed.sets)
    val effortLevels = EffortDisplay.levelsCurrent(model.terminals.list, page.harness, currentModel)
    val slidesEffort = levelTaken != null && page.status != TerminalStatus.Exited && effortLevels.isNotEmpty()
    val resting = page.status == TerminalStatus.Idle && page.permissions.isEmpty()
    val answering = page.status == TerminalStatus.Waiting || page.permissions.isNotEmpty()
    val daybreakClash: String? = run {
        val on = daybreak
        if (on == null || page.status == TerminalStatus.Exited) null
        else TerminalDaybreak.clash(model.terminals.list?.models?.get(page.harness)?.firstOrNull { RecordDisplay.isCurrent(it, currentModel) }, on, currentModel?.let(ModelName::display))
    }

    fun modelAction(option: TerminalModelOption) = PixelBox.Action((if (RecordDisplay.isCurrent(option, currentModel)) "✓ " else "") + option.name) {
        scope.launch {
            if (page.setModel(option.id) == null) return@launch
            // The list says which model it is on once the agent has said (the stream does at once, where it can).
            delay(1000)
            model.terminals.refreshList(model.api)
        }
    }

    fun openModelMenu(anchor: Rect) {
        val options = model.terminals.list?.models?.get(page.harness) ?: emptyList()
        val offer = TerminalModelMenu.offer(page.harness, listed.sets, page.status == TerminalStatus.Exited, resting, options, daybreak)
        val word = EffortDisplay.word(page.harness)
        val wide = 320.dp
        menu = when (offer) {
            TerminalModelMenu.Ended -> PageMenu(null, anchor, wide, listOf(PixelBox.Action("终端已结束") {}))
            is TerminalModelMenu.Models -> {
                val head = when (page.harness) {
                    "claude-code" -> "Model · Claude Code 会把它记成新会话的默认模型"
                    "grok" -> "Model · Grok 会把它记成新会话的默认模型"
                    else -> "Model"
                }
                val older = offer.options.filter { it.older }
                val rows = offer.options.filter { !it.older }.map(::modelAction) +
                    (if (older.isEmpty()) emptyList() else listOf(PixelBox.Action("Older ▸") {
                        menu = PageMenu("Older", anchor, PixelBox.menuWidth, older.map(::modelAction))
                    }))
                PageMenu(head, anchor, 264.dp, rows)
            }
            TerminalModelMenu.Busy -> PageMenu("Model", anchor, wide, listOf(PixelBox.Action("它正在工作或等待回答，结束后再切换") {}))
            TerminalModelMenu.Picker -> {
                val rows = ArrayList<PixelBox.Action>()
                rows += PixelBox.Action(if (page.harness == "codex") "Model and Reasoning in Terminal…" else "Choose in Terminal…") {
                    if (resting) {
                        show(TerminalViewMode.Terminal)
                        scope.launch { page.send(RecordDisplay.modelPicker(page.harness), sealed = false) }
                    }
                }
                EffortDisplay.picker(page.harness)?.let { picker ->
                    rows += PixelBox.Action("$word in Terminal…") {
                        if (resting) {
                            show(TerminalViewMode.Terminal)
                            scope.launch { page.send(picker, sealed = false) }
                        }
                    }
                }
                PageMenu(null, anchor, wide, rows)
            }
        }
    }

    fun openDaybreakMenu(anchor: Rect) {
        val on = daybreak ?: return
        val rows = if (answering) listOf(PixelBox.Action("它正在等待回答，回答后再调整") {})
        else listOf(true, false).map { want ->
            PixelBox.Action((if (want == on) "✓ " else "") + (if (want) "On" else "Off")) { scope.launch { page.setDaybreak(want) } }
        }
        menu = PageMenu(TerminalDaybreak.note, anchor, 264.dp, rows)
    }

    // MARK: the page's menu

    fun openMoreMenu(anchor: Rect) {
        val rows = ArrayList<PixelBox.Action>()
        rows += PixelBox.Action(if (simple) "Terminal View" else "Simple View") { show(if (simple) TerminalViewMode.Terminal else TerminalViewMode.Simple) }
        if (simple) {
            rows += PixelBox.Action(if (verbose) "Transcript: Normal" else "Transcript: Verbose") {
                verbose = !verbose
                settings.putBool("record.verbose", verbose)
            }
            if (record.hasSession && (page.harness == "claude-code" || page.harness == "codex")) {
                rows += PixelBox.Action("Changes") {
                    val session = recordSession
                    if (session != null) nav.present("changes") { ChangesSheet(harness = listed.harness, session = session, work = null) }
                }
            }
        } else {
            // The pinch changes the text size too; these are for a hand that cannot pinch.
            rows += PixelBox.Action("Larger Text") { page.screen.setFontSize(page.screen.fontSize + 1); settings.putFloat("terminal.fontSize", page.screen.fontSize) }
            rows += PixelBox.Action("Smaller Text") { page.screen.setFontSize(page.screen.fontSize - 1); settings.putFloat("terminal.fontSize", page.screen.fontSize) }
        }
        // Its folder, where the agent works now (docs/files-v0.md §12.4.1): in the Files tab.
        rows += PixelBox.Action("Show in Files") { model.showInFiles(workdir); nav.pop() }
        rows += PixelBox.Action("Rename") { renaming = true }
        rows += PixelBox.Action("Close", PixelBox.Action.Role.Destructive) {
            if (page.status == TerminalStatus.Exited && !canDeleteRecord) close() else confirmClose = true
        }
        menu = PageMenu(null, anchor, PixelBox.menuWidth, rows)
    }

    fun openPlusMenu(anchor: Rect) {
        val rows = ArrayList<PixelBox.Action>()
        if (context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)) rows += PixelBox.Action("Camera") { hideKeyboard(); capture() }
        rows += PixelBox.Action("Photos") { hideKeyboard(); pickPhotos.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }
        rows += PixelBox.Action("Files") { hideKeyboard(); pickFiles.launch(arrayOf("*/*")) }
        // The Mac's own files, as a sheet at this terminal's folder; what is picked lands in this reply box.
        rows += PixelBox.Action("Files on Mac") { hideKeyboard(); presentMacFiles() }
        rows += PixelBox.Action("Paste Image") { pasteImages() }
        // The keys are out of the way under the record until they are wanted.
        if (simple) rows += PixelBox.Action(if (showKeys) "Hide Keys" else "Keys") { showKeys = !showKeys }
        menu = PageMenu(null, anchor, PixelBox.menuWidth, rows)
    }

    // MARK: boxes

    PixelBoxEffect(menu, { menu = null }) { PixelBox(head = it.head, cancel = null, actions = it.actions, anchor = it.anchor, width = it.width) }
    PixelBoxEffect(confirmClose, { confirmClose = false }) {
        val actions = ArrayList<PixelBox.Action>()
        if (canDeleteRecord) actions += PixelBox.Action("Delete Record", PixelBox.Action.Role.Destructive) { close(deleteRecord = true) }
        actions += PixelBox.Action("Close", PixelBox.Action.Role.Primary) { close() }
        PixelBox(
            head = "Close", tone = PixelBox.Tone.Red,
            message = "关闭「${page.name}」？" + (if (canDeleteRecord) "程序将结束并从列表移除。会话记录默认保留，之后可继续；删除记录后无法恢复。" else "程序将结束并从列表移除；会话记录保留，之后可继续。"),
            actions = actions,
        )
    }
    PixelBoxEffect(linkMenu, { linkMenu = null }) { menuOf ->
        val link = menuOf.hit.link
        PixelBox(
            head = link.text, cancel = null,
            actions = link.actions.map { action -> PixelBox.Action(action.label(link)) { run(action, menuOf.hit) } },
            anchor = menuOf.anchor, width = 264.dp,
        )
    }
    if (renaming) RenameDialog(page.name, onSave = { name -> renaming = false; scope.launch { page.rename(name) } }, onCancel = { renaming = false })

    // What the Files tab handed over for this terminal, taken as the page appears or as it arrives.
    val handoff = model.files.handoff
    LaunchedEffect(handoff) {
        if (handoff != null && handoff.terminal == id) {
            model.files.handoff = null
            takeMacFiles(handoff.picks)
        }
    }

    // MARK: demo

    LaunchedEffect(demoScreen) {
        when (demoScreen) {
            "filessheet" -> { delay(1500); presentMacFiles() }
            "terminalsealed" -> {
                reply = TextFieldValue("my password is hunter2", TextRange(22))
                // After the page has come in, as a tap on the lock would: the box glitches open.
                delay(3000)
                sealing = true
            }
            "terminalslash" -> reply = TextFieldValue("/co", TextRange(3))
            "terminalkeyboard" -> { delay(2000); focusReply() }
            "terminalclose" -> { delay(2000); confirmClose = true }
            // A link held, as a long press on the address in the demo's screen would open its menu.
            "terminallink" -> {
                delay(2500)
                val links = page.screen.links(workdir)
                val hit = links.firstOrNull { it.link is TappedLink.Web } ?: links.firstOrNull() ?: return@LaunchedEffect
                page.screen.flash(hit)
                linkMenu = LinkMenu(hit, anchorOf(hit))
            }
            // The rest of the path cut over two lines, tapped (`gn/concepts/split.html`): its flash. (Over here it would then
            // leave for the Files tab, which is not what a still picture wants.)
            "terminalpath" -> {
                delay(2500)
                page.screen.links(workdir).lastOrNull { it.link is TappedLink.File }?.let { page.screen.flash(it) }
            }
            "simplepaste" -> {
                delay(1500)
                DemoData.pasteBoardImage?.let { addFiles(listOf(UploadFile("pasted.png", "image/png", it))) }
            }
        }
    }

    // MARK: the page

    val bodyGround = if (simple) Theme.base else Color.Black
    Column(Modifier.fillMaxSize().background(bodyGround).imePadding()) {
        PageBar(
            ground = bodyGround, title = TerminalTree.lastComponent(workdir), git = model.terminals.git[workdir]?.said, status = status,
            statusWord = if (page.permissions.isEmpty()) page.status.label else "Waiting", simple = simple,
            onBack = { nav.pop() }, onToggle = { show(if (simple) TerminalViewMode.Terminal else TerminalViewMode.Simple) }, onMore = { openMoreMenu(it) },
        )
        Box(Modifier.weight(1f).fillMaxWidth()) {
            if (simple) {
                RecordTextSized(textStep) {
                    androidx.compose.runtime.CompositionLocalProvider(LocalOpenMacFile provides { file -> model.showInFiles(file.folder); nav.pop(); Unit }) {
                        TerminalRecordView(
                            page, record, listed, model.terminals.git[workdir]?.said, verbose, openTerminal = { show(TerminalViewMode.Terminal) },
                            modifier = Modifier.fillMaxSize(),
                        )
                    }
                }
            } else {
                ScreenBody(page, wheeled, said?.words, onOrigin = { screenOrigin = it }, onTap = ::tapped, onHold = ::held, onWheel = ::wheel,
                    onPinchEnded = { settings.putFloat("terminal.fontSize", it) })
            }
        }
        Controls(
            page = page, record = record, simple = simple, ground = if (simple) Theme.base else page.ground, reply = reply, onReply = { reply = it },
            sealing = sealing, onCloseSealing = { sealing = false }, replying = replying, onFocus = { replying = it }, focus = focus, canSend = canSend, stops = stops,
            showKeys = showKeys || prompting, prompting = prompting,
            onHideKeyboard = { hideKeyboard() }, onKey = { key -> scope.launch { page.press(key) } },
            onSend = { scope.launch { if (stops) page.press(TerminalKey.Esc) else if (canSend) send(reply.text, sealed = false) } },
            onSendSealed = { scope.launch { send(reply.text, sealed = true) } },
            onPlus = { openPlusMenu(it) }, onImages = if (sealing) null else ({ files -> addFiles(files) }),
            onSuggest = { text -> reply = TextFieldValue(text, TextRange(text.length)); focusReply() },
            modelLabel = listOfNotNull(currentModel?.let(ModelName::display) ?: "Model", if (slidesEffort) null else currentEffort?.let(EffortDisplay::name)).joinToString(" · "),
            mode = RecordDisplay.mode(record.mode) ?: RecordDisplay.mode(listed.mode) ?: listed.mode.replaceFirstChar { it.uppercase() },
            onModelMenu = { openModelMenu(it) },
            effort = if (!slidesEffort) null else EffortLine(
                label = currentEffort?.let(EffortDisplay::name) ?: EffortDisplay.word(page.harness), levels = effortLevels, level = currentEffort,
                locked = if (answering) "它正在等待回答，回答后再调整。" else if (levelTaken != true && page.status != TerminalStatus.Idle) "它正在工作，结束后再调整。" else null,
                heading = EffortDisplay.word(page.harness), choose = { level -> scope.launch { page.setEffort(level) } },
                autoOpen = demoScreen == "simpleeffort",
            ),
            daybreakLabel = if (daybreak != null && page.status != TerminalStatus.Exited) TerminalDaybreak.word(daybreak) else null,
            onDaybreakMenu = { openDaybreakMenu(it) },
            daybreakClash = if (simple) daybreakClash else null,
            context = RecordDisplay.context(record.usage), hasDaybreak = daybreak != null,
            suggestion = page.suggestion?.takeIf { !sealing && reply.text.isEmpty() && page.status == TerminalStatus.Idle && it.isNotEmpty() },
        )
    }
}

// MARK: the bar

/**
 * The page's bar (the navigation bar of the iPhone's page): back, the folder the agent works in now with its git, the
 * terminal's status under it (as the Mac window's title, terminal-v0 §1, 2026-10-01, user: 手机上的标题栏没变; the
 * terminal's name stays on its row in the list), the switch between the two views, and `⋯`. `ground`: black over the
 * terminal's own screen. The shared `NavBar` has one string for its title; this one is two lines of its own.
 */
@Composable
private fun PageBar(
    ground: Color, title: String, git: String?, status: TerminalStatus, statusWord: String, simple: Boolean,
    onBack: () -> Unit, onToggle: () -> Unit, onMore: (Rect) -> Unit,
) {
    val classic = LocalLook.current.isClassic
    var more by remember { mutableStateOf(Rect.Zero) }
    Column(Modifier.fillMaxWidth().background(ground).windowInsetsPadding(WindowInsets.statusBars)) {
        Row(Modifier.fillMaxWidth().height(48.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.padding(start = 8.dp)) { BarBack(onBack, "Terminals") }
            Box(Modifier.weight(1f).padding(horizontal = 4.dp), contentAlignment = Alignment.Center) {
                Column(Modifier.glitch(status, whenChanged = { it == TerminalStatus.Waiting || it == TerminalStatus.Exited }), horizontalAlignment = Alignment.CenterHorizontally) {
                    Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(title, Modifier.weight(1f, fill = false), color = Theme.ink, style = plain(17, FontWeight.SemiBold), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (git != null) Text(git, color = Theme.secondaryInk, style = mono(12), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(bottom = 1.dp))
                    }
                    Row(Modifier.padding(top = 1.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                        PageStatusMark(status)
                        Text(lookWord(statusWord), color = Theme.secondaryInk, style = mono(11), maxLines = 1)
                    }
                }
            }
            // The other view of the same session (simple-view-v0 §1).
            BarButton(onToggle, if (simple) "terminal view" else "simple view") {
                val tint = if (classic) Theme.signal else Theme.ink
                if (simple) {
                    if (classic) TerminalGlyph(tint) else PixelSprite(PixelArt.terminalWindow, pixel = 2.dp, color = Theme.ink, strength = 1f, shadow = false)
                } else {
                    if (classic) AlignLeftGlyph(tint) else Text("≡", color = tint, style = mono(16, FontWeight.Medium))
                }
            }
            Box(Modifier.padding(end = 4.dp).onGloballyPositioned { more = it.boundsInRoot() }) {
                BarButton({ onMore(more) }, "more") {
                    val tint = if (classic) Theme.signal else Theme.ink
                    if (classic) EllipsisGlyph(tint) else Text("⋯", color = tint, style = mono(17))
                }
            }
        }
        HairRule()
    }
}

@Composable
private fun BarButton(onClick: () -> Unit, label: String, content: @Composable () -> Unit) {
    Box(
        Modifier.size(width = 44.dp, height = 48.dp).clickable(role = Role.Button, onClickLabel = label, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { content() }
}

/** `TerminalStatusMark`: a spinner at work, a blinking amber square waiting, a hollow one when ended, a green one idle. */
@Composable
private fun PageStatusMark(status: TerminalStatus) {
    when (status) {
        TerminalStatus.Working -> BrailleSpinner()
        TerminalStatus.Waiting -> if (LocalLook.current.isClassic) ClassicWaitingDot() else PixelSprite(PixelArt.square, pixel = 2.dp, color = Theme.waiting, modifier = Modifier.waitingBlink())
        TerminalStatus.Exited -> PixelSprite(PixelArt.hollow, pixel = 2.dp, color = Theme.inkDim)
        else -> PixelSprite(PixelArt.square, pixel = 2.dp, color = Theme.done)
    }
}

// MARK: the screen's body

/** The program's own screen, with what floats over it. */
@Composable
private fun ScreenBody(
    page: TerminalPageModel, wheeled: Int, said: String?, onOrigin: (Offset) -> Unit, onTap: (Float, Float) -> Unit, onHold: (Float, Float) -> Unit,
    onWheel: (Boolean, Int) -> Unit, onPinchEnded: (Float) -> Unit,
) {
    val ground = page.ground
    Box(Modifier.fillMaxSize().background(Color.Black)) {
        Box(Modifier.fillMaxSize().background(ground).screenRefresh(page.snapshots, ground)) {
            TerminalScreen(page.screen, Modifier.fillMaxSize(), onPinchEnded = onPinchEnded, onWheel = onWheel, onTap = onTap, onHold = onHold, onOrigin = onOrigin)
            if (wheeled != 0) Box(Modifier.align(Alignment.CenterEnd).padding(end = 8.dp)) { Chip("Wheel ${if (wheeled > 0) "↑" else "↓"} ${abs(wheeled)}") }
            if (said != null) Box(Modifier.align(Alignment.BottomCenter).padding(bottom = 10.dp)) { Chip(said) }
            page.away?.let { TerminalAwayCover(page, it) }
        }
        if (!page.drawn && page.away == null) {
            Row(Modifier.align(Alignment.TopCenter).padding(top = 60.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                BrailleSpinner(color = Theme.secondaryInk)
                Text("Connecting", color = Theme.secondaryInk, style = mono(12))
            }
        }
        Column(Modifier.align(Alignment.TopCenter).padding(horizontal = Theme.Space.m).padding(top = Theme.Space.s), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            for (p in page.permissions) {
                androidx.compose.runtime.key(p.id) {
                    if (p.isQuestion) TerminalQuestionCard(page, p) else TerminalPermissionCard(page, p)
                }
            }
        }
    }
}

/** A few words over the screen for a moment: the wheel's notches, `Link Copied`. */
@Composable
private fun Chip(words: String) {
    val light = Color(0xFFE8E8E8)
    Text(words, Modifier.background(Color.Black).border(1.dp, light, RectangleShape).padding(horizontal = 6.dp, vertical = 2.dp), color = light, style = mono(11))
}

// MARK: keys and reply

private class EffortLine(
    val label: String, val levels: List<String>, val level: String?, val locked: String?, val heading: String, val choose: (String) -> Unit,
    /** The sample screen `simpleeffort`: the popover opens by itself after 2 s. */
    val autoOpen: Boolean = false,
)

@Composable
private fun Controls(
    page: TerminalPageModel, record: SessionRecordModel, simple: Boolean, ground: Color,
    reply: TextFieldValue, onReply: (TextFieldValue) -> Unit, sealing: Boolean, onCloseSealing: () -> Unit,
    replying: Boolean, onFocus: (Boolean) -> Unit, focus: FocusRequester, canSend: Boolean, stops: Boolean,
    showKeys: Boolean, prompting: Boolean, onHideKeyboard: () -> Unit, onKey: (TerminalKey) -> Unit,
    onSend: () -> Unit, onSendSealed: () -> Unit, onPlus: (Rect) -> Unit, onImages: ((List<UploadFile>) -> Unit)?,
    onSuggest: (String) -> Unit, modelLabel: String, mode: String, onModelMenu: (Rect) -> Unit, effort: EffortLine?,
    daybreakLabel: String?, onDaybreakMenu: (Rect) -> Unit, daybreakClash: String?, context: String?, hasDaybreak: Boolean, suggestion: String?,
) {
    val suggestions = if (sealing) emptyList() else SlashCommand.matching(reply.text, page.commands)
    val commandsMissing = !sealing && page.commandsUnavailable && reply.text.startsWith("/") && reply.text.none { it.isWhitespace() }
    Column(Modifier.fillMaxWidth().background(ground).navigationBarsPadding()) {
        if (suggestions.isNotEmpty()) SuggestionList(suggestions) { c -> onSuggest("/${c.name} ") }
        if (suggestion != null) OfferedRow(suggestion) { onSuggest(suggestion) }
        if (commandsMissing) {
            Text(
                "命令补全需要更新 Mac 上的 AgentSwitch。", Modifier.fillMaxWidth().background(Theme.raised).padding(horizontal = Theme.Space.l, vertical = 8.dp),
                color = Theme.secondaryInk, style = plain(13),
            )
        }
        HairRule()
        page.error?.let { error ->
            Row(Modifier.fillMaxWidth().padding(horizontal = Theme.Space.l).padding(top = 6.dp).glitch(error, onAppear = true), verticalAlignment = Alignment.CenterVertically) {
                Text(error, Modifier.weight(1f), color = Theme.failed, style = plain(13), maxLines = 2, overflow = TextOverflow.Ellipsis)
                Box(Modifier.size(32.dp).clickable(role = Role.Button, onClickLabel = "dismiss") { page.error = null }, contentAlignment = Alignment.Center) { CrossGlyph(Theme.secondaryInk, 15.dp) }
            }
        }
        if (simple) TasksRow(record.plan)
        if (!simple || showKeys) {
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = Theme.Space.l, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (replying) KeyCapBox(onHideKeyboard) { color -> KeyboardGlyph(color) }
                for ((key, label) in keys) KeyCap(label, { onKey(key) }, solid = key == TerminalKey.Enter, enabled = page.status != TerminalStatus.Exited)
            }
        } else {
            Spacer(Modifier.height(8.dp))
        }
        Composer(page, sealing, onCloseSealing, reply, onReply, focus, onFocus, canSend, stops, onSend, onSendSealed, onPlus, onImages)
        page.sealedNote?.let { note ->
            Text(note, Modifier.fillMaxWidth().padding(horizontal = Theme.Space.l).padding(bottom = 6.dp), color = Theme.secondaryInk, style = mono(11))
        }
        // Codex's Daybreak switch and the model it is on do not go together: its next turn would not start, and only
        // its own screen would say so (docs/simple-view-v0.md §5.8).
        if (daybreakClash != null) {
            Text(daybreakClash, Modifier.fillMaxWidth().padding(horizontal = Theme.Space.l).padding(bottom = 6.dp), color = Theme.waiting, style = plain(13))
        }
        if (simple) SessionLine(page, mode, modelLabel, onModelMenu, effort, daybreakLabel, onDaybreakMenu, context, hasDaybreak)
    }
}

/**
 * One box for both ways of replying, so switching keeps the text and the keyboard as they were (one text field, never
 * swapped): typed as it is; or, in the sealed box, the desktop's sealed composer (ui-v0 §7.4) — a framed box with a
 * signal head bar naming the terminal and a hard dithered shadow, glitching as it opens; the reply then goes through
 * the sealer and the box closes. (The lock that opens it is gone with the gate from terminals, docs/profiles-v0.md §8:
 * only the sample screen `terminalsealed` opens it.)
 */
@Composable
private fun Composer(
    page: TerminalPageModel, sealing: Boolean, onCloseSealing: () -> Unit, reply: TextFieldValue, onReply: (TextFieldValue) -> Unit,
    focus: FocusRequester, onFocus: (Boolean) -> Unit, canSend: Boolean, stops: Boolean, onSend: () -> Unit, onSendSealed: () -> Unit,
    onPlus: (Rect) -> Unit, onImages: ((List<UploadFile>) -> Unit)?,
) {
    val classic = LocalLook.current.isClassic
    val radius = Theme.Radius.bubble
    var plus by remember { mutableStateOf(Rect.Zero) }
    Column {
        if (page.draftFiles.isNotEmpty()) DraftStrip(page) { d ->
            val text = TerminalDraft.remove(d.token, reply.text)
            onReply(TextFieldValue(text, TextRange(minOf(reply.selection.end, text.length))))
            page.removeDraftFile(d)
        }
        Box(
            Modifier.padding(start = if (sealing) Theme.Space.l else 0.dp, end = if (sealing) Theme.Space.l + 6.dp else 0.dp, bottom = if (sealing) Theme.Space.m + 6.dp else Theme.Space.s)
                .glitch(sealing),
        ) {
            if (sealing) DitherShadow(Modifier.matchParentSize().offset(6.dp, 6.dp))
            Column(
                Modifier.grounded(if (sealing) (if (classic) Theme.panel else Theme.base) else Color.Transparent, 14.dp)
                    .framed(if (sealing) (if (classic) Theme.line else Theme.ink) else Color.Transparent, 14.dp),
            ) {
                if (sealing) {
                    // The head: black on the signal colour; in the classic look the lock in the accent and plain words.
                    Row(
                        Modifier.fillMaxWidth().height(if (classic) 34.dp else 26.dp).background(if (classic) Color.Transparent else Theme.signal).padding(start = if (classic) 12.dp else 8.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        val ink = if (classic) Theme.ink else Color.Black
                        PixelSprite(PixelArt.lock, pixel = 2.dp, color = if (classic) Theme.signal else Color.Black, strength = 1f, shadow = false, picture = ShadedSprite.lockSmall, onDark = false)
                        Text("Sealed → ${page.name}", Modifier.weight(1f), color = ink, style = mono(12, if (classic) FontWeight.SemiBold else FontWeight.Normal), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Box(Modifier.size(width = 28.dp, height = 26.dp).clickable(role = Role.Button, onClickLabel = "cancel", onClick = onCloseSealing), contentAlignment = Alignment.Center) { CrossGlyph(ink, 15.dp) }
                    }
                }
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = if (sealing) 0.dp else Theme.Space.l).padding(top = if (sealing) 4.dp else 0.dp),
                    verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(Theme.Space.s),
                ) {
                    if (!sealing) {
                        // Pictures and files for the agent: their paths go into its prompt (Claude Code: [Image #n]); write on and send.
                        val enabled = !page.sending && page.status != TerminalStatus.Exited
                        Box(
                            Modifier.onGloballyPositioned { plus = it.boundsInRoot() }.then(
                                if (classic) Modifier.size(width = 34.dp, height = 38.dp) else Modifier.size(38.dp).border(1.dp, Theme.line, RectangleShape),
                            ).clickable(enabled, role = Role.Button, onClickLabel = "attach") { onPlus(plus) }.alpha(if (enabled) 1f else 0.4f),
                            contentAlignment = Alignment.Center,
                        ) {
                            if (classic) PlusCircleGlyph(Theme.ink.copy(alpha = 0.72f)) else Text("+", color = Theme.ink.copy(alpha = 0.72f), style = com.agentswitch.android.design.code(20))
                        }
                    }
                    // A framed line; a round field on its own ground in the classic look.
                    Box(
                        Modifier.weight(1f)
                            .grounded(if (classic && !sealing) Theme.raised else Color.Transparent, radius)
                            .framed(if (sealing || classic) Color.Transparent else Theme.line, radius)
                            .padding(horizontal = if (classic && !sealing) 14.dp else 12.dp, vertical = 9.dp),
                    ) {
                        ReplyBox(
                            value = reply, onValueChange = onReply, prompt = if (sealing) "Message" else "回复", monospaced = sealing,
                            minLines = if (sealing) 2 else 1, maxLines = if (sealing) 6 else 5, focus = focus, onFocus = onFocus, onImages = onImages,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                    if (!sealing) {
                        SquareIconButton(onSend, if (stops) "stop" else "send", active = canSend || page.sending || stops) { color ->
                            when {
                                page.sending -> BrailleSpinner(color = Theme.base)
                                stops -> if (classic) Box(Modifier.size(13.dp).background(color, androidx.compose.foundation.shape.RoundedCornerShape(2.dp))) else Text("■", color = color, style = com.agentswitch.android.design.code(15, FontWeight.Bold))
                                classic -> ArrowUpGlyph(color)
                                else -> Text("↑", color = color, style = com.agentswitch.android.design.code(18, FontWeight.Bold))
                            }
                        }
                    }
                }
                if (sealing) {
                    Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Theme.Space.s)) {
                        Text("凭据在 Mac 上换成密文后再交给 agent", Modifier.weight(1f), color = Theme.secondaryInk, style = plain(12), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (page.sending) {
                            Box(Modifier.background(Theme.fill).padding(horizontal = 12.dp, vertical = 10.dp)) { BrailleSpinner(color = Theme.base) }
                        } else {
                            SquareButton("Send", onSendSealed, prominent = true, expand = false, enabled = canSend)
                        }
                    }
                }
            }
        }
    }
}

/**
 * The reply's files above the box: the picture (or the file's name), its number as the placeholder says, × to take it
 * out (its placeholder goes too).
 */
@Composable
private fun DraftStrip(page: TerminalPageModel, remove: (TerminalPageModel.DraftFile) -> Unit) {
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = Theme.Space.l).padding(top = 10.dp, bottom = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        for (d in page.draftFiles) {
            androidx.compose.runtime.key(d.id) {
                Box {
                    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        Box(
                            Modifier.size(48.dp).clip(RectangleShape).border(1.dp, if (d.sensitive) Theme.waiting else Theme.line, RectangleShape),
                            contentAlignment = Alignment.Center,
                        ) {
                            val thumbnail = d.thumbnail
                            if (thumbnail != null) Image(thumbnail.asImageBitmap(), null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
                            else FileGlyph(d.isFolder, Theme.ink.copy(alpha = 0.7f))
                        }
                        // A file of the Mac's: `on Mac` (not sent, its path goes); one that may hold a password, the amber mark (docs/files-v0.md §4).
                        Row(Modifier.widthIn(max = 96.dp), horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                            if (d.sensitive) Text("!", color = Theme.waiting, style = mono(10, FontWeight.Bold))
                            Text(if (d.isImage) "#${d.number}" else "#${d.number} ${d.name}", color = Theme.secondaryInk, style = mono(10), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        if (d.macPath != null) Text("on Mac", color = Theme.inkDim, style = mono(9))
                    }
                    Box(
                        Modifier.align(Alignment.TopEnd).offset(x = 6.dp, y = (-6).dp).size(18.dp).background(Theme.ink, CircleShape).clickable(role = Role.Button, onClickLabel = "remove ${d.token}") { remove(d) },
                        contentAlignment = Alignment.Center,
                    ) { CrossGlyph(Theme.base, 11.dp) }
                }
            }
        }
    }
}

/** What `/` may be: tap one to put it in the box (a space after it, ready for arguments). */
@Composable
private fun SuggestionList(suggestions: List<SlashCommand>, pick: (SlashCommand) -> Unit) {
    Column(Modifier.fillMaxWidth().background(Theme.raised)) {
        HairRule()
        for (c in suggestions) {
            Row(
                Modifier.fillMaxWidth().clickable(role = Role.Button) { pick(c) }.padding(horizontal = Theme.Space.l, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text("/${c.name}", color = Theme.ink, style = mono(13, FontWeight.Medium), maxLines = 1)
                Text(c.description, Modifier.weight(1f), color = Theme.secondaryInk, style = plain(12), maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (c.source != "builtin") Text(c.source, color = Theme.inkDim, style = mono(10))
            }
        }
    }
}

/** One line over the reply box: a tap writes it in, yours to change or send. */
@Composable
private fun OfferedRow(text: String, use: () -> Unit) {
    Column(Modifier.fillMaxWidth().background(Theme.raised)) {
        HairRule()
        Row(
            Modifier.fillMaxWidth().clickable(role = Role.Button, onClickLabel = "use suggestion", onClick = use).padding(horizontal = Theme.Space.l, vertical = 9.dp),
            verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(text, Modifier.weight(1f), color = Theme.secondaryInk, style = plain(15), maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(lookWord("Use"), color = Theme.inkDim, style = mono(11))
        }
    }
}

// MARK: under the reply box

/** Under the reply box in the simple view: how it asks, the model, how full its context is. */
@Composable
private fun SessionLine(
    page: TerminalPageModel, mode: String, modelLabel: String, onModelMenu: (Rect) -> Unit, effort: EffortLine?,
    daybreakLabel: String?, onDaybreakMenu: (Rect) -> Unit, context: String?, hasDaybreak: Boolean,
) {
    val tertiary = Theme.inkDim
    Row(Modifier.fillMaxWidth().padding(horizontal = Theme.Space.l).padding(bottom = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        // Skipping every permission is said in the colour of a warning (2026-10-07, as on the Mac).
        Text(mode, color = if (mode == "Bypass") Theme.failed else tertiary, style = mono(11), maxLines = 1)
        Text("·", color = tertiary, style = mono(11))
        MenuWord(modelLabel, page.changingModel, onModelMenu)
        if (effort != null) {
            Text("·", color = tertiary, style = mono(11))
            EffortButton(effort)
        }
        if (daybreakLabel != null) {
            Text("·", color = tertiary, style = mono(11))
            MenuWord(daybreakLabel, false, onDaybreakMenu)
        }
        Spacer(Modifier.weight(1f))
        // With Codex's Daybreak switch in the row there is no room for the word: the figure alone.
        if (context != null) Text(if (!hasDaybreak) "Context $context" else context, color = tertiary, style = mono(11), maxLines = 1)
    }
}

/** A word that opens a menu, with its ▾. A line of small words is hard to hit: it takes the room around its own. */
@Composable
private fun MenuWord(word: String, busy: Boolean, open: (Rect) -> Unit) {
    var bounds by remember { mutableStateOf(Rect.Zero) }
    Row(
        Modifier.onGloballyPositioned { bounds = it.boundsInRoot() }.clickable(role = Role.Button) { open(bounds) }.padding(top = 5.dp, bottom = 5.dp, end = 8.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        if (busy) BrailleSpinner(color = Theme.secondaryInk)
        Text(word, Modifier.widthIn(max = 220.dp), color = Theme.secondaryInk, style = mono(12, FontWeight.Medium), maxLines = 1, overflow = TextOverflow.Ellipsis)
        DownGlyph(Theme.secondaryInk)
    }
}

/** How hard it thinks, and a slider to change it (2026-10-07, user: 思考强度改成滑块调节), in a popover over the word. */
@Composable
private fun EffortButton(line: EffortLine) {
    var open by remember { mutableStateOf(false) }
    LaunchedEffect(line.autoOpen) { if (line.autoOpen) { delay(2000); open = true } }
    Box {
        Row(
            Modifier.clickable(role = Role.Button) { open = true }.padding(top = 5.dp, bottom = 5.dp, end = 8.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            Text(line.label, color = Theme.secondaryInk, style = mono(12, FontWeight.Medium), maxLines = 1)
            DownGlyph(Theme.secondaryInk)
        }
        if (open) {
            Popup(popupPositionProvider = AbovePopup, onDismissRequest = { open = false }, properties = PopupProperties(focusable = true)) {
                val classic = LocalLook.current.isClassic
                Box(
                    Modifier.then(if (classic) Modifier.clip(androidx.compose.foundation.shape.RoundedCornerShape(12.dp)).background(Theme.panel) else Modifier.background(Theme.base).border(1.dp, Theme.ink, RectangleShape))
                        .width(228.dp).padding(horizontal = 14.dp, vertical = 12.dp),
                ) {
                    EffortPicker(levels = line.levels, level = line.level, enabled = line.locked == null, note = line.locked, choose = line.choose) {
                        Text(lookWord(line.heading), color = Theme.ink, style = mono(13, FontWeight.SemiBold))
                    }
                }
            }
        }
    }
}

private object AbovePopup : PopupPositionProvider {
    override fun calculatePosition(anchorBounds: IntRect, windowSize: IntSize, layoutDirection: LayoutDirection, popupContentSize: IntSize): IntOffset {
        val x = anchorBounds.left.coerceIn(8, maxOf(8, windowSize.width - popupContentSize.width - 8))
        val y = (anchorBounds.top - popupContentSize.height - 4).coerceAtLeast(0)
        return IntOffset(x, y)
    }
}

// MARK: renaming

/** `Rename`: the terminal's name, empty to go back to its automatic one. The system's own kind of dialog, in the look's frame. */
@Composable
private fun RenameDialog(current: String, onSave: (String) -> Unit, onCancel: () -> Unit) {
    var text by remember { mutableStateOf(TextFieldValue(current, TextRange(current.length))) }
    val focus = remember { FocusRequester() }
    val classic = LocalLook.current.isClassic
    LaunchedEffect(Unit) { focus.requestFocus() }
    Dialog(onDismissRequest = onCancel, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(Modifier.padding(horizontal = 28.dp)) {
            if (!classic) DitherShadow(Modifier.matchParentSize().offset(6.dp, 6.dp))
            Column(
                Modifier.fillMaxWidth().grounded(Theme.base, 14.dp).framed(if (classic) Theme.line else Theme.ink, 14.dp).padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text("Rename", color = Theme.ink, style = mono(14, FontWeight.SemiBold))
                Column {
                    androidx.compose.foundation.text.BasicTextField(
                        value = text, onValueChange = { text = it }, singleLine = true, textStyle = plain(16).copy(color = Theme.ink),
                        cursorBrush = androidx.compose.ui.graphics.SolidColor(Theme.signal), modifier = Modifier.fillMaxWidth().focusRequester(focus),
                        decorationBox = { inner ->
                            Box(Modifier.padding(vertical = 6.dp)) {
                                if (text.text.isEmpty()) Text("名称（留空恢复自动命名）", color = Theme.inkDim, style = plain(16), maxLines = 1)
                                inner()
                            }
                        },
                    )
                    HairRule()
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Theme.Space.m)) {
                    SquareButton("Cancel", onCancel, Modifier.weight(1f))
                    SquareButton("Save", { onSave(text.text.trim()) }, Modifier.weight(1f), prominent = true)
                }
            }
        }
    }
}

// MARK: what the pickers bring

/** Files picked in the system's picker: read whole; one over the limit is not read at all (its name is given back). */
private fun readFiles(context: Context, uris: List<Uri>): Pair<List<UploadFile>, List<String>> {
    val files = ArrayList<UploadFile>()
    val skipped = ArrayList<String>()
    for (uri in uris) {
        val (name, size) = nameAndSize(context, uri)
        val label = name ?: uri.lastPathSegment ?: "file"
        if (size > PendingAttachment.maxFileBytes) { skipped.add(label); continue }
        val data = try { context.contentResolver.openInputStream(uri)?.use { it.readBytes() } } catch (_: Exception) { null }
        if (data == null || data.size > PendingAttachment.maxFileBytes) { skipped.add(label); continue }
        val type = context.contentResolver.getType(uri) ?: "application/octet-stream"
        files.add(UploadFile(label, type, data))
    }
    return files to skipped
}

/** Images on the clipboard, as the files they are sent as (the `+` menu's `Paste Image`; the keyboard's own offer goes through `ReplyBox`). */
private fun pastedImages(context: Context): List<UploadFile> {
    val clip = (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).primaryClip ?: return emptyList()
    val uris = (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }.filter { context.contentResolver.getType(it)?.startsWith("image/") == true }
    return uris.mapIndexedNotNull { i, uri -> readPicture(context, uri, if (uris.size == 1) "pasted" else "pasted-${i + 1}") }
}

/** `record.textStep` as a whole number, whichever way the Settings page keeps it. */
private fun readStep(settings: com.agentswitch.android.AppSettings): Int = try {
    settings.float(RecordTextSize.key, 0f).toInt()
} catch (_: Exception) {
    settings.string(RecordTextSize.key)?.toIntOrNull() ?: 0
}

// MARK: glyphs (the classic look's line icons, and what the pixel look has no character for)

@Composable
private fun CrossGlyph(color: Color, size: Dp) {
    if (LocalLook.current.isClassic) {
        Canvas(Modifier.size(size * 0.6f)) {
            val w = 1.8.dp.toPx()
            drawLine(color, Offset(0f, 0f), Offset(this.size.width, this.size.height), w, StrokeCap.Round)
            drawLine(color, Offset(this.size.width, 0f), Offset(0f, this.size.height), w, StrokeCap.Round)
        }
    } else {
        Text("×", color = color, style = com.agentswitch.android.design.code((size.value).toInt()), maxLines = 1)
    }
}

@Composable
private fun DownGlyph(color: Color) {
    if (LocalLook.current.isClassic) {
        Canvas(Modifier.size(width = 8.dp, height = 5.dp)) {
            val w = 1.6.dp.toPx()
            drawLine(color, Offset(0f, 0f), Offset(size.width / 2, size.height), w, StrokeCap.Round)
            drawLine(color, Offset(size.width, 0f), Offset(size.width / 2, size.height), w, StrokeCap.Round)
        }
    } else {
        Text("▾", color = color, style = com.agentswitch.android.design.code(10), maxLines = 1)
    }
}

@Composable
private fun KeyboardGlyph(color: Color) {
    // `keyboard.chevron.compact.down`: a keyboard's key rows with a chevron under them.
    Canvas(Modifier.size(width = 22.dp, height = 18.dp)) {
        val w = 1.4.dp.toPx()
        drawRoundRect(color, Offset(w / 2, w / 2), Size(size.width - w, size.height * 0.62f), CornerRadius(2.dp.toPx()), Stroke(w))
        val dot = 1.6.dp.toPx()
        for (r in 0 until 2) for (c in 0 until 5) drawRect(color, Offset(4.dp.toPx() + c * 3.2.dp.toPx(), 3.5.dp.toPx() + r * 3.6.dp.toPx()), Size(dot, dot))
        drawLine(color, Offset(size.width * 0.32f, size.height * 0.82f), Offset(size.width * 0.5f, size.height * 0.98f), w, StrokeCap.Round)
        drawLine(color, Offset(size.width * 0.68f, size.height * 0.82f), Offset(size.width * 0.5f, size.height * 0.98f), w, StrokeCap.Round)
    }
}

@Composable
private fun PlusCircleGlyph(color: Color) {
    Canvas(Modifier.size(26.dp)) {
        val w = 1.2.dp.toPx()
        drawCircle(color, size.minDimension / 2 - w, style = Stroke(w))
        drawLine(color, Offset(size.width * 0.3f, size.height / 2), Offset(size.width * 0.7f, size.height / 2), w, StrokeCap.Round)
        drawLine(color, Offset(size.width / 2, size.height * 0.3f), Offset(size.width / 2, size.height * 0.7f), w, StrokeCap.Round)
    }
}

@Composable
private fun ArrowUpGlyph(color: Color) {
    Canvas(Modifier.size(15.dp)) {
        val w = 2.dp.toPx()
        drawLine(color, Offset(size.width / 2, size.height), Offset(size.width / 2, 0f), w, StrokeCap.Round)
        drawLine(color, Offset(size.width * 0.1f, size.height * 0.42f), Offset(size.width / 2, 0f), w, StrokeCap.Round)
        drawLine(color, Offset(size.width * 0.9f, size.height * 0.42f), Offset(size.width / 2, 0f), w, StrokeCap.Round)
    }
}

@Composable
private fun TerminalGlyph(color: Color) {
    // `terminal`: a rounded frame with a prompt.
    Canvas(Modifier.size(width = 24.dp, height = 18.dp)) {
        val w = 1.5.dp.toPx()
        drawRoundRect(color, Offset(w / 2, w / 2), Size(size.width - w, size.height - w), CornerRadius(3.dp.toPx()), Stroke(w))
        val p = Path().apply { moveTo(5.dp.toPx(), 5.dp.toPx()); lineTo(9.dp.toPx(), 9.dp.toPx()); lineTo(5.dp.toPx(), 13.dp.toPx()) }
        drawPath(p, color, style = Stroke(w, cap = StrokeCap.Round, join = StrokeJoin.Round))
        drawLine(color, Offset(11.dp.toPx(), 13.dp.toPx()), Offset(17.dp.toPx(), 13.dp.toPx()), w, StrokeCap.Round)
    }
}

@Composable
private fun AlignLeftGlyph(color: Color) {
    Canvas(Modifier.size(20.dp)) {
        val w = 1.8.dp.toPx()
        for ((i, f) in listOf(1f, 0.62f, 1f, 0.62f).withIndex()) {
            val y = size.height * (0.12f + i * 0.253f)
            drawLine(color, Offset(0f, y), Offset(size.width * f, y), w, StrokeCap.Round)
        }
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

@Composable
private fun FileGlyph(folder: Boolean, color: Color) {
    Canvas(Modifier.size(18.dp)) {
        val w = 1.3.dp.toPx()
        if (folder) {
            val p = Path().apply {
                moveTo(0f, size.height * 0.2f); lineTo(size.width * 0.38f, size.height * 0.2f); lineTo(size.width * 0.5f, size.height * 0.34f)
                lineTo(size.width, size.height * 0.34f); lineTo(size.width, size.height * 0.88f); lineTo(0f, size.height * 0.88f); close()
            }
            drawPath(p, color, style = Stroke(w, join = StrokeJoin.Round))
        } else {
            val p = Path().apply {
                moveTo(size.width * 0.15f, 0f); lineTo(size.width * 0.62f, 0f); lineTo(size.width * 0.88f, size.height * 0.26f)
                lineTo(size.width * 0.88f, size.height); lineTo(size.width * 0.15f, size.height); close()
            }
            drawPath(p, color, style = Stroke(w, join = StrokeJoin.Round))
        }
    }
}

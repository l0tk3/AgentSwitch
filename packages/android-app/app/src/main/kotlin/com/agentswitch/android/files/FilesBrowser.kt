package com.agentswitch.android.files

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentswitch.android.AppSettings
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.LocalSettings
import com.agentswitch.android.demo.DemoFiles
import com.agentswitch.android.demo.LocalDemo
import com.agentswitch.android.demo.LocalDemoScreen
import com.agentswitch.android.design.BarBack
import com.agentswitch.android.design.BarWord
import com.agentswitch.android.design.BrailleSpinner
import com.agentswitch.android.design.HairRule
import com.agentswitch.android.design.LocalLook
import com.agentswitch.android.design.NavBar
import com.agentswitch.android.design.PixelBox
import com.agentswitch.android.design.PixelBoxEffect
import com.agentswitch.android.design.PixelSprite
import com.agentswitch.android.design.Scanlines
import com.agentswitch.android.design.SquareButton
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.code
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.android.onboarding.MacLine
import com.agentswitch.android.terminals.ConnectionBanner
import com.agentswitch.android.terminals.LookSymbol
import com.agentswitch.android.terminals.LookSymbolIcon
import com.agentswitch.kit.api.FileRefusal
import com.agentswitch.kit.api.FileSize
import com.agentswitch.kit.api.FileSort
import com.agentswitch.kit.api.FileTime
import com.agentswitch.kit.api.MacFileEntry
import com.agentswitch.kit.api.MacFolder
import com.agentswitch.kit.api.MacPath
import com.agentswitch.kit.api.MacPick
import com.agentswitch.kit.design.PixelArt
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// The Mac's files on the phone (docs/files-v0.md §5): a stack of pages, one level at a time, as iOS Files has them — the
// folder's name in the bar with the Mac under it, its whole path under the bar (every level a button), the list, and
// `Select` and `⋯` (hidden files, the order, home). The classic look is iOS Files' list; the pixel look draws the level
// in tree lines, a folder's `▸` opening one level in place. A file opens its preview. The Files tab and `+` › Files on
// Mac over a terminal are this same browser; what differs is where the picks go (`FilesSession.Mode`).
//
// What differs from the iPhone: the pages are a stack of this composable's own (`FilesSession.stack`), the system's back
// gesture takes one off; a level is read again
// every few seconds, there is no pull to refresh; menus and questions are the look's boxes (`PixelBox`); a menu's
// submenu (Sort By, Upload) is a second menu.

/** `⋯`'s two choices, as one value the pages share (the iPhone's `@AppStorage`). */
@Stable
class FilesViewPrefs(private val settings: AppSettings) {
    var hidden by mutableStateOf(settings.bool(FilesPrefs.hiddenKey, false))
        private set
    var sort by mutableStateOf(FileSort.entries.firstOrNull { it.rawValue == settings.string(FilesPrefs.sortKey) } ?: FileSort.Name)
        private set

    fun chooseHidden(value: Boolean) { hidden = value; settings.putBool(FilesPrefs.hiddenKey, value) }
    fun chooseSort(value: FileSort) { sort = value; settings.putString(FilesPrefs.sortKey, value.rawValue) }
}

/**
 * The browser. `onPick`: picks that are to land (checked, and asked about when one may hold a password). `onClose`: the
 * way out of a sheet (`Done`, and after a hand-off to another terminal); null on the tab.
 */
@Composable
fun FilesBrowser(session: FilesSession, onPick: (List<MacPick>) -> Unit, modifier: Modifier = Modifier, onClose: (() -> Unit)? = null) {
    val context = LocalContext.current
    val settings = LocalSettings.current
    val prefs = remember { FilesViewPrefs(settings) }
    val shareMode = remember { ShareMode() }
    val models = remember { HashMap<String, FolderModel>() }
    SideEffect { ShareCache.clearOnce(context) }
    val stack = session.stack

    // On the tab, the tab bar goes while selecting and on a file's page (FilesBrowser.swift, FilePreviewPage.swift).
    val barHidden = com.agentswitch.android.LocalTabBarHidden.current
    val wantsBarHidden = session.inTab && (session.selecting || stack.lastOrNull() is FilesRoute.File)
    androidx.compose.runtime.DisposableEffect(wantsBarHidden) { barHidden.value = wantsBarHidden; onDispose { barHidden.value = false } }

    // The page's own way back: one page off the stack.
    BackHandler(enabled = stack.isNotEmpty()) { session.stack = stack.dropLast(1) }

    val keys = HashSet<String>()
    fun model(key: String, path: String?): FolderModel { keys.add(key); return models.getOrPut(key) { FolderModel(path) } }
    Box(modifier.fillMaxSize().background(Theme.base)) {
        when (val top = stack.lastOrNull()) {
            null -> androidx.compose.runtime.key(session.root ?: "") {
                FolderPage(model("root", session.root), session, prefs, true, onPick, onClose, shareMode)
            }
            is FilesRoute.Folder -> androidx.compose.runtime.key(stack.size, top.path) {
                FolderPage(model("${stack.size}:${top.path}", top.path), session, prefs, false, onPick, onClose, shareMode)
            }
            is FilesRoute.File -> androidx.compose.runtime.key(top.path) { FilePreviewPage(top.path, session, onPick, shareMode) }
        }
        // The first page's model is kept under one key, the others by their depth: the rest are let go.
        SideEffect { models.keys.retainAll(keys) }
        FileQuestions(session, shareMode, Modifier.align(Alignment.BottomCenter))
        if (session.asksTerminal && session.choosing != null) {
            TerminalChooser(session.choosing ?: emptyList(), session, onDelivered = { onClose?.invoke() })
        }
    }
}

/** `+` › Files on Mac over a terminal's page: the browser at the terminal's folder; what is picked lands in its reply box. */
@Composable
fun MacFilesSheet(terminal: String, start: String, file: String? = null, onPick: (List<MacPick>) -> Unit, onClose: () -> Unit) {
    val session = remember { FilesSession(FilesSession.Mode.Sheet(terminal), start).also { s -> if (file != null) s.stack = listOf(FilesRoute.File(file)) } }
    FilesBrowser(session, onPick, onClose = onClose)
}

/** `Show in Files` from an earlier session's page (docs/files-v0.md §12.4.1): the browser over the page, `Done` back to it. */
@Composable
fun MacFilesOverSheet(start: String, onClose: () -> Unit) {
    val session = remember { FilesSession(FilesSession.Mode.Over, start) }
    FilesBrowser(session, { }, onClose = onClose)
}

private class MenuSpec(val anchor: Rect, val actions: List<PixelBox.Action>, val width: androidx.compose.ui.unit.Dp = 220.dp)

private class RowSpec(val entry: MacFileEntry, val dir: String, val last: Boolean, val depth: Int, val underLast: Boolean) {
    val path: String get() = MacPath.join(dir, entry.name)
}

/** One folder's page. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun FolderPage(
    folder: FolderModel,
    session: FilesSession,
    prefs: FilesViewPrefs,
    first: Boolean,
    onPick: (List<MacPick>) -> Unit,
    onClose: (() -> Unit)?,
    shareMode: ShareMode,
) {
    val model = LocalAppModel.current
    val classic = LocalLook.current.isClassic
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val demoScreen = if (LocalDemo.current) LocalDemoScreen.current else null
    val hidden = prefs.hidden
    val sort = prefs.sort
    val hiddenNow by rememberUpdatedState(hidden)
    val mac = model.profile?.name ?: "Mac"
    val level = folder.folder
    var menu by remember { mutableStateOf<MenuSpec?>(null) }
    var moreBounds by remember { mutableStateOf(Rect.Zero) }
    val rowBounds = remember { HashMap<String, Rect>() }

    LaunchedEffect(hidden, model.api) { folder.follow({ model.fileSource }, { hiddenNow }) }
    // `filesopen`: the pixel look's `▸` on `src`, as a tap would open it in place.
    LaunchedEffect(Unit) {
        if (first && demoScreen == "filesopen") { delay(400); folder.toggle("${DemoFiles.project}/src", model.fileSource, hiddenNow) }
    }
    LaunchedEffect(level?.path) {
        if (session.inTab && level != null) model.files.remember(level.path, model.profile?.fingerprint)
        level?.home?.let { model.files.home = it }
    }
    // Changed from this phone just now (made, renamed, moved, landed): read again at once.
    LaunchedEffect(model.files.changed) { if (model.files.changed > 0) folder.load(model.fileSource, hiddenNow) }
    // What was just made or landed lights up once.
    LaunchedEffect(model.files.lit) {
        if (model.files.lit != null) { delay(1600); model.files.lit = null }
    }

    val taken = level?.entries?.map { it.name }?.toSet() ?: emptySet()

    fun send(files: List<java.io.File>) {
        val dir = level?.path ?: return
        if (files.isEmpty()) return
        model.files.macName = mac
        val asking = model.files.send(files, dir, taken) { model.fileSource }
        if (asking.isNotEmpty()) session.clashing = FilesSession.Clashing(asking, model.files.uploads.filter { it.id in asking }.map { it.name })
    }
    val pickers = rememberUploadPickers { send(it) }

    fun askTrash(paths: List<String>) {
        if (paths.isEmpty()) return
        val running = paths.firstNotNullOfOrNull { FilesSession.runningIn(it, model.terminals.terminals) }
        session.trashing = FilesSession.Trashing(paths, terminal = running?.name)
    }

    fun give(picks: List<MacPick>) {
        if (picks.isEmpty()) return
        scope.launch {
            val checked = session.checked(picks, model.fileSource)
            if (session.asksTerminal) session.choosing = checked
            else session.land(checked) { landed -> session.endSelecting(); onPick(landed) }
        }
    }

    // MARK: menus

    fun uploadMenu(anchor: Rect) {
        val rows = ArrayList<PixelBox.Action>()
        if (pickers.hasCamera) rows += PixelBox.Action("Camera") { pickers.takePhoto() }
        rows += PixelBox.Action("Photos") { pickers.pickPhotos() }
        rows += PixelBox.Action("Files") { pickers.pickFiles() }
        menu = MenuSpec(anchor, rows, 180.dp)
    }

    fun sortMenu(anchor: Rect) {
        menu = MenuSpec(anchor, FileSort.entries.map { s -> PixelBox.Action((if (s == sort) "✓ " else "   ") + s.title) { prefs.chooseSort(s) } })
    }

    fun moreMenu(anchor: Rect) {
        val rows = ArrayList<PixelBox.Action>()
        val here = level?.path
        if (here != null && here != "/") {
            rows += PixelBox.Action("New Folder") { session.naming = FilesSession.Naming(FilesSession.Naming.Kind.Folder(here), taken, "") }
            rows += PixelBox.Action("New File") { session.naming = FilesSession.Naming(FilesSession.Naming.Kind.File(here), taken, "") }
            rows += PixelBox.Action("Upload ›") { uploadMenu(anchor) }
        }
        rows += PixelBox.Action((if (hidden) "✓ " else "   ") + "Show Hidden Files") { prefs.chooseHidden(!hidden) }
        rows += PixelBox.Action("Sort By ›") { sortMenu(anchor) }
        rows += PixelBox.Action("Home") { session.root = null; session.stack = emptyList() }
        menu = MenuSpec(anchor, rows)
    }

    /** A long press on a row (files-v0 §12.3, iOS Files): give it, share it, its path; its new name; the Mac's Trash last and red. */
    fun rowMenu(entry: MacFileEntry, path: String, dir: String) {
        val rows = ArrayList<PixelBox.Action>()
        rows += PixelBox.Action(if (session.asksTerminal) "Add to Reply…" else "Add to Reply") { give(listOf(MacPick(path, entry.isFolder))) }
        if (!entry.isFolder) rows += PixelBox.Action("Share…") { shareMode.save = false; session.share(listOf(path), model.fileSource, model.files, scope) }
        rows += PixelBox.Action("Copy Path") { copyText(context, path) }
        if (entry.changeable) {
            rows += PixelBox.Action("Rename…") {
                val names = if (dir == level?.path) taken else folder.opened[dir]?.map { it.name }?.toSet() ?: emptySet()
                session.naming = FilesSession.Naming(FilesSession.Naming.Kind.Rename(path), names, entry.name)
            }
            rows += PixelBox.Action("Move to Trash", PixelBox.Action.Role.Destructive) { askTrash(listOf(path)) }
        }
        menu = MenuSpec(rowBounds[path] ?: Rect.Zero, rows)
    }

    PixelBoxEffect(menu, { menu = null }) { PixelBox(cancel = null, actions = it.actions, anchor = it.anchor, width = it.width) }

    // MARK: the page

    Column(Modifier.fillMaxSize().background(Theme.base)) {
        NavBar(
            title = folder.path?.let { MacPath.name(it) } ?: "Files",
            subtitle = {
                if (session.selecting && session.asksTerminal) Text("${session.picked.size} Selected", color = Theme.secondaryInk, style = mono(11), maxLines = 1)
                // The tab's first page switches Macs; a folder further in, or a sheet over a terminal, only says which.
                else MacLine(switches = first && session.inTab)
            },
            leading = {
                if (!first) BarBack({ session.stack = session.stack.dropLast(1) })
                else if (!session.inTab && !session.selecting && onClose != null) BarWord("Done", onClose)
            },
            trailing = {
                BarWord(if (session.selecting) "Cancel" else "Select", { if (session.selecting) session.endSelecting() else session.selecting = true }, enabled = level != null)
                Box(
                    Modifier.onGloballyPositioned { moreBounds = it.boundsInRoot() }.heightIn(min = 44.dp).width(44.dp)
                        .clickable(role = Role.Button, onClickLabel = "More") { moreMenu(moreBounds) },
                    contentAlignment = Alignment.Center,
                ) { MoreGlyph(Theme.ink) }
            },
        )
        if (folder.path != null) PathRow(folder.path!!, session)
        HairRule()
        Box(Modifier.weight(1f).fillMaxWidth()) {
            if (!classic) Scanlines(Modifier.fillMaxSize())
            LazyColumn(Modifier.fillMaxSize()) {
                if (model.connection.endpoint == null && model.fileSource == null) item { ConnectionBanner(Modifier.padding(Theme.Space.l)) }
                val refusal = folder.refusal
                if (refusal != null) {
                    item { Note(refusal.sentence(mac), home = refusal == FileRefusal.Scope || refusal == FileRefusal.NotFound) { session.root = null; session.stack = emptyList() } }
                } else if (level != null) {
                    folder.failure?.let { f -> item { Text(f, Modifier.padding(Theme.Space.l), color = Theme.failed, style = plain(13)) } }
                    folder.gone?.let { g ->
                        item {
                            Text(
                                "$mac 上没有“${MacPath.name(g)}”，已打开它最近的上一层。",
                                Modifier.padding(start = Theme.Space.l, end = Theme.Space.l, top = Theme.Space.m), color = Theme.secondaryInk, style = plain(13),
                            )
                        }
                    }
                    val ups = model.files.uploads.filter { it.dir == level.path }
                    items(ups, key = { "up:" + it.id }) { up -> UploadRow(up, { model.files.stop(up.id) }, { model.files.retry(up.id) { model.fileSource } }) }
                    val entries = sort.sorted(level.entries)
                    if (entries.isEmpty() && ups.isEmpty()) {
                        item { Note(if (level.scoped) "仅显示授权范围内的项目。" else "此文件夹为空。") }
                    } else {
                        val specs = ArrayList<RowSpec>()
                        entries.forEachIndexed { i, entry ->
                            val path = MacPath.join(level.path, entry.name)
                            specs.add(RowSpec(entry, level.path, i == entries.size - 1 && !folder.isOpen(path), 0, false))
                            // The pixel look's folder opened in place: its level under it.
                            val kids = if (!classic && entry.isFolder) folder.opened[path] else null
                            if (kids != null) {
                                val sorted = sort.sorted(kids.filter { hidden || !it.hidden })
                                sorted.forEachIndexed { k, kid -> specs.add(RowSpec(kid, path, k == sorted.size - 1, 1, i == entries.size - 1)) }
                            }
                        }
                        items(specs, key = { it.path }) { spec ->
                            val entry = spec.entry
                            val path = spec.path
                            FileRow(
                                entry = entry,
                                picked = session.isPicked(path) || model.files.lit == path,
                                selecting = session.selecting,
                                last = spec.last, depth = spec.depth, underLast = spec.underLast,
                                open = folder.isOpen(path),
                                toggle = if (entry.isFolder && spec.depth == 0 && !entry.locked) ({ scope.launch { folder.toggle(path, model.fileSource, hidden) } }) else null,
                                modifier = Modifier.onGloballyPositioned { rowBounds[path] = it.boundsInRoot() },
                                onClick = {
                                    if (!entry.locked) {
                                        if (session.selecting) session.togglePick(MacPick(path, entry.isFolder))
                                        else session.stack = session.stack + (if (entry.isFolder) FilesRoute.Folder(path) else FilesRoute.File(path))
                                    }
                                },
                                onLongClick = if (!entry.locked && !session.selecting) ({ rowMenu(entry, path, spec.dir) }) else null,
                            )
                        }
                        item { Footer(level, entries.size, hidden) }
                    }
                } else if (folder.failure != null) {
                    item { Note(folder.failure ?: "") }
                } else {
                    item {
                        Row(Modifier.padding(Theme.Space.l), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            BrailleSpinner(color = Theme.secondaryInk)
                            Text("Loading", color = Theme.secondaryInk, style = mono(12))
                        }
                    }
                }
            }
        }
        if (session.selecting) {
            SelectBar(
                session, give = { give(session.picked) },
                share = if (session.asksTerminal) ({ shareMode.save = false; session.share(session.picked.map { it.path }, model.fileSource, model.files, scope) }) else null,
                trash = if (session.asksTerminal) ({ askTrash(session.picked.map { it.path }) }) else null,
                modifier = if (session.inTab) Modifier else Modifier.windowInsetsPadding(WindowInsets.navigationBars),
            )
        } else if (!session.inTab) {
            Spacer(Modifier.windowInsetsPadding(WindowInsets.navigationBars))
        }
    }
}

private fun copyText(context: Context, text: String) {
    (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("path", text))
}

@Composable
private fun Note(words: String, home: Boolean = false, goHome: () -> Unit = {}) {
    Column(Modifier.fillMaxWidth().padding(Theme.Space.l), verticalArrangement = Arrangement.spacedBy(Theme.Space.m)) {
        Text(words, color = Theme.secondaryInk, style = plain(15))
        if (home) SquareButton("Home", goHome, expand = false)
    }
}

@Composable
private fun Footer(level: MacFolder, shown: Int, hidden: Boolean) {
    Column(Modifier.fillMaxWidth().padding(horizontal = Theme.Space.l, vertical = Theme.Space.m), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (level.scoped) Text("仅显示授权范围内的项目。", color = Theme.secondaryInk, style = plain(13))
        if (level.more > 0) Text("还有 ${level.more} 项未列出。", color = Theme.secondaryInk, style = plain(13))
        val count = if (shown == 1) "1 Item" else "$shown Items"
        Text(listOfNotNull(count, if (level.hiddenCount > 0 && !hidden) "${level.hiddenCount} Hidden" else null).joinToString(" · "), color = Theme.inkDim, style = mono(11))
    }
}

/** `⋯` in a bar: the three dots in the pixel look, the system's circled ellipsis in the classic one. */
@Composable
fun MoreGlyph(tint: Color) {
    if (LocalLook.current.isClassic) {
        Canvas(Modifier.size(24.dp)) {
            val w = 1.5.dp.toPx()
            drawCircle(tint, size.minDimension / 2 - w, style = Stroke(w))
            for (i in -1..1) drawCircle(tint, 1.5.dp.toPx(), Offset(size.width / 2 + i * 5.dp.toPx(), size.height / 2))
        }
    } else {
        Text("⋯", color = tint, style = mono(17))
    }
}

// MARK: - rows

/**
 * One entry's row: iOS Files' (an icon, the name, when and how big, a chevron for a folder) or the pixel look's (tree
 * lines, `▸` for a folder, the name with `/`, its size). A tap on the row, not a button around it: the pixel look's `▸`
 * in it is a button of its own.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun FileRow(
    entry: MacFileEntry,
    picked: Boolean,
    selecting: Boolean,
    last: Boolean,
    modifier: Modifier = Modifier,
    depth: Int = 0,
    underLast: Boolean = false,
    open: Boolean = false,
    toggle: (() -> Unit)? = null,
    onClick: () -> Unit = {},
    onLongClick: (() -> Unit)? = null,
) {
    val classic = LocalLook.current.isClassic
    val faint = entry.hidden || entry.dim || entry.locked
    val meta = run {
        if (entry.locked) return@run ""
        val whenText = FileTime.short(entry.mtime)
        if (entry.isFolder) whenText else { val size = FileSize.short(entry.size); if (whenText.isEmpty()) size else "$whenText · $size" }
    }
    val tap = modifier.fillMaxWidth().combinedClickable(onClick = onClick, onLongClick = onLongClick)
    if (classic) {
        Box(tap.background(if (picked) Theme.signal.copy(alpha = 0.10f) else Color.Transparent)) {
            Row(Modifier.padding(vertical = 9.dp, horizontal = Theme.Space.l), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                if (selecting && !entry.locked) {
                    LookSymbolIcon(if (picked) LookSymbol.CheckCircleFill else LookSymbol.Circle, side = 21.dp, color = if (picked) Theme.signal else Theme.inkDim)
                }
                Box(Modifier.width(30.dp), contentAlignment = Alignment.Center) {
                    FileGlyph(FileKinds.of(entry), if (entry.isFolder && !entry.locked && !entry.dim && !entry.hidden) Theme.signal else Theme.secondaryInk)
                }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(entry.name, Modifier.weight(1f, fill = false), color = if (faint) Theme.secondaryInk else Theme.ink, style = plain(16), maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
                        entry.link?.let { Text("→ ${MacPath.name(it.target)}", color = Theme.inkDim, style = plain(13), maxLines = 1) }
                    }
                    if (meta.isNotEmpty()) Text(meta, color = Theme.secondaryInk, style = plain(12), maxLines = 1)
                }
                if (entry.isFolder && !selecting && !entry.locked) LookSymbolIcon(LookSymbol.ChevronRight, side = 13.dp, color = Theme.inkDim)
            }
            HairRule(Modifier.align(Alignment.BottomStart).padding(start = if (selecting) 92.dp else 58.dp), color = Theme.line)
        }
    } else {
        val bar = Theme.signal
        Box(tap.background(if (picked) Theme.raised else Color.Transparent).drawBehind { if (picked) drawRect(bar, size = Size(3.dp.toPx(), size.height)) }) {
            Row(Modifier.heightIn(min = 40.dp).padding(horizontal = Theme.Space.l), verticalAlignment = Alignment.CenterVertically) {
                if (selecting && !entry.locked) {
                    Text(if (picked) "[x]" else "[ ]", Modifier.padding(end = 8.dp), color = if (picked) Theme.signal else Theme.secondaryInk, style = code(13))
                }
                Text((if (depth > 0) (if (underLast) "   " else "│  ") else "") + (if (last) "└─" else "├─"), color = Theme.inkDim, style = code(13), softWrap = false)
                if (entry.isFolder && !entry.locked) {
                    if (toggle != null) {
                        Box(
                            Modifier.heightIn(min = 34.dp).width(22.dp).clickable(role = Role.Button, onClickLabel = if (open) "收起" else "展开", onClick = toggle),
                            contentAlignment = Alignment.Center,
                        ) { Text(if (open) "▾" else "▸", color = Theme.secondaryInk, style = code(13)) }
                    } else {
                        Box(Modifier.width(22.dp), contentAlignment = Alignment.Center) { Text("▸", color = Theme.inkDim, style = code(13)) }
                    }
                } else {
                    Text("─ ", color = Theme.inkDim, style = code(13), softWrap = false)
                }
                Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        entry.name + (if (entry.isFolder) "/" else ""), Modifier.weight(1f, fill = false),
                        color = if (faint) Theme.inkDim else Theme.ink,
                        style = code(13, if (entry.isFolder && !faint) FontWeight.Bold else FontWeight.Normal).copy(fontSize = 13.5.sp),
                        maxLines = 1, overflow = TextOverflow.MiddleEllipsis,
                    )
                    if (entry.locked) Text(" ⌧", color = Theme.inkDim, style = code(13))
                    entry.link?.let { Text(" → ${MacPath.name(it.target)}", color = Theme.inkDim, style = code(12), maxLines = 1) }
                    Spacer(Modifier.width(8.dp))
                }
                if (!entry.isFolder && !entry.locked) Text(FileSize.short(entry.size), color = Theme.inkDim, style = mono(11), maxLines = 1)
            }
            HairRule(Modifier.align(Alignment.BottomStart))
        }
    }
}

// MARK: - icons

/** What an entry is drawn as in the classic look: the folder in the accent, a file by its kind, the lock. */
enum class FileKind { Folder, Locked, Link, Photo, Pdf, Table, Zip, Audio, Film, Code, Text }

object FileKinds {
    fun of(entry: MacFileEntry): FileKind = when {
        entry.locked -> FileKind.Locked
        entry.isFolder -> FileKind.Folder
        entry.kind == MacFileEntry.Kind.Link -> FileKind.Link
        else -> of(entry.name)
    }

    fun of(name: String): FileKind = when (name.substringAfterLast('.', "").lowercase().takeIf { name.lastIndexOf('.') > 0 } ?: "") {
        "png", "jpg", "jpeg", "heic", "gif", "webp", "tiff", "bmp" -> FileKind.Photo
        "pdf" -> FileKind.Pdf
        "csv", "xlsx", "xls", "numbers" -> FileKind.Table
        "zip", "tar", "gz", "tgz", "7z", "dmg" -> FileKind.Zip
        "mp3", "m4a", "wav", "aac", "flac" -> FileKind.Audio
        "mp4", "mov", "m4v", "webm" -> FileKind.Film
        "ts", "tsx", "js", "jsx", "swift", "py", "rs", "go", "c", "h", "cpp", "java", "kt", "rb", "sh", "json", "yaml", "yml", "toml", "html", "css" -> FileKind.Code
        else -> FileKind.Text
    }
}

/** A light line icon for a kind of entry (the iPhone's SF Symbols `folder`, `doc.text`, `photo`, `lock`…), in a 22 dp square. */
@Composable
fun FileGlyph(kind: FileKind, color: Color, side: androidx.compose.ui.unit.Dp = 22.dp) {
    if (kind == FileKind.Folder) { LookSymbolIcon(LookSymbol.Folder, side = side, color = color); return }
    Canvas(Modifier.size(side)) {
        val s = size.width
        val line = maxOf(1f, s * 0.07f)
        val stroke = Stroke(line, cap = StrokeCap.Round, join = StrokeJoin.Round)
        fun p(x: Float, y: Float) = Offset(x * s, y * s)
        fun seg(a: Pair<Float, Float>, b: Pair<Float, Float>) = drawLine(color, p(a.first, a.second), p(b.first, b.second), line, StrokeCap.Round)
        if (kind == FileKind.Locked) {
            drawRoundRect(color, p(0.2f, 0.45f), Size(0.6f * s, 0.43f * s), androidx.compose.ui.geometry.CornerRadius(s * 0.08f), stroke)
            val shackle = Path().apply { moveTo(0.32f * s, 0.45f * s); lineTo(0.32f * s, 0.32f * s); quadraticTo(0.32f * s, 0.1f * s, 0.5f * s, 0.1f * s); quadraticTo(0.68f * s, 0.1f * s, 0.68f * s, 0.32f * s); lineTo(0.68f * s, 0.45f * s) }
            drawPath(shackle, color, style = stroke)
            return@Canvas
        }
        // A page with a folded corner.
        val page = Path().apply {
            moveTo(0.2f * s, 0.1f * s); lineTo(0.62f * s, 0.1f * s); lineTo(0.8f * s, 0.28f * s); lineTo(0.8f * s, 0.9f * s); lineTo(0.2f * s, 0.9f * s); close()
        }
        drawPath(page, color, style = stroke)
        seg(0.62f to 0.1f, 0.62f to 0.28f); seg(0.62f to 0.28f, 0.8f to 0.28f)
        when (kind) {
            FileKind.Photo -> { drawCircle(color, s * 0.05f, p(0.38f, 0.5f)); seg(0.26f to 0.8f, 0.45f to 0.62f); seg(0.45f to 0.62f, 0.6f to 0.74f); seg(0.6f to 0.74f, 0.74f to 0.6f) }
            FileKind.Code -> { seg(0.42f to 0.5f, 0.32f to 0.62f); seg(0.32f to 0.62f, 0.42f to 0.74f); seg(0.58f to 0.5f, 0.68f to 0.62f); seg(0.68f to 0.62f, 0.58f to 0.74f) }
            FileKind.Table -> { seg(0.3f to 0.55f, 0.7f to 0.55f); seg(0.3f to 0.72f, 0.7f to 0.72f); seg(0.5f to 0.45f, 0.5f to 0.8f) }
            FileKind.Zip -> { seg(0.5f to 0.14f, 0.5f to 0.34f); seg(0.5f to 0.42f, 0.5f to 0.5f); seg(0.4f to 0.6f, 0.6f to 0.6f); seg(0.4f to 0.6f, 0.4f to 0.78f); seg(0.6f to 0.6f, 0.6f to 0.78f); seg(0.4f to 0.78f, 0.6f to 0.78f) }
            FileKind.Audio -> { for ((i, h) in listOf(0.1f, 0.2f, 0.12f, 0.24f, 0.1f).withIndex()) seg((0.3f + i * 0.1f) to (0.62f - h / 2), (0.3f + i * 0.1f) to (0.62f + h / 2)) }
            FileKind.Film -> { drawRoundRect(color, p(0.3f, 0.48f), Size(0.4f * s, 0.28f * s), androidx.compose.ui.geometry.CornerRadius(s * 0.04f), stroke); seg(0.44f to 0.56f, 0.56f to 0.62f); seg(0.56f to 0.62f, 0.44f to 0.68f) }
            FileKind.Link -> { seg(0.34f to 0.72f, 0.66f to 0.46f); seg(0.5f to 0.46f, 0.66f to 0.46f); seg(0.66f to 0.46f, 0.66f to 0.62f) }
            FileKind.Pdf -> { seg(0.3f to 0.5f, 0.7f to 0.5f); seg(0.3f to 0.62f, 0.7f to 0.62f); seg(0.3f to 0.74f, 0.5f to 0.74f) }
            else -> { seg(0.3f to 0.5f, 0.7f to 0.5f); seg(0.3f to 0.62f, 0.7f to 0.62f); seg(0.3f to 0.74f, 0.55f to 0.74f) }
        }
    }
}

// MARK: - the path under the bar

/**
 * The folder's whole path under the bar (files-v0 §3.2): from `/`, every level a button that goes back to it. When it
 * does not fit, `/` and the levels nearest this folder stay and the ones between fold into `…`, a menu of them (as the
 * Mac's path control folds its middle) — so every level is still one tap away and the row never has to be scrolled.
 * (What fits is worked out from the characters' width: the iPhone's `ViewThatFits` measures.)
 */
@Composable
private fun PathRow(path: String, session: FilesSession) {
    val classic = LocalLook.current.isClassic
    val levels = remember(path) { MacPath.levels(path) }
    var menu by remember { mutableStateOf<MenuSpec?>(null) }
    var foldBounds by remember { mutableStateOf(Rect.Zero) }
    PixelBoxEffect(menu, { menu = null }) { PixelBox(cancel = null, actions = it.actions, anchor = it.anchor, width = 220.dp) }
    BoxWithConstraints(Modifier.fillMaxWidth().padding(horizontal = Theme.Space.l, vertical = 8.dp)) {
        val avail = maxWidth.value
        fun widthOf(folded: Int): Float {
            val shown = listOf(levels[0]) + levels.drop(1 + folded)
            val names = shown.sumOf { it.name.length }
            return if (classic) names * 7f + 24f * (shown.size + (if (folded > 0) 1 else 0))
            else (names + 3 * (shown.size - 1) - 2 + (if (folded > 0) 4 else 0)) * 7.5f
        }
        val maxFolded = maxOf(0, levels.size - 2)
        var folded = 0
        while (folded < maxFolded && widthOf(folded) > avail) folded++
        val shown = listOf(levels[0]) + levels.drop(1 + folded)
        val hiddenLevels = levels.drop(1).take(folded)

        @Composable
        fun chip(name: String, current: Boolean, modifier: Modifier) {
            if (classic) {
                Text(
                    name, modifier.background(if (current) Theme.signal.copy(alpha = 0.16f) else Theme.raised, RoundedCornerShape(50)).padding(horizontal = 9.dp, vertical = 3.dp),
                    color = if (current) Theme.signal else Theme.ink, style = plain(12, if (current) FontWeight.SemiBold else FontWeight.Normal).copy(fontSize = 12.5.sp), maxLines = 1,
                )
            } else {
                Text(name, modifier.padding(vertical = 4.dp), color = if (current) Theme.ink else Theme.secondaryInk, style = code(12, if (current) FontWeight.Bold else FontWeight.Normal).copy(fontSize = 12.5.sp), maxLines = 1)
            }
        }

        @Composable
        fun separator(afterRoot: Boolean) {
            if (!classic) Text(if (afterRoot) " " else " / ", color = Theme.inkDim, style = code(12).copy(fontSize = 12.5.sp), softWrap = false)
        }

        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(if (classic) 6.dp else 0.dp)) {
            val root = levels[0]
            chip(root.name, levels.size == 1, Modifier.clickable(role = Role.Button, onClickLabel = root.path) { session.go(root.path) })
            if (hiddenLevels.isNotEmpty()) {
                separator(true)
                chip(
                    "…", false,
                    Modifier.onGloballyPositioned { foldBounds = it.boundsInRoot() }.semantics { contentDescription = "上层文件夹" }
                        .clickable(role = Role.Button) {
                            menu = MenuSpec(foldBounds, hiddenLevels.reversed().map { l -> PixelBox.Action(l.name) { session.go(l.path) } })
                        },
                )
            }
            shown.drop(1).forEachIndexed { i, l ->
                separator(i == 0 && hiddenLevels.isEmpty())
                chip(l.name, l.path == levels.last().path, Modifier.clickable(role = Role.Button, onClickLabel = l.path) { session.go(l.path) })
            }
        }
    }
}

// MARK: - the select bar

/**
 * While selecting: where they go; on the Files tab also share them and move them to the Mac's Trash (iOS Files' select
 * bar; files-v0 §12.3), the count then under the title.
 */
@Composable
private fun SelectBar(session: FilesSession, give: () -> Unit, share: (() -> Unit)?, trash: (() -> Unit)?, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth().background(Theme.base)) {
        HairRule()
        Row(Modifier.padding(horizontal = Theme.Space.l, vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(Theme.Space.m), verticalAlignment = Alignment.CenterVertically) {
            if (share != null && trash != null) {
                val files = session.picked.isNotEmpty() && session.picked.all { !it.isFolder }
                BarIcon(PixelArt.share, "Share", files, share)
                BarIcon(PixelArt.trash, "Move to Trash", session.picked.isNotEmpty(), trash)
            } else {
                Text("${session.picked.size} Selected", color = Theme.secondaryInk, style = mono(13))
            }
            Spacer(Modifier.weight(1f))
            if (session.checking) BrailleSpinner(color = Theme.secondaryInk)
            SquareButton(
                if (session.asksTerminal) "Add to Reply…" else "Add to Reply (${session.picked.size})", give,
                prominent = true, expand = false, enabled = session.picked.isNotEmpty() && !session.checking,
            )
        }
    }
}

/** A picture in a bar that acts: the pixel look's sprite, the classic look's symbol for it. */
@Composable
fun BarIcon(rows: List<String>, label: String, enabled: Boolean, onClick: () -> Unit) {
    Box(
        Modifier.heightIn(min = 36.dp).width(36.dp).alpha(if (enabled) 1f else 0.4f)
            .clickable(enabled, role = Role.Button, onClickLabel = label, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { PixelSprite(rows, pixel = 2.dp, color = Theme.ink, strength = 1f, shadow = false) }
}

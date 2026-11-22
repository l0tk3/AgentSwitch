package com.agentswitch.android.terminals

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.pulltorefresh.PullToRefreshDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
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
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onPlaced
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
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.agentswitch.android.AppModel
import com.agentswitch.android.AppSettings
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.LocalNav
import com.agentswitch.android.LocalSettings
import com.agentswitch.android.Nav
import com.agentswitch.android.WhileStarted
import com.agentswitch.android.demo.LocalDemoScreen
import com.agentswitch.android.design.BarWord
import com.agentswitch.android.design.BrailleSpinner
import com.agentswitch.android.design.LocalLook
import com.agentswitch.android.design.NavBar
import com.agentswitch.android.design.PixelBox
import com.agentswitch.android.design.PixelBoxEffect
import com.agentswitch.android.design.PixelSprite
import com.agentswitch.android.design.PlainField
import com.agentswitch.android.design.Scanlines
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.framed
import com.agentswitch.android.design.glitch
import com.agentswitch.android.design.grounded
import com.agentswitch.android.design.lookWord
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.android.design.runningGlitch
import com.agentswitch.android.design.stepIn
import com.agentswitch.android.design.wipeOut
import com.agentswitch.android.onboarding.MacTabSubtitle
import com.agentswitch.kit.api.ResumeOutcome
import com.agentswitch.kit.api.ResumeTerminalRequest
import com.agentswitch.kit.api.SessionDeleteWords
import com.agentswitch.kit.api.SessionSummary
import com.agentswitch.kit.api.TerminalInfo
import com.agentswitch.kit.api.TerminalStatus
import com.agentswitch.kit.api.TerminalSubagent
import com.agentswitch.kit.api.GitSummary
import com.agentswitch.kit.api.deleteSession
import com.agentswitch.kit.api.deleteSessions
import com.agentswitch.kit.api.resumeTerminal
import com.agentswitch.kit.api.searchSessions
import com.agentswitch.kit.design.PixelArt
import com.agentswitch.kit.feed.TerminalSearch
import com.agentswitch.kit.feed.TerminalTree
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// The terminals tab (docs/terminal-v0.md §1): a directory tree of the Mac's terminals and its earlier sessions, as the
// web page's sidebar — each project folder with its running terminals (status mark, name, agent), then its sessions
// (resume), then the folders under it (TerminalTree has the rules). A folder's line folds and unfolds (remembered); `▸ N
// More` lists all of a folder's sessions, the rows drawn line by line; a long press on a session opens its menu
// (resume, delete — a deleted row is wiped out). A terminal that needs you or exits glitches once. Menus and confirm
// boxes are the desktop's pixel boxes; the list has its scanlines and a rule under the bar. `New` starts one.
// In the classic look (docs/ui-v0.md §8) the tree is drawn by indentation: a chevron and a folder for a folder's line,
// dots for the terminals' states, a clock before a session; the search line is a round field.
//
// Left out on this phone: the iPhone's haptics (`model.feedback…`: a tap when a menu opens, a tick as a session is
// picked) and sounds.

/** The sessions are read every this many rounds (20 s, as the web page). */
private const val sessionsEvery = 5

/** Sessions shown per folder before `▸ N More`. */
private const val sessionsShown = 3

/** The classic look's tree: how far a folder's rows sit in from its line, and each level from the one above. */
private val classicLead = 20.dp
private val classicStep = 16.dp

/** The sessions one question is about. */
@Stable
private class SessionBatch(val sessions: List<SessionSummary>)

/** A menu opened by a long press: its rows, and where the row it belongs to is. */
@Stable
private class RowMenu(val actions: List<PixelBox.Action>, val anchor: Rect)

private class Reveal(val key: String, val at: Long = System.currentTimeMillis())

private class Elsewhere(val session: SessionSummary, val app: String, val mode: String?, val folder: String?)

/** A folder a line sits in, and where that folder's own line falls. */
private class Within(val key: String, val at: Int)

/** Where a line falls among the lines its top folder draws, and the folders it sits in: for the unfold's step-in. */
private class Step(val at: Int, val within: List<Within>)

/** Where a view is on the screen, kept without redrawing anything as it scrolls (read when its menu opens). */
private class Anchor {
    var coordinates: LayoutCoordinates? = null
    val rect: Rect get() = coordinates?.takeIf { it.isAttached }?.boundsInRoot() ?: Rect.Zero
}

private fun Modifier.trackAnchor(anchor: Anchor): Modifier = onPlaced { anchor.coordinates = it }

/** One line of the list. */
private sealed class Line(val key: String) {
    class Folder(val f: TerminalTree.Folder, val depth: Int, val folded: Boolean, val step: Step) : Line("f:${f.cwd}")
    class Terminal(val t: TerminalInfo, val last: Boolean, val depth: Int, val step: Step) : Line("t:${t.id}")
    class Subagent(val t: TerminalInfo, val agent: TerminalSubagent, val underLast: Boolean, val last: Boolean, val depth: Int, val step: Step) : Line("a:${t.id}:${agent.id}")
    class Session(val s: SessionSummary, val last: Boolean, val depth: Int, val step: Step) : Line("s:${s.recordID}")
    class More(val f: TerminalTree.Folder, val all: Boolean, val more: Int, val depth: Int, val step: Step) : Line("m:${f.cwd}")
    class Summary(val text: String) : Line("summary")
    class FoundFolder(val folder: TerminalSearch.Folder) : Line("sf:${folder.cwd}")
    class FoundTerminal(val t: TerminalInfo, val last: Boolean, val titleHit: Boolean) : Line("st:${t.id}")
    class FoundSession(val s: SessionSummary, val last: Boolean, val titleHit: Boolean) : Line("ss:${s.recordID}")
    class Hit(val owner: String, val words: String, val last: Boolean, val open: () -> Unit) : Line("h:$owner")
    class NoMatch(val query: String) : Line("nomatch")
}

/**
 * What the tab keeps (the iPhone's `@State`s) and does: folding, picking, deleting, resuming. Network work runs on the
 * app's own scope, so a delete or a resume goes on when the tab is left.
 */
@Stable
private class TerminalsTabState(val model: AppModel, val nav: Nav, val settings: AppSettings) {
    /** Folded folders and parents, by path. */
    var folded by mutableStateOf(settings.string("terminals.folded")?.split("\n")?.filter { it.isNotEmpty() }?.toSet() ?: emptySet())
        private set

    /** Folders showing all their sessions (this visit). */
    var showingAll by mutableStateOf<Set<String>>(emptySet())
    var deletingSession by mutableStateOf<SessionSummary?>(null)

    /**
     * Sessions are being picked to delete together (docs/terminal-v0.md §5 批量删除): a tap on a session's row takes it
     * in or out. `picked`: their rows' ids; `deletingMany`: the ones the question is about.
     */
    var selecting by mutableStateOf(false)
    var picked by mutableStateOf<Set<String>>(emptySet())
    var deletingMany by mutableStateOf<SessionBatch?>(null)

    /** After several were deleted: what the Mac left, and why. */
    var leftSaid by mutableStateOf<String?>(null)

    /** The menu open (a long press), and where its row is. */
    var menu by mutableStateOf<RowMenu?>(null)

    /** The folder just unfolded: its rows are drawn line by line. */
    var revealed by mutableStateOf<Reveal?>(null)

    /** Sessions being wiped out, and those gone from the list until the next one comes without them. */
    var wiping by mutableStateOf<Set<String>>(emptySet())
    var gone by mutableStateOf<Set<String>>(emptySet())

    /** A session last run in bypass, asked about before it goes on. */
    var bypassResume by mutableStateOf<SessionSummary?>(null)

    /** The profile named for a session being continued (`Resume As`), by the session's id. */
    private val resumeAs = HashMap<String, String?>()

    /** Why continuing or deleting a session failed: a box over whatever page is open. */
    var failure by mutableStateOf<String?>(null)

    /** A session to continue whose folder is gone: a folder is picked for it (docs/terminal-v0.md §5). */
    var movedFolder by mutableStateOf<MovedFolder?>(null)
    var elsewhere by mutableStateOf<Elsewhere?>(null)
    var opening by mutableStateOf<String?>(null)

    /** The search line (docs/terminal-v0.md §1 搜索); the Mac's answer for the words said in sessions, and what it was asked. */
    var query by mutableStateOf("")
    var said by mutableStateOf<Map<String, String>>(emptyMap())
    var saidFor by mutableStateOf("")

    val scope get() = model.scope

    fun pushTerminal(t: TerminalInfo) = nav.push("terminal/${t.id}") { TerminalPage(t) }

    fun pushSession(s: SessionSummary) = nav.push("session/${s.id}") {
        SessionTranscriptView(s, resuming = opening == s.id, resume = { scope.launch { resume(s) } })
    }

    fun newTerminal() {
        nav.present("newterminal") {
            NewTerminalSheet { terminal ->
                model.terminals.add(terminal)
                unfold(terminal.cwd)
                pushTerminal(terminal)
            }
        }
    }

    /**
     * A terminal just started or continued shows in the list: its folder and every folder above it open
     * (docs/terminal-v0.md §1, as the web page).
     */
    fun unfold(cwd: String) {
        val set = folded - TerminalTree.foldersAbove(cwd).toSet()
        if (set.size != folded.size) keep(set)
    }

    fun toggleFold(key: String) {
        val set = folded.toMutableSet()
        if (set.remove(key)) revealed = Reveal(key) else set.add(key)
        keep(set)
    }

    private fun keep(set: Set<String>) {
        folded = set
        settings.putString("terminals.folded", set.sorted().joinToString("\n"))
    }

    // MARK: the tree as lines

    /** The sessions a folder lists: those not deleted just now, the first few unless all are asked for. */
    private class Listed(val sessions: List<SessionSummary>, val more: Int, val foot: Boolean)

    private fun listed(f: TerminalTree.Folder): Listed {
        val kept = f.sessions.filter { it.id !in gone }
        val sessions = if (f.cwd in showingAll) kept else kept.take(sessionsShown)
        return Listed(sessions, kept.size - sessions.size, kept.size > sessionsShown)
    }

    /** A folder's own rows while it is open: its terminals, its sessions, `▸ N More`. */
    private fun ownRows(f: TerminalTree.Folder): Int {
        val l = listed(f)
        return f.terminals.size + l.sessions.size + (if (l.foot) 1 else 0)
    }

    /** The lines under a folder's own line while it is open: its rows, then the folders under it with theirs. */
    private fun drawn(f: TerminalTree.Folder): Int {
        if (f.cwd in folded) return 0
        return ownRows(f) + f.children.sumOf { 1 + drawn(it) }
    }

    /** A folder's line, its own terminals and sessions, then the folders under it one step further in. */
    fun lines(folders: List<TerminalTree.Folder>): List<Line> {
        val out = ArrayList<Line>()
        for (f in folders) addFolder(f, 0, 0, emptyList(), out)
        return out
    }

    private fun addFolder(f: TerminalTree.Folder, depth: Int, at: Int, above: List<Within>, out: MutableList<Line>) {
        val isFolded = f.cwd in folded
        val all = f.cwd in showingAll
        val l = listed(f)
        val rows = if (isFolded) 0 else ownRows(f)
        val within = listOf(Within(f.cwd, at)) + above
        out.add(Line.Folder(f, depth, isFolded, Step(at, above)))
        if (isFolded) return
        f.terminals.forEachIndexed { i, t ->
            out.add(Line.Terminal(t, last = i == rows - 1, depth = depth, step = Step(at + 1 + i, within)))
            // Its sub-agents, one level under it; a tap opens the terminal.
            if (t.isRunning) t.subagents.forEachIndexed { k, agent ->
                out.add(Line.Subagent(t, agent, underLast = i == rows - 1, last = k == t.subagents.size - 1, depth = depth, step = Step(at + 1 + i, within)))
            }
        }
        l.sessions.forEachIndexed { i, s ->
            val index = f.terminals.size + i
            // Those "more" brings are drawn from the first of them.
            val place = at + 1 + (if (all && i >= sessionsShown) index - sessionsShown else index)
            out.add(Line.Session(s, last = index == rows - 1, depth = depth, step = Step(place, within)))
        }
        // ▸ opens the rest under it; ▴ folds them back up (2026-10-03, user: 这个图标也有问题吧，有点误导人 — ▾ under
        // the list read as a folder still to open).
        if (l.foot) out.add(Line.More(f, all, l.more, depth, Step(at + rows, within)))
        f.children.forEachIndexed { i, child ->
            addFolder(child, depth + 1, at + 1 + rows + f.children.take(i).sumOf { 1 + drawn(it) }, within, out)
        }
    }

    /** What matched, in the tree's order and shape, the match marked; a match in the words shows them under the row. */
    fun foundLines(result: TerminalSearch.Result): List<Line> {
        if (result.folders.isEmpty()) return listOf(Line.NoMatch(query.trim()))
        val out = ArrayList<Line>()
        out.add(Line.Summary(result.summary))
        for (folder in result.folders) {
            out.add(Line.FoundFolder(folder))
            folder.rows.forEachIndexed { i, row ->
                val last = i == folder.rows.size - 1
                when (val item = row.item) {
                    is TerminalSearch.Item.Terminal -> {
                        out.add(Line.FoundTerminal(item.value, last, row.titleHit))
                        row.said?.let { out.add(Line.Hit("t:${item.value.id}", it, last) { pushTerminal(item.value) }) }
                    }
                    is TerminalSearch.Item.Session -> {
                        out.add(Line.FoundSession(item.value, last, row.titleHit))
                        row.said?.let { out.add(Line.Hit("s:${item.value.recordID}", it, last) { pushSession(item.value) }) }
                    }
                }
            }
        }
        return out
    }

    /** The step-in a line gets: one that came with the unfold of a folder it sits in, just now, draws at its turn after that folder's line. */
    fun stepOf(step: Step): Pair<Int, Boolean> {
        val r = revealed ?: return 0 to false
        if (System.currentTimeMillis() - r.at >= 400) return 0 to false
        val w = step.within.firstOrNull { it.key == r.key } ?: return 0 to false
        return maxOf(0, step.at - w.at) to true
    }

    /** "2 · 5": terminals · sessions in the folder and the folders under it, for a folded line. */
    fun count(f: TerminalTree.Folder): String {
        val terminals = f.allTerminals.size
        val sessions = f.allSessions.size
        return if (terminals > 0) "$terminals · $sessions" else "$sessions"
    }

    // MARK: menus

    /** The session's menu: continue it, under another profile, its folder on the Files tab, pick it, delete it. */
    fun sessionMenu(s: SessionSummary, anchor: Rect): RowMenu {
        val items = ArrayList<PixelBox.Action>()
        if (s.harness in terminalsResumable) {
            items.add(PixelBox.Action("Resume") { scope.launch { resume(s) } })
            // Under another profile than the one it last ran under (docs/profiles-v0.md §3.3), where the agent has more than the Mac's own.
            model.terminals.profiles[s.harness]?.takeIf { it.several }?.let { choices ->
                for (p in choices.profiles) if (p.id != (s.profile ?: "default")) items.add(PixelBox.Action("Resume As ${p.name}") { scope.launch { resume(s, profile = p.id) } })
            }
        }
        // Its folder on the Files tab, as on the Mac's list (docs/files-v0.md §12.4).
        if (s.cwd.isNotEmpty()) items.add(PixelBox.Action("Show in Files") { model.showInFiles(s.cwd) })
        if (s.harness in terminalsDeletable) {
            items.add(PixelBox.Action("Select") { selecting = true; picked = setOf(s.recordID) })
            items.add(PixelBox.Action("Delete", PixelBox.Action.Role.Destructive) { deletingSession = s })
        }
        return RowMenu(items, anchor)
    }

    /** A folder's menu (the iPhone's long-press menu): its folder on the Files tab; its own sessions, all at once. */
    fun folderMenu(f: TerminalTree.Folder, anchor: Rect): RowMenu? {
        val own = f.sessions.filter { it.id !in gone && it.harness in terminalsDeletable }
        val items = ArrayList<PixelBox.Action>()
        if (f.cwd.isNotEmpty()) items.add(PixelBox.Action("Show in Files") { model.showInFiles(f.cwd) })
        if (own.size > 1) items.add(PixelBox.Action(SessionDeleteWords.all(own.size), PixelBox.Action.Role.Destructive) { deletingMany = SessionBatch(own) })
        return if (items.isEmpty()) null else RowMenu(items, anchor)
    }

    // MARK: actions

    /** The row is wiped out while the Mac deletes the record; it comes back if that fails. */
    fun deleteSession(s: SessionSummary) {
        val api = model.api ?: return
        scope.launch {
            wiping = wiping + s.id
            val deleted = async { try { api.deleteSession(s.harness, s.sessionId); null } catch (e: CancellationException) { throw e } catch (e: Exception) { e } }
            delay(210)
            gone = gone + s.id
            wiping = wiping - s.id
            val error = deleted.await()
            if (error == null) {
                model.refreshTerminals(sessions = true)
            } else {
                gone = gone - s.id
                failure = error.message ?: error.javaClass.simpleName
            }
        }
    }

    /** The sessions picked that the list still has, in the list's order. */
    fun pickedSessions(folders: List<TerminalTree.Folder>): List<SessionSummary> =
        folders.flatMap { it.allSessions }.filter { it.recordID in picked && it.id !in gone && it.harness in terminalsDeletable }

    fun endSelecting() {
        selecting = false
        picked = emptySet()
    }

    /**
     * Several at once: their rows are wiped out while the Mac deletes the records; one it left (in use) comes back, and
     * the tab says how many.
     */
    fun deleteSessions(list: List<SessionSummary>) {
        val api = model.api ?: return
        if (list.isEmpty()) return
        val ids = list.map { it.id }.toSet()
        endSelecting()
        scope.launch {
            wiping = wiping + ids
            val removed = async { try { Result.success(api.deleteSessions(list)) } catch (e: CancellationException) { throw e } catch (e: Exception) { Result.failure(e) } }
            delay(210)
            gone = gone + ids
            wiping = wiping - ids
            val outcome = removed.await()
            val removal = outcome.getOrNull()
            if (removal != null) {
                gone = gone - removal.kept
                model.refreshTerminals(sessions = true)
                leftSaid = SessionDeleteWords.left(removal)
            } else {
                gone = gone - ids
                val e = outcome.exceptionOrNull()
                failure = e?.message ?: e?.javaClass?.simpleName
            }
        }
    }

    /** `new`, or a terminal (from a notification) on top of the page open now; one closed since is not found. */
    fun openRequested() {
        val id = model.openTerminalRequest ?: return
        if (id == "new") {
            model.openTerminalRequest = null
            newTerminal()
            return
        }
        val list = model.terminals.list ?: return
        model.openTerminalRequest = null
        list.terminals.firstOrNull { it.id == id }?.let { pushTerminal(it) }
    }

    /**
     * Continue a session in place (one record, one writer): the terminal that has it already, a new one, or — open in
     * another program — the choice to fork. It goes on in the mode it last had; bypass is asked about first. Its folder
     * gone, a folder is picked and it goes on `folder` (after the box it was picked in: `picking`).
     */
    suspend fun resume(s: SessionSummary, profile: String? = null, fork: Boolean = false, chosen: String? = null, folder: String? = null, picking: MovedFolder? = null) {
        val api = model.api ?: return
        // `Resume As`: the profile named is kept through the questions that may come in between (its mode, a fork,
        // another folder), each of which comes back here; asked afresh, what was named before is let go.
        if (chosen == null && !fork && folder == null) resumeAs[s.id] = profile
        val named = resumeAs[s.id]
        if (s.mode == "bypass" && chosen == null) {
            bypassResume = s
            return
        }
        opening = s.id
        try {
            val mode = chosen ?: s.mode
            val request = ResumeTerminalRequest(
                harness = s.harness, cwd = s.cwd, agentSessionId = s.sessionId, title = s.title.ifEmpty { null },
                mode = mode, fork = if (fork) true else null, profile = named,
            )
            when (val outcome = api.resumeTerminal(folder?.let { request.continuing(it) } ?: request)) {
                is ResumeOutcome.Started -> opened(outcome.terminal)
                is ResumeOutcome.Existing -> opened(outcome.terminal)
                is ResumeOutcome.Elsewhere -> elsewhere = Elsewhere(s, outcome.app ?: "其他程序", mode, folder)
                is ResumeOutcome.FolderGone ->
                    movedFolder = if (picking != null && folder != null) picking.picked(folder)
                    else MovedFolder(s, outcome.cwd, outcome.alike, outcome.near, fork, mode)
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            failure = e.message ?: e.javaClass.simpleName
        } finally {
            opening = null
        }
    }

    private fun opened(t: TerminalInfo) {
        model.terminals.add(t)
        unfold(t.cwd)
        pushTerminal(t)
    }
}

/** The terminals tab (docs/terminal-v0.md §1). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TerminalsTab() {
    val model = LocalAppModel.current
    val nav = LocalNav.current
    val settings = LocalSettings.current
    val classic = LocalLook.current.isClassic
    val density = LocalDensity.current.density
    val state = remember(model) { TerminalsTabState(model, nav, settings) }
    val store = model.terminals
    val folders = store.folders
    val searching = state.query.trim().isNotEmpty()
    val scope = rememberCoroutineScope()
    var refreshing by remember { mutableStateOf(false) }
    val listState = rememberLazyListState()
    val pullState = rememberPullToRefreshState()

    val lines: List<Line> = if (!searching) state.lines(folders) else {
        val said = if (state.saidFor == state.query) state.said else emptyMap()
        state.foundLines(TerminalSearch.run(folders, state.query, said))
    }

    // The words said in sessions, once typing pauses; an answer to an older query is not kept.
    LaunchedEffect(state.query) {
        val q = state.query.trim()
        val api = model.api
        if (q.isEmpty() || api == null) {
            state.said = emptyMap()
            state.saidFor = ""
            return@LaunchedEffect
        }
        delay(250)
        val hits = try { api.searchSessions(q) } catch (e: CancellationException) { throw e } catch (_: Exception) { return@LaunchedEffect }
        val map = LinkedHashMap<String, String>()
        for (h in hits) map.putIfAbsent("${h.harness}:${h.id}", h.excerpt)
        state.said = map
        state.saidFor = state.query
    }
    // A terminal to open (a notification's link): once the list is there, and when the request comes.
    LaunchedEffect(model.openTerminalRequest, store.list == null) { state.openRequested() }
    // The list itself is followed from every tab (MainTabs); the folders' git and the sessions while this tab is on
    // screen — the sessions, all of them now (docs/terminal-v0.md §4), every fifth time: they change slowly, and the
    // whole list is the larger read (pull to refresh reads them at once).
    WhileStarted(model.connection.endpoint) {
        var round = 0
        while (true) {
            if (round % sessionsEvery == 0) store.refreshSessions(model.api)
            store.refreshGit(model.api)
            round += 1
            delay(TerminalsStore.pollIntervalMs)
        }
    }
    // A session to continue whose folder is gone: the sheet that picks another one.
    val moved = state.movedFolder
    LaunchedEffect(moved) {
        if (moved == null) return@LaunchedEffect
        state.movedFolder = null
        nav.present("movedfolder") {
            MovedFolderSheet(moved) { folder -> state.scope.launch { state.resume(moved.session, fork = moved.fork, chosen = moved.mode, folder = folder, picking = moved) } }
        }
    }
    // The sample screens that open a menu, a box or the search line, as a long press and its delete would.
    val demoScreen = LocalDemoScreen.current
    // The new-terminal sheet's sample screens open it, as `New` would (the iPhone's `openTerminalRequest = "new"`).
    LaunchedEffect(demoScreen) {
        if (demoScreen == "newterminal" || demoScreen == "newterminalbypass" || demoScreen == "newterminalprofile") state.newTerminal()
    }
    val firstSessions = folders.flatMap { it.allSessions }
    LaunchedEffect(demoScreen, firstSessions.isNotEmpty()) {
        val first = firstSessions.firstOrNull() ?: return@LaunchedEffect
        val anchor = Rect(16 * density, 210 * density, 376 * density, 246 * density)
        when (demoScreen) {
            "terminalmenu" -> state.menu = state.sessionMenu(first, anchor)
            // A Claude Code session where the agent has more than the Mac's own sign-in: `Resume As`.
            "terminalmenuprofile" -> firstSessions.firstOrNull { it.harness == "claude-code" }?.let { state.menu = state.sessionMenu(it, anchor) }
            "terminalsearch" -> state.query = "终端"
            "terminaldelete" -> state.deletingSession = first
            // Sessions being picked, two of them in.
            "terminalselect" -> {
                state.selecting = true
                state.picked = firstSessions.take(3).drop(1).map { it.recordID }.toSet()
            }
            "terminaldeletemany" -> state.deletingMany = SessionBatch(firstSessions.take(5))
        }
    }

    // MARK: boxes
    PixelBoxEffect(state.menu, onDismiss = { state.menu = null }) { m -> PixelBox(cancel = null, actions = m.actions, anchor = m.anchor) }
    PixelBoxEffect(state.bypassResume, onDismiss = { state.bypassResume = null }) { s ->
        PixelBox(
            head = "Bypass", tone = PixelBox.Tone.Amber, message = "「${s.displayTitle}」上次以 Bypass 运行。$bypassNote",
            actions = listOf(
                PixelBox.Action("Auto") { state.scope.launch { state.resume(s, chosen = "auto") } },
                PixelBox.Action("Bypass", PixelBox.Action.Role.Primary) { state.scope.launch { state.resume(s, chosen = "bypass") } },
            ),
        )
    }
    PixelBoxEffect(state.deletingSession, onDismiss = { state.deletingSession = null }) { s ->
        PixelBox(
            head = "Delete Record", tone = PixelBox.Tone.Red, message = "删除会话记录「${s.displayTitle}」？Mac 上这段会话的记录将被删除，无法恢复，也无法再继续。",
            actions = listOf(PixelBox.Action("Delete", PixelBox.Action.Role.Primary) { state.deleteSession(s) }),
        )
    }
    PixelBoxEffect(state.deletingMany, onDismiss = { state.deletingMany = null }) { batch ->
        PixelBox(
            head = "Delete Records", tone = PixelBox.Tone.Red, message = SessionDeleteWords.question(batch.sessions.map { it.displayTitle }),
            actions = listOf(PixelBox.Action("Delete", PixelBox.Action.Role.Primary) { state.deleteSessions(batch.sessions) }),
        )
    }
    PixelBoxEffect(state.elsewhere, onDismiss = { state.elsewhere = null }) { e ->
        PixelBox(
            head = "In Use", tone = PixelBox.Tone.Amber,
            message = "「${e.session.displayTitle}」正在 ${e.app} 中运行。同一会话同时只能由一个程序写入。请先在 ${e.app} 中退出，或创建分支：新会话包含全部历史，原会话保持不变。",
            actions = listOf(PixelBox.Action("Fork", PixelBox.Action.Role.Primary) { state.scope.launch { state.resume(e.session, fork = true, chosen = e.mode, folder = e.folder) } }),
        )
    }
    PixelBoxEffect(state.leftSaid, onDismiss = { state.leftSaid = null }) { message ->
        PixelBox(head = "Not Deleted", tone = PixelBox.Tone.Amber, message = message, cancel = null, actions = listOf(PixelBox.Action("OK", PixelBox.Action.Role.Primary) {}))
    }
    PixelBoxEffect(state.failure, onDismiss = { state.failure = null }) { message ->
        PixelBox(head = "Error", tone = PixelBox.Tone.Red, message = message, cancel = null, actions = listOf(PixelBox.Action("OK", PixelBox.Action.Role.Primary) {}))
    }

    Column(Modifier.fillMaxSize().background(Theme.base)) {
        val chosen = if (state.selecting) state.pickedSessions(folders) else emptyList()
        NavBar(
            "Terminals",
            subtitle = { MacTabSubtitle() },
            leading = {
                // `Select` where there are sessions to pick from; while picking, `Done` leaves it.
                if (state.selecting || folders.any { it.allSessions.isNotEmpty() }) {
                    BarWord(if (state.selecting) "Done" else "Select", { if (state.selecting) state.endSelecting() else state.selecting = true })
                }
            },
            trailing = {
                if (state.selecting) {
                    BarWord(if (chosen.isEmpty()) "Delete" else "Delete ${chosen.size}", { state.deletingMany = SessionBatch(chosen) }, enabled = chosen.isNotEmpty(), color = Theme.failed)
                } else if (classic) {
                    PlusButton(enabled = store.list != null) { state.newTerminal() }
                } else {
                    BarWord("New", { state.newTerminal() }, enabled = store.list != null)
                }
            },
        )
        Box(Modifier.weight(1f).fillMaxWidth()) {
            Scanlines(Modifier.fillMaxSize())
            PullToRefreshBox(
                isRefreshing = refreshing,
                onRefresh = { scope.launch { refreshing = true; try { model.refreshTerminals(sessions = true) } finally { refreshing = false } } },
                modifier = Modifier.fillMaxSize(),
                state = pullState,
                indicator = {
                    PullToRefreshDefaults.Indicator(pullState, refreshing, Modifier.align(Alignment.TopCenter), containerColor = Theme.raised, color = Theme.signal)
                },
            ) {
                LazyColumn(Modifier.fillMaxSize(), state = listState, contentPadding = PaddingValues(horizontal = Theme.Space.l, vertical = Theme.Space.m)) {
                    if (model.connection.endpoint == null) item(key = "banner") { ConnectionBanner(Modifier.padding(bottom = Theme.Space.m)) }
                    store.error?.let { item(key = "error") { Text(it, Modifier.padding(bottom = Theme.Space.m), color = Theme.failed, style = plain(13)) } }
                    if (store.list != null && folders.isEmpty() && state.query.isEmpty()) {
                        item(key = "empty") { Text("尚无终端。点 New 在 Mac 上启动 agent。", Modifier.padding(top = 40.dp), color = Theme.secondaryInk, style = plain(13)) }
                    }
                    if (store.list != null && !(folders.isEmpty() && state.query.isEmpty())) item(key = "search") { SearchLine(state) }
                    items(lines, key = { it.key }) { line -> LineView(line, state) }
                }
            }
        }
    }
}

/** `+` in the bar (the classic look's `New`). */
@Composable
private fun PlusButton(enabled: Boolean, onClick: () -> Unit) {
    Box(
        Modifier.clickable(enabled, role = Role.Button, onClickLabel = "New", onClick = onClick).padding(horizontal = 12.dp, vertical = 10.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text("+", color = if (enabled) Theme.signal else Theme.inkDim, style = plain(26, FontWeight.Light))
    }
}

// MARK: lines

@Composable
private fun LineView(line: Line, state: TerminalsTabState) {
    val model = state.model
    when (line) {
        is Line.Folder -> {
            val (index, active) = state.stepOf(line.step)
            FolderLineView(line, state, Modifier.stepIn(index, active))
        }
        is Line.Terminal -> {
            val (index, active) = state.stepOf(line.step)
            val anchor = remember { Anchor() }
            TerminalRowView(
                line.t, line.last, line.depth, title = null,
                Modifier.stepIn(index, active).trackAnchor(anchor).combinedClickable(
                    onClick = { state.pushTerminal(line.t) },
                    // Its folder on the Files tab (docs/files-v0.md §5).
                    onLongClick = { state.menu = RowMenu(listOf(PixelBox.Action("Show in Files") { model.showInFiles(line.t.workdir) }), anchor.rect) },
                ),
            )
        }
        is Line.Subagent -> {
            val (index, active) = state.stepOf(line.step)
            SubagentRowView(line.agent, line.underLast, line.last, line.depth, Modifier.stepIn(index, active).clickable { state.pushTerminal(line.t) })
        }
        is Line.Session -> {
            val (index, active) = state.stepOf(line.step)
            SessionRowView(
                line.s, line.last, line.depth, state, title = null,
                picking = if (state.selecting) line.s.recordID in state.picked else null,
                modifier = Modifier.wipeOut(line.s.id in state.wiping).stepIn(index, active),
            )
        }
        is Line.More -> {
            val (index, active) = state.stepOf(line.step)
            MoreRowView(line, Modifier.stepIn(index, active).clickable {
                if (line.all) state.showingAll = state.showingAll - line.f.cwd
                else {
                    state.showingAll = state.showingAll + line.f.cwd
                    state.revealed = Reveal(line.f.cwd)
                }
            })
        }
        is Line.Summary -> Text(line.text, Modifier.padding(top = 8.dp), color = Theme.inkDim, style = mono(11))
        is Line.NoMatch -> Text("没有找到与“${line.query}”相关的文件夹或会话。", Modifier.padding(vertical = 18.dp), color = Theme.secondaryInk, style = plain(13))
        is Line.FoundFolder -> {
            val folder = line.folder
            val classic = LocalLook.current.isClassic
            Row(Modifier.padding(top = Theme.Space.m, bottom = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                if (classic) {
                    ClassicFolderLine(folder.name.removeSuffix("/"), folded = false, depth = 0, own = true, title = marked(folder.name.removeSuffix("/"), state.query, true))
                } else {
                    Text(
                        buildAnnotatedString {
                            append("▾ ")
                            append(marked(folder.name, state.query, false))
                            if (!folder.name.endsWith("/")) append("/")
                        },
                        color = Theme.ink, style = mono(13, FontWeight.SemiBold), maxLines = 1,
                    )
                }
                folder.git?.let { Text(it.said, color = Theme.inkDim, style = mono(11), maxLines = 1) }
            }
        }
        is Line.FoundTerminal -> {
            val classic = LocalLook.current.isClassic
            TerminalRowView(
                line.t, line.last, 0, title = if (line.titleHit) marked(line.t.name, state.query, classic) else null,
                Modifier.clickable { state.pushTerminal(line.t) },
            )
        }
        is Line.FoundSession -> {
            val classic = LocalLook.current.isClassic
            SessionRowView(
                line.s, line.last, 0, state, title = if (line.titleHit) marked(line.s.displayTitle, state.query, classic) else null,
                picking = null, modifier = Modifier,
            )
        }
        is Line.Hit -> {
            val classic = LocalLook.current.isClassic
            Row(
                Modifier.fillMaxWidth().clickable(onClick = line.open).padding(bottom = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically,
            ) {
                if (classic) Spacer(Modifier.width(classicLead + classicStep))
                else Text("${if (line.last) "  " else "│ "}└─", color = Theme.inkDim, style = mono(13))
                Text(marked(TerminalSearch.near(state.query, line.words), state.query, classic), Modifier.weight(1f), color = Theme.inkDim, style = plain(12), maxLines = 1)
            }
        }
    }
}

/** `text` with the match on the signal colour, as the web list marks it (a wash of the accent in the classic look). */
@Composable
private fun marked(text: String, query: String, classic: Boolean): AnnotatedString {
    val signal = Theme.signal
    return buildAnnotatedString {
        append(text)
        val range = TerminalSearch.match(query, text) ?: return@buildAnnotatedString
        // On the signal colour, in black; a wash of the accent in the classic look.
        addStyle(
            if (classic) SpanStyle(background = signal.copy(alpha = 0.3f)) else SpanStyle(background = signal, color = Color.Black),
            range.first, range.last + 1,
        )
    }
}

/** The tree's `├─` / `└─` in front of a row, indented once more for each folder it sits in under the top one. */
@Composable
private fun TreeLine(last: Boolean, depth: Int) {
    if (LocalLook.current.isClassic) {
        Spacer(Modifier.width(classicLead + classicStep * depth - 8.dp))
    } else {
        Text("${"  ".repeat(depth)}${if (last) "└─" else "├─"}", color = Theme.inkDim, style = mono(13), maxLines = 1, softWrap = false)
    }
}

@Composable
private fun FolderLineView(line: Line.Folder, state: TerminalsTabState, modifier: Modifier) {
    val f = line.f
    val classic = LocalLook.current.isClassic
    val anchor = remember { Anchor() }
    val text = "${"  ".repeat(line.depth)}${if (line.folded) "▸" else "▾"} ${TerminalTree.slashed(f.name)}"
    Row(
        modifier.fillMaxWidth().trackAnchor(anchor)
            .combinedClickable(
                onClickLabel = if (line.folded) "展开" else "收起",
                onClick = { state.toggleFold(f.cwd) },
                // Its own sessions, all at once (those a folder under it has are that folder's).
                onLongClick = { state.folderMenu(f, anchor.rect)?.let { state.menu = it } },
            )
            .padding(top = if (line.depth == 0) Theme.Space.m else Theme.Space.s, bottom = if (f.holdsOwn) 4.dp else 2.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        if (classic) ClassicFolderLine(f.name, line.folded, line.depth, f.holdsOwn)
        else if (f.holdsOwn) Text(text, color = Theme.ink, style = mono(13, FontWeight.SemiBold), maxLines = 1)
        else Text(text, color = Theme.inkDim, style = mono(12), maxLines = 1)
        f.git?.let { git ->
            Text(git.said, Modifier.weight(1f, fill = false).semantics { contentDescription = "git ${git.said}" }, color = Theme.inkDim, style = mono(11), maxLines = 1)
        }
        if (line.folded) Text(state.count(f), color = Theme.inkDim, style = mono(11), maxLines = 1)
        Spacer(Modifier.weight(1f))
    }
}

/**
 * A folder's line in the classic look: a chevron (down while open), a folder, its name without the slash. A folder
 * that only gathers others is quieter.
 */
@Composable
private fun ClassicFolderLine(name: String, folded: Boolean, depth: Int, own: Boolean, title: AnnotatedString? = null) {
    Row(Modifier.padding(start = classicStep * depth), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.width(12.dp), contentAlignment = Alignment.Center) {
            LookSymbolIcon(if (folded) LookSymbol.ChevronRight else LookSymbol.ChevronDown, side = 10.dp, color = Theme.inkDim, bold = true)
        }
        LookSymbolIcon(LookSymbol.Folder, side = 14.dp, color = Theme.secondaryInk)
        Text(
            title ?: AnnotatedString(name.removeSuffix("/")),
            color = if (own) Theme.ink else Theme.secondaryInk, style = plain(14, if (own) FontWeight.SemiBold else FontWeight.Normal), maxLines = 1,
        )
    }
}

@Composable
private fun TerminalRowView(t: TerminalInfo, last: Boolean, depth: Int, title: AnnotatedString?, modifier: Modifier) {
    val classic = LocalLook.current.isClassic
    val status = if (t.permissions.isEmpty()) t.status else TerminalStatus.Waiting
    Row(
        modifier.fillMaxWidth()
            // Now and then while it works (2026-10-01, user: 正在运行中的都改成这个效果); the full burst once, as it comes to
            // need you or exits.
            .runningGlitch(status == TerminalStatus.Working)
            .glitch(status) { it == TerminalStatus.Waiting || it == TerminalStatus.Exited }
            .padding(vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        TreeLine(last, depth)
        TerminalStatusMark(status, if (classic) Modifier.width(16.dp) else Modifier)
        Text(
            title ?: AnnotatedString(t.name), Modifier.weight(1f), color = if (t.isRunning) Theme.ink else Theme.secondaryInk,
            style = plain(15), maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
        )
        // The classic look says what its dot means (the pixel look's square blinks).
        if (classic && status == TerminalStatus.Waiting) NeedsYouPill()
        // Under a profile other than the Mac's own, while it runs: that profile's lit dot.
        t.profile?.color?.let { color -> if (t.isRunning) ProfileDot(color, Modifier.semantics { contentDescription = "配置 ${t.profile?.name}" }) }
        PixelSprite(PixelArt.agents[t.harness] ?: PixelArt.square, pixel = 2.dp, color = Theme.secondaryInk, strength = 0.8f, shadow = false)
        LookGlyph("›", LookSymbol.ChevronRight, color = Theme.inkDim)
    }
}

/**
 * A terminal's sub-agent at work, one level under it (docs/terminal-v0.md §1): what it was sent to do and what it is
 * doing now, its kind at the end; the spinner while it works.
 */
@Composable
private fun SubagentRowView(agent: TerminalSubagent, underLast: Boolean, last: Boolean, depth: Int, modifier: Modifier) {
    val classic = LocalLook.current.isClassic
    Row(
        modifier.fillMaxWidth().padding(vertical = 4.dp)
            .semantics(mergeDescendants = true) {
                contentDescription = "子代理 ${agent.name}，${agent.type}${if (agent.doing.isEmpty()) "" else "，${agent.doing}"}"
            },
        horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        if (classic) Spacer(Modifier.width(classicLead + classicStep * (depth + 1) - 8.dp))
        else Text("${"  ".repeat(depth)}${if (underLast) "  " else "│ "}${if (last) "└─" else "├─"}", color = Theme.inkDim, style = mono(13), maxLines = 1, softWrap = false)
        BrailleSpinner()
        Text(
            buildAnnotatedString {
                withStyle(SpanStyle(color = Theme.secondaryInk)) { append(agent.name) }
                if (agent.doing.isNotEmpty()) withStyle(SpanStyle(color = Theme.inkDim)) { append("  ${agent.doing}") }
            },
            Modifier.weight(1f), style = plain(13), maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
        )
        Text(agent.type, color = Theme.inkDim, style = mono(10), maxLines = 1)
    }
}

/**
 * One of the Mac's earlier sessions under its folder: a tap reads it, `Resume` goes on with it, a long press opens its
 * menu by the row (the row is lit while held). While sessions are picked: its box, and a tap takes it in or out.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SessionRowView(s: SessionSummary, last: Boolean, depth: Int, state: TerminalsTabState, title: AnnotatedString?, picking: Boolean?, modifier: Modifier) {
    val classic = LocalLook.current.isClassic
    val resumable = s.harness in terminalsResumable
    val deletable = s.harness in terminalsDeletable
    val source = remember { MutableInteractionSource() }
    val held = source.collectIsPressedAsState().value
    val anchor = remember { Anchor() }
    val opening = state.opening
    Row(
        modifier.fillMaxWidth().background(if (held || picking == true) Theme.raised else Color.Transparent)
            .padding(vertical = 8.dp).trackAnchor(anchor),
        horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        TreeLine(last, depth)
        // The classic look: a clock where a terminal has its dot (an earlier session, to go on with).
        if (picking != null && deletable) {
            // The row's box while sessions are picked from.
            if (classic) {
                Box(Modifier.width(16.dp), contentAlignment = Alignment.Center) {
                    LookSymbolIcon(if (picking) LookSymbol.CheckCircleFill else LookSymbol.Circle, side = 15.dp, color = if (picking) Theme.signal else Theme.inkDim)
                }
            } else {
                Text(if (picking) "■" else "□", color = if (picking) Theme.signal else Theme.inkDim, style = mono(13))
            }
        } else if (classic) {
            Box(Modifier.width(16.dp), contentAlignment = Alignment.Center) { LookSymbolIcon(LookSymbol.Clock, side = 12.dp, color = Theme.inkDim) }
        }
        Row(
            Modifier.weight(1f).combinedClickable(
                interactionSource = source, indication = null,
                onClick = { if (picking == null) state.pushSession(s) else if (deletable) state.picked = state.picked.let { if (s.recordID in it) it - s.recordID else it + s.recordID } },
                onLongClick = { if (picking == null && (resumable || deletable)) state.menu = state.sessionMenu(s, anchor.rect) },
            ).semantics { if (deletable) contentDescription = "${s.displayTitle}" },
            horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                title ?: AnnotatedString(s.displayTitle), Modifier.weight(1f), color = Theme.secondaryInk,
                style = plain(15), maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
            )
            // Which agent wrote it, before its time (as on the Mac): the mark a running terminal has, dimmed.
            PixelSprite(
                PixelArt.agents[s.harness] ?: PixelArt.square, pixel = 2.dp, color = Theme.inkDim, strength = 0.55f, shadow = false,
                modifier = Modifier.semantics { contentDescription = newTerminalAgents.firstOrNull { it.first == s.harness }?.second ?: s.harness },
            )
            Text(relativeTime(s.updated), color = Theme.inkDim, style = mono(11), maxLines = 1)
        }
        if (resumable && picking == null) {
            Box(
                Modifier.clickable(enabled = opening == null, role = Role.Button) { state.scope.launch { state.resume(s) } }.padding(horizontal = 2.dp, vertical = 2.dp),
                contentAlignment = Alignment.Center,
            ) {
                if (opening == s.id) BrailleSpinner(color = Theme.secondaryInk)
                else Text("Resume", color = if (classic) Theme.signal else Theme.ink, style = mono(12), maxLines = 1)
            }
        }
    }
}

/** `▸ N More` under a folder's sessions (▴ Less once opened). */
@Composable
private fun MoreRowView(line: Line.More, modifier: Modifier) {
    val classic = LocalLook.current.isClassic
    Row(modifier.fillMaxWidth().padding(vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        TreeLine(last = true, depth = line.depth)
        if (classic) {
            Box(Modifier.width(16.dp), contentAlignment = Alignment.Center) {
                LookSymbolIcon(if (line.all) LookSymbol.ChevronUp else LookSymbol.ChevronDown, side = 10.dp, color = Theme.secondaryInk, bold = true)
            }
            Text(if (line.all) "Less" else "${line.more} More", color = Theme.secondaryInk, style = mono(13))
        } else {
            Text(if (line.all) "▴ Less" else "▸ ${line.more} More", color = Theme.secondaryInk, style = mono(12))
        }
        Spacer(Modifier.weight(1f))
    }
}

/** A prompt line over the list: `/` as less and vim search, then what is typed; × clears it. */
@Composable
private fun SearchLine(state: TerminalsTabState) {
    val classic = LocalLook.current.isClassic
    Row(
        Modifier.padding(top = 4.dp, bottom = 2.dp).fillMaxWidth()
            // A framed prompt line; a round field on a quiet ground in the classic look.
            .grounded(if (classic) Theme.raised else Color.Transparent, 10.dp)
            .framed(if (classic) Color.Transparent else Theme.line, 10.dp)
            .padding(horizontal = 10.dp, vertical = if (classic) 7.dp else 6.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        if (classic) LookSymbolIcon(LookSymbol.Magnifier, side = 14.dp, color = Theme.inkDim)
        else Text("/", color = Theme.signal, style = mono(14, FontWeight.Bold))
        PlainField(
            state.query, { state.query = it }, Modifier.weight(1f).semantics { contentDescription = "搜索文件夹和会话" },
            placeholder = "Search", style = mono(if (classic) 15 else 14),
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(),
        )
        if (state.query.isNotEmpty()) {
            Box(
                Modifier.clickable(role = Role.Button, onClickLabel = "清除搜索") { state.query = "" }.padding(horizontal = 2.dp, vertical = 2.dp),
                contentAlignment = Alignment.Center,
            ) { LookGlyph("×", LookSymbol.XCircleFill, color = Theme.secondaryInk, size = 15, scale = 1f, bold = false) }
        }
    }
}

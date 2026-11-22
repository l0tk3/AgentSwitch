package com.agentswitch.android.terminals

import android.graphics.Bitmap
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.Color
import com.agentswitch.android.AppSettings
import com.agentswitch.android.platform.ImagePrep
import com.agentswitch.android.platform.PhoneScreen
import com.agentswitch.kit.api.MacPick
import com.agentswitch.kit.api.APIError
import com.agentswitch.kit.api.AgentSwitchAPI
import com.agentswitch.kit.api.AgentWriting
import com.agentswitch.kit.api.ModelChange
import com.agentswitch.kit.api.ScreenChoices
import com.agentswitch.kit.api.ScreenNotice
import com.agentswitch.kit.api.SentReply
import com.agentswitch.kit.api.TerminalActivity
import com.agentswitch.kit.api.TerminalAttachmentRef
import com.agentswitch.kit.api.TerminalEvent
import com.agentswitch.kit.api.TerminalInfo
import com.agentswitch.kit.api.TerminalKey
import com.agentswitch.kit.api.TerminalPermission
import com.agentswitch.kit.api.TerminalStatus
import com.agentswitch.kit.api.TerminalStyle
import com.agentswitch.kit.api.TerminalSubagent
import com.agentswitch.kit.api.TurnProgress
import com.agentswitch.kit.api.answerTerminalQuestion
import com.agentswitch.kit.api.chooseOnTerminal
import com.agentswitch.kit.api.clickTerminal
import com.agentswitch.kit.api.closeTerminal
import com.agentswitch.kit.api.decideTerminalPermission
import com.agentswitch.kit.api.redrawTerminal
import com.agentswitch.kit.api.renameTerminal
import com.agentswitch.kit.api.resizeTerminal
import com.agentswitch.kit.api.sendTerminalInput
import com.agentswitch.kit.api.sendTerminalKeys
import com.agentswitch.kit.api.setTerminalDaybreak
import com.agentswitch.kit.api.setTerminalEffort
import com.agentswitch.kit.api.setTerminalModel
import com.agentswitch.kit.api.terminalCommands
import com.agentswitch.kit.api.terminalEvents
import com.agentswitch.kit.feed.EffortDisplay
import com.agentswitch.kit.feed.QuestionPicks
import com.agentswitch.kit.feed.RecordDisplay
import com.agentswitch.kit.feed.SlashCommand
import com.agentswitch.kit.feed.TerminalDraft
import com.agentswitch.kit.files.UploadFile
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.util.UUID
import kotlin.math.abs

/**
 * One terminal on the phone (docs/terminal-v0.md §1): its stream drawn into the screen, its status and name, the
 * permission requests waiting, and what the phone sends — a sealed reply, named keys, a decision. One terminal has one
 * size ("尺寸有主"): the phone takes it when the user acts here (taps the screen or the reply box, sends, presses a key,
 * [ take over ]); opening the page or coming back to the app takes it only when no other screen is in use. While it
 * has it, the text size and the space set the grid. Another screen's size shows the placeholder over the frame as it
 * was; taking it over draws the screen afresh.
 *
 * Main thread only. `scope` runs what it starts (the stream, the debounced resize, the wheel, timers); it is the page's
 * (cancelled when the page leaves) and its dispatcher is the main one. Swift held itself weakly in its tasks, so a page
 * gone ended its stream at the next event; here the owner calls [stop] when the page leaves (or cancels `scope`).
 * `screenId`: this phone as a screen, [PhoneScreen.id] (the iPhone read it from `UserDefaults` itself).
 */
@Stable
class TerminalPageModel(
    terminal: TerminalInfo,
    fontSize: Float,
    showsScreen: Boolean = true,
    /**
     * This phone as a screen: the size it takes is its own until another takes it or this page's stream ends (the page
     * closed, the app in the background).
     */
    val screenId: String,
    private val scope: CoroutineScope,
) {
    val id: String = terminal.id
    var name: String by mutableStateOf(terminal.name)
        private set
    var harness: String by mutableStateOf(terminal.harness)
        private set
    var status: TerminalStatus by mutableStateOf(terminal.status)
        private set

    /** It writes a session of its own (not one it continues in place): closing may delete that record. */
    val ownsRecord: Boolean = terminal.resumedFrom == null || terminal.forked

    /** What `/` offers: the agent's slash commands in this folder. */
    var commands: List<SlashCommand> by mutableStateOf(emptyList())
        private set

    /** The Mac's AgentSwitch is too old to list them (said when `/` is typed). */
    var commandsUnavailable: Boolean by mutableStateOf(false)
        private set
    var permissions: List<TerminalPermission> by mutableStateOf(terminal.permissions)
        private set

    /** The terminal was closed (here or elsewhere): the page leaves. */
    var removed: Boolean by mutableStateOf(false)
        private set

    /** Drawn at least once (the placeholder goes). */
    var drawn: Boolean by mutableStateOf(false)
        private set

    /** Screens drawn afresh from a snapshot (each comes in top down). */
    var snapshots: Int by mutableStateOf(0)
        private set

    /** The Mac takes the wheel (one that predates it says so once, and the drag stops sending). */
    var wheelWorks: Boolean by mutableStateOf(true)
        private set
    var error: String? by mutableStateOf(null)

    /** "1 secret sealed" after a reply the sealer changed; cleared by the next one. */
    var sealedNote: String? by mutableStateOf(null)
        private set
    var sending: Boolean by mutableStateOf(false)
        private set

    val screen: TerminalScreenController = TerminalScreenController(fontSize)
    private var api: AgentSwitchAPI? = null
    private var follow: Job? = null

    /** Bumped each time a stream starts: events from one that was replaced are dropped. */
    private var followGeneration = 0
    private var resizing: Job? = null

    /** The grid the service last heard from this phone. */
    private var told: Pair<Int, Int>? = null

    /** Wheel notches not sent yet (up positive), and the send under way. */
    private var wheelPending = 0
    private var wheeling: Job? = null
    private var clickRefused = false

    /** Where the terminal is in use instead ("mac", "web", "iphone"): the placeholder over the frame as it was. */
    var away: String? by mutableStateOf(null)
        private set

    /** Who has the size, as the stream last said (null: nobody, or not heard yet). */
    private var owner: String? = null

    /** Just opened or back in front: the size is taken when the stream says no other screen has it. */
    private var claimOnConnect = false

    /** While that is not known yet, what the stream draws is held (drawn for another screen's width it comes apart here). */
    private var held: MutableList<TerminalEvent> = mutableListOf()

    /** A claim on its way: the stream may still say the size is another screen's (what it replays on connecting). */
    private var claiming = false

    /** The claim's own request (a layout change's resize does not cancel it). */
    private var claimTask: Job? = null

    /** The app is in front. */
    private var active = true
    private val mine: Boolean get() = owner == screenId

    /**
     * The page draws the terminal's screen. False in the simple view (docs/simple-view-v0.md §1): the stream then
     * carries no screen, this phone never takes the size, and the Mac says what the agent is doing and when the
     * session's record changed.
     */
    var showsScreen: Boolean by mutableStateOf(showsScreen)
        private set

    /** What the agent is doing now, as the record's stream says it (the list's reading until it has). */
    var activity: TerminalActivity? by mutableStateOf(terminal.activity)
        private set
    var subagents: List<TerminalSubagent> by mutableStateOf(terminal.subagents)
        private set

    /** The stream has said what it is doing (so "nothing" is known, not unheard). */
    var activityKnown: Boolean by mutableStateOf(false)
        private set

    /** When what it is doing now began (the tool, else the turn), milliseconds since 1970. */
    var activitySince: Long? by mutableStateOf(terminal.statusSince)
        private set

    /** How far the turn has come, as the agent's own screen counts it (null: it says nothing). */
    var progress: TurnProgress? by mutableStateOf(terminal.progress)
        private set

    /**
     * What it is writing now (docs/simple-view-v0.md §5.14), drawn at the record's end. Once the service says the part
     * is done it stays a moment ([writingKeepMs]): the record has it by then, and nothing goes blank between the two.
     */
    var writing: AgentWriting? by mutableStateOf(null)
        private set
    private var writingTimer: Job? = null

    /** Replies sent that the record does not hold yet: shown at its end meanwhile. */
    var sent: List<SentReply> by mutableStateOf(terminal.sent)
        private set

    /** The list the agent's own screen shows to choose from (null: none). */
    var choices: ScreenChoices? by mutableStateOf(terminal.choices)
        private set

    /** What its screen said to commands sent from a screen. */
    var notices: List<ScreenNotice> by mutableStateOf(terminal.notices)
        private set

    /** Changes when the session's record does: the page reads it again. */
    var recordRev: String? by mutableStateOf(null)
        private set

    /**
     * The session the record's stream last named (a `/clear` or another one resumed says so at once); null until it has,
     * and from an older Mac. The terminals' list, read every few seconds, may still name the one before.
     */
    var recordSession: String? by mutableStateOf(null)
        private set

    /** The model the agent says it is on now (Claude Code), as the stream last said; null until it has. */
    var modelNow: String? by mutableStateOf(terminal.modelNow)
        private set

    /** Codex's Daybreak switch as the stream said last (null: nothing said — the list's word stands). */
    var daybreakNow: Boolean? by mutableStateOf(null)
        private set

    /** What Claude Code offers as your next message, while it shows one: said over the empty reply box, a tap takes it. */
    var suggestion: String? by mutableStateOf(terminal.suggestion)
        private set

    /** A change of model is on its way to the agent. */
    var changingModel: Boolean by mutableStateOf(false)
        private set

    /** The thinking level a screen here asked for, until a turn has run at it (the record then says). */
    var effortAsked: String? by mutableStateOf(null)
        private set

    /** A page without a Mac (the sample screens): what it draws and offers (the iPhone's `DemoData` in a debug build). */
    private var demoScreen: String? = null
    private var demoCommands: List<SlashCommand> = emptyList()

    init {
        screen.onSize = { cols, rows -> sizeChanged(cols, rows) }
    }

    /** What it is writing now; null: the part is done, kept a moment. */
    private fun writes(now: AgentWriting?) {
        writingTimer?.cancel()
        writingTimer = null
        if (now != null) { if (writing != now) writing = now; return }
        if (writing == null) return
        writingTimer = scope.launch {
            delay(writingKeepMs)
            writing = null
        }
    }

    /** The stream followed (once; again after [stop]) and the Mac's colours taken. Without a Mac: the demo's screen. */
    fun start(api: AgentSwitchAPI?, style: TerminalStyle?) {
        if (style != null) screen.apply(style)
        if (follow != null) return
        this.api = api
        if (api == null) {
            demoScreen?.let {
                screen.snapshot(it)
                drawn = true
                snapshots += 1
            }
            if (demoScreen != null || demoCommands.isNotEmpty()) commands = demoCommands
            return
        }
        val id = id
        scope.launch {
            try {
                val listed = api.terminalCommands(id)
                commands = listed ?: emptyList()
                commandsUnavailable = listed == null
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                commandsUnavailable = true
            }
        }
        claimOnConnect = showsScreen
        startStream(api)
    }

    private fun startStream(api: AgentSwitchAPI) {
        val id = id
        val screen = if (showsScreen) screenId else null
        val record = !showsScreen
        followGeneration += 1
        val generation = followGeneration
        follow = scope.launch {
            try {
                api.terminalEvents(id, screen = screen, record = record).collect { event ->
                    // Replaced or stopped while this one was on its way: dropped.
                    if (!currentCoroutineContext().isActive || generation != followGeneration) return@collect
                    handle(event)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (generation == followGeneration) error = describe(e)
            }
        }
    }

    /** Again from a fresh snapshot (the service's screen at the size it has now). */
    private fun restartStream() {
        follow?.cancel()
        follow = null
        api?.let { startStream(it) }
    }

    /**
     * The app went to the background: the stream ends, and a few seconds later this phone's hold on the size (the Mac
     * takes it back).
     */
    fun suspend() {
        active = false
        follow?.cancel()
        follow = null
        resizing?.cancel()
    }

    /** Back in front: the stream again, and the size (the user is looking here). */
    fun resume() {
        active = true
        val api = api
        if (follow != null || api == null || removed) return
        claimOnConnect = showsScreen && status != TerminalStatus.Exited
        startStream(api)
    }

    /**
     * To the terminal's screen, or to the record. The screen comes fresh from the Mac and the size becomes this
     * phone's (the user chose to look at it here); leaving it gives the size back a moment later.
     */
    fun show(screen: Boolean) {
        if (screen == showsScreen) return
        showsScreen = screen
        follow?.cancel()
        follow = null
        resizing?.cancel()
        claimTask?.cancel()
        claiming = false
        held = mutableListOf()
        owner = null
        away = null
        drawn = false
        val api = api
        if (!active || api == null || removed) return
        claimOnConnect = screen && status != TerminalStatus.Exited
        startStream(api)
    }

    /** The screen's own background (the Mac's terminal colours): what covers it before it is drawn. */
    val ground: Color get() = Color(screen.background)

    /** The page leaves: the stream, the resize on its way and the wheel stop. */
    fun stop() {
        follow?.cancel()
        follow = null
        resizing?.cancel()
        wheeling?.cancel()
        wheeling = null
        wheelPending = 0
    }

    fun handle(event: TerminalEvent) {
        when (event) {
            // The record's stream draws nothing and owns no size (a Mac from before it still sends these).
            is TerminalEvent.Snapshot, is TerminalEvent.Output, is TerminalEvent.Resize -> if (!showsScreen) return
            else -> Unit
        }
        when (event) {
            is TerminalEvent.Snapshot -> {
                if (claimOnConnect) { held = mutableListOf(event); return }
                // Another screen has the size: the frame stays as it was under the placeholder (drawn for that screen's
                // width it would come apart here).
                if (away != null) return
                screen.snapshot(event.data)
                drawn = true
                snapshots += 1
                // Drawn at the size it had; at this phone's when it takes or has the size, and the agent draws again (its
                // links and status line are not in a snapshot).
                told = event.cols to event.rows
                if (mine) {
                    val grid = screen.grid
                    tellSize(grid.first, grid.second, redraw = true)
                }
            }
            is TerminalEvent.Output -> {
                if (claimOnConnect) { held.add(event); return }
                if (away != null) return
                screen.output(event.data)
                drawn = true
            }
            is TerminalEvent.Status -> {
                val s = event.status
                if (s != status) {
                    // A turn begins or ends: the clock starts over, and at rest it is doing nothing.
                    activitySince = System.currentTimeMillis()
                    if (s != TerminalStatus.Working) { activity = null; subagents = emptyList(); progress = null }
                    // A turn has run since the level was asked for: its record says what it ran at.
                    if (status == TerminalStatus.Working && s == TerminalStatus.Idle) effortAsked = null
                }
                status = s
            }
            is TerminalEvent.Writing -> writes(event.writing)
            is TerminalEvent.Activity -> {
                activityKnown = true
                if (event.activity != activity) { activity = event.activity; activitySince = System.currentTimeMillis() }
                subagents = event.subagents
            }
            is TerminalEvent.Progress -> progress = event.progress
            is TerminalEvent.Sent -> sent = event.replies
            is TerminalEvent.Choices -> choices = event.choices
            is TerminalEvent.Notices -> notices = event.notices
            is TerminalEvent.Record -> {
                recordRev = event.rev
                val session = event.session
                if (session != null && session != recordSession) recordSession = session
            }
            is TerminalEvent.Model -> modelNow = event.model
            is TerminalEvent.Daybreak -> daybreakNow = event.on
            is TerminalEvent.Suggestion -> suggestion = event.text
            is TerminalEvent.Name -> name = event.name
            is TerminalEvent.Resize -> resized(event.by)
            is TerminalEvent.Permission -> {
                val p = event.permission
                if (permissions.none { it.id == p.id }) permissions = permissions + p
            }
            is TerminalEvent.PermissionResolved -> {
                permissions = permissions.filter { it.id != event.id }
                questionPicks = questionPicks - event.id
            }
            is TerminalEvent.Permissions -> {
                val all = event.permissions
                permissions = all
                questionPicks = questionPicks.filterKeys { pid -> all.any { it.id == pid } }
            }
            is TerminalEvent.Exit -> {
                status = TerminalStatus.Exited
                permissions = emptyList()
                activity = null
                subagents = emptyList()
                progress = null
                writingTimer?.cancel(); writingTimer = null; writing = null
                sent = emptyList()
                choices = null
                if (!showsScreen) return
                if (away != null) {
                    // Nothing to take any more: the last screen, as the service has it.
                    away = null
                    restartStream()
                    return
                }
                screen.write("\r\n\u001b[2m[exited · code ${event.code?.toString() ?: "?"}]\u001b[0m\r\n")
            }
            TerminalEvent.Removed -> removed = true
        }
    }

    /** Who has the size now, as the stream says. */
    private fun resized(by: String?) {
        if (claimOnConnect) {
            // Opened or back in front: this phone's size unless another screen is in use (the placeholder says where).
            claimOnConnect = false
            val drawing = held
            held = mutableListOf()
            if (by == null || by == screenId) {
                owner = by
                away = null
                // A screen drawn for another width comes apart at this one: then a fresh one once the size is ours.
                val grid = screen.grid
                val first = drawing.firstOrNull()
                if (first is TerminalEvent.Snapshot && (first.cols != grid.first || first.rows != grid.second)) {
                    claim(fresh = true)
                } else {
                    for (e in drawing) handle(e)
                    claim()
                }
            } else {
                owner = by
                away = place(by)
            }
            return
        }
        if (claiming && by != screenId) return
        owner = by
        if (by != null && by != screenId) {
            away = place(by)
        } else if (by == null && active && drawn && !claimOnConnect && status != TerminalStatus.Exited) {
            claim()   // its owner left: this phone, in front, takes it back
        }
    }

    // MARK: size

    /** The text size or the space changed: the service hears it while the size is this phone's. */
    private fun sizeChanged(cols: Int, rows: Int) {
        if (!drawn || !mine) return
        tellSize(cols, rows, redraw = false)
    }

    /** Debounced: a pinch or the keyboard sliding in changes the grid many times. */
    private fun tellSize(cols: Int, rows: Int, redraw: Boolean) {
        val api = api
        if (cols < 20 || rows < 5 || status == TerminalStatus.Exited || api == null) return
        val id = id
        val me = screenId
        val same = told?.let { it.first == cols && it.second == rows } ?: false
        resizing?.cancel()
        resizing = scope.launch {
            delay(resizeDebounceMs)
            if (!same) quietly { api.resizeTerminal(id, cols = minOf(cols, 500), rows = minOf(rows, 300), screen = me) }
            told = cols to rows
            // The same size makes no redraw on its own: ask for one.
            if (redraw && same) quietly { api.redrawTerminal(id) }
        }
    }

    /** The user acts here: the size is this phone's (nothing is sent when it already is). */
    fun userActed() {
        if (showsScreen && !mine) claim()
    }

    /**
     * Takes the size: this phone's grid, told with its id (also at the same size: the owner changes). After the
     * placeholder the screen is drawn afresh at it — what came meanwhile was for another width, and was not drawn.
     */
    fun claim(fresh: Boolean = false) {
        val api = api
        if (api == null || status == TerminalStatus.Exited) return
        val wasAway = away != null || fresh
        owner = screenId
        away = null
        claiming = true
        val grid = screen.grid
        val cols = grid.first.coerceIn(20, 500)
        val rows = grid.second.coerceIn(5, 300)
        val same = told?.let { it.first == cols && it.second == rows } ?: false
        told = cols to rows
        val id = id
        val me = screenId
        claimTask?.cancel()
        claimTask = scope.launch {
            quietly { api.resizeTerminal(id, cols = cols, rows = rows, screen = me) }
            claiming = false
            if (wasAway) restartStream()
            // The same size makes no redraw on its own: ask for one.
            else if (same) quietly { api.redrawTerminal(id) }
        }
    }

    // MARK: sending

    /** A row of the list on the agent's own screen, taken as the terminal would take it. */
    suspend fun choose(pick: Int) {
        val api = api ?: return
        val choices = choices ?: return
        if (pick !in choices.options.indices) return
        try {
            api.chooseOnTerminal(id, pick = pick, label = choices.options[pick].label)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = describe(e)
        }
    }

    /**
     * A reply, pasted in and entered: as typed, or sealed on the Mac first (credentials become ciphertext). Its files go
     * where their placeholders stand: sent to the Mac first, then the reply says where each goes. True when it went.
     */
    suspend fun send(text: String, sealed: Boolean): Boolean {
        val api = api ?: return false
        if (text.isBlank()) return false
        sending = true
        try {
            userActed()
            val files = draftFiles.filter { text.contains(it.token) }
            // The phone's own files are sent first; the Mac's are named by where they are (docs/files-v0.md §5).
            val refs = files.mapNotNull { f -> f.macPath?.let { TerminalAttachmentRef(token = f.token, path = it) } }.toMutableList()
            val withFile = files.filter { it.file != null }
            if (withFile.isNotEmpty()) {
                val staged = api.upload(withFile.mapNotNull { it.file })
                refs += withFile.zip(staged).map { (f, s) -> TerminalAttachmentRef(token = f.token, upload = s.id) }
            }
            val result = api.sendTerminalInput(id, text = text, sealed = sealed, attachments = refs)
            draftFiles = emptyList()
            val notes = mutableListOf<String>()
            if (result.sealed > 0) notes.add(if (result.sealed == 1) "1 secret sealed" else "${result.sealed} secrets sealed")
            val attached = result.attached
            if (attached != null && attached > 0) notes.add(if (attached == 1) "1 file attached" else "$attached files attached")
            sealedNote = if (notes.isEmpty()) null else notes.joinToString(" · ")
            error = if (refs.isEmpty() || result.attached != null) null
            else "此 Mac 上的 AgentSwitch 版本不支持在回复里带图片和文件（占位符按文字发出了），请先更新。"
            return true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = describe(e)
            return false
        } finally {
            sending = false
        }
    }

    /**
     * Another model for the agent (Claude Code: its `/model <id>`, typed by the Mac). Says how it went: null when it
     * was refused (the page shows why).
     */
    suspend fun setModel(model: String): ModelChange? {
        val api = api ?: return null
        if (changingModel) return null
        changingModel = true
        try {
            val how = api.setTerminalModel(id, model = model)
            error = if (how == ModelChange.Typed) "已输入 ${RecordDisplay.modelCommand(model)}。Mac 上的 AgentSwitch 版本较旧：Claude Code 若要求确认，请切到终端查看。" else null
            return how
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = if (e is APIError.Http && e.status == 409) "它正在工作或等待回答，结束后再切换模型。" else describe(e)
        } finally {
            changingModel = false
        }
        return null
    }

    /**
     * Codex's Daybreak switch turned (docs/simple-view-v0.md §5.8): the Mac types Codex's own command and waits
     * until Codex says so, which takes a moment.
     */
    suspend fun setDaybreak(on: Boolean) {
        val api = api ?: return
        if (changingModel) return
        changingModel = true
        try {
            daybreakNow = api.setTerminalDaybreak(id, on = on)
            error = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = if (e is APIError.Http && e.status == 409) "Codex 没有切换：它正在等待回答，或它的屏幕上写着原因。" else describe(e)
        } finally {
            changingModel = false
        }
    }

    /** Another thinking level for the agent (Claude Code: its `/effort <level>`, typed by the Mac). */
    suspend fun setEffort(level: String) {
        val api = api ?: return
        if (changingModel) return
        changingModel = true
        try {
            val how = api.setTerminalEffort(id, effort = level)
            effortAsked = level
            error = if (how == ModelChange.Typed) "已输入 ${EffortDisplay.command(level)}。Mac 上的 AgentSwitch 版本较旧：Claude Code 若要求确认，请切到终端查看。" else null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = if (e is APIError.Http && e.status == 409) "它正在工作或等待回答，结束后再调整。" else describe(e)
        } finally {
            changingModel = false
        }
    }

    // MARK: files in the reply

    /**
     * A picture or file for the next reply (docs/terminal-v0.md §4): it stands in the reply box as its placeholder,
     * where the user put it, and goes there when the reply is sent — as Claude Code shows `[Image #1]`. One from the
     * phone is sent with the reply (`file`); one of the Mac's, picked in Files, is named by where it is (`macPath`).
     */
    data class DraftFile(
        val token: String,
        val number: Int,
        val isImage: Boolean,
        val name: String,
        val thumbnail: Bitmap?,
        val file: UploadFile? = null,
        val macPath: String? = null,
        val isFolder: Boolean = false,
        /** The Mac thinks it may hold a password: its chip is marked. */
        val sensitive: Boolean = false,
        val id: UUID = UUID.randomUUID(),
    )

    /** The files of the reply being written, in the order they were added. */
    var draftFiles: List<DraftFile> by mutableStateOf(emptyList())
        private set

    /**
     * Pictures and files picked (made small and upright on the phone, no location leaves it): kept for the reply;
     * their placeholders, to put in the box. Prepared here, on the main thread, as on the iPhone.
     */
    fun addDraftFiles(files: List<UploadFile>): List<String> {
        val tokens = mutableListOf<String>()
        for (file in files) {
            val prepared = ImagePrep.prepare(file) ?: continue
            val image = ImagePrep.isImage(prepared)
            val number = (draftFiles.maxOfOrNull { it.number } ?: 0) + 1
            val token = TerminalDraft.token(image = image, number = number)
            val thumbnail = if (image) ImagePrep.decode(prepared.data, side = draftThumbnailSide) else null
            draftFiles = draftFiles + DraftFile(token = token, number = number, isImage = image, name = prepared.name, thumbnail = thumbnail, file = prepared)
            tokens.add(token)
        }
        return tokens
    }

    /**
     * Files and folders of the Mac's, picked in Files (docs/files-v0.md §5): not copied, their paths go to the agent;
     * their placeholders, to put in the box. One already in the reply is not added twice.
     */
    fun addMacFiles(picks: List<MacPick>): List<String> {
        val tokens = mutableListOf<String>()
        for (pick in picks) {
            if (draftFiles.any { it.macPath == pick.path }) continue
            val number = (draftFiles.maxOfOrNull { it.number } ?: 0) + 1
            val token = TerminalDraft.token(image = false, number = number)
            draftFiles = draftFiles + DraftFile(token = token, number = number, isImage = false, name = pick.name, thumbnail = null,
                macPath = pick.path, isFolder = pick.isFolder, sensitive = pick.sensitive)
            tokens.add(token)
        }
        return tokens
    }

    fun removeDraftFile(file: DraftFile) {
        draftFiles = draftFiles.filter { it.id != file.id }
    }

    /** A placeholder deleted from the box: its file goes too. */
    fun keepDraftFiles(text: String) {
        if (draftFiles.any { !text.contains(it.token) }) draftFiles = draftFiles.filter { text.contains(it.token) }
    }

    /** Notches from a drag, sent together every 50 ms (at most 20 at a time) instead of one request each. */
    fun wheel(up: Boolean, count: Int) {
        if (api == null || status == TerminalStatus.Exited) return
        wheelPending += if (up) count else -count
        if (wheeling != null) return
        val job = scope.launch(start = CoroutineStart.LAZY) {
            val me = currentCoroutineContext()[Job]
            try {
                while (wheelPending != 0) {
                    val n = wheelPending.coerceIn(-wheelBatch, wheelBatch)
                    wheelPending -= n
                    try {
                        api?.sendTerminalKeys(id, List(abs(n)) { if (n > 0) TerminalKey.WheelUp else TerminalKey.WheelDown })
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        // Said once, and this drag stops: a Mac that predates the wheel answers 400.
                        if (e is APIError.Http && e.status == 400) {
                            wheelWorks = false
                            error = "此 Mac 上的 AgentSwitch 版本不支持滑动翻页，请先更新。"
                        } else {
                            error = describe(e)
                        }
                        wheelPending = 0
                        break
                    }
                    delay(wheelIntervalMs)
                }
            } finally {
                if (wheeling === me) wheeling = null
            }
        }
        wheeling = job
        job.start()
    }

    /** A left click on a cell, for a program that tracks the mouse. A Mac that predates it says so once. */
    suspend fun click(col: Int, row: Int) {
        val api = api ?: return
        if (status == TerminalStatus.Exited) return
        try {
            api.clickTerminal(id, col = col, row = row)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (e is APIError.Http && e.status == 400) {
                if (!clickRefused) error = "此 Mac 上的 AgentSwitch 版本不支持在手机上点击，请先更新。"
                clickRefused = true
            } else {
                error = describe(e)
            }
        }
    }

    suspend fun press(key: TerminalKey) {
        val api = api ?: return
        userActed()
        try {
            api.sendTerminalKeys(id, listOf(key))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = describe(e)
        }
    }

    suspend fun decide(permission: TerminalPermission, allow: Boolean) {
        val api = api
        if (api == null) { permissions = permissions.filter { it.id != permission.id }; return }
        try {
            // Answered or already answered elsewhere: either way the card goes.
            api.decideTerminalPermission(id, permissionId = permission.id, allow = allow)
            permissions = permissions.filter { it.id != permission.id }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = describe(e)
        }
    }

    /** What is picked on each question card (docs/terminal-v0.md §3 "选择题"), by its request. */
    var questionPicks: Map<String, QuestionPicks> by mutableStateOf(emptyMap())
        private set

    /** The question cards being sent (Other's words go through the Mac's sealer first, which may take a while). */
    var answering: Set<String> by mutableStateOf(emptySet())
        private set

    /** What is picked on `question` now: a copy (change it with [updatePicks]). */
    fun picks(question: TerminalPermission): QuestionPicks = questionPicks[question.id]?.copy() ?: QuestionPicks(question.questions)

    fun updatePicks(question: TerminalPermission, change: (QuestionPicks) -> Unit) {
        val picks = picks(question)
        change(picks)
        questionPicks = questionPicks + (question.id to picks)
    }

    /**
     * A question card's answers, once every question has one: the card goes when they are in, or when it was answered
     * already (in the terminal, on the Mac).
     */
    suspend fun answer(question: TerminalPermission) {
        val picks = picks(question)
        if (!picks.isComplete || question.id in answering) return
        val api = api
        if (api == null) { permissions = permissions.filter { it.id != question.id }; return }
        answering = answering + question.id
        try {
            userActed()
            val sealed = api.answerTerminalQuestion(id, permissionId = question.id, answers = picks.answers)
            if (sealed != null && sealed > 0) sealedNote = if (sealed == 1) "1 secret sealed" else "$sealed secrets sealed"
            permissions = permissions.filter { it.id != question.id }
            questionPicks = questionPicks - question.id
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = describe(e)
        } finally {
            answering = answering - question.id
        }
    }

    suspend fun rename(newName: String) {
        val api = api ?: return
        try {
            name = api.renameTerminal(id, name = newName.ifEmpty { null }).name
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = describe(e)
        }
    }

    /** Closes the terminal (and, `deleteRecord`, the session it wrote): true when it is closed. */
    suspend fun close(deleteRecord: Boolean = false): Boolean {
        val api = api ?: return true
        return try {
            api.closeTerminal(id, deleteRecord = deleteRecord)
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = describe(e)
            false
        }
    }

    companion object {
        /** How long what was being written stays once the part is done. */
        const val writingKeepMs = 1500L

        /** A grid change is told to the service once it has held this long. */
        const val resizeDebounceMs = 250L

        /** The wheel's notches go together this often, at most [wheelBatch] at a time. */
        const val wheelIntervalMs = 50L
        const val wheelBatch = 20

        /** A picked picture's chip, pixels on its long side (96 points on a 3× iPhone). */
        const val draftThumbnailSide = 288

        /** One id for this phone, kept across pages and launches (PhoneScreen; the browser's tabs know it by the same id). */
        fun phoneScreen(settings: AppSettings): String = PhoneScreen.id(settings)

        /** Where the terminal is in use instead: "iphone" (another phone), "mac" or "web". */
        fun place(screen: String): String =
            if (screen.startsWith("phone")) "iphone" else if (screen.startsWith("mac")) "mac" else "web"

        /**
         * A page on made-up data (the sample screens; the iPhone's page without a Mac in a debug build): `screen` drawn
         * when it starts with no Mac (`start(null, …)`), `commands` what `/` offers. The data itself is the caller's
         * (`demo/DemoData.kt`).
         */
        fun demo(
            terminal: TerminalInfo,
            screen: String?,
            commands: List<SlashCommand>,
            scope: CoroutineScope,
            fontSize: Float = 12f,
            showsScreen: Boolean = true,
            screenId: String = "phone-demo0000",
        ): TerminalPageModel = TerminalPageModel(terminal, fontSize, showsScreen, screenId, scope).also {
            it.demoScreen = screen
            it.demoCommands = commands
        }

        private fun describe(e: Throwable): String = e.message ?: e.toString()

        /** `try?` that lets cancellation through. */
        private inline fun quietly(body: () -> Unit) {
            try {
                body()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
            }
        }
    }
}

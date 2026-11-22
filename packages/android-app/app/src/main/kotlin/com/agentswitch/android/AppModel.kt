package com.agentswitch.android

import kotlinx.coroutines.delay
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.agentswitch.kit.api.APIError
import com.agentswitch.kit.api.AgentSwitchAPI
import com.agentswitch.kit.api.Me
import com.agentswitch.kit.api.asMacFileSource
import com.agentswitch.android.dispatch.DispatchServices
import com.agentswitch.android.dispatch.DispatchStore
import com.agentswitch.kit.feed.Cue
import com.agentswitch.android.platform.Notifier
import com.agentswitch.android.terminals.TerminalsStore
import com.agentswitch.kit.api.PinnedSessionTransport
import com.agentswitch.kit.connection.ConnectionManager
import com.agentswitch.kit.connection.ConnectionPhase
import com.agentswitch.kit.connection.ConnectionProgress
import com.agentswitch.kit.connection.ConnectionState
import com.agentswitch.kit.connection.HTTPEndpointProber
import com.agentswitch.kit.connection.PathMonitoring
import com.agentswitch.kit.connection.ServiceDiscovery
import com.agentswitch.kit.feed.TerminalCueTracker
import com.agentswitch.kit.feed.TerminalDoneTracker
import com.agentswitch.kit.feed.noticeName
import com.agentswitch.kit.feed.noticeWait
import com.agentswitch.kit.feed.spokenWait
import com.agentswitch.kit.pairing.PairedMacs
import com.agentswitch.kit.pairing.PairingPayload
import com.agentswitch.kit.pairing.PairingService
import com.agentswitch.kit.pairing.ServerProfile
import com.agentswitch.kit.storage.LocalStore
import com.agentswitch.kit.storage.TokenVault
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.launch

/** The entries side by side (docs/terminal-v0.md §1, browser-v0 §1): terminals first, the app opens on them. */
enum class MainTab { Terminals, Tasks, Files, Browser, Settings }

sealed class GateKeyStatus {
    data object Unknown : GateKeyStatus()
    data object Available : GateKeyStatus()

    /** The Mac could not read its gate key (`GET /gate/pubkey` → 503); minting waits until it can. */
    data class Unavailable(val reason: String) : GateKeyStatus()
}

/** What the phone itself gives the app: finding the Mac nearby, hearing of network changes, its own name. */
interface PlatformServices {
    fun discovery(): ServiceDiscovery?
    fun paths(): PathMonitoring?
    val deviceName: String

    /** The way to the Mac's LAN address around a VPN on the phone, where there is one (kit `DirectRoute`). */
    fun directRoute(): com.agentswitch.kit.connection.DirectRoute? = null
}

/**
 * App-wide state (the iPhone's `AppModel`): the paired Macs and the current one, the live connection, what was read
 * from it. Views read it as Compose state; everything network-bound goes through `api`, which is pinned to the paired
 * certificate. Everything here is touched on the main thread only.
 */
@Stable
class AppModel(
    private val store: LocalStore?,
    private val vault: TokenVault,
    private val services: PlatformServices?,
    val scope: CoroutineScope = MainScope(),
    dispatchServices: DispatchServices = DispatchServices(),
    /** What the phone keeps (the iPhone's `UserDefaults`): the Files tab's last places, the Browser's addresses and zoom. Null in a preview. */
    val settings: AppSettings? = null,
    /** Where files wait on their way to the Mac or to be shared (the cache directory); null: the JVM's temporary one. */
    tempDir: java.io.File? = null,
) {
    /** Every paired Mac; the app talks to the current one only (app-v0 §5 多台 Mac). */
    var macs: PairedMacs by mutableStateOf(PairedMacs())
        private set
    val profile: ServerProfile? get() = macs.current
    var connection: ConnectionState by mutableStateOf(ConnectionState.Idle)
        private set

    /** How the attempts went since the last connection: the tiers of the connection line (control-v0 §5). */
    var connectionProgress: ConnectionProgress by mutableStateOf(ConnectionProgress())
        private set
    var api: AgentSwitchAPI? by mutableStateOf(null)
        private set
    var me: Me? by mutableStateOf(null)
        private set

    /** How each address fared in the last route choice (settings › Mac), for "why can't it connect". */
    var routeReport: ConnectionManager.LastReport? by mutableStateOf(null)
        private set
    var gateKeyStatus: GateKeyStatus by mutableStateOf(GateKeyStatus.Unknown)
        private set

    /** The app opens on the terminals (2026-10-07, user: 手机默认进入 terminal 页吧): what the phone is used for most. */
    var tab: MainTab by mutableStateOf(MainTab.Terminals)

    /** A pairing link from a tap or a scan, waiting for the user to confirm. */
    var incomingPairingLink: String? by mutableStateOf(null)

    /** Adding a Mac, or pairing again with one that no longer knows this phone: the scanner is asked for. */
    var addingMac: Boolean by mutableStateOf(false)
    var banner: String? by mutableStateOf(null)

    /** The app is in front (its activity is resumed). */
    /** Follows the Mac from behind while something is in progress (FollowService); null in sample screens and tests. */
    var follower: com.agentswitch.android.platform.Follower? = null

    var inFront: Boolean by mutableStateOf(true)

    /** The terminals tab (its list, the Mac's other sessions, the colours). */
    val terminals = TerminalsStore()
    private var terminalCues = TerminalCueTracker()
    private var terminalDone = TerminalDoneTracker()

    /** The phone's own notifications; none in a preview or a test. */
    var notifier: Notifier? = null

    /** The terminal whose page is on screen: nothing is notified of it while the app is in front. */
    var viewedTerminal: String? = null
        set(value) {
            field = value
            if (value != null) notifier?.clear(value)
        }

    /** A terminal to open on the terminals tab (a notification's link, a demo screen); the tab takes it. */
    var openTerminalRequest: String? by mutableStateOf(null)

    /** A folder to show on the Files tab (a terminal row's `Show in Files`); the tab takes it. */
    var openFilesRequest: String? by mutableStateOf(null)

    private var manager: ConnectionManager? = null

    /** Bumped whenever the current Mac changes: an answer that arrives later from the one before is dropped. */
    var session = 0
        private set
    private var watcher: Job? = null

    /** What is read again whenever a connection is made or the app comes back: each part of the app adds its own. */
    private val refreshers = ArrayList<suspend () -> Unit>()

    /** What is cleared when the current Mac changes: each part of the app adds its own. */
    private val resetters = ArrayList<() -> Unit>()

    /** The Files tab across its visits (`FilesStore`); joins `onReset`. */
    val files = com.agentswitch.android.files.FilesStore(scope, settings, tempDir ?: java.io.File(System.getProperty("java.io.tmpdir") ?: "."))

    /** The Browser tab's data (`BrowserStore`); joins `onReset`. */
    val browser = com.agentswitch.android.browser.BrowserStore(scope, settings)

    /** The API whose browser routes are those of the browser the tab shows (the shared one, or a profile's own). */
    val browserAPI: AgentSwitchAPI? get() = browser.scoped(api)

    /** A tab to open on the Browser tab (a link's tab, a demo screen; `new`: the new-tab sheet); the tab takes it. */
    var openBrowserRequest: String? by mutableStateOf(null)

    /** A link's page over where the link was (`open(link)`): `Done` goes back there; the screens show it and clear it. */
    var linkedPage: com.agentswitch.kit.api.BrowserTabInfo? by mutableStateOf(null)

    /** The Mac's files to a screen: the API's, or the made-up disk of a sample screen. */
    var demoFiles: com.agentswitch.kit.api.MacFileSource? = null
    val fileSource: com.agentswitch.kit.api.MacFileSource? get() = api?.asMacFileSource() ?: demoFiles

    init { onReset { files.reset(); browser.reset(); linkedPage = null; openBrowserRequest = null } }

    /** The Dispatch half: tasks, conversation, input box, ciphertexts (after `refreshers` and `resetters`, which it joins). */
    val dispatch = DispatchStore(this, store, dispatchServices)

    val isPaired: Boolean get() = !macs.isEmpty
    val canMint: Boolean get() = profile?.gate?.isValid == true
    val deviceName: String get() = services?.deviceName ?: "Android"

    /** What the connection line says now (连接中 · 重连中 · 无法连接（第 N 次）· 未找到 Mac · 配对已失效). */
    val connectionPhase: ConnectionPhase get() = connectionProgress.phase(connection)

    /** Reads what was saved and connects to the current Mac. Once, when the process starts. */
    fun start() {
        try { macs = store?.loadMacs() ?: PairedMacs() } catch (e: Exception) { banner = e.message }
        connectCurrent()
    }

    fun onRefresh(body: suspend () -> Unit) { refreshers.add(body) }
    fun onReset(body: () -> Unit) { resetters.add(body) }

    // MARK: pairing

    fun receivePairingLink(text: String) {
        incomingPairingLink = text
    }

    /**
     * Pairs with the Mac in `payload` and makes it the current one: a Mac paired before is renewed in place, a new one
     * is added. Nothing saved changes unless the pairing succeeded.
     */
    suspend fun pair(payload: PairingPayload, deviceName: String) {
        val transport = PinnedSessionTransport(payload.fp, services?.directRoute())
        val outcome = PairingService(transport, services?.discovery()).pair(payload, deviceName)
        vault.save(outcome.token, outcome.profile.tokenAccount)
        stopConnection()
        resetSession()
        save(macs.adding(outcome.profile))
        gateKeyStatus = if (outcome.profile.gate == null) GateKeyStatus.Unknown else GateKeyStatus.Available
        connect(outcome.token, transport)
    }

    /** Talk to another paired Mac: what came from the current one goes. */
    fun switchTo(fingerprint: String) {
        if (fingerprint == profile?.fingerprint || macs.server(fingerprint) == null) return
        stopConnection()
        resetSession()
        save(macs.activating(fingerprint))
        connectCurrent()
    }

    /**
     * Removes the current Mac (its token, its details and everything fetched from it) and moves to the next one, or
     * back to pairing when none is left.
     */
    fun forget() {
        val old = profile ?: return
        stopConnection()
        resetSession()
        try { vault.delete(old.tokenAccount) } catch (_: Exception) { /* nothing was kept */ }
        save(macs.removing(old.fingerprint))
        connectCurrent()
    }

    /** The Mac no longer knows this phone: scan its QR code again (pairing renews it in place). */
    fun pairAgain() {
        addingMac = true
    }

    /** `body`'s answer, or null when the current Mac changed while waiting for it (or it failed: `handle` then). */
    suspend fun <T> fetch(quiet: Boolean = false, body: suspend (AgentSwitchAPI) -> T): T? {
        val api = api ?: return null
        val asked = session
        return try {
            val value = body(api)
            if (asked == session) value else null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (asked == session && !quiet) handle(e)
            null
        }
    }

    private fun save(next: PairedMacs) {
        macs = next
        try { store?.saveMacs(next) } catch (e: Exception) { banner = e.message }
    }

    /** Clears what was fetched from the current Mac, before switching or removing it. */
    private fun resetSession() {
        session += 1
        connection = ConnectionState.Idle
        connectionProgress = ConnectionProgress()
        routeReport = null
        api = null
        me = null
        gateKeyStatus = GateKeyStatus.Unknown
        terminalCues = TerminalCueTracker()
        terminalDone = TerminalDoneTracker()
        terminals.reset()
        for (reset in resetters) reset()
    }

    // MARK: connection

    /** Connects to the current Mac with its saved token; without one it is shown as no longer paired. */
    private fun connectCurrent() {
        val current = profile ?: return
        gateKeyStatus = if (current.gate == null) GateKeyStatus.Unknown else GateKeyStatus.Available
        val token = try { vault.load(current.tokenAccount) } catch (_: Exception) { null }
        if (token == null) {
            connection = ConnectionState.Unauthorized
            return
        }
        connect(token, PinnedSessionTransport(current.fingerprint, services?.directRoute()))
    }

    private fun connect(token: String, transport: PinnedSessionTransport) {
        val profile = profile ?: return
        stopConnection()
        val manager = ConnectionManager(book = profile, token = token, discovery = services?.discovery(), prober = HTTPEndpointProber(transport))
        this.manager = manager
        api = AgentSwitchAPI(endpoints = manager, transport = transport, token = token)
        watcher = scope.launch {
            services?.paths()?.let { manager.startMonitoring(it) }
            launch { manager.states().collect { connectionChanged(manager, it) } }
            manager.reselect()
        }
    }

    private fun stopConnection() {
        watcher?.cancel()
        watcher = null
        manager?.stop()
        manager = null
    }

    private fun connectionChanged(from: ConnectionManager, state: ConnectionState) {
        if (from !== manager) return
        val wasConnected = connection.endpoint != null
        connection = state
        connectionProgress = connectionProgress.after(state)
        if (state != ConnectionState.Selecting) routeReport = from.lastReport
        if (state.endpoint != null && !wasConnected) {
            scope.launch {
                refreshAll()
                refreshGateKey()
                refreshAddresses()
                fetch(quiet = true) { it.me() }?.let { me = it }
            }
        }
    }

    /**
     * Back in the foreground (control-v0 §5): the address in use is checked at once, since it may have gone while the
     * phone slept (another Wi-Fi, Tailscale off), and a new one chosen if it does not answer; then a refresh. A
     * connection that comes back refreshes by itself (connectionChanged).
     */
    fun resume() {
        val manager = manager ?: return
        if (connection == ConnectionState.Unauthorized) return
        val before = connection.endpoint
        scope.launch {
            val state = manager.verify()
            val endpoint = state.endpoint
            if (endpoint != null && endpoint == before) {
                refreshAll()
                refreshAddresses()
            }
        }
    }

    fun reconnect() {
        val manager = manager ?: return
        scope.launch { manager.reselect() }
    }

    // MARK: data

    suspend fun refreshAll() {
        for (refresh in refreshers.toList()) refresh()
    }

    /** From a notification: the terminals tab opens the terminal. */
    fun openTerminal(id: String) {
        tab = MainTab.Terminals
        openTerminalRequest = id
    }

    /** A folder on the Files tab (a terminal row's `Show in Files`). */
    fun showInFiles(path: String) {
        openFilesRequest = path
        tab = MainTab.Files
    }

    /**
     * The terminals' list, from any tab (terminal-v0 §1): the tab's badge, and a notification for a terminal that
     * newly waits and for one whose turn ended — not for the one on screen in front. `sessions`: the Mac's other
     * sessions too (the tab's own refresh).
     */
    suspend fun refreshTerminals(sessions: Boolean = false) {
        val api = api ?: return
        val asked = session
        terminals.refreshList(api)
        if (sessions) {
            terminals.refreshSessions(api)
            terminals.refreshGit(api)
        }
        if (asked != session) return
        val fresh = terminalCues.newlyWaiting(terminals.terminals)
        // The "needs you" cue for a terminal that newly waits, read aloud in voice mode (the assistant does not report
        // terminals).
        if (fresh.isNotEmpty()) {
            dispatch.feedback.play(Cue.NeedsYou, speaking = dispatch.speaker.isSpeaking)
            if (dispatch.feedback.voiceMode) {
                dispatch.speaker.say(fresh.joinToString("。") { it.spokenWait }, key = "terminals:" + fresh.joinToString(",") { it.id })
            }
        }
        val seen = if (inFront) viewedTerminal else null
        for (terminal in fresh) if (terminal.id != seen) notifier?.post(terminal.id, "${terminal.noticeName} · Needs You", terminal.noticeWait)
        for (terminal in terminalDone.newlyDone(terminals.terminals)) if (terminal.id != seen) notifier?.post(terminal.id, "${terminal.noticeName} · Done", "这一轮结束了。")
        // What is in progress has the terminals in it (and each asking lets a wait that is over run out: FollowRule).
        dispatch.syncLive()
    }

    /**
     * The app leaves the screen (FollowService): what the terminals are doing is asked once more now and once a moment
     * later, so that a reply sent just before leaving — its terminal not yet said to be at work — still starts the
     * following. Android lets a service start for a few seconds after an app left the screen, not later.
     */
    fun leaving() {
        if (follower?.enabled != true || api == null) return
        scope.launch {
            refreshTerminals()
            delay(leavingRecheckMs)
            if (!inFront) refreshTerminals()
        }
    }

    /**
     * The Mac's current addresses into the saved profile and the address choice, so a phone paired while Tailscale was
     * off (or before the Mac's LAN address changed) still finds it elsewhere next time. Asked when a connection is
     * made, when the app comes back to the front, and every `addressRefreshInterval` while connected.
     */
    suspend fun refreshAddresses() {
        val api = api ?: return
        val profile = profile ?: return
        val now = try { api.addresses() } catch (e: CancellationException) { throw e } catch (_: Exception) { return }
        val updated = profile.updated(now) ?: return
        if (updated.fingerprint != this.profile?.fingerprint) return
        save(macs.updating(updated))
        manager?.update(updated)
    }

    /**
     * The Mac's current gate key. Kept as is when the Mac cannot read it (503), so minting keeps working with the key
     * from pairing; the gate still opens tokens made for any of its keypairs.
     */
    suspend fun refreshGateKey() {
        val api = api ?: return
        val profile = profile ?: return
        try {
            val key = api.gatePubkey()
            if (!key.isValid || profile.fingerprint != this.profile?.fingerprint) return
            if (key != profile.gate) save(macs.updating(profile.with(gate = key)))
            gateKeyStatus = GateKeyStatus.Available
        } catch (e: CancellationException) {
            throw e
        } catch (e: APIError.Http) {
            if (e.status == 503) {
                if (profile.gate == null) gateKeyStatus = GateKeyStatus.Unavailable(e.detail.ifEmpty { "公钥暂时不可用" })
            } else handle(e)
        } catch (e: Exception) {
            handle(e)
        }
    }

    /**
     * Central error funnel: a 401 anywhere means this phone is no longer paired. A network failure is left to the
     * connection line (无法连接（第 N 次）…), which says it better and goes away by itself once the Mac is back.
     */
    fun handle(error: Throwable) {
        if (error is CancellationException) return
        if (error is APIError) {
            if (error == APIError.Unauthorized) {
                connection = ConnectionState.Unauthorized
                banner = error.message
                return
            }
            if (error.isNetworkFailure) return
        }
        banner = error.message ?: error.javaClass.simpleName
    }

    /**
     * The sample screens (a debug build's `uiDemo`): a paired Mac and a connection that were never made, no network.
     * Nothing is saved (the store and the vault of such a model are in memory).
     */
    fun setDemo(macs: PairedMacs, connection: ConnectionState, progress: ConnectionProgress, routeReport: ConnectionManager.LastReport? = null) {
        this.macs = macs
        this.connection = connection
        this.connectionProgress = progress
        this.routeReport = routeReport
    }

    companion object {
        /** How long after leaving the screen the terminals are asked about a second time (leaving). */
        const val leavingRecheckMs = 2_500L
        /** While connected the Mac is asked for its addresses again this often (app-v0 §5). */
        const val addressRefreshIntervalMs = 300_000L
    }
}

package com.agentswitch.android.demo

import androidx.compose.runtime.staticCompositionLocalOf
import com.agentswitch.android.AppModel
import com.agentswitch.android.MainTab
import com.agentswitch.android.files.FilesStore
import com.agentswitch.android.terminals.ReplyDrafts
import com.agentswitch.kit.api.MacPick
import com.agentswitch.kit.api.APIEndpoint
import com.agentswitch.kit.api.EndpointKind
import com.agentswitch.kit.api.ProfileChoice
import com.agentswitch.kit.api.ProfileChoices
import com.agentswitch.kit.api.ProfileColor
import com.agentswitch.kit.connection.ConnectionManager
import com.agentswitch.kit.connection.ConnectionProgress
import com.agentswitch.kit.connection.ConnectionState
import com.agentswitch.kit.connection.ProbeOutcome
import com.agentswitch.kit.connection.ProbeReport
import com.agentswitch.kit.pairing.GateKey
import com.agentswitch.kit.pairing.PairedMacs
import com.agentswitch.kit.pairing.PairingPayload
import com.agentswitch.kit.pairing.ServerProfile
import com.agentswitch.kit.storage.MemoryTokenVault

/**
 * The sample screen a debug build was started on (the iPhone's `-uiDemo YES -uiDemoScreen <name>`; here
 * `--ez uiDemo true --es uiDemoScreen <name>`): null in the real app. A page reads it to open in the state the
 * screen's name asks for (a menu open, a search typed) — never to change what it does with a real Mac.
 */
val LocalDemoScreen = staticCompositionLocalOf<String?> { null }

/**
 * `--ez uiDemoOpenTools true` (the iPhone's `-uiDemoOpenTools YES`): every tool call and every fold of calls on a task
 * page starts open, for looking at the screen (docs/ui-v0.md §5).
 */
val LocalDemoOpenTools = staticCompositionLocalOf { false }

/**
 * `--es uiDemoScroll route` (the iPhone's `-uiDemoScroll route`, with `mac` or `offlinemac`): the Mac page opens
 * scrolled to the end of troubleshooting with the common causes open — a screenshot cannot scroll by hand.
 */
val LocalDemoScroll = staticCompositionLocalOf<String?> { null }

/** Whether this is a sample screen at all (no Mac, no network), also when no screen was named. */
val LocalDemo = staticCompositionLocalOf { false }

object Demo {
    /**
     * The sample screens' state: a paired Mac, the demo terminals and sessions, no network. `offline`: the Mac has not
     * answered for three tries in a row, the last route choice found nothing.
     */
    fun model(screen: String?, offline: Boolean = false, phoneScreen: String = "phone-demo0000"): AppModel {
        val model = AppModel(store = null, vault = MemoryTokenVault(), services = null)
        val payload = PairingPayload(
            name = "Mac mini", port = 4713, fp = "ab".repeat(32), code = "7K3M-9QZX", lan = listOf("192.168.1.5"), tailnet = listOf("100.101.102.103"),
            bonjour = "AgentSwitch on Mac mini", gate = GateKey(publicKey = "A".repeat(43), keypair = "default"),
        )
        val macs = PairedMacs(servers = listOf(
            ServerProfile(payload = payload, deviceId = "dev-preview", gate = null),
            ServerProfile(
                name = "MacBook Pro", port = 4713, fingerprint = "cd".repeat(32), lan = listOf("192.168.1.8"), tailnet = emptyList(),
                bonjour = "AgentSwitch on MacBook Pro", gate = null, deviceId = "dev-preview-2", pairedAt = System.currentTimeMillis(),
            ),
        ))
        var connection: ConnectionState = ConnectionState.Connected(APIEndpoint(host = "192.168.1.5", port = 4713, kind = EndpointKind.Bonjour))
        var progress = ConnectionProgress().after(connection)
        var report: ConnectionManager.LastReport? = ConnectionManager.LastReport(at = System.currentTimeMillis() - 40_000, reports = DemoData.routeReport)
        // `terminalprofiles`, `newterminalprofile`, `terminalmenuprofile`: Claude Code with more than the Mac's own
        // sign-in (docs/profiles-v0.md §3.3) — a `Profile` row in the new-terminal sheet, `Resume As` in a session's menu.
        val profiles: Map<String, ProfileChoices> = if (screen?.contains("profile") == true) mapOf(
            "claude-code" to ProfileChoices(current = "abc123def0", profiles = listOf(
                ProfileChoice(id = "default", name = "Default", account = "me@example.com"),
                ProfileChoice(id = "abc123def0", name = "cwork1", account = "work@example.com", color = ProfileColor.Violet),
                ProfileChoice(id = "abc123def1", name = "side", color = ProfileColor.Sand),
            )),
        ) else emptyMap()
        // `terminalsconnecting`: the first connection still being made, nothing read yet (the Terminals tab's one line).
        if (screen == "terminalsconnecting") {
            connection = ConnectionState.Selecting
            progress = ConnectionProgress()
        } else if (screen == "terminalsmany") {
            // The long tree (docs/terminal-v0.md §1): one home folder holding everything, as a Mac's real list nests.
            model.terminals.setDemo(TerminalsListProbe.list(0), sessions = TerminalsListProbe.sessions(0), profiles = profiles)
        } else {
            model.terminals.setDemo(DemoData.terminalList(screen), sessions = DemoData.sessions, git = DemoData.git, profiles = profiles)
        }
        model.dispatch.setDemo(DemoData.tasks, DemoData.threads, DemoData.approvals, DemoData.messages, DemoData.quota)
        if (offline) {
            val start = System.currentTimeMillis() - 150_000
            connection = ConnectionState.Unreachable
            for (i in 0 until 3) progress = progress.after(ConnectionState.Unreachable, at = start + i * 30_000L)
            report = ConnectionManager.LastReport(
                at = System.currentTimeMillis() - 20_000,
                reports = DemoData.routeReport.map { ProbeReport(endpoint = it.endpoint, outcome = ProbeOutcome.Unreachable("请求超时。"), seconds = 4.0) },
            )
        }
        // The Files tab's made-up disk (`filesscoped`: as a device given only one folder sees it).
        model.demoFiles = DemoFiles(scope = if (screen == "filesscoped") DemoFiles.scopeFolder else null)
        // The Browser tab's sample tabs (held by this phone as the screen `phoneScreen`, `PhoneScreen.id`).
        model.browser.setDemo(DemoBrowser.list(screen, phoneScreen), DemoBrowser.servers, DemoBrowser.recent, DemoBrowser.zoom(screen),
            browsers = if (screen == "browserprofiles") DemoBrowser.profileBrowsers else null)
        model.setDemo(macs, connection, progress, report)
        open(model, screen, phoneScreen)
        return model
    }

    /** Where a sample screen's name leads: its tab, and the page opened on it (the iPhone's `AgentSwitchApp`). */
    private fun open(model: AppModel, screen: String?, phoneScreen: String) {
        when {
            screen == null -> Unit
            screen in settingsScreens -> model.tab = MainTab.Settings
            screen == "task" -> { model.tab = MainTab.Tasks; model.dispatch.openTaskRequest = "t2" }
            screen == "done" -> { model.tab = MainTab.Tasks; model.dispatch.openTaskRequest = "t3" }
            screen == "running" -> { model.tab = MainTab.Tasks; model.dispatch.openTaskRequest = "t1" }
            screen == "stale" -> { model.tab = MainTab.Tasks; model.dispatch.openTaskRequest = "t4" }
            screen == "interrupted" -> { model.tab = MainTab.Tasks; model.dispatch.openTaskRequest = "t6" }
            // The Dispatch page itself (the app opens on the terminals).
            screen == "home" || screen == "offline" || screen == "keptfiles" -> model.tab = MainTab.Tasks
            // The Files tab (docs/files-v0.md §5) on the made-up disk (DemoFiles): its pages in the Files screens.
            screen in filesProjectScreens -> { model.tab = MainTab.Files; model.openFilesRequest = DemoFiles.project }
            screen == "fileshome" || screen == "filesscoped" -> { model.tab = MainTab.Files; model.openFilesRequest = DemoFiles.home }
            // `Show in Files` for a session whose folder is gone: its nearest level still there (files-v0 §12.4).
            screen == "filesgone" -> { model.tab = MainTab.Files; model.openFilesRequest = "${DemoFiles.project}/packages/gone" }
            // The Mac's files in its reply box, as the Files tab hands them over, to a reply begun before (kept as a draft is).
            // A link tapped on a terminal's screen: its page over the terminal, `Done` back to it.
            screen == "linkedpage" -> {
                model.tab = MainTab.Terminals; model.openTerminalRequest = "a1b2c3d4"
                model.linkedPage = DemoBrowser.list(screen, phoneScreen).tabs.firstOrNull { it.id == "vite" }
            }
            screen == "filesreply" -> {
                model.tab = MainTab.Terminals; model.openTerminalRequest = "a1b2c3d4"
                ReplyDrafts.text["a1b2c3d4"] = "对照一下 "
                model.files.handoff = FilesStore.Handoff("a1b2c3d4", listOf(
                    MacPick(path = "${DemoFiles.project}/src/app.ts", isFolder = false),
                    MacPick(path = "${DemoFiles.project}/.env", isFolder = false, sensitive = true),
                ))
            }
            // One terminal's page, in the view its name says.
            screen in terminalPageScreens || screen.startsWith("simple") -> { model.tab = MainTab.Terminals; model.openTerminalRequest = "a1b2c3d4" }
            screen.startsWith("terminal") || screen.startsWith("newterminal") -> model.tab = MainTab.Terminals
            screen.startsWith("files") -> model.tab = MainTab.Files
            screen.startsWith("browser") -> { model.tab = MainTab.Browser; model.openBrowserRequest = DemoBrowser.openRequest(screen) }
        }
    }

    private val filesProjectScreens = setOf(
        "files", "filesopen", "filespreview", "filespreviewlong", "filesimage", "filesselect", "fileschoose", "filessensitive",
        "filesnew", "filesnameerror", "filestrash", "filestrashbusy", "filesselectbar", "filesshare", "filesupload", "filesclash",
    )
    private val settingsScreens = setOf(
        "settings", "mac", "offlinemac", "tasks", "search", "sessions", "transcript", "transcriptfiles", "proxies", "clash", "clashservice",
        "clashrules", "clashcheck", "clashnodes", "clashtext", "clashsource", "proxybrowser", "proxyprofile",
    )
    private val terminalPageScreens = setOf(
        "terminal", "terminalsealed", "terminalslash", "terminalclose", "terminalkeyboard", "terminalquestion", "terminallink", "terminalpath",
        "filessheet", "filesreply", "linkedpage",
    )
}

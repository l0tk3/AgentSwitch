package com.agentswitch.android.files

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.LocalSettings
import com.agentswitch.android.demo.DemoFiles
import com.agentswitch.android.demo.LocalDemo
import com.agentswitch.android.demo.LocalDemoScreen
import com.agentswitch.android.design.BarWord
import com.agentswitch.android.design.HairRule
import com.agentswitch.android.design.LocalLook
import com.agentswitch.android.design.PixelBox
import com.agentswitch.android.design.PixelBoxEffect
import com.agentswitch.android.design.PixelSprite
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.android.terminals.TerminalStatusMark
import com.agentswitch.kit.api.MacPath
import com.agentswitch.kit.api.MacPick
import com.agentswitch.kit.api.SensitiveWarning
import com.agentswitch.kit.api.TerminalInfo
import com.agentswitch.kit.api.TerminalStatus
import com.agentswitch.kit.design.PixelArt
import kotlinx.coroutines.launch

/**
 * The `Files` tab (docs/files-v0.md §5; 2026-10-16, user: 开一个标签页吧): the Mac's files, opened where it was last on
 * this Mac (the first time, the Mac's home folder), or at a terminal's folder from its row (`Show in Files`,
 * `AppModel.openFilesRequest`: taken and cleared here). Nobody to give to here: `Add to Reply…` asks which terminal,
 * then opens that terminal's page with the files in its reply box.
 */
@Composable
fun FilesTab() {
    val model = LocalAppModel.current
    val settings = LocalSettings.current
    val scope = rememberCoroutineScope()
    val demoScreen = if (LocalDemo.current) LocalDemoScreen.current else null
    val session = remember { FilesSession(FilesSession.Mode.Tab, null) }
    var started by remember { mutableStateOf(false) }

    /** The demo screens' pages, as taps would open them (the Swift's `FilesTab.demo`). */
    fun demo() {
        val p = DemoFiles.project
        when (demoScreen) {
            "filespreview" -> { session.root = "$p/src"; session.stack = listOf(FilesRoute.File("$p/src/app.ts")) }
            "filespreviewlong" -> { session.root = "$p/dist"; session.stack = listOf(FilesRoute.File("$p/dist/app.min.js")) }
            "filesimage" -> { session.root = "$p/docs"; session.stack = listOf(FilesRoute.File("$p/docs/logo.png")) }
            "filesselect", "fileschoose" -> {
                session.root = "$p/src"
                session.selecting = true
                session.togglePick(MacPick("$p/src/app.ts", false))
                session.togglePick(MacPick("$p/src/store.ts", false))
                if (demoScreen == "fileschoose") session.choosing = session.picked
            }
            "filessensitive" -> {
                settings.putBool(FilesPrefs.hiddenKey, true)
                session.stack = listOf(FilesRoute.File("$p/.env"))
                session.choosing = listOf(MacPick("$p/.env", false, sensitive = true))
            }
            // Changing files (docs/files-v0.md §12), as ⋯, a long press and Select would open them.
            "filesnew" -> {
                session.root = p
                session.naming = FilesSession.Naming(FilesSession.Naming.Kind.Folder(p), setOf("docs", "src", "node_modules", "README.md", "package.json"), "fixtures")
            }
            "filesnameerror" -> {
                session.root = p
                session.naming = FilesSession.Naming(FilesSession.Naming.Kind.Folder(p), setOf("docs"), "docs", "此位置已有“docs”。请换一个名称。")
            }
            "filestrash" -> { session.root = "$p/src"; session.trashing = FilesSession.Trashing(listOf("$p/src/app.ts")) }
            "filestrashbusy" -> { session.root = p; session.trashing = FilesSession.Trashing(listOf("$p/src"), terminal = "iPhone 终端标签页") }
            "filesselectbar" -> {
                session.root = "$p/src"
                session.selecting = true
                session.togglePick(MacPick("$p/src/app.ts", false))
                session.togglePick(MacPick("$p/src/store.ts", false))
            }
            "filesshare" -> {
                session.root = "$p/docs"; session.stack = listOf(FilesRoute.File("$p/docs/logo.png"))
                session.share(listOf("$p/docs/logo.png"), model.fileSource, model.files, scope)
            }
            "filesupload", "filesclash" -> {
                session.root = "$p/docs"
                val made = listOf("IMG_0412.HEIC", "IMG_0413.HEIC") + (if (demoScreen == "filesclash") listOf("logo.png") else emptyList())
                val files = made.mapNotNull { name ->
                    try { java.io.File(model.files.holder(), name).also { it.writeBytes(ByteArray(2_400_000)) } } catch (_: Exception) { null }
                }
                val asking = model.files.send(files, "$p/docs", setOf("files-v0.md", "logo.png")) { model.fileSource }
                if (asking.isNotEmpty()) session.clashing = FilesSession.Clashing(asking, listOf("logo.png"))
            }
        }
    }

    fun start() {
        val asked = model.openFilesRequest
        if (asked != null) {
            model.openFilesRequest = null
            session.endSelecting()
            session.root = asked
            session.stack = emptyList()
            started = true
            if (demoScreen != null) demo()
            return
        }
        if (started) return
        session.root = model.files.lastPlace(model.profile?.fingerprint)
        started = true
    }

    LaunchedEffect(model.openFilesRequest) { start() }
    // Another Mac: where the tab was on that one.
    var seen by remember { mutableStateOf(model.profile?.fingerprint) }
    LaunchedEffect(model.profile?.fingerprint) {
        val now = model.profile?.fingerprint
        if (now == seen) return@LaunchedEffect
        seen = now
        session.endSelecting()
        session.root = model.files.lastPlace(now)
        session.stack = emptyList()
    }

    Box(Modifier.fillMaxSize().background(Theme.base)) {
        if (started) FilesBrowser(session, onPick = { })
    }
}

/**
 * `Add to Reply…`: which of this Mac's terminals the files go to, the one used last first (agent, name, folder). A file
 * that may hold a password is asked about once it is known where it goes. The iPhone's medium sheet is a panel from the
 * bottom of the browser, over a veil; `Cancel` or a tap on the veil closes it.
 */
@Composable
fun TerminalChooser(picks: List<MacPick>, session: FilesSession, onDelivered: () -> Unit = {}) {
    val model = LocalAppModel.current
    val classic = LocalLook.current.isClassic
    var asking by remember { mutableStateOf<TerminalInfo?>(null) }
    val terminals = model.terminals.terminals.filter { it.isRunning }.sortedByDescending { maxOf(it.lastOutputAt, it.createdAt) }
    val none = remember { MutableInteractionSource() }

    /** To the terminal's page: the tab switches to Terminals, opens it, and its page takes the files. */
    fun deliver(landed: List<MacPick>, t: TerminalInfo) {
        model.files.handoff = FilesStore.Handoff(t.id, landed)
        session.choosing = null
        session.endSelecting()
        onDelivered()
        model.openTerminal(t.id)
    }

    fun choose(t: TerminalInfo) { if (picks.any { it.sensitive }) asking = t else deliver(picks, t) }

    PixelBoxEffect(asking, { asking = null }) { t ->
        PixelBox(
            head = SensitiveWarning.title, tone = PixelBox.Tone.Amber, message = SensitiveWarning.message(picks.filter { it.sensitive }.map { it.name }),
            cancel = null,
            actions = listOf(
                PixelBox.Action("Cancel") { val rest = picks.filter { !it.sensitive }; if (rest.isNotEmpty()) deliver(rest, t) },
                PixelBox.Action("Add", PixelBox.Action.Role.Primary) { deliver(picks, t) },
            ),
        )
    }
    BackHandler { session.choosing = null }
    // `filessensitive`: the question, as choosing the first terminal would ask it.
    val demoScreen = if (LocalDemo.current) LocalDemoScreen.current else null
    LaunchedEffect(Unit) {
        if (demoScreen == "filessensitive") { kotlinx.coroutines.delay(1200); terminals.firstOrNull()?.let { asking = it } }
    }

    Box(Modifier.fillMaxSize()) {
        Box(Modifier.fillMaxSize().background(androidx.compose.ui.graphics.Color.Black.copy(alpha = 0.45f)).clickable(none, null) { session.choosing = null })
        val shape = if (classic) RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp) else androidx.compose.ui.graphics.RectangleShape
        Column(
            Modifier.align(Alignment.BottomCenter).fillMaxWidth().fillMaxHeight(0.62f).background(Theme.base, shape).clickable(none, null) { }
                .then(if (session.inTab) Modifier else Modifier.windowInsetsPadding(WindowInsets.navigationBars)),
        ) {
            Box(Modifier.fillMaxWidth().height(52.dp)) {
                Row(Modifier.align(Alignment.CenterStart).padding(start = 8.dp)) { BarWord("Cancel", { session.choosing = null }) }
                Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("Add to Reply", color = Theme.ink, style = plain(17, FontWeight.SemiBold))
                    Text(if (picks.size == 1) "1 File" else "${picks.size} Files", color = Theme.secondaryInk, style = mono(11))
                }
            }
            HairRule()
            LazyColumn(Modifier.weight(1f).fillMaxWidth()) {
                if (terminals.isEmpty()) item { Text("没有开着的终端。请先在 Terminals 页新建一个。", Modifier.padding(Theme.Space.l), color = Theme.secondaryInk, style = plain(15)) }
                items(terminals, key = { it.id }) { t -> ChooserRow(t, model.files.home) { choose(t) } }
            }
            HairRule()
            Text("选的文件会落进这个终端的回复框，最近用过的终端在前。", Modifier.fillMaxWidth().padding(Theme.Space.l), color = Theme.secondaryInk, style = plain(13))
        }
    }
}

@Composable
private fun ChooserRow(t: TerminalInfo, home: String?, onClick: () -> Unit) {
    val classic = LocalLook.current.isClassic
    Box(Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = onClick)) {
        Row(Modifier.padding(horizontal = Theme.Space.l, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.width(22.dp), contentAlignment = Alignment.Center) {
                PixelSprite(PixelArt.agents[t.harness] ?: PixelArt.square, pixel = 2.dp, color = Theme.secondaryInk, strength = 0.9f, shadow = false)
            }
            Column(Modifier.weight(1f).padding(start = 12.dp, end = 6.dp), verticalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(2.dp)) {
                Text(t.name, color = Theme.ink, style = plain(15, FontWeight.SemiBold), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    home?.let { MacPath.short(t.workdir, it) } ?: MacPath.tilde(t.workdir), color = Theme.secondaryInk,
                    style = com.agentswitch.android.design.code(11), maxLines = 1, overflow = TextOverflow.MiddleEllipsis,
                )
            }
            TerminalStatusMark(if (t.permissions.isEmpty()) t.status else TerminalStatus.Waiting)
        }
        HairRule(Modifier.align(Alignment.BottomStart).padding(start = if (classic) 50.dp else 0.dp))
    }
}

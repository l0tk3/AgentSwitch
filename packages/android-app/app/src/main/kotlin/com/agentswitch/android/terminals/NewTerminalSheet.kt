package com.agentswitch.android.terminals

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.LocalSettings
import com.agentswitch.android.demo.LocalDemoScreen
import com.agentswitch.android.design.BarWord
import com.agentswitch.android.design.BlockCaret
import com.agentswitch.android.design.BrailleSpinner
import com.agentswitch.android.design.LocalLook
import com.agentswitch.android.design.HairRule
import com.agentswitch.android.design.NavBar
import com.agentswitch.android.design.PixelBox
import com.agentswitch.android.design.PixelBoxEffect
import com.agentswitch.android.design.PixelSprite
import com.agentswitch.android.design.PlainField
import com.agentswitch.android.design.SectionLabel
import com.agentswitch.android.design.SquareButton
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.Wordmark
import com.agentswitch.android.design.code
import com.agentswitch.android.design.dithered
import com.agentswitch.android.design.glitch
import com.agentswitch.android.design.grounded
import com.agentswitch.android.design.framed
import com.agentswitch.android.design.lookWord
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.android.rememberBack
import com.agentswitch.kit.api.NewTerminalRequest
import com.agentswitch.kit.api.TerminalDaybreak
import com.agentswitch.kit.api.TerminalInfo
import com.agentswitch.kit.api.createTerminal
import com.agentswitch.kit.design.PixelArt
import com.agentswitch.kit.feed.EffortDisplay
import com.agentswitch.kit.support.PathDisplay
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** The agents a phone starts (no Shell here), in the order of the tiles: id and name. */
val newTerminalAgents: List<Pair<String, String>> = listOf(
    "claude-code" to "Claude Code", "codex" to "Codex", "opencode" to "OpenCode", "pi" to "pi", "grok" to "Grok",
)

/** `< >` is one of several (§7.2.6). */
val newTerminalModes: List<Pair<String, String>> = listOf("manual" to "Ask Each", "auto" to "Auto", "bypass" to "Bypass")

/** What bypass leaves in force, said before it is chosen (here and when a bypass session is continued). */
const val bypassNote = "agent 的任何操作都不再询问你，包括删除文件和执行命令。仍然生效的：凭据网关（密钥不可读）。"

/** A value kept on this phone across starts (the iPhone's `@AppStorage`): read once, written through at once. */
private class Kept(private val key: String, default: String, private val write: (String, String) -> Unit, read: (String) -> String?) {
    var value by mutableStateOf(read(key) ?: default)
        private set

    fun set(next: String) {
        value = next
        write(key, next)
    }
}

/**
 * `New` in the Terminals tab (docs/terminal-v0.md §1): the wordmark resolving out of glyph noise as it opens, then an
 * agent (its pixel mark and name; one not installed on the Mac is dithered and cannot be picked; the one picked
 * glitches once), its model (default = the agent's own), the folder (a prompt with a block caret: typed, or one used
 * before), and how it asks (`< > Ask Each` `<x> Auto` `< > Bypass`, bypass confirmed first in a pixel box). The page it
 * opens takes the size. A sheet: present it with `LocalNav`; `started` is given the new terminal once the sheet is gone.
 */
@Composable
fun NewTerminalSheet(started: (TerminalInfo) -> Unit) {
    val model = LocalAppModel.current
    val settings = LocalSettings.current
    val back = rememberBack()
    val scope = rememberCoroutineScope()
    val look = LocalLook.current
    val classic = look.isClassic
    val store = model.terminals
    val agentKept = remember { Kept("terminal.agent", "claude-code", settings::putString, settings::string) }
    val modeKept = remember { Kept("terminal.mode", "manual", settings::putString, settings::string) }
    val folderKept = remember { Kept("terminal.folder", "", settings::putString, settings::string) }
    val agent = agentKept.value
    val mode = modeKept.value
    val folder = folderKept.value
    // The profile chosen this time, by its id; "": the one the Mac offers (the one last chosen).
    var profileId by remember { mutableStateOf("") }
    var modelId by remember { mutableStateOf("") }
    // How hard it thinks: one of the levels the chosen model takes, or "" for the agent's own default.
    var effortId by remember { mutableStateOf("") }
    var starting by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var confirmBypass by remember { mutableStateOf(false) }
    var modelMenu by remember { mutableStateOf<Rect?>(null) }
    var olderMenu by remember { mutableStateOf<Rect?>(null) }
    var profileMenu by remember { mutableStateOf<Rect?>(null) }

    val list = store.list
    val installed = list?.agents?.toSet() ?: emptySet()
    // Codex: the models that run as its new sessions start (its Daybreak switch, docs/simple-view-v0.md §5.8).
    val models = TerminalDaybreak.offered(list?.models?.get(agent) ?: emptyList(), list?.daybreak?.get(agent))
    // The levels the chosen model takes (none chosen: the agent's default model's).
    val levels = EffortDisplay.levels(list, agent, modelId)
    val defaultLabel = list?.defaults?.get(agent)?.let { "Default · $it" } ?: "Default"
    val choices = store.profiles[agent]?.takeIf { it.several }
    val chosenProfile = choices?.let { c -> (c.profiles.firstOrNull { it.id == profileId } ?: c.offered)?.id }

    LaunchedEffect(Unit) {
        if (folder.isEmpty()) store.recentFolders.firstOrNull()?.let { folderKept.set(PathDisplay.short(it)) }
        if (agent !in installed) newTerminalAgents.firstOrNull { it.first in installed }?.let { agentKept.set(it.first) }
        if (newTerminalModes.none { it.first == mode }) modeKept.set("manual")
    }
    // The bypass question, as the sample screen shows it (two seconds after the sheet is up).
    val demoScreen = LocalDemoScreen.current
    LaunchedEffect(demoScreen) {
        if (demoScreen == "newterminalbypass") {
            delay(2000)
            confirmBypass = true
        }
    }

    fun pickAgent(id: String) {
        if (agentKept.value == id) return
        agentKept.set(id)
        modelId = ""
        effortId = ""
    }

    fun pickModel(id: String) {
        modelId = id
        // Another model may not take the level chosen: then its own default.
        effortId = EffortDisplay.kept(effortId, EffortDisplay.levels(store.list, agent, id))
    }

    fun start() {
        val api = model.api ?: return
        scope.launch {
            starting = true
            try {
                val terminal = api.createTerminal(
                    NewTerminalRequest(
                        harness = agent, cwd = folder.trim(), model = modelId.ifEmpty { null },
                        effort = effortId.ifEmpty { null }, mode = mode, profile = chosenProfile,
                    ),
                )
                back()
                started(terminal)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = e.message ?: e.javaClass.simpleName
            } finally {
                starting = false
            }
        }
    }

    PixelBoxEffect(confirmBypass, onDismiss = { confirmBypass = false }) {
        PixelBox(
            head = "Bypass", tone = PixelBox.Tone.Amber, message = "跳过全部权限确认？$bypassNote",
            actions = listOf(PixelBox.Action("Use Bypass", PixelBox.Action.Role.Primary) { modeKept.set("bypass") }),
        )
    }
    PixelBoxEffect(modelMenu, onDismiss = { modelMenu = null }) { at ->
        val actions = mutableListOf(PixelBox.Action(defaultLabel) { pickModel("") })
        for (m in models.filter { !it.older }) actions.add(PixelBox.Action(m.name) { pickModel(m.id) })
        if (models.any { it.older }) actions.add(PixelBox.Action("Older ›") { olderMenu = at })
        PixelBox(cancel = null, actions = actions, anchor = at, width = 260.dp)
    }
    PixelBoxEffect(olderMenu, onDismiss = { olderMenu = null }) { at ->
        PixelBox(cancel = null, actions = models.filter { it.older }.map { m -> PixelBox.Action(m.name) { pickModel(m.id) } }, anchor = at, width = 260.dp)
    }
    PixelBoxEffect(profileMenu, onDismiss = { profileMenu = null }) { at ->
        PixelBox(
            cancel = null, anchor = at, width = 300.dp,
            actions = choices?.profiles?.map { p -> PixelBox.Action("${p.name} — ${p.who}") { profileId = p.id } } ?: emptyList(),
        )
    }

    Column(
        Modifier.fillMaxSize().background(Theme.base).windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars)),
    ) {
        NavBar("New Terminal", leading = { BarWord("Cancel", back) })
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(Theme.Space.l),
            verticalArrangement = Arrangement.spacedBy(Theme.Space.xl),
        ) {
            Wordmark(reveal = true)
            Column(verticalArrangement = Arrangement.spacedBy(Theme.Space.s)) {
                SectionLabel("Agent")
                // Two to a row, each tile as tall as its own words (a grid's rows centre what is in them).
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    for (pair in newTerminalAgents.chunked(2)) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                            for ((id, name) in pair) {
                                AgentTile(id, name, on = agent == id, installed = id in installed, Modifier.weight(1f)) { pickAgent(id) }
                            }
                            if (pair.size == 1) Box(Modifier.weight(1f))
                        }
                    }
                }
            }
            // Whose sign-in it runs under, where the agent has more than the Mac's own (docs/profiles-v0.md §3.3).
            if (choices != null) {
                val picked = choices.profiles.firstOrNull { it.id == profileId } ?: choices.offered
                Column(verticalArrangement = Arrangement.spacedBy(Theme.Space.s)) {
                    SectionLabel("Profile")
                    Dropdown(onOpen = { profileMenu = it }) {
                        picked?.color?.let { ProfileDot(it) }
                        Text(picked?.name ?: "Default", color = Theme.ink, style = mono(14), maxLines = 1)
                        Text(picked?.who ?: "", Modifier.weight(1f), color = Theme.secondaryInk, style = mono(12), maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
                    }
                }
            }
            Column(verticalArrangement = Arrangement.spacedBy(Theme.Space.s)) {
                SectionLabel("Model")
                // The agent's own list: its current models, then those a newer one superseded under `Older`.
                Dropdown(enabled = models.isNotEmpty(), onOpen = { modelMenu = it }) {
                    Text(models.firstOrNull { it.id == modelId }?.name ?: defaultLabel, Modifier.weight(1f), color = Theme.ink, style = mono(14), maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            // How hard it thinks, under the agent's own word for it and with the levels the chosen model takes
            // (terminal-v0 §1 思考强度). Not shown where there is nothing to choose: a model with no levels, or
            // OpenCode before a model is chosen (a variant is a model's).
            if (levels.isNotEmpty()) {
                // On a line, the model's stops lowest first; none chosen is the model's own default (the knob resting
                // there hollow), and `Default` puts a choice back.
                EffortPicker(
                    levels = levels, level = effortId.ifEmpty { null }, fallback = EffortDisplay.defaultLevel(list, agent, modelId),
                    choose = { effortId = it }, reset = { effortId = "" },
                ) { SectionLabel(EffortDisplay.word(agent)) }
            }
            Column(verticalArrangement = Arrangement.spacedBy(Theme.Space.s)) {
                SectionLabel("Folder")
                FolderPrompt(folder, { folderKept.set(it) }, code(14), classic)
                for (f in store.recentFolders.map { PathDisplay.short(it) }) {
                    Text(
                        f, Modifier.fillMaxWidth().clickable { folderKept.set(f) },
                        color = if (folder == f) Theme.ink else Theme.secondaryInk, style = code(12), maxLines = 1, overflow = TextOverflow.MiddleEllipsis,
                    )
                }
            }
            Column(verticalArrangement = Arrangement.spacedBy(Theme.Space.s)) {
                SectionLabel("Permissions")
                // One of three: `< >` / `<x>`; a segmented control's look in the classic one.
                Row(
                    Modifier.fillMaxWidth().then(if (classic) Modifier.grounded(Theme.raised, 10.dp).padding(2.dp) else Modifier),
                    horizontalArrangement = if (classic) Arrangement.Start else Arrangement.spacedBy(Theme.Space.l),
                ) {
                    for ((id, name) in newTerminalModes) {
                        val on = mode == id
                        val pick = { if (id == "bypass" && mode != "bypass") confirmBypass = true else modeKept.set(id) }
                        if (classic) {
                            Text(
                                name, Modifier.weight(1f).clickable(role = Role.RadioButton, onClick = pick)
                                    .background(if (on) Theme.panel else Color.Transparent, RoundedCornerShape(8.dp)).padding(vertical = 7.dp),
                                color = if (on) Theme.ink else Theme.secondaryInk, style = plain(14, if (on) FontWeight.SemiBold else FontWeight.Normal),
                                textAlign = TextAlign.Center, maxLines = 1,
                            )
                        } else {
                            Text(
                                "${if (on) "<x>" else "< >"} $name", Modifier.clickable(role = Role.RadioButton, onClick = pick).padding(vertical = 4.dp),
                                color = if (on) Theme.ink else Theme.secondaryInk, style = mono(14), maxLines = 1,
                            )
                        }
                    }
                }
                if (mode == "bypass") {
                    Text("agent 的任何操作都不再询问你；禁区和凭据网关仍然生效。", color = Theme.waiting, style = plain(13))
                }
            }
            error?.let { Text(it, color = Theme.failed, style = plain(13)) }
            val canStart = !starting && agent in installed && folder.trim().isNotEmpty() && model.api != null
            if (starting) StartingButton() else SquareButton("Start", onClick = ::start, prominent = true, enabled = canStart)
        }
    }
}

/** `[ Starting ⠋ ]`: the start button while the Mac makes the terminal (the button's own word cannot hold a spinner). */
@Composable
private fun StartingButton() {
    val classic = LocalLook.current.isClassic
    if (classic) {
        Row(
            Modifier.fillMaxWidth().background(Theme.fill, RoundedCornerShape(10.dp)).padding(vertical = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Starting", color = Theme.onFill, style = plain(15, FontWeight.SemiBold))
            BrailleSpinner(color = Theme.onFill)
        }
    } else {
        Row(
            Modifier.fillMaxWidth().background(Theme.fill).border(1.dp, Theme.fill).padding(vertical = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("[ Starting", color = Theme.base, style = mono(14, FontWeight.Medium))
            BrailleSpinner(color = Theme.base)
            Text("]", color = Theme.base, style = mono(14, FontWeight.Medium))
        }
    }
}

/** A field that opens a menu: framed (a round field on its own ground in the classic look), its glyph at the right. */
@Composable
private fun Dropdown(enabled: Boolean = true, onOpen: (Rect) -> Unit, content: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit) {
    val classic = LocalLook.current.isClassic
    var bounds by remember { mutableStateOf(Rect.Zero) }
    Row(
        Modifier.fillMaxWidth().onGloballyPositioned { bounds = it.boundsInRoot() }
            .then(if (enabled) Modifier else Modifier.alpha(0.45f))
            .grounded(if (classic) Theme.panel else Color.Transparent, 10.dp)
            .framed(if (classic) Color.Transparent else Theme.line, 10.dp)
            .clickable(enabled, role = Role.DropdownList) { onOpen(bounds) }
            .padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        content()
        LookGlyph("▾", LookSymbol.ChevronDown, color = Theme.secondaryInk)
    }
}

/**
 * An agent's tile: a 2 dp ink frame once picked; while a finger is on it, raised at once. Not on this Mac: half of it
 * dithered away (the desktop's), not faded.
 */
@Composable
private fun AgentTile(id: String, name: String, on: Boolean, installed: Boolean, modifier: Modifier, onPick: () -> Unit) {
    val classic = LocalLook.current.isClassic
    val source = remember { MutableInteractionSource() }
    val pressed = source.collectIsPressedAsState().value
    val shape = if (classic) RoundedCornerShape(12.dp) else androidx.compose.ui.graphics.RectangleShape
    val frame = if (classic) Modifier.background(if (pressed) Theme.raised else Theme.panel, shape).then(if (on) Modifier.border(2.dp, Theme.signal, shape) else Modifier)
    else Modifier.background(if (pressed) Theme.raised else Color.Transparent).border(if (on) 2.dp else 1.dp, if (on || pressed) Theme.ink else Theme.line)
    Box(
        modifier.dithered(!installed).then(frame)
            .clickable(source, null, enabled = installed, role = Role.RadioButton, onClick = onPick)
            .semantics { contentDescription = name; selected = on },
    ) {
        Column(Modifier.fillMaxWidth().padding(12.dp).glitch(on), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            // The agent's shaded mark (§9): whole for the one chosen, fainter for the others; the tile's frame says which.
            PixelSprite(
                PixelArt.agents[id] ?: PixelArt.square, pixel = 4.dp,
                color = if (on) Theme.signal else if (installed) Theme.ink else Theme.inkDim,
                strength = if (on) 1f else if (installed) 0.75f else 0.4f, cell = 7.0 / 3,
            )
            Text(name, color = if (installed) Theme.ink else Theme.inkDim, style = mono(13), maxLines = 1)
            if (!installed) Text("Not Installed", color = Theme.inkDim, style = mono(10))
        }
    }
}

/**
 * The folder line: a prompt (`❯`, a folder in the classic look) with a block caret after the text while it is not being
 * typed in (the system's caret then takes over), a rule under it; a round field in the classic look. A folder is a
 * path: `style` is code in New, mono where the Swift says so.
 */
@Composable
fun FolderPrompt(value: String, onChange: (String) -> Unit, style: TextStyle, classic: Boolean = LocalLook.current.isClassic) {
    var focused by remember { mutableStateOf(false) }
    Column {
        Row(
            Modifier.fillMaxWidth().then(if (classic) Modifier.grounded(Theme.panel, 10.dp).padding(horizontal = 12.dp, vertical = 10.dp) else Modifier.padding(vertical = 8.dp)),
            horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically,
        ) {
            if (classic) LookSymbolIcon(LookSymbol.Folder, side = 14.dp, color = Theme.inkDim)
            else Text("❯", color = Theme.signal, style = mono(14))
            Box(Modifier.weight(1f).clipToBounds()) {
                PlainField(
                    value, onChange, Modifier.fillMaxWidth().onFocusChanged { focused = it.isFocused }, placeholder = "~/project", style = style,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
                )
                // The prompt's block caret after the text while it is not being typed in.
                if (!focused && !classic) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(value, color = Color.Transparent, style = style, maxLines = 1, softWrap = false, overflow = TextOverflow.Clip)
                        Box(Modifier.padding(start = 1.dp)) { BlockCaret(width = 8.dp, height = 17.dp) }
                    }
                }
            }
        }
        if (!classic) HairRule()
    }
}

package com.agentswitch.android.settings

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.demo.DemoData
import com.agentswitch.android.demo.LocalDemo
import com.agentswitch.android.design.BarWord
import com.agentswitch.android.design.BrailleSpinner
import com.agentswitch.android.design.FormRow
import com.agentswitch.android.design.FormSection
import com.agentswitch.android.design.LocalLook
import com.agentswitch.android.design.PlainField
import com.agentswitch.android.design.SectionLabel
import androidx.compose.ui.draw.clip
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.code
import com.agentswitch.android.design.lookShape
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.android.rememberBack
import com.agentswitch.android.terminals.LookSymbol
import com.agentswitch.android.terminals.LookSymbolIcon
import com.agentswitch.kit.api.ClashService
import com.agentswitch.kit.api.ClashTemplate
import com.agentswitch.kit.api.ClashText
import com.agentswitch.kit.api.ClashView
import com.agentswitch.kit.api.clashDNS
import com.agentswitch.kit.api.clashTemplate
import com.agentswitch.kit.api.setClashSource
import com.agentswitch.kit.api.setClashSourceVerge
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction

/**
 * A service's own way out: what its group uses now — the automatic group or one node, picked by a tap — over the
 * nodes chosen for it in their order. A node is taken away by swiping its row to the left.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun ClashServiceSection(clash: ClashModel, view: ClashView, service: ClashService, anchor: BringIntoViewRequester? = null) {
    val nav = com.agentswitch.android.LocalNav.current
    val state = view.state(service)
    val nodes = view.settings[service].nodes
    val live = state?.live ?: false
    val delays = clash.delays[service] ?: emptyMap()
    val testing = service in clash.testing

    FormSection("Separate Proxy for ${service.title}", footer = serviceFooter(view, service)) {
        var first = true
        if (state != null && state.live) {
            ServiceRow("Automatic", state.autoNow?.let { "→ $it" } ?: "", chosen = state.automatic, gone = false, first = true) { clash.select(service, null) }
            first = false
        }
        nodes.forEachIndexed { i, node ->
            val isFirst = first && i == 0
            SwipeRow({ clash.setNodes(service, nodes.filterIndexed { j, _ -> j != i }) }) {
                ServiceRow(
                    node, ClashText.delay(delays, node), chosen = if (live) state?.now == node else null,
                    gone = state?.missing?.contains(node) ?: false, first = isFirst,
                ) { clash.select(service, node) }
            }
        }
        NavRow({ nav.push("clash:nodes:${service.rawValue}") { ClashNodesScreen(clash, service) } }, first = first && nodes.isEmpty()) {
            Text("Nodes", color = Theme.ink, style = plain(16), maxLines = 1)
            Text(if (nodes.isEmpty()) "None" else "${nodes.size}", Modifier.weight(1f), color = Theme.secondaryInk, style = mono(13), textAlign = TextAlign.End, maxLines = 1)
        }
        val canTest = !testing && nodes.isNotEmpty() && view.running
        FormRow(if (anchor != null) Modifier.bringIntoViewRequester(anchor) else Modifier, onClick = if (canTest) ({ clash.test(service, all = false) }) else null) {
            Text("Test", color = if (canTest) Theme.ink else Theme.inkDim, style = plain(16), maxLines = 1)
            Spacer(Modifier.weight(1f))
            if (testing) BrailleSpinner()
        }
    }
}

/**
 * One way out: its mark (a ring, or `< >` / `<x>`; none while the core has no such group yet), its name, and what
 * there is to say of it on the right.
 */
@Composable
private fun ServiceRow(title: String, detail: String, chosen: Boolean?, gone: Boolean, first: Boolean, pick: () -> Unit) {
    FormRow(first = first, onClick = if (chosen == null || gone) null else pick) {
        if (chosen != null) ChoiceMark(chosen, box = false)
        Text(title, Modifier.weight(1f), color = Theme.ink, style = plain(16), maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (gone) Text("Gone", color = Theme.waiting, style = mono(12))
        Text(detail, color = if (detail == "Timeout") Theme.waiting else Theme.secondaryInk, style = mono(12), maxLines = 1)
    }
}

private fun serviceFooter(view: ClashView, service: ClashService): String {
    val state = view.state(service) ?: return ""
    val nodes = view.settings[service].nodes
    if (nodes.isEmpty()) return "没有选节点：${service.title} 的流量照订阅里原有的规则走。在 Nodes 里选几个。"
    if (nodes.all { it in state.missing }) {
        return "选的节点在现在这个订阅里一个都没有（标着 Gone）：${service.title} 的流量照订阅里原有的规则走。在 Nodes 里重新选几个；用不着的向左滑拿掉。"
    }
    val groups = "Clash 里是两组：${state.auto} 按从上到下的顺序用第一个连得上的节点；${state.group} 决定 ${service.title} 的流量走哪里。"
    return if (state.live) groups + "点一行就改用那一个。" else groups + "Clash Verge 用上 AgentSwitch 订阅之后，可以在这里点选用哪一个。"
}

/**
 * A service's nodes: the ones chosen, in their order (moved with the arrows in `Edit`), and every node of the
 * subscription to take in or leave out with a tap. `Test All` says how long each takes.
 */
@Composable
internal fun ClashNodesScreen(clash: ClashModel, service: ClashService) {
    var query by remember { mutableStateOf("") }
    var editing by remember { mutableStateOf(false) }
    val view = clash.view
    val chosen = view?.settings?.get(service)?.nodes ?: emptyList()
    val delays = clash.delays[service] ?: emptyMap()
    val asked = query.trim()
    val all = (view?.nodes ?: emptyList()).let { nodes -> if (asked.isEmpty()) nodes else nodes.filter { it.contains(asked, ignoreCase = true) } }
    val testing = service in clash.testing
    val showEdit = chosen.size > 1 || editing

    ProxyPage(
        "${service.title} Nodes", "Clash",
        trailing = {
            if (testing) BrailleSpinner(Modifier.padding(horizontal = 12.dp)) else BarWord("Test All", { clash.test(service, all = true) }, enabled = view?.running == true)
        },
    ) {
        SearchField(query, { query = it })
        if (chosen.isNotEmpty()) {
            // The iPhone's bar holds `Edit` beside `Test All`; here the two would crowd the title, so it sits by the group's label.
            ChosenGroup(showEdit, editing, { editing = !editing }) {
                chosen.forEachIndexed { i, node ->
                    val row: @Composable () -> Unit = {
                        FormRow(first = i == 0) {
                            Text(node, Modifier.weight(1f), color = Theme.ink, style = plain(16), maxLines = 1, overflow = TextOverflow.Ellipsis)
                            if (view?.state(service)?.missing?.contains(node) == true) Text("Gone", color = Theme.waiting, style = mono(12))
                            Text(ClashText.delay(delays, node), color = Theme.secondaryInk, style = mono(12), maxLines = 1)
                            if (editing) {
                                EditGlyph("↑", "上移", enabled = i > 0) { clash.setNodes(service, chosen.toMutableList().apply { add(i - 1, removeAt(i)) }) }
                                EditGlyph("↓", "下移", enabled = i < chosen.size - 1) { clash.setNodes(service, chosen.toMutableList().apply { add(i + 1, removeAt(i)) }) }
                                EditGlyph("×", "移除", enabled = true) { clash.setNodes(service, chosen.filterIndexed { j, _ -> j != i }) }
                            }
                        }
                    }
                    if (editing) row() else SwipeRow({ clash.setNodes(service, chosen.filterIndexed { j, _ -> j != i }) }) { row() }
                }
            }
        }
        FormSection("All Nodes") {
            all.forEachIndexed { i, node ->
                val on = node in chosen
                val delay = ClashText.delay(delays, node)
                FormRow(first = i == 0, onClick = { clash.setNodes(service, if (on) chosen.filter { it != node } else chosen + node) }) {
                    ChoiceMark(on, box = true)
                    Text(node, Modifier.weight(1f), color = Theme.ink, style = plain(16), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(delay, color = if (delay == "Timeout") Theme.waiting else Theme.secondaryInk, style = mono(12), maxLines = 1)
                }
            }
        }
    }
}

/** A `FormSection` labelled `Chosen`, with `Edit` / `Done` at the right of its label. */
@Composable
private fun ChosenGroup(showEdit: Boolean, editing: Boolean, toggle: () -> Unit, content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit) {
    androidx.compose.foundation.layout.Column(Modifier.fillMaxWidth().padding(top = 8.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            SectionLabel("Chosen", Modifier.padding(start = 16.dp))
            Spacer(Modifier.weight(1f))
            if (showEdit) BarWord(if (editing) "Done" else "Edit", toggle)
        }
        androidx.compose.foundation.layout.Column(
            Modifier.fillMaxWidth().clip(androidx.compose.foundation.shape.RoundedCornerShape(12.dp)).background(Theme.raised), content = content,
        )
        Text("从上到下，用第一个连得上的。", Modifier.padding(start = 16.dp, end = 16.dp, top = 7.dp), color = Theme.secondaryInk, style = plain(13))
    }
}

@Composable
private fun EditGlyph(glyph: String, label: String, enabled: Boolean, onClick: () -> Unit) {
    Text(
        glyph,
        Modifier.clickable(enabled, onClickLabel = label, role = Role.Button, onClick = onClick).padding(horizontal = 8.dp, vertical = 4.dp),
        color = if (enabled) Theme.ink else Theme.inkDim, style = mono(15),
    )
}

/** The search field under the bar (the iPhone's `searchable`): a magnifier, the words, a clear mark. */
@Composable
private fun SearchField(query: String, onChange: (String) -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(top = 6.dp).background(Theme.raised, lookShape(10.dp)).padding(horizontal = 10.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        LookSymbolIcon(LookSymbol.Magnifier, side = 16.dp, color = Theme.secondaryInk)
        PlainField(query, onChange, Modifier.weight(1f), placeholder = "Search", style = plain(16))
        if (query.isNotEmpty()) Text("×", Modifier.clickable(role = Role.Button, onClickLabel = "clear") { onChange("") }.padding(horizontal = 6.dp), color = Theme.secondaryInk, style = mono(15))
    }
}

/**
 * A template's text, edited: a rule template's rules, a line each (docs/clash-v0.md §7.7), or the DNS template's text
 * (§7.8, `template` null). What the Mac says is wrong with it is shown; the page stays open on it.
 */
@Composable
internal fun ClashTextScreen(clash: ClashModel, template: ClashTemplate?) {
    val model = LocalAppModel.current
    val demo = LocalDemo.current
    val back = rememberBack()
    var text by remember { mutableStateOf("") }
    var initial by remember { mutableStateOf("") }
    var custom by remember { mutableStateOf(false) }
    var loaded by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }

    val help = when (template) {
        ClashTemplate.Domestic -> "一行一条规则，写成“类型,内容”，例如 DOMAIN-SUFFIX,cn 或 PROCESS-NAME,WeChat；不写去向（这里的都直连）。空行和 # 开头的行不算。"
        ClashTemplate.Block -> "一行一条规则，写成“类型,内容”，例如 DOMAIN-SUFFIX,doubleclick.net；不写去向（这里的都拦截）。空行和 # 开头的行不算。"
        null -> "这是订阅里 dns: 下面的整段内容（YAML，不含 dns: 这一行），打开开关后它会替换掉订阅自带的那一段。改完要等 Clash Verge 重新取一次订阅才生效。"
    }

    LaunchedEffect(Unit) {
        if (loaded) return@LaunchedEffect
        val api = clash.api
        if (api == null) {
            if (demo) {
                text = DemoData.clashRules
                initial = text
                loaded = true
            }
            return@LaunchedEffect
        }
        try {
            if (template != null) {
                val rules = api.clashTemplate(template)
                text = rules.rules.joinToString("\n")
                custom = rules.custom
            } else {
                val dns = api.clashDNS()
                text = dns.text
                custom = dns.custom
            }
            initial = text
            loaded = true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            problem = e.message ?: e.javaClass.simpleName
        }
    }

    fun keep(edited: String?) {
        saving = true
        model.scope.launch {
            problem = clash.keep(template, edited)
            saving = false
            if (problem == null) back()
        }
    }

    ProxyPage(
        template?.title ?: "DNS", "Clash",
        trailing = { if (saving) BrailleSpinner(Modifier.padding(end = 12.dp)) else BarWord("Save", { keep(text) }, enabled = loaded && text != initial) },
    ) {
        problem?.let { FormSection { FormNote(it, Theme.failed, first = true) } }
        FormSection(footer = help) {
            BasicTextField(
                text, { text = it }, Modifier.fillMaxWidth().heightIn(min = 320.dp),
                textStyle = code(13).copy(color = Theme.ink), cursorBrush = SolidColor(Theme.signal),
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
                decorationBox = { inner -> androidx.compose.foundation.layout.Box(Modifier.padding(16.dp)) { inner() } },
            )
        }
        if (custom) {
            FormSection(footer = "丢掉你自己改的这一份，用回内置的模版。") {
                FormButton("Use Built-In", { keep(null) }, first = true, enabled = !saving, destructive = true)
            }
        }
    }
}

/** Where the subscription comes from: a link pasted in, one of Clash Verge's own subscriptions, or a file. */
@Composable
internal fun ClashSourceSheet(clash: ClashModel) {
    val model = LocalAppModel.current
    val context = LocalContext.current
    val back = rememberBack()
    var link by remember { mutableStateOf("") }
    var problem by remember { mutableStateOf<String?>(null) }
    val typed = link.trim()

    fun use(work: suspend (com.agentswitch.kit.api.AgentSwitchAPI) -> ClashView) {
        clash.fetch(work)
        back()
    }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) {
            model.scope.launch {
                val read = withContext(Dispatchers.IO) { readYaml(context, uri) }
                if (read == null) problem = "读不了这个文件，或者它超过 8 MB、不是文本。" else use { it.setClashSource(yaml = read.first, name = read.second) }
            }
        }
    }

    ProxyPage("Subscription", "", leading = { BarWord("Cancel", back) }) {
        problem?.let { FormSection { FormNote(it, Theme.failed, first = true) } }
        FormSection(
            "Link",
            footer = "Mac 现在就去取一次，之后按 Auto Update 的间隔再取。链接经这条加密的连接发给 Mac，由它保管，不留在这台手机上。",
        ) {
            FormRow(first = true) {
                PlainField(
                    link, { link = it }, Modifier.weight(1f), placeholder = "https://…", style = code(13), singleLine = false,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = KeyboardType.Uri),
                )
            }
            FormButton("Use Link", { use { it.setClashSource(link = typed) } }, enabled = typed.length >= 8)
        }
        val profiles = clash.view?.profiles ?: emptyList()
        if (profiles.isNotEmpty()) {
            FormSection("From Clash Verge", footer = "Mac 的 Clash Verge 里已有的订阅：点一个拿过来用。") {
                profiles.forEachIndexed { i, profile ->
                    FormRow(first = i == 0, onClick = { use { it.setClashSourceVerge(profile.uid) } }) {
                        Text(profile.name, Modifier.weight(1f), color = Theme.ink, style = plain(16), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(profile.type, color = Theme.secondaryInk, style = mono(12), maxLines = 1)
                    }
                }
            }
        }
        FormSection(footer = "一份 Clash 的 yaml 配置。文件不会自己更新。") {
            FormButton("Choose File…", { picker.launch(arrayOf("*/*")) }, first = true)
        }
    }
}

/** A picked file's text and name; null when it cannot be read, is over 8 MB, is not UTF-8 text, or is empty. */
private fun readYaml(context: Context, uri: Uri): Pair<String, String>? {
    val limit = 8_000_000
    val bytes = try {
        context.contentResolver.openInputStream(uri)?.use { input ->
            val out = ByteArrayOutputStream()
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buffer)
                if (n < 0) break
                out.write(buffer, 0, n)
                if (out.size() > limit) return null
            }
            out.toByteArray()
        }
    } catch (e: Exception) {
        null
    } ?: return null
    val yaml = try {
        Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()
    } catch (e: Exception) {
        return null
    }
    if (yaml.isEmpty()) return null
    val name = try {
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { if (it.moveToFirst()) it.getString(0) else null }
    } catch (e: Exception) {
        null
    } ?: uri.lastPathSegment ?: "clash.yaml"
    return yaml to name
}

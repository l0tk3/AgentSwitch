package com.agentswitch.android.settings

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.ui.semantics.Role
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.LocalNav
import com.agentswitch.android.components.ErrorText
import com.agentswitch.android.demo.LocalDemo
import com.agentswitch.android.demo.LocalDemoScreen
import com.agentswitch.android.design.BrailleSpinner
import com.agentswitch.android.design.FormRow
import com.agentswitch.android.design.FormSection
import com.agentswitch.android.design.PixelBox
import com.agentswitch.android.design.PixelBoxEffect
import com.agentswitch.android.design.PlainField
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.code
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.android.terminals.LookGlyph
import com.agentswitch.android.terminals.LookSymbol
import com.agentswitch.android.terminals.relativeTime
import com.agentswitch.kit.api.ClashService
import com.agentswitch.kit.api.ClashSettings
import com.agentswitch.kit.api.ClashTemplate
import com.agentswitch.kit.api.ClashText
import com.agentswitch.kit.api.ClashView
import com.agentswitch.kit.api.removeClashSource
import com.agentswitch.kit.api.updateClash
import kotlinx.coroutines.delay

/**
 * Settings › Proxies › Clash (docs/clash-v0.md §9): the Mac's Clash page on the phone — what was found of Clash Verge,
 * the subscription worked from, the nodes for Claude and for OpenAI with what each group uses now, the rule templates
 * and DNS, the addresses that go direct, and the routing check. The one thing that stays on the Mac is adding
 * AgentSwitch's subscription to Clash Verge. A page: push it with [openClash].
 *
 * The iPhone pulls the page down to read it again; here it reads again by itself every 15 s while it is in front
 * and nothing of its own is under way.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun ClashScreen() {
    val model = LocalAppModel.current
    val nav = LocalNav.current
    val demo = LocalDemo.current
    val screen = LocalDemoScreen.current
    val api = model.api
    val clash = remember(api) { ClashModel(model.scope, api, { model.handle(it) }, demo) }
    var confirmRemove by remember { mutableStateOf(false) }
    val scroll = rememberScrollState()
    val openaiAnchor = remember { BringIntoViewRequester() }
    val directAnchor = remember { BringIntoViewRequester() }
    val checkAnchor = remember { BringIntoViewRequester() }
    val adding = { nav.present("clash:source") { ClashSourceSheet(clash) } }

    LaunchedEffect(clash) {
        clash.load()
        // The demo screens of this page: a part of it in view, or one of the pages behind it open.
        if (demo) {
            delay(300)
            when (screen) {
                "clashservice" -> openaiAnchor.bringIntoView()
                "clashrules" -> directAnchor.bringIntoView()
                "clashcheck" -> checkAnchor.bringIntoView()
                "clashnodes" -> nav.push("clash:nodes:claude") { ClashNodesScreen(clash, ClashService.Claude) }
                "clashtext" -> nav.push("clash:text:domestic") { ClashTextScreen(clash, ClashTemplate.Domestic) }
                "clashsource" -> adding()
            }
        }
    }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(clash, lifecycle) {
        if (api == null) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            while (true) {
                delay(15_000)
                if (!clash.busy) clash.load()
            }
        }
    }
    PixelBoxEffect(confirmRemove, { confirmRemove = false }) {
        PixelBox(
            head = "移除这个订阅？", tone = PixelBox.Tone.Red,
            message = "Clash Verge 会继续用它上次取到的那一份，直到你在那里切走或删掉 AgentSwitch 订阅。",
            actions = listOf(PixelBox.Action("Remove", PixelBox.Action.Role.Destructive) { clash.run { it.removeClashSource() } }),
        )
    }

    ProxyPage("Clash", "Settings", scroll = scroll, trailing = { if (clash.fetching) BrailleSpinner(Modifier.padding(end = 12.dp)) }) {
        clash.error?.let { message ->
            FormSection { FormRow(first = true) { ErrorText(message, { clash.error = null }, Modifier.weight(1f)) } }
        }
        val view = clash.view
        if (view != null) {
            StatusSection(view)
            SubscriptionSection(clash, view, adding = adding, remove = { confirmRemove = true })
            if (view.source != null) {
                for (service in ClashService.entries) {
                    ClashServiceSection(clash, view, service, anchor = if (service == ClashService.Openai) openaiAnchor else null)
                }
                RulesSection(clash, view)
                DirectSection(clash, view, directAnchor)
                RoutingSection(clash, view, checkAnchor)
            }
        } else if (clash.loaded) {
            FormSection { FormNote("这台 Mac 上的 AgentSwitch 还不能从手机管理 Clash：在 Mac 上更新 AgentSwitch。", first = true) }
        }
    }
}

// MARK: Clash Verge

@Composable
private fun StatusSection(view: ClashView) {
    FormSection("Status") {
        ValueRow(
            "Clash Verge", view.word, first = true,
            color = if (!view.found || !view.running) Theme.failed else if (view.todo.isEmpty()) Theme.done else Theme.waiting,
        )
        view.version?.let { ValueRow("Core", it) }
        view.tun?.let { ValueRow("TUN", if (it) "On" else "Off", color = if (it) Theme.secondaryInk else Theme.waiting) }
        for (todo in view.todo) FormNote(todo, Theme.waiting)
    }
}

// MARK: the subscription

@Composable
private fun SubscriptionSection(clash: ClashModel, view: ClashView, adding: () -> Unit, remove: () -> Unit) {
    val source = view.source
    FormSection(
        "Subscription",
        footer = if (source == null) "AgentSwitch 从这个订阅出发，加上给 Claude 和 OpenAI 单独的分组，再交给 Clash Verge。链接由 Mac 保管，这里只显示它的主机名。"
        else "换一个订阅会忘掉为 Claude 和 OpenAI 选过的节点。",
    ) {
        if (source != null) {
            ValueRow("From", ClashText.origin(source), first = true)
            ValueRow("Nodes", "${source.nodes}")
            source.traffic?.let { ValueRow("Traffic", ClashText.traffic(it)) }
            ValueRow("Updated", relativeTime(source.updatedAt))
            source.error?.let { FormNote("上次更新没有成功，用的还是之前那一份：$it", Theme.waiting) }
            for (provider in source.providers.filter { it.error != null }) FormNote("节点集 ${provider.name} 没有取到：${provider.error ?: ""}", Theme.waiting)
            AutoUpdateRow(view.settings.autoUpdateHours) { hours -> clash.change { it.copy(autoUpdateHours = hours) } }
            FormButton("Update Now", { clash.fetch { it.updateClash() } }, enabled = !clash.fetching && !(source.kind != "link" && source.providers.isEmpty()))
            FormButton("Replace…", adding, enabled = !clash.fetching)
            FormButton("Remove", remove, enabled = !clash.fetching, destructive = true)
        } else {
            FormButton("Add Subscription…", adding, first = true, enabled = !clash.fetching)
        }
    }
}

/** The iPhone's menu `Picker`: the interval at the right, a tap opens the choices by the row. */
@Composable
private fun AutoUpdateRow(hours: Int, choose: (Int) -> Unit) {
    var bounds by remember { mutableStateOf(Rect.Zero) }
    var menu by remember { mutableStateOf<Rect?>(null) }
    PixelBoxEffect(menu, { menu = null }) { anchor ->
        PixelBox(cancel = null, anchor = anchor, actions = ClashSettings.updateHours.map { h -> PixelBox.Action(ClashText.interval(h)) { choose(h) } })
    }
    FormRow(Modifier.onGloballyPositioned { bounds = it.boundsInRoot() }, onClick = { menu = bounds }) {
        Text("Auto Update", color = Theme.ink, style = plain(16), maxLines = 1)
        Spacer(Modifier.weight(1f))
        Text(ClashText.interval(hours), color = Theme.secondaryInk, style = mono(13), maxLines = 1)
        LookGlyph("▾", LookSymbol.ChevronDown, color = Theme.secondaryInk, size = 13)
    }
}

// MARK: rules and DNS

@Composable
private fun RulesSection(clash: ClashModel, view: ClashView) {
    val nav = LocalNav.current
    val settings = view.settings
    FormSection(
        "Rules",
        footer = "Only My Rules：订阅的分组和规则都不要，只留它的节点，其余走 Manual；国内模版跟着打开。规则模版打开就加进 Clash，关掉就拿走，都立刻生效。Only My Rules 和 DNS 改的是订阅正文，要 Clash Verge 重新取一次才生效。",
    ) {
        SwitchRow("Only My Rules", settings.ownRules, { on -> clash.change { it.copy(ownRules = on) } }, first = true)
        for (template in ClashTemplate.entries) {
            // The domestic template is on while only these rules are: without it everything at home goes by Manual.
            val held = template == ClashTemplate.Domestic && settings.ownRules
            SwitchRow(
                template.title, held || settings.templates[template].on,
                { on -> clash.change { it.copy(templates = it.templates.with(template, it.templates[template].copy(on = on))) } },
                enabled = !held,
            )
            NavRow({ nav.push("clash:text:${template.rawValue}") { ClashTextScreen(clash, template) } }) {
                Text("Edit", color = Theme.ink, style = plain(16), maxLines = 1)
                Text(detail(view, template), Modifier.weight(1f), color = Theme.secondaryInk, style = mono(13), textAlign = TextAlign.End, maxLines = 1)
            }
        }
        SwitchRow("DNS", settings.dns.on, { on -> clash.change { it.copy(dns = it.dns.copy(on = on)) } })
        NavRow({ nav.push("clash:text:dns") { ClashTextScreen(clash, null) } }) {
            Text("Edit", color = Theme.ink, style = plain(16), maxLines = 1)
            Text(if (view.dns.custom) "Edited" else "Template", Modifier.weight(1f), color = Theme.secondaryInk, style = mono(13), textAlign = TextAlign.End, maxLines = 1)
        }
        if (view.dns.on && view.dns.overridden) FormNote("Clash Verge 自己的“DNS 覆写”开着：内核用的是它那一份，这里的 DNS 不起作用。", Theme.waiting)
        val group = view.defaultGroup
        if (group != null && !settings.ownRules) {
            SwitchRow("Rename $group to Manual", settings.renameDefault, { on -> clash.change { it.copy(renameDefault = on) } })
        }
    }
}

private fun detail(view: ClashView, template: ClashTemplate): String {
    val state = view.state(template) ?: return ""
    return ClashText.rules(state.count) + (if (state.custom) " · Edited" else "")
}

// MARK: go direct

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun DirectSection(clash: ClashModel, view: ClashView, anchor: BringIntoViewRequester) {
    var newDirect by remember { mutableStateOf("") }
    val add = {
        val address = newDirect.trim()
        if (address.isNotEmpty()) {
            clash.change { if (address in it.direct) it else it.copy(direct = it.direct + address) }
            newDirect = ""
        }
    }
    FormSection("Go Direct", footer = "这些地址不经任何节点，直接连出去。向左滑删除。") {
        view.settings.direct.forEachIndexed { i, address ->
            SwipeRow({ clash.change { it.copy(direct = it.direct.filterIndexed { j, _ -> j != i }) } }) {
                FormRow(first = i == 0) { Text(address, color = Theme.ink, style = code(14), maxLines = 1) }
            }
        }
        FormRow(Modifier.bringIntoViewRequester(anchor), first = view.settings.direct.isEmpty()) {
            PlainField(
                newDirect, { newDirect = it }, Modifier.weight(1f), placeholder = "host or IP", style = code(14),
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = KeyboardType.Uri, imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { add() }),
            )
            Text(
                "Add", if (newDirect.trim().isEmpty()) Modifier else Modifier.clickable(role = Role.Button, onClick = add).padding(vertical = 8.dp), color = if (newDirect.trim().isEmpty()) Theme.inkDim else Theme.ink,
                style = plain(16), maxLines = 1,
            )
        }
    }
}

// MARK: the routing check

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun RoutingSection(clash: ClashModel, view: ClashView, anchor: BringIntoViewRequester) {
    FormSection("Routing Check", footer = "每一类流量各发一条连接，看 Mac 上的内核把它送去了哪里。") {
        val rows = clash.checked ?: emptyList()
        rows.forEachIndexed { i, row ->
            FormRow(first = i == 0) {
                Column(Modifier.weight(1f).padding(vertical = 2.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    androidx.compose.foundation.layout.Row {
                        Text(row.title, color = Theme.ink, style = plain(16), maxLines = 1)
                        Spacer(Modifier.weight(1f))
                        row.ok?.let { Text(if (it) "OK" else "Wrong", color = if (it) Theme.done else Theme.failed, style = mono(12)) }
                    }
                    Text(row.host, color = Theme.secondaryInk, style = code(12))
                    Text(row.route, color = Theme.secondaryInk, style = plain(13))
                    row.seen?.let { Text(it, color = Theme.secondaryInk, style = mono(12)) }
                    row.problem?.let { Text(it, color = Theme.failed, style = plain(13)) }
                }
            }
        }
        FormRow(Modifier.bringIntoViewRequester(anchor), first = rows.isEmpty(), onClick = if (clash.checking || !view.running) null else ({ clash.check() })) {
            Text(if (clash.checked == null) "Run Check" else "Run Again", color = if (clash.checking || !view.running) Theme.inkDim else Theme.ink, style = plain(16), maxLines = 1)
            Spacer(Modifier.weight(1f))
            if (clash.checking) BrailleSpinner()
        }
    }
}

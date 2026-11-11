package com.agentswitch.android.settings

import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.LocalNav
import com.agentswitch.android.Nav
import com.agentswitch.android.components.ErrorText
import com.agentswitch.android.demo.DemoData
import com.agentswitch.android.demo.LocalDemo
import com.agentswitch.android.design.BrailleSpinner
import com.agentswitch.android.design.FormRow
import com.agentswitch.android.design.FormSection
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.code
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.android.platform.SodiumSealer
import com.agentswitch.android.terminals.ProfileDot
import com.agentswitch.kit.api.AgentSwitchAPI
import com.agentswitch.kit.api.APIError
import com.agentswitch.kit.api.BrowserProxyState
import com.agentswitch.kit.api.ClashView
import com.agentswitch.kit.api.ProfileChoice
import com.agentswitch.kit.api.ProfileChoices
import com.agentswitch.kit.api.ProxyDraft
import com.agentswitch.kit.api.ProxyOwner
import com.agentswitch.kit.api.ProxyRequest
import com.agentswitch.kit.api.ProxySetting
import com.agentswitch.kit.api.ProxyText
import com.agentswitch.kit.api.browserProxy
import com.agentswitch.kit.api.checkProfileExit
import com.agentswitch.kit.api.clash
import com.agentswitch.kit.api.profiles
import com.agentswitch.kit.api.restartBrowser
import com.agentswitch.kit.api.setBrowserProxy
import com.agentswitch.kit.api.setProfileProxy
import com.agentswitch.kit.secrets.TokenError
import com.agentswitch.kit.secrets.TokenMinter
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch

/** Whose proxy a form sets, as a place to go to from Settings. */
sealed class ProxyTarget {
    /** The browser everything shares. */
    data object Browser : ProxyTarget()

    /** One of an agent's profiles (never the Mac's own, which has no proxy of its own). */
    data class Profile(val agent: String, val profile: ProfileChoice) : ProxyTarget()

    val owner: ProxyOwner
        get() = when (this) {
            Browser -> ProxyOwner.Browser
            is Profile -> ProxyOwner.Profile(agent = agent, id = profile.id)
        }

    val title: String
        get() = when (this) {
            Browser -> "Browser"
            is Profile -> profile.name
        }

    /** The page's key in the `Nav` stack. */
    val key: String
        get() = when (this) {
            Browser -> "proxy:browser"
            is Profile -> "proxy:$agent.${profile.id}"
        }
}

/**
 * What the Mac has of proxies (docs/clash-v0.md §9, docs/profiles-v0.md §4.2, docs/browser-v0.md §7.6): Clash
 * Integration, the shared browser's proxy, and each profile's own. Null or empty for what an older Mac keeps to
 * itself; with nothing at all the section is not shown.
 */
data class ProxiesOverview(
    val clash: ClashView? = null,
    val browser: BrowserProxyState? = null,
    val profiles: Map<String, ProfileChoices> = emptyMap(),
) {
    data class Owned(val agent: String, val profile: ProfileChoice) {
        val id: String get() = "$agent.${profile.id}"
    }

    /** Every profile that is not the Mac's own, agents in a fixed order. */
    val owned: List<Owned>
        get() = profiles.keys.sorted().flatMap { agent -> (profiles[agent]?.profiles ?: emptyList()).filter { !it.isDefault }.map { Owned(agent, it) } }

    val isEmpty: Boolean get() = clash == null && browser == null && owned.isEmpty()

    companion object {
        /** Read again; what does not answer keeps what was last read. */
        suspend fun load(api: AgentSwitchAPI, keeping: ProxiesOverview): ProxiesOverview = coroutineScope {
            val clash = async { quietly { api.clash() } }
            val browser = async { quietly { api.browserProxy() } }
            val profiles = async { quietly { api.profiles() } }
            ProxiesOverview(clash.await() ?: keeping.clash, browser.await() ?: keeping.browser, profiles.await() ?: keeping.profiles)
        }

        /** The sample screens' (`DemoData.proxies`). */
        fun demo(): ProxiesOverview =
            ProxiesOverview(ClashDemo.view(), BrowserProxyState(fingerprint = DemoData.browserFingerprint), DemoData.proxyProfiles)
    }
}

private suspend fun <T> quietly(work: suspend () -> T?): T? =
    try {
        work()
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        null
    }

/** The Clash page, over Settings. */
fun Nav.openClash() = push("clash") { ClashScreen() }

/** A proxy's form, over Settings. */
fun Nav.openProxy(target: ProxyTarget) = push(target.key) { ProxyFormView(target) }

/**
 * Settings › Proxies: one row for Clash, one for the shared browser, one for each profile — each with where it stands
 * in a word, and behind each the page that changes it. Nothing at all while the Mac has none of this. It reads the
 * Mac itself, and again when a page it opened is closed (what that changed is on its row).
 */
@Composable
fun ProxiesSection() {
    val model = LocalAppModel.current
    val nav = LocalNav.current
    val demo = LocalDemo.current
    val api = model.api
    var overview by remember(api, demo) { mutableStateOf(if (demo) ProxiesOverview.demo() else ProxiesOverview()) }
    val idle = nav.isEmpty
    LaunchedEffect(api, idle) {
        if (api != null && idle) overview = ProxiesOverview.load(api, keeping = overview)
    }
    if ((api == null && !demo) || overview.isEmpty) return

    FormSection(
        "Proxies",
        footer = "Clash 为 Claude 和 OpenAI 单独选节点；浏览器和每个配置可以各有自己的代理。右边是它现在从哪里出去。",
    ) {
        var first = true
        overview.clash?.let { clash ->
            NavRow({ nav.openClash() }, first = first) {
                Text("Clash", color = Theme.ink, style = plain(16), maxLines = 1)
                Spacer(Modifier.weight(1f))
                Text(clash.word, color = if (clash.todo.isEmpty()) Theme.secondaryInk else Theme.waiting, style = mono(13), maxLines = 1)
            }
            first = false
        }
        overview.browser?.let { browser ->
            NavRow({ nav.openProxy(ProxyTarget.Browser) }, first = first) {
                Text("Browser", color = Theme.ink, style = plain(16), maxLines = 1)
                Text(browser.way, Modifier.weight(1f), color = Theme.secondaryInk, style = mono(13), textAlign = TextAlign.End, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            first = false
        }
        for (item in overview.owned) {
            NavRow({ nav.openProxy(ProxyTarget.Profile(item.agent, item.profile)) }, first = first) {
                item.profile.color?.let { ProfileDot(it) }
                Text(item.profile.name, color = Theme.ink, style = plain(16), maxLines = 1)
                Text(item.profile.way, Modifier.weight(1f), color = Theme.secondaryInk, style = mono(13), textAlign = TextAlign.End, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            first = false
        }
    }
}

/** A form's state in the sample screens (no Mac): the profile's own proxy, or the shared browser going direct. */
private fun demoProxyState(target: ProxyTarget): BrowserProxyState = when (target) {
    ProxyTarget.Browser -> BrowserProxyState(fingerprint = DemoData.browserFingerprint)
    is ProxyTarget.Profile -> BrowserProxyState(proxy = target.profile.proxy, exit = target.profile.exit?.let { BrowserProxyState.Exit.Found(it) })
}

/**
 * A proxy's form (the Mac's `Proxy…` sheet and the Browser page's identity box, in one): where it is, who asks, the
 * password — sealed on this phone before it is sent — and where it lets traffic out. A page: push it with
 * [openProxy].
 *
 * The typed password is sealed with the Mac's gate key as it is now and leaves the field as soon as it is sealed; it
 * is never logged and never kept (only the ciphertext goes out). A request that fails after that has to have it typed
 * again: the field does not hold on to it for a retry.
 */
@Composable
fun ProxyFormView(target: ProxyTarget) {
    val model = LocalAppModel.current
    val demo = LocalDemo.current
    var current by remember { mutableStateOf<ProxySetting?>(null) }
    var exit by remember { mutableStateOf<String?>(null) }
    var problem by remember { mutableStateOf<String?>(null) }
    var restartNeeded by remember { mutableStateOf(false) }
    /** The shared browser's fingerprint in a line; a profile's form has none. */
    var fingerprint by remember { mutableStateOf<String?>(null) }
    var draft by remember { mutableStateOf(ProxyDraft()) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val isBrowser = target == ProxyTarget.Browser
    val none = if (isBrowser) "Direct" else "This Mac"

    fun show(state: BrowserProxyState, resetDraft: Boolean) {
        current = state.proxy
        restartNeeded = state.restartNeeded
        fingerprint = state.fingerprint
        when (val e = state.exit) {
            is BrowserProxyState.Exit.Found -> { exit = e.exit.text; problem = null }
            is BrowserProxyState.Exit.Problem -> { exit = null; problem = e.text }
            null -> { exit = null; problem = null }
        }
        val proxy = state.proxy
        if (exit == null && proxy != null) exit = ProxyText.site(proxy.server)
        if (resetDraft) draft = ProxyDraft(proxy)
    }

    fun show(profile: ProfileChoice?, said: String?, resetDraft: Boolean) {
        if (profile == null) return
        current = profile.proxy
        exit = if (profile.proxy == null) null else profile.way
        problem = said
        if (resetDraft) draft = ProxyDraft(profile.proxy)
    }

    suspend fun load() {
        val api = model.api
        if (api == null) {
            if (demo) show(demoProxyState(target), resetDraft = true)
            return
        }
        try {
            when (target) {
                ProxyTarget.Browser -> api.browserProxy()?.let { show(it, resetDraft = current == null) }
                is ProxyTarget.Profile -> show(api.profiles()[target.agent]?.profiles?.firstOrNull { it.id == target.profile.id }, null, resetDraft = current == null)
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            model.handle(e)
            error = e.message ?: e.javaClass.simpleName
        }
    }
    LaunchedEffect(model.api) { load() }

    /** One call to the Mac; said to be under way meanwhile, and what went wrong is said. */
    fun run(work: suspend (AgentSwitchAPI) -> Unit) {
        val api = model.api
        if (busy || api == null) return
        busy = true
        model.scope.launch {
            try {
                work(api)
                error = null
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (e is APIError.Http && e.status == 404 && e.detail == "not found") {
                    // The Mac's listener for phones does not know the route: an AgentSwitch from before proxies were a phone's.
                    error = "这台 Mac 上的 AgentSwitch 还不能从手机设代理：在 Mac 上更新 AgentSwitch。"
                } else {
                    model.handle(e)
                    error = e.message ?: e.javaClass.simpleName
                }
            } finally {
                busy = false
            }
        }
    }

    suspend fun send(api: AgentSwitchAPI, request: ProxyRequest?) {
        when (target) {
            ProxyTarget.Browser -> show(api.setBrowserProxy(request), resetDraft = true)
            is ProxyTarget.Profile -> {
                val reply = api.setProfileProxy(target.agent, target.profile.id, request)
                show(reply.agents[target.agent]?.profiles?.firstOrNull { it.id == target.profile.id }, reply.problem, resetDraft = true)
            }
        }
    }

    suspend fun apply(api: AgentSwitchAPI) {
        val typed = draft.split()
        draft = typed
        var ciphertext: String? = null
        val payload = typed.sealing(target.owner.sealLabel)
        if (payload != null) {
            // The Mac's key as it is now (it may have changed since pairing); the one kept from pairing otherwise.
            model.refreshGateKey()
            val key = model.profile?.gate?.publicKey ?: throw TokenError.BadPublicKey
            ciphertext = TokenMinter(key, SodiumSealer).mint(payload)
            // Sealed: the typed password is gone from the field, whatever the Mac answers.
            draft = draft.copy(password = "")
        }
        send(api, typed.request(ciphertext, current))
    }

    suspend fun check(api: AgentSwitchAPI) {
        if (target !is ProxyTarget.Profile) return
        val reply = api.checkProfileExit(target.agent, target.profile.id)
        show(reply.agents[target.agent]?.profiles?.firstOrNull { it.id == target.profile.id }, reply.problem, resetDraft = false)
    }

    val typed = draft.split()
    ProxyPage(target.title, "Settings", trailing = { if (busy) BrailleSpinner(Modifier.padding(end = 12.dp)) }) {
        if (error != null) {
            FormSection {
                FormRow(first = true) { ErrorText(error, { error = null }, Modifier.weight(1f)) }
            }
        }
        FormSection(
            footer = ((if (current == null) (if (isBrowser) "浏览器现在直接从这台 Mac 出去。" else "这个配置现在从这台 Mac 自己的出口出去。") else "") +
                (if (fingerprint == null) "" else "指纹在 Mac 上更换。")).ifEmpty { null },
        ) {
            FormRow(first = true) {
                Text("Exit", color = Theme.ink, style = plain(16), maxLines = 1)
                SelectionContainer(Modifier.weight(1f)) {
                    Text(exit ?: none, color = Theme.secondaryInk, style = mono(13), textAlign = TextAlign.End, modifier = Modifier.fillMaxWidth())
                }
            }
            fingerprint?.let { ValueRow("Fingerprint", it) }
            problem?.let { FormNote(it, Theme.waiting) }
            if (current != null && target is ProxyTarget.Profile) FormButton("Check Exit", { run { check(it) } }, enabled = !busy)
        }
        FormSection(
            "Proxy",
            footer = "可以把整条代理地址（http://用户名:密码@主机:端口）直接粘进 Server，用户名和密码会自己分到下面两栏。" +
                (if (isBrowser) ProxyText.browserHint else ProxyText.profileHint) + ProxyText.passwordHint,
        ) {
            FormRow(first = true) {
                Text("Server", color = Theme.ink, style = plain(16), maxLines = 1)
                RightField(
                    draft.server, { draft = draft.copy(server = it) }, "http://host:port", Modifier.weight(1f), style = code(13),
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next),
                    keyboardActions = KeyboardActions(onNext = { draft = draft.split() }),
                )
            }
            FormRow {
                Text("User Name", color = Theme.ink, style = plain(16), maxLines = 1)
                RightField(
                    draft.username, { draft = draft.copy(username = it) }, "None", Modifier.weight(1f),
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, imeAction = ImeAction.Next),
                )
            }
            FormRow {
                Text("Password", color = Theme.ink, style = plain(16), maxLines = 1)
                RightField(
                    draft.password, { draft = draft.copy(password = it) }, if (current?.sealed == true) "Kept" else "None", Modifier.weight(1f),
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
                    visualTransformation = PasswordVisualTransformation(),
                )
            }
            typed.problem?.let { FormNote(it, Theme.failed) }
            FormButton(if (isBrowser) "Apply" else "Apply & Check", { run { apply(it) } }, enabled = !busy && typed.canApply)
            FormButton(if (isBrowser) "Direct" else "No Proxy", { run { send(it, null) } }, enabled = !busy && current != null, destructive = true)
        }
        if (restartNeeded) {
            FormSection(footer = ProxyText.restartHint + "重新启动后已打开的标签按网址恢复。") {
                FormButton("Restart Browser", { run { show(it.restartBrowser(), resetDraft = false) } }, first = true, enabled = !busy)
            }
        }
    }
}

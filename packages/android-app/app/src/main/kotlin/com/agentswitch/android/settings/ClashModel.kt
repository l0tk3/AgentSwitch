package com.agentswitch.android.settings

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.agentswitch.android.demo.DemoData
import com.agentswitch.kit.api.AgentSwitchAPI
import com.agentswitch.kit.api.ClashCheckRow
import com.agentswitch.kit.api.ClashService
import com.agentswitch.kit.api.ClashServiceNodes
import com.agentswitch.kit.api.ClashSettings
import com.agentswitch.kit.api.ClashTemplate
import com.agentswitch.kit.api.ClashText
import com.agentswitch.kit.api.ClashView
import com.agentswitch.kit.api.checkClash
import com.agentswitch.kit.api.clash
import com.agentswitch.kit.api.clashDelays
import com.agentswitch.kit.api.saveClash
import com.agentswitch.kit.api.selectClash
import com.agentswitch.kit.support.KitJson
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.builtins.ListSerializer

/** The sample Clash data (`DemoData`'s JSON) decoded into the kit's types. */
internal object ClashDemo {
    fun view(): ClashView = KitJson.decodeFromJsonElement(ClashView.serializer(), DemoData.clash)

    /** The same page after a setting was changed here (no Mac to keep it). */
    fun view(with: ClashSettings): ClashView =
        KitJson.decodeFromJsonElement(ClashView.serializer(), DemoData.clash(KitJson.encodeToJsonElement(ClashSettings.serializer(), with)))

    fun delays(): Map<ClashService, Map<String, Int?>> =
        ClashService.entries.associateWith { DemoData.clashDelays[it.rawValue] ?: emptyMap() }

    fun checked(): List<ClashCheckRow> = KitJson.decodeFromJsonElement(ListSerializer(ClashCheckRow.serializer()), DemoData.clashChecked)
}

/**
 * What the Clash page has read and is doing (docs/clash-v0.md §9): one of these per page, handed to the pages behind
 * it (a service's nodes, a template's text) so that they change the same thing. It reads the Mac again every now and
 * then while the page is in front (the iPhone pulls to refresh; here the page does it by itself, see [ClashScreen]).
 * [api] is null in the sample screens, which show sample data and whose actions only change what is shown.
 */
@Stable
class ClashModel(
    private val scope: CoroutineScope,
    val api: AgentSwitchAPI?,
    /** What went wrong goes to the app's own handling first (a lost pairing, a Mac that cannot be reached). */
    private val failed: (Throwable) -> Unit,
    private val demo: Boolean = false,
) {
    var view by mutableStateOf<ClashView?>(null)
        private set
    var loaded by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)

    /** A call that fetches from the subscription service is under way. */
    var fetching by mutableStateOf(false)
        private set
    var delays by mutableStateOf<Map<ClashService, Map<String, Int?>>>(emptyMap())
        private set
    var testing by mutableStateOf<Set<ClashService>>(emptySet())
        private set
    var checked by mutableStateOf<List<ClashCheckRow>?>(null)
        private set
    var checking by mutableStateOf(false)
        private set

    /** Something of the page's own is under way: a poll leaves it alone. */
    val busy: Boolean get() = fetching || testing.isNotEmpty() || checking

    suspend fun load() {
        val api = api
        if (api == null) {
            if (demo) {
                view = ClashDemo.view()
                delays = ClashDemo.delays()
                checked = ClashDemo.checked()
                loaded = true
            }
            return
        }
        try {
            view = api.clash()
            error = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (view == null) say(e)
        }
        loaded = true
    }

    private fun launchSaying(work: suspend () -> Unit) {
        scope.launch {
            try {
                work()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                say(e)
            }
        }
    }

    /** One call to the Mac; what it has afterwards is shown. */
    fun run(work: suspend (AgentSwitchAPI) -> ClashView) {
        val api = api ?: return
        launchSaying {
            view = work(api)
            error = null
        }
    }

    /** The same for a call that fetches from the subscription service: said to be under way meanwhile. */
    fun fetch(work: suspend (AgentSwitchAPI) -> ClashView) {
        val api = api ?: return
        if (fetching) return
        fetching = true
        scope.launch {
            try {
                view = work(api)
                error = null
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                say(e)
            } finally {
                fetching = false
            }
        }
    }

    /** The settings with one thing changed, kept by the Mac at once. */
    fun change(edit: (ClashSettings) -> ClashSettings) {
        val now = view?.settings ?: return
        val next = edit(now)
        if (next == now) return
        if (api == null && demo) view = ClashDemo.view(next)
        run { it.saveClash(next) }
    }

    /** A service's chosen nodes replaced. */
    fun setNodes(service: ClashService, nodes: List<String>) = change { it.with(service, ClashServiceNodes(nodes)) }

    fun select(service: ClashService, node: String?) = run { it.selectClash(service, node) }

    fun test(service: ClashService, all: Boolean) {
        val api = api ?: return
        if (service in testing) return
        testing = testing + service
        scope.launch {
            try {
                val tried = api.clashDelays(service, all)
                delays = delays + (service to ((delays[service] ?: emptyMap()) + tried))
                error = null
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                say(e)
            } finally {
                testing = testing - service
            }
        }
    }

    fun check() {
        val api = api ?: return
        if (checking) return
        checking = true
        scope.launch {
            try {
                checked = api.checkClash()
                error = null
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                say(e)
            } finally {
                checking = false
            }
        }
    }

    /**
     * What was edited is kept — a rule template's own rules, or the DNS template's own text (`template` null); `text`
     * null: the built-in one again. What the Mac says is wrong with it is the answer (null when it was kept).
     */
    suspend fun keep(template: ClashTemplate?, text: String?): String? {
        val api = api
        val settings = view?.settings
        if (api == null || settings == null) return "还没有读到设置。"
        val next = if (template != null) {
            settings.copy(templates = settings.templates.with(template, settings.templates[template].copy(rules = text?.let(ClashText::lines))))
        } else {
            settings.copy(dns = settings.dns.copy(text = text))
        }
        return try {
            view = api.saveClash(next)
            null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            failed(e)
            e.message ?: e.javaClass.simpleName
        }
    }

    private fun say(e: Exception) {
        failed(e)
        error = e.message ?: e.javaClass.simpleName
    }
}

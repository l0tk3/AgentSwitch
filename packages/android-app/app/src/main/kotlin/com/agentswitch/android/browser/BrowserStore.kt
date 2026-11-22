package com.agentswitch.android.browser

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.agentswitch.android.AppSettings
import com.agentswitch.kit.api.APIEndpoint
import com.agentswitch.kit.api.APIError
import com.agentswitch.kit.api.AgentSwitchAPI
import com.agentswitch.kit.api.BrowserChoice
import com.agentswitch.kit.api.BrowserLocalServer
import com.agentswitch.kit.api.BrowserTabInfo
import com.agentswitch.kit.api.BrowserTabList
import com.agentswitch.kit.api.browserServers
import com.agentswitch.kit.api.browserSpeed
import com.agentswitch.kit.api.browserTabs
import com.agentswitch.kit.api.browsers
import com.agentswitch.kit.api.forBrowser
import com.agentswitch.kit.browser.BrowserAddress
import com.agentswitch.kit.browser.BrowserSpeed
import com.agentswitch.kit.browser.BrowserStreamPolicy
import com.agentswitch.kit.browser.BrowserZoomMemory
import com.agentswitch.kit.support.KitJson
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import org.json.JSONArray

/**
 * The Browser tab's data (docs/browser-v0.md §1): the Mac's tabs by owner (read from every tab: the badge counts the
 * agents waiting for you; more often while the Browser tab is on screen — there is no list stream yet), the servers
 * listening on the Mac, the addresses typed on this phone and the page zoom it remembers by site. One tab's page
 * follows its own stream.
 *
 * `settings` is the iPhone's `UserDefaults` (null: nothing is kept); `scope` runs the speed measure.
 */
@Stable
class BrowserStore(private val scope: CoroutineScope, private val settings: AppSettings? = null) {
    var list: BrowserTabList? by mutableStateOf(null)
        private set
    var servers: List<BrowserLocalServer> by mutableStateOf(emptyList())
        private set

    /** The Mac has no browser: an AgentSwitch that predates it, or one with the browser switched off (404). */
    var unsupported: Boolean by mutableStateOf(false)
        private set

    /** The last read failed (the kept list is shown); cleared by the next good one. */
    var error: String? by mutableStateOf(null)

    /** This Mac cannot fill ciphertexts into a page yet (its fill route answered 404): the key is not offered. */
    var fillUnavailable: Boolean by mutableStateOf(false)

    /** Addresses typed on this phone, newest first. */
    var recent: List<String> by mutableStateOf(keptRecent())
        private set

    /**
     * The page zoom this phone remembers, a site at a time (browser-v0 §1 页面缩放, 2026-10-03; user: 然后我发现
     * agentswitch的浏览器页没有放大缩小的选项，加上 用来调节大小): the phone's own — the Mac keeps another.
     */
    var zoomMemory: BrowserZoomMemory by mutableStateOf(keptZoom())
        private set

    /** Bumped by `reset` (another Mac): a read that started before it is dropped. */
    private var generation = 0

    /** The link's speed last measured, and over which address: used again on the same address for a minute. */
    private var measured: Measured? = null

    /** A measure under way: a page opened meanwhile waits for it rather than measuring alongside. */
    private var measuring: Pair<APIEndpoint, Deferred<Double?>>? = null

    private class Measured(val endpoint: APIEndpoint, val mbps: Double?, val at: Long)

    /** A speed measured in the last minute (Swift's `Double??`: the outer nil is "not known"). */
    class KnownSpeed(val mbps: Double?)

    /**
     * The browsers the Mac holds, the shared one first (docs/profiles-v0.md §5.4); more than one only when a profile
     * has a proxy of its own.
     */
    var browsers: List<BrowserChoice> by mutableStateOf(listOf(BrowserChoice.shared))
        private set

    /** The one this tab shows: null, the shared one; else a profile's own, by its key. */
    var key: String? by mutableStateOf(null)
        private set

    /** `api`, its browser routes those of the browser shown. */
    fun scoped(api: AgentSwitchAPI?): AgentSwitchAPI? = api?.forBrowser(key)

    /** Another browser on the tab: its list is read afresh (the kept one is another browser's). */
    fun show(key: String?) {
        if (key == this.key) return
        this.key = key
        generation += 1
        list = null
        error = null
    }

    /** The browsers there are now. One that was shown and is gone gives the tab back to the shared one. */
    suspend fun refreshBrowsers(api: AgentSwitchAPI?) {
        if (api == null) return
        val fresh = try {
            api.browsers()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            return
        }
        if (fresh.isEmpty()) return
        if (fresh != browsers) browsers = fresh
        val shown = key
        if (shown != null && fresh.none { it.key == shown }) show(null)
    }

    val tabs: List<BrowserTabInfo> get() = list?.tabs ?: emptyList()
    val waiting: Int get() = list?.waiting ?: 0

    suspend fun refreshList(api: AgentSwitchAPI?) {
        if (api == null) return
        val asked = generation
        try {
            val fresh = api.browserTabs()
            if (asked != generation) return
            if (fresh != list) list = fresh
            unsupported = false
            error = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: APIError.Http) {
            if (e.status == 404) {
                if (asked != generation) return
                unsupported = true
                list = null
            } else if (asked == generation) error = e.message
        } catch (e: Exception) {
            if (asked == generation) error = e.message ?: e.javaClass.simpleName
        }
    }

    /** The Mac's local servers; a failed read keeps the last. */
    suspend fun refreshServers(api: AgentSwitchAPI?) {
        if (api == null || unsupported) return
        val asked = generation
        val fresh = try {
            api.browserServers()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            return
        }
        if (asked == generation && fresh != servers) servers = fresh
    }

    /** The speed measured over `endpoint` in the last minute, if any (megabits a second; a measure that told nothing is null inside). */
    fun knownSpeed(endpoint: APIEndpoint?): KnownSpeed? {
        val m = measured ?: return null
        if (m.endpoint != endpoint || System.currentTimeMillis() - m.at >= BrowserSpeed.fresh.inWholeMilliseconds) return null
        return KnownSpeed(m.mbps)
    }

    /**
     * The link's speed over `endpoint` for a tab's picture: the measure from the last minute on that address, else a
     * new one (`GET /browser/speed`, at most `BrowserSpeed.limit`). Null when not known: an address not measured (the
     * local network), an older Mac, too little came.
     */
    suspend fun speed(api: AgentSwitchAPI?, endpoint: APIEndpoint?): Double? {
        knownSpeed(endpoint)?.let { return it.mbps }
        if (api == null || endpoint == null || !BrowserStreamPolicy.measures(endpoint.kind)) return null
        measuring?.let { if (it.first == endpoint) return it.second.await() }
        val asked = generation
        val task = scope.async { try { api.browserSpeed() } catch (e: CancellationException) { throw e } catch (_: Exception) { null } }
        measuring = endpoint to task
        val mbps = task.await()
        if (measuring?.first == endpoint) measuring = null
        if (asked == generation) measured = Measured(endpoint, mbps, System.currentTimeMillis())
        return mbps
    }

    /** Another Mac (or none): nothing of this one's stays (the typed addresses and the page zoom do: they are this phone's). */
    fun reset() {
        generation += 1
        measured = null
        measuring = null
        list = null
        servers = emptyList()
        unsupported = false
        error = null
        fillUnavailable = false
        browsers = listOf(BrowserChoice.shared)
        key = null
    }

    /** A tab just opened here: listed at once, before the next read. */
    fun add(tab: BrowserTabInfo) {
        list = (list ?: BrowserTabList(running = true, groups = emptyList())).adding(tab)
    }

    fun remove(id: String) {
        list = list?.removing(id)
    }

    fun remember(typed: String) {
        recent = BrowserAddress.remember(typed, recent)
        settings?.putString(recentKey, JSONArray(recent).toString())
    }

    /**
     * A site's pages at `percent` on this phone from now on (100% forgets the site; a blank tab is not kept), across
     * launches. Throws when it cannot be written down: it then holds until the app is closed.
     */
    fun rememberZoom(percent: Int, site: String) {
        val next = zoomMemory.setting(percent, site)
        if (next == zoomMemory) return
        zoomMemory = next
        val text = KitJson.encodeToString(BrowserZoomMemory.serializer(), next)
        settings?.putString(zoomKey, text)
    }

    /** The server listening on a port, for a local tab's line. */
    fun server(port: Int): BrowserLocalServer? = servers.firstOrNull { it.port == port }

    /**
     * The sample screens: the tabs, servers, addresses and zoom of the demo. `browsers`: `browserprofiles` shows a
     * profile's own browser beside the shared one, and the one shown.
     */
    fun setDemo(list: BrowserTabList, servers: List<BrowserLocalServer>, recent: List<String>, zoom: BrowserZoomMemory, browsers: List<BrowserChoice>? = null) {
        if (browsers != null) { this.browsers = browsers; key = browsers.lastOrNull()?.key }
        this.list = list
        this.servers = servers
        this.recent = recent
        zoomMemory = zoom
    }

    private fun keptRecent(): List<String> {
        val raw = settings?.string(recentKey) ?: return emptyList()
        return try {
            val a = JSONArray(raw)
            (0 until a.length()).map { a.getString(it) }
        } catch (_: Exception) { emptyList() }
    }

    /** What was kept under `zoomKey`; nothing there, or something this version cannot read, is nothing remembered. */
    private fun keptZoom(): BrowserZoomMemory {
        val raw = settings?.string(zoomKey) ?: return BrowserZoomMemory()
        return try { KitJson.decodeFromString(BrowserZoomMemory.serializer(), raw) } catch (_: Exception) { BrowserZoomMemory() }
    }

    companion object {
        const val recentKey = "browser.recent"
        const val zoomKey = "browser.zoom"

        /** The list while the Browser tab is on screen, and from the other tabs (the badge). */
        const val pollIntervalMs = 2_000L
        const val backgroundIntervalMs = 8_000L

        /** A Mac without the browser is asked again now and then (it may be updated meanwhile). */
        const val unsupportedIntervalMs = 60_000L
    }
}

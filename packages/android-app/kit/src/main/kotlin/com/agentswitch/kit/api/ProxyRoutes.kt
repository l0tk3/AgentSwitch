package com.agentswitch.kit.api

import kotlin.time.Duration.Companion.seconds
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive

// Proxies from the phone (docs/clash-v0.md §9, docs/profiles-v0.md §4.2, docs/browser-v0.md §7.6): Clash Integration,
// a profile's own proxy, the shared browser's. A Mac from before these were a phone's answers 403 or 404: then there
// is nothing to show, said as null.

private val stringMap = MapSerializer(String.serializer(), String.serializer())

// MARK: Clash

suspend fun AgentSwitchAPI.clash(): ClashView? =
    try {
        get(listOf("clash"), ClashView.serializer())
    } catch (e: APIError.Http) {
        if (e.status == 403 || e.status == 404) null else throw e
    }

suspend fun AgentSwitchAPI.saveClash(settings: ClashSettings): ClashView =
    send("PUT", listOf("clash", "settings"), settings, ClashSettings.serializer(), ClashView.serializer(), timeout = 20.seconds)

/** Work from this link from now on (fetched now). */
suspend fun AgentSwitchAPI.setClashSource(link: String): ClashView =
    send("POST", listOf("clash", "source"), mapOf("link" to link), stringMap, ClashView.serializer(), timeout = ClashText.fetchTimeout)

/** Work from this file's text. */
suspend fun AgentSwitchAPI.setClashSource(yaml: String, name: String): ClashView =
    send("POST", listOf("clash", "source"), mapOf("yaml" to yaml, "name" to name), stringMap, ClashView.serializer(), timeout = ClashText.fetchTimeout)

/** Take one of Clash Verge's own subscriptions in (Swift's `setClashSource(verge:)`). */
suspend fun AgentSwitchAPI.setClashSourceVerge(uid: String): ClashView =
    send("POST", listOf("clash", "source"), mapOf("verge" to uid), stringMap, ClashView.serializer(), timeout = ClashText.fetchTimeout)

suspend fun AgentSwitchAPI.removeClashSource(): ClashView =
    perform("DELETE", listOf("clash", "source"), emptyList(), null, ClashView.serializer())

/** The subscription fetched again now. */
suspend fun AgentSwitchAPI.updateClash(): ClashView =
    perform("POST", listOf("clash", "update"), emptyList(), null, ClashView.serializer(), timeout = ClashText.fetchTimeout)

/** A service's group uses `node` from now on; null: its automatic group. */
suspend fun AgentSwitchAPI.selectClash(service: ClashService, node: String?): ClashView =
    send("POST", listOf("clash", "select"), ClashSelection(service = service.rawValue, node = node), ClashSelectionSerializer,
        ClashView.serializer(), timeout = 20.seconds)

@Serializable
private class ClashDelaysAnswer(val delays: Map<String, Int?>)

@Serializable
private class ClashCheckAnswer(val rows: List<ClashCheckRow>)

/** How long each node takes to reach the service, in ms (null: no answer): the chosen ones, or every node. */
suspend fun AgentSwitchAPI.clashDelays(service: ClashService, all: Boolean): Map<String, Int?> =
    send("POST", listOf("clash", "delays"), mapOf("service" to service.rawValue, "scope" to if (all) "all" else "chosen"), stringMap,
        ClashDelaysAnswer.serializer(), timeout = 30.seconds).delays

/** The routing check: a connection of each kind through the running core, and what the core did with it. */
suspend fun AgentSwitchAPI.checkClash(): List<ClashCheckRow> =
    perform("POST", listOf("clash", "check"), emptyList(), null, ClashCheckAnswer.serializer(), timeout = 40.seconds).rows

/** A template's rules as they are in use. */
suspend fun AgentSwitchAPI.clashTemplate(template: ClashTemplate): ClashTemplateRules =
    get(listOf("clash", "templates", template.rawValue), ClashTemplateRules.serializer())

/** The DNS template's text as it is in use. */
suspend fun AgentSwitchAPI.clashDNS(): ClashDNSText = get(listOf("clash", "dns"), ClashDNSText.serializer())

// MARK: a profile's own proxy

/**
 * `proxy` null: none from now on. Returns every agent's profiles again, and what to say when the proxy was kept
 * but where it lets traffic out is not known.
 */
suspend fun AgentSwitchAPI.setProfileProxy(agent: String, id: String, proxy: ProxyRequest?): ProfileProxyReply {
    if (proxy != null) {
        return send("PUT", listOf("profiles", agent, id, "proxy"), proxy, ProxyRequest.serializer(), ProfileProxyReply.serializer(), timeout = 40.seconds)
    }
    return send("PUT", listOf("profiles", agent, id, "proxy"), NoProxy(), NoProxySerializer, ProfileProxyReply.serializer(), timeout = 40.seconds)
}

/** Where a profile's proxy lets traffic out, asked now. */
suspend fun AgentSwitchAPI.checkProfileExit(agent: String, id: String): ProfileProxyReply =
    perform("POST", listOf("profiles", agent, id, "check"), emptyList(), null, ProfileProxyReply.serializer(), timeout = 40.seconds)

// MARK: the shared browser's proxy

suspend fun AgentSwitchAPI.browserProxy(): BrowserProxyState? =
    try {
        get(listOf("browser", "identity"), BrowserProxyState.serializer())
    } catch (e: APIError.Http) {
        if (e.status == 403 || e.status == 404) null else throw e
    }

/** `proxy` null: direct from now on. */
suspend fun AgentSwitchAPI.setBrowserProxy(proxy: ProxyRequest?): BrowserProxyState =
    send("PUT", listOf("browser", "identity"), BrowserProxyChange(proxy), BrowserProxyChangeSerializer, BrowserProxyState.serializer(),
        timeout = 40.seconds)

/** The browser again, so a time zone that changed with the proxy is in force; its tabs come back. */
suspend fun AgentSwitchAPI.restartBrowser(): BrowserProxyState =
    perform("POST", listOf("browser", "identity", "restart"), emptyList(), null, BrowserProxyState.serializer(), timeout = 60.seconds)

/** Every agent's profiles after a proxy was set or asked, and what there is to say about its exit. */
@Serializable
data class ProfileProxyReply(
    val agents: Map<String, ProfileChoices>,
    val problem: String? = null,
)

internal class ClashSelection(val service: String, val node: String?)

/** `node` null is said (as `null`), not left out. */
internal object ClashSelectionSerializer : KSerializer<ClashSelection> {
    override val descriptor: SerialDescriptor = JsonElement.serializer().descriptor
    override fun deserialize(decoder: Decoder): ClashSelection = throw UnsupportedOperationException("only sent")
    override fun serialize(encoder: Encoder, value: ClashSelection) =
        encoder.encodeObject(linkedMapOf("service" to JsonPrimitive(value.service), "node" to (value.node?.let { JsonPrimitive(it) } ?: JsonNull)))
}

/** No proxy: `{"server": null}`. */
internal class NoProxy

internal object NoProxySerializer : KSerializer<NoProxy> {
    override val descriptor: SerialDescriptor = JsonElement.serializer().descriptor
    override fun deserialize(decoder: Decoder): NoProxy = throw UnsupportedOperationException("only sent")
    override fun serialize(encoder: Encoder, value: NoProxy) = encoder.encodeObject(linkedMapOf("server" to JsonNull))
}

internal class BrowserProxyChange(val proxy: ProxyRequest?)

/** `proxy` null is said (direct), not left out. */
internal object BrowserProxyChangeSerializer : KSerializer<BrowserProxyChange> {
    override val descriptor: SerialDescriptor = JsonElement.serializer().descriptor
    override fun deserialize(decoder: Decoder): BrowserProxyChange = throw UnsupportedOperationException("only sent")
    override fun serialize(encoder: Encoder, value: BrowserProxyChange) {
        val element: JsonElement = value.proxy?.let { com.agentswitch.kit.support.KitJson.encodeToJsonElement(ProxyRequest.serializer(), it) } ?: JsonNull
        encoder.encodeObject(linkedMapOf("proxy" to element))
    }
}

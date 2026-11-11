package com.agentswitch.kit.api

import com.agentswitch.kit.support.KitJson
import java.time.Instant
import java.time.ZoneId
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * Clash Integration from the phone (docs/clash-v0.md §7, §9): the subscription AgentSwitch works from, the nodes
 * chosen for Claude and for OpenAI in their order, the addresses that go direct — and what the Mac's service found
 * of Clash Verge and of the core it runs: whether it is on AgentSwitch's subscription, and what each service's group
 * uses now. The same models as the Mac's page (`AgentSwitchMacCore/Agents/ClashIntegration.swift`).
 *
 * Unlike Swift's, the settings types are immutable (`val`s with `copy`): where Swift writes `settings[.openai].nodes =
 * …` here is `settings.with(ClashService.Openai, ClashServiceNodes(…))`, and the same for a template.
 */
enum class ClashService(val rawValue: String) {
    Claude("claude"), Openai("openai");

    val title: String get() = if (this == Claude) "Claude" else "OpenAI"
}

@Serializable
data class ClashServiceNodes(
    /** Nodes by name, the first preferred. */
    val nodes: List<String> = emptyList(),
)

/** A rule template (docs/clash-v0.md §7.7): a set of rules that go one way, put on with a switch. */
enum class ClashTemplate(val rawValue: String) {
    /** Domestic and local traffic goes direct. */
    Domestic("domestic"),

    /** Ads and trackers are rejected. */
    Block("block");

    val title: String get() = if (this == Domestic) "Domestic & Local Direct" else "Block Ads & Trackers"
}

/** A whole number from a JSON number that may carry a fraction (the Mac writes some sizes and times as doubles). */
internal object WholeNumber : KSerializer<Long> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("WholeNumber", PrimitiveKind.LONG)

    override fun deserialize(decoder: Decoder): Long {
        val element = ((decoder as? JsonDecoder) ?: throw SerializationException("JSON only")).decodeJsonElement()
        val p = element as? JsonPrimitive
        val d = p?.takeIf { it !is JsonNull && !it.isString }?.doubleOrNull
        if (d == null || !d.isFinite()) throw SerializationException("not a number")
        return d.toLong()
    }

    override fun serialize(encoder: Encoder, value: Long) = encoder.encodeLong(value)
}

private fun Encoder.writeObject(vararg fields: Pair<String, JsonElement>) = encodeObject(linkedMapOf(*fields))

private fun JsonObject.requireBool(key: String): Boolean =
    (this[key] as? JsonPrimitive)?.takeIf { it !is JsonNull && !it.isString }?.let { it.content.toBooleanStrictOrNull() }
        ?: throw SerializationException("$key missing or not a boolean")

private fun JsonObject.optionalStrings(key: String): List<String>? {
    val v = this[key] ?: return null
    if (v is JsonNull) return null
    return KitJson.decodeFromJsonElement(ListSerializer(String.serializer()), v)
}

private fun List<String>?.toJson(): JsonElement =
    if (this == null) JsonNull else KitJson.encodeToJsonElement(ListSerializer(String.serializer()), this)

@Serializable(with = ClashTemplateSettingSerializer::class)
data class ClashTemplateSetting(
    val on: Boolean = false,
    /** The user's own rules, a line each; null: the template as it is built in. */
    val rules: List<String>? = null,
)

/** `rules` null is said (as `null`), not left out. */
object ClashTemplateSettingSerializer : KSerializer<ClashTemplateSetting> {
    override val descriptor: SerialDescriptor = JsonElement.serializer().descriptor
    override fun deserialize(decoder: Decoder): ClashTemplateSetting {
        val o = decoder.jsonObject("ClashTemplateSetting")
        return ClashTemplateSetting(o.requireBool("on"), o.optionalStrings("rules"))
    }

    override fun serialize(encoder: Encoder, value: ClashTemplateSetting) =
        encoder.writeObject("on" to JsonPrimitive(value.on), "rules" to value.rules.toJson())
}

@Serializable
data class ClashTemplates(
    val domestic: ClashTemplateSetting = ClashTemplateSetting(),
    val block: ClashTemplateSetting = ClashTemplateSetting(),
) {
    operator fun get(template: ClashTemplate): ClashTemplateSetting = if (template == ClashTemplate.Domestic) domestic else block

    /** Swift's `subscript` setter. */
    fun with(template: ClashTemplate, setting: ClashTemplateSetting): ClashTemplates =
        if (template == ClashTemplate.Domestic) copy(domestic = setting) else copy(block = setting)
}

/** The DNS template (docs/clash-v0.md §7.8): on, the subscription handed over has it under `dns:` in place of its own. */
@Serializable(with = ClashDNSSettingSerializer::class)
data class ClashDNSSetting(
    val on: Boolean = false,
    /** The user's own text (YAML, what goes under `dns:`); null: the built-in one. */
    val text: String? = null,
)

/** `text` null is said (as `null`), not left out. */
object ClashDNSSettingSerializer : KSerializer<ClashDNSSetting> {
    override val descriptor: SerialDescriptor = JsonElement.serializer().descriptor
    override fun deserialize(decoder: Decoder): ClashDNSSetting {
        val o = decoder.jsonObject("ClashDNSSetting")
        return ClashDNSSetting(o.requireBool("on"), o.strictStringOrNull("text"))
    }

    override fun serialize(encoder: Encoder, value: ClashDNSSetting) =
        encoder.writeObject("on" to JsonPrimitive(value.on), "text" to (value.text?.let { JsonPrimitive(it) } ?: JsonNull))
}

/**
 * The DNS template as it stands: on or off, whether its text is the user's own, and whether Clash Verge has its own
 * DNS settings on — the core then takes those, and this changes nothing.
 */
@Serializable
data class ClashDNSState(val on: Boolean, val custom: Boolean, val overridden: Boolean)

/** The DNS template's text as it is in use, to edit it. */
@Serializable
data class ClashDNSText(val text: String, val custom: Boolean)

@Serializable(with = ClashSettingsSerializer::class)
data class ClashSettings(
    val claude: ClashServiceNodes = ClashServiceNodes(),
    val openai: ClashServiceNodes = ClashServiceNodes(),
    val direct: List<String> = emptyList(),
    /** The subscription is fetched again after this many hours; 0: only when asked. */
    val autoUpdateHours: Int = 24,
    val templates: ClashTemplates = ClashTemplates(),
    /** The subscription's default group is called `Manual` in what Clash Verge is handed. */
    val renameDefault: Boolean = false,
    val dns: ClashDNSSetting = ClashDNSSetting(),
    /**
     * What Clash Verge is handed keeps the subscription's nodes alone: AgentSwitch's groups and rules are all there is,
     * and the domestic template is on while this is (docs/clash-v0.md §7.11).
     */
    val ownRules: Boolean = false,
) {
    operator fun get(service: ClashService): ClashServiceNodes = if (service == ClashService.Claude) claude else openai

    /** Swift's `subscript` setter. */
    fun with(service: ClashService, nodes: ClashServiceNodes): ClashSettings =
        if (service == ClashService.Claude) copy(claude = nodes) else copy(openai = nodes)

    companion object {
        /** The intervals offered (the service takes no other). */
        val updateHours = listOf(0, 1, 6, 12, 24)
    }
}

/** A Mac from before §7.11 says nothing of `ownRules`: off. Every other field is required, as in Swift. */
object ClashSettingsSerializer : KSerializer<ClashSettings> {
    override val descriptor: SerialDescriptor = JsonElement.serializer().descriptor

    private fun <T> JsonObject.need(key: String, serializer: KSerializer<T>): T =
        KitJson.decodeFromJsonElement(serializer, this[key] ?: throw SerializationException("$key missing"))

    override fun deserialize(decoder: Decoder): ClashSettings {
        val o = decoder.jsonObject("ClashSettings")
        val own = o["ownRules"]
        return ClashSettings(
            claude = o.need("claude", ClashServiceNodes.serializer()),
            openai = o.need("openai", ClashServiceNodes.serializer()),
            direct = o.need("direct", ListSerializer(String.serializer())),
            autoUpdateHours = o.need("autoUpdateHours", Int.serializer()),
            templates = o.need("templates", ClashTemplates.serializer()),
            renameDefault = o.need("renameDefault", Boolean.serializer()),
            dns = o.need("dns", ClashDNSSetting.serializer()),
            ownRules = if (own == null || own is JsonNull) false else KitJson.decodeFromJsonElement(Boolean.serializer(), own),
        )
    }

    override fun serialize(encoder: Encoder, value: ClashSettings) = encoder.writeObject(
        "claude" to KitJson.encodeToJsonElement(ClashServiceNodes.serializer(), value.claude),
        "openai" to KitJson.encodeToJsonElement(ClashServiceNodes.serializer(), value.openai),
        "direct" to value.direct.toJson(),
        "autoUpdateHours" to JsonPrimitive(value.autoUpdateHours),
        "templates" to KitJson.encodeToJsonElement(ClashTemplates.serializer(), value.templates),
        "renameDefault" to JsonPrimitive(value.renameDefault),
        "dns" to KitJson.encodeToJsonElement(ClashDNSSetting.serializer(), value.dns),
        "ownRules" to JsonPrimitive(value.ownRules),
    )
}

/** A node set the subscription names by link, which AgentSwitch fetches too. */
@Serializable
data class ClashSourceProvider(
    val name: String,
    val host: String,
    val nodes: Int,
    val error: String? = null,
)

@Serializable
data class ClashTraffic(
    /** Bytes used, of how many; when it ends (ms since 1970), if the subscription service says. */
    @Serializable(with = WholeNumber::class) val used: Long,
    @Serializable(with = WholeNumber::class) val total: Long,
    @Serializable(with = WholeNumber::class) val expire: Long? = null,
)

@Serializable
data class ClashSource(
    /** `link` or `file`. */
    val kind: String,
    val name: String,
    /** Where a link goes (its host; the rest is never told). */
    val host: String? = null,
    /** Ms since 1970. */
    @Serializable(with = WholeNumber::class) val updatedAt: Long,
    val nodes: Int,
    val providers: List<ClashSourceProvider>,
    /** The last fetch did not work; what is kept is the one before. */
    val error: String? = null,
    val traffic: ClashTraffic? = null,
)

@Serializable
data class ClashServiceState(
    /** Its two groups by the names they have in Clash. */
    val group: String,
    val auto: String,
    /** The core has this service's groups from AgentSwitch: what its group uses can be picked from here. */
    val live: Boolean,
    /** What its group uses now (a node, or the automatic group's name), and what the automatic one uses. */
    val now: String? = null,
    val autoNow: String? = null,
    /** Chosen nodes the subscription no longer has. */
    val missing: List<String>,
) {
    /** The group follows the automatic one. */
    val automatic: Boolean get() = live && now == auto
}

/** A rule template as it stands: on or off, whether its rules are the user's own, how many are in use. */
@Serializable
data class ClashTemplateState(val on: Boolean, val custom: Boolean, val count: Int)

/** A template's rules as they are in use, to edit them. */
@Serializable
data class ClashTemplateRules(val rules: List<String>, val custom: Boolean)

/**
 * One line of the routing check (docs/clash-v0.md §7.9): a kind of traffic, the name tried for it, what it should do
 * and what the running core did with it.
 */
@Serializable
data class ClashCheckRow(
    val id: String,
    val title: String,
    val host: String,
    /** Null: nothing is asked of this kind here (its template is off); it is shown for what it is. */
    val expect: Expect? = null,
    val observed: Observed,
    val ok: Boolean? = null,
) {
    @Serializable
    data class Expect(
        /** `group`, `direct` or `reject`. */
        val kind: String,
        val group: String? = null,
    )

    @Serializable
    data class Exit(val ip: String, val loc: String)

    @Serializable
    data class Observed(
        /** `proxied`, `direct`, `rejected`, or `unknown` (the core listed nothing: the node did not answer). */
        val outcome: String,
        /** The rule that matched, as the core names it. */
        val rule: String? = null,
        /** The way out, from the group the rule names down to the node. */
        val path: List<String>,
        /** Where the far end saw it come from, where that was asked. */
        val exit: Exit? = null,
        val ms: Int? = null,
    )

    /** What happened, in a line: `RuleSet as-claude → Claude → Claude自动选择 → 日本家宽-02`, `Rejected`, `No Answer`. */
    val route: String
        get() = when (observed.outcome) {
            "rejected" -> "Rejected"
            "unknown" -> "No Answer"
            else -> (listOfNotNull(observed.rule) + observed.path).joinToString(" → ")
        }

    /** Where the far end saw it come from and how long it took: `JP 126.36.1.2 · 362 ms`; null where it was not asked. */
    val seen: String?
        get() {
            val exit = observed.exit ?: return null
            return listOf(exit.loc, exit.ip).filter { it.isNotEmpty() }.joinToString(" ") + (observed.ms?.let { " · $it ms" } ?: "")
        }

    /** What it should have done, said when it did not; null when it did, or nothing was asked. */
    val problem: String?
        get() {
            val expect = expect
            if (ok != false || expect == null) return null
            val should = if (expect.kind == "group") "应该走 ${expect.group ?: ""} 这一组" else if (expect.kind == "direct") "应该直连" else "应该被拦截"
            return if (observed.outcome == "unknown") "$should，但内核没有列出这条连接（节点没有回应，或没有连上）。" else "$should，实际不是。"
        }
}

@Serializable
data class ClashProfile(val uid: String, val name: String, val type: String) {
    val id: String get() = uid
}

@Serializable
data class ClashView(
    /** Clash Verge is on this Mac; its core answers. */
    val found: Boolean,
    val running: Boolean,
    val version: String? = null,
    val tun: Boolean? = null,
    val source: ClashSource? = null,
    /** Every node of the subscription, by name. */
    val nodes: List<String>,
    /** Clash Verge's own subscriptions, to import one. */
    val profiles: List<ClashProfile>,
    val settings: ClashSettings,
    private val services: Map<String, ClashServiceState>,
    private val templates: Map<String, ClashTemplateState>,
    /** The subscription's default group, which can be called `Manual`; null: it has none such, or has a `Manual`. */
    val defaultGroup: String? = null,
    val dns: ClashDNSState,
    /** The core runs the subscription AgentSwitch makes; it is the one made now (else Clash Verge fetches it again). */
    val active: Boolean,
    val upToDate: Boolean,
    /** When Clash Verge last fetched it (ms since 1970); null: not since the service started. */
    @Serializable(with = WholeNumber::class) val fetchedAt: Long? = null,
) {
    fun state(service: ClashService): ClashServiceState? = services[service.rawValue]

    fun state(template: ClashTemplate): ClashTemplateState? = templates[template.rawValue]

    /**
     * What is still to do, in order; empty when nothing is. Said from the phone: Clash Verge is on the Mac, and
     * adding AgentSwitch's subscription to it is done there (the address it takes it by works on the Mac alone).
     */
    val todo: List<String>
        get() {
            if (!found) return listOf("Mac 上没有找到 Clash Verge。")
            if (!running) return listOf("Mac 上的 Clash Verge 没有在运行：在 Mac 上打开它。")
            val steps = mutableListOf<String>()
            if (source == null) steps.add("先在下面给一个订阅：一条链接、一个文件，或者从 Clash Verge 导入。")
            else if (!active) steps.add("在 Mac 的 Clash Verge 里添加并切换到 AgentSwitch 订阅（Mac 上 AgentSwitch 的 Clash 页有一键添加）。")
            else if (!upToDate) steps.add("订阅的正文变了（分组、规则集或 DNS）：在 Mac 的 Clash Verge 里更新一次 AgentSwitch 订阅，或者等它自己来取（每小时一次）。")
            if (tun == false) steps.add("打开 Mac 上 Clash Verge 的 TUN 模式。")
            return steps
        }

    /** The state in a word: `Not Found`, `Not Running`, `Set Up` while something is still to do, else `Running`. */
    val word: String get() = if (!found) "Not Found" else if (!running) "Not Running" else if (todo.isEmpty()) "Running" else "Set Up"
}

/** The page's short words (docs/ui-v0.md §7.2.7: a unit that starts with a digit is written as it is). */
object ClashText {
    /** How long a call that fetches from the subscription service may take (the service gives each fetch 30 s). */
    val fetchTimeout: Duration = 100.seconds

    /**
     * `428 ms`; `Timeout` for a node that did not answer; nothing for one not tried. Swift's `Int??`: [delays] holds a
     * node with a null value when it did not answer, and has no entry for one not tried.
     */
    fun delay(delays: Map<String, Int?>, node: String): String = if (node in delays) delay(delays[node]) else ""

    /** A node that was tried: `428 ms`, or `Timeout` for null. */
    fun delay(tried: Int?): String = if (tried == null) "Timeout" else "$tried ms"

    /** `12.3 / 100 GB`, and when it ends if that is said. */
    fun traffic(traffic: ClashTraffic, zone: ZoneId = ZoneId.systemDefault()): String {
        val gb = 1_073_741_824.0
        val number = { bytes: Double ->
            val value = bytes / gb
            if (value >= 100 || value == roundAway(value).toDouble()) roundAway(value).toString() else value.cFixed(1)
        }
        var text = "${number(traffic.used.toDouble())} / ${number(traffic.total.toDouble())} GB"
        val expire = traffic.expire
        if (expire != null) {
            val day = Instant.ofEpochMilli(expire).atZone(zone).toLocalDate()
            text += " · Expires ${day.year}/${day.monthValue}/${day.dayOfMonth}"
        }
        return text
    }

    /** `1 h`, `24 h`; `Off` for never. */
    fun interval(hours: Int): String = if (hours == 0) "Off" else "$hours h"

    /** `169 Rules`, `1 Rule`. */
    fun rules(count: Int): String = if (count == 1) "1 Rule" else "$count Rules"

    /** The lines of an edited template, as they go to the service (which says which of them is not a rule). */
    fun lines(text: String): List<String> = text.split('\n', '\u000B', '\u000C', '\r', '\u0085', '\u2028', '\u2029')

    /** Where the subscription comes from, in a line: a link's host, a file's name. */
    fun origin(source: ClashSource): String = if (source.kind == "link") (source.host ?: source.name) else source.name
}

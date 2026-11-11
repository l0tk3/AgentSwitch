package com.agentswitch.kit.api

import com.agentswitch.kit.browser.Size
import com.agentswitch.kit.browser.roundedHalfAway
import com.agentswitch.kit.feed.ModelName
import com.agentswitch.kit.support.KitJson
import kotlin.math.floor
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

// The shared browser (docs/browser-v0.md §5): the tabs `GET /browser/tabs` lists, what a tab's stream brings and what a
// screen may send. Unknown fields and values decode leniently, so a newer Mac never empties the list.
//
// Swift's `Decodable` structs with a hand-written `init(from:)` (`try? decodeIfPresent(…) ?? default`) are read here
// from the JSON tree by hand, with the same tolerance; each has a decode-only `KSerializer` for `KitJson`.

// MARK: - reading JSON leniently

/** What a reader that is strict (Swift's `try`) throws. */
internal class MalformedJSON : Exception()

internal fun JsonElement?.string(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content
internal fun JsonElement?.double(): Double? = (this as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull
internal fun JsonElement?.long(): Long? {
    val p = (this as? JsonPrimitive)?.takeIf { !it.isString } ?: return null
    p.longOrNull?.let { return it }
    return p.doubleOrNull?.takeIf { it.isFinite() && it == floor(it) && Math.abs(it) < 9.0e18 }?.toLong()
}
internal fun JsonElement?.int(): Int? = long()?.takeIf { it in Int.MIN_VALUE..Int.MAX_VALUE }?.toInt()
internal fun JsonElement?.bool(): Boolean? = (this as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toBooleanStrictOrNull()
internal fun JsonElement?.obj(): JsonObject? = this as? JsonObject

/** `try container.decodeIfPresent(…)`: absent and `null` are none, a value of another type throws. */
private fun <T> JsonObject.optional(key: String, read: JsonElement.() -> T?): T? {
    val e = this[key] ?: return null
    if (e is JsonNull) return null
    return e.read() ?: throw MalformedJSON()
}

/** `try container.decode(…)`: the key must be there. */
private fun <T> JsonObject.required(key: String, read: JsonElement.() -> T?): T {
    val e = this[key] ?: throw MalformedJSON()
    return e.read() ?: throw MalformedJSON()
}

/** A decode-only serializer over the JSON tree (Swift's types here are `Decodable` only). */
internal abstract class TreeReader<T> : KSerializer<T> {
    override val descriptor: SerialDescriptor = JsonElement.serializer().descriptor

    abstract fun read(element: JsonElement): T

    override fun deserialize(decoder: Decoder): T {
        val tree = (decoder as? JsonDecoder ?: throw SerializationException("JSON only")).decodeJsonElement()
        try {
            return read(tree)
        } catch (e: MalformedJSON) {
            throw SerializationException("unreadable")
        }
    }

    override fun serialize(encoder: Encoder, value: T) = throw UnsupportedOperationException("only read")
}

/** A body that is only sent, written as the object it builds. */
internal class ObjectWriter<T>(private val build: (T) -> Map<String, JsonElement>) : KSerializer<T> {
    override val descriptor: SerialDescriptor = JsonElement.serializer().descriptor
    override fun deserialize(decoder: Decoder): T = throw UnsupportedOperationException("only sent")
    override fun serialize(encoder: Encoder, value: T) = encoder.encodeObject(build(value))
}

/** A number as Foundation's `JSONEncoder` writes it: a whole value without `.0`. */
internal fun jsonNumber(value: Double): JsonPrimitive =
    if (value.isFinite() && value == floor(value) && Math.abs(value) < 1e15) JsonPrimitive(value.toLong()) else JsonPrimitive(value)

/** Foundation's `trimmingCharacters(in: .whitespaces)` (`newlines`: `.whitespacesAndNewlines`). */
internal fun String.swiftTrimmed(newlines: Boolean = false): String {
    fun blank(c: Char): Boolean =
        c == '\t' || Character.getType(c) == Character.SPACE_SEPARATOR.toInt() ||
            (newlines && (c in '\n'..'\r' || c == '\u0085' || c == ' ' || c == ' '))
    var start = 0
    var end = length
    while (start < end && blank(this[start])) start++
    while (end > start && blank(this[end - 1])) end--
    return substring(start, end)
}

// MARK: - tabs

/** Who a tab belongs to: a person (`you`), an agent in a terminal, or a dispatched task. */
@Serializable(with = BrowserTabOwnerSerializer::class)
data class BrowserTabOwner(val kind: Kind, val id: String, /** `You`, the terminal's name (`codex · AgentSwitch`), or the task's title. */ val label: String) {
    sealed class Kind {
        data object You : Kind()
        data object Terminal : Kind()
        data object Task : Kind()
        data class Other(val value: String) : Kind()

        companion object {
            /** Swift's `Kind(rawValue:)`. */
            operator fun invoke(rawValue: String): Kind = when (rawValue) {
                "you" -> You
                "terminal" -> Terminal
                "task" -> Task
                else -> Other(rawValue)
            }
        }
    }

    /** An agent's tab: people drive it only once they have taken it over. */
    val isAgent: Boolean get() = kind != Kind.You

    /** The agent named first in a label (`codex · AgentSwitch` → `codex`), when the label says one. */
    val namedHarness: String?
        get() {
            val first = label.split(" · ").first().swiftTrimmed().lowercase()
            return mapOf("claude code" to "claude-code", "claude" to "claude-code", "codex" to "codex", "opencode" to "opencode",
                "pi" to "pi", "grok" to "grok")[first]
        }

    /**
     * The agent as people call it (`Codex`, `Claude Code`), for the holder line and sentences: `harness` (the terminal's
     * or the task's, when known) or the one the label names, by its proper name (ModelName); else the label's first part.
     */
    fun agentName(harness: String? = null): String {
        (harness ?: namedHarness)?.let { return ModelName.harness(it) }
        return label.split(" · ").firstOrNull() ?: label
    }

    companion object {
        val you = BrowserTabOwner(kind = Kind.You, id = "you", label = "You")
    }
}

internal object BrowserTabOwnerSerializer : TreeReader<BrowserTabOwner>() {
    override fun read(element: JsonElement): BrowserTabOwner {
        val o = element.obj() ?: throw MalformedJSON()
        return BrowserTabOwner(
            kind = BrowserTabOwner.Kind(o["kind"].string() ?: "you"),
            id = o["id"].string() ?: "",
            label = o["label"].string() ?: "",
        )
    }
}

/** `busy`: an agent is operating the tab; `waiting`: it waits for the user (a code, a login, a confirmation). */
@Serializable(with = BrowserTabStatusSerializer::class)
sealed class BrowserTabStatus {
    data object Idle : BrowserTabStatus()
    data object Busy : BrowserTabStatus()
    data object Waiting : BrowserTabStatus()
    data class Other(val value: String) : BrowserTabStatus()

    /** The word on screen (docs/ui-v0.md §7.2.7, as the terminals: Busy · Waiting · Idle). */
    val label: String
        get() = when (this) {
            Idle -> "Idle"
            Busy -> "Busy"
            Waiting -> "Waiting"
            is Other -> value
        }

    companion object {
        /** Swift's `init(rawValue:)`. */
        operator fun invoke(rawValue: String): BrowserTabStatus = when (rawValue) {
            "idle" -> Idle
            "busy" -> Busy
            "waiting" -> Waiting
            else -> Other(rawValue)
        }
    }
}

internal object BrowserTabStatusSerializer : TreeReader<BrowserTabStatus>() {
    override fun read(element: JsonElement): BrowserTabStatus = BrowserTabStatus(element.string() ?: throw MalformedJSON())
}

/** What kind of place a tab shows: a site, a file of the Mac's, a local server, nothing. */
@Serializable
enum class BrowserPlaceKind(val rawValue: String) {
    @SerialName("web") Web("web"),
    @SerialName("file") File("file"),
    @SerialName("local") Local("local"),
    @SerialName("blank") Blank("blank");

    companion object {
        /** An unknown value, or none, is a site. */
        fun from(element: JsonElement?): BrowserPlaceKind = entries.firstOrNull { it.rawValue == element.string() } ?: Web
    }
}

/** A rectangle in the page's CSS pixels (the viewport's). */
@Serializable(with = BrowserBoxSerializer::class)
data class BrowserBox(val x: Double, val y: Double, val width: Double, val height: Double)

internal object BrowserBoxSerializer : TreeReader<BrowserBox>() {
    override fun read(element: JsonElement): BrowserBox {
        val o = element.obj() ?: throw MalformedJSON()
        return BrowserBox(o.required("x") { double() }, o.required("y") { double() }, o.required("width") { double() }, o.required("height") { double() })
    }
}

/** What an agent just did, for the outline over the screen (`codex · click "Merge"`). */
@Serializable(with = BrowserAgentActionSerializer::class)
data class BrowserAgentAction(val tool: String, val description: String, val box: BrowserBox? = null, val at: Long = 0) {
    /** What the outline's label says: the agent and what it did. */
    fun said(by: String): String {
        val what = if (description.isEmpty()) tool else description
        return if (by.isEmpty()) what else "$by · $what"
    }
}

internal object BrowserAgentActionSerializer : TreeReader<BrowserAgentAction>() {
    override fun read(element: JsonElement): BrowserAgentAction {
        val o = element.obj() ?: throw MalformedJSON()
        return BrowserAgentAction(
            tool = o["tool"].string() ?: "",
            description = o["description"].string() ?: "",
            box = o["box"]?.let { try { BrowserBoxSerializer.read(it) } catch (e: MalformedJSON) { null } },
            at = o["at"].long() ?: 0,
        )
    }
}

/**
 * The page's size in CSS pixels, its device pixel ratio, whether it is a phone's, and the screen that set it (null:
 * the default, 1280 × 800).
 */
@Serializable(with = BrowserViewportSerializer::class)
data class BrowserViewport(
    val width: Double,
    val height: Double,
    val scale: Double = 1.0,
    val mobile: Boolean = false,
    val by: String? = null,
) {
    companion object {
        val standard = BrowserViewport(width = 1280.0, height = 800.0)
    }
}

internal object BrowserViewportSerializer : TreeReader<BrowserViewport>() {
    override fun read(element: JsonElement): BrowserViewport {
        val o = element.obj() ?: throw MalformedJSON()
        return BrowserViewport(
            width = o["width"].double() ?: 1280.0,
            height = o["height"].double() ?: 800.0,
            scale = o["scale"].double() ?: 1.0,
            mobile = o["mobile"].bool() ?: false,
            by = o["by"].string(),
        )
    }
}

/** One tab of the browser on the Mac. */
@Serializable(with = BrowserTabInfoSerializer::class)
data class BrowserTabInfo(
    val id: String,
    val owner: BrowserTabOwner = BrowserTabOwner.you,
    val title: String = "",
    val url: String = "about:blank",
    /** The list's second line: the host, the file's path (`~/x/mesh.html`) or `localhost:5173`. */
    val site: String = "",
    val kind: BrowserPlaceKind = BrowserPlaceKind.Web,
    val status: BrowserTabStatus = BrowserTabStatus.Idle,
    val loading: Boolean = false,
    /** The screen (or paired device) that has taken it over; null while nobody holds it. */
    val heldBy: String? = null,
    val action: BrowserAgentAction? = null,
    val viewport: BrowserViewport = BrowserViewport.standard,
    val openedAt: Long = 0,
) {
    /** The title as a row shows it: the page's own, else where it is. */
    val displayTitle: String
        get() {
            if (title.isNotEmpty()) return title
            if (site.isNotEmpty()) return site
            return if (url.isEmpty()) "about:blank" else url
        }

    /** Why an agent's tab waits for you, when it said (its last action while waiting). */
    val waitingReason: String?
        get() {
            val a = action
            if (status != BrowserTabStatus.Waiting || a == null || a.description.isEmpty()) return null
            return a.description
        }

    /** `screen` may drive it: it holds it, or nobody does and it is a person's tab (an agent's is taken over first). */
    fun drivable(by: String): Boolean = heldBy == by || (heldBy == null && !owner.isAgent)

    /** The same tab with what a stream event changes. */
    fun applying(event: BrowserEvent): BrowserTabInfo = when (event) {
        is BrowserEvent.Tab -> event.tab
        is BrowserEvent.Url -> copy(url = event.url, site = event.site, kind = event.kind)
        is BrowserEvent.Title -> copy(title = event.title)
        is BrowserEvent.Loading -> copy(loading = event.loading)
        is BrowserEvent.Status -> copy(status = event.status)
        is BrowserEvent.Held -> copy(heldBy = event.holder)
        is BrowserEvent.Action -> copy(action = event.action)
        is BrowserEvent.Viewport -> copy(viewport = event.viewport)
        is BrowserEvent.Frame, is BrowserEvent.Closed, BrowserEvent.Dropped -> this
    }
}

internal object BrowserTabInfoSerializer : TreeReader<BrowserTabInfo>() {
    override fun read(element: JsonElement): BrowserTabInfo {
        val o = element.obj() ?: throw MalformedJSON()
        return BrowserTabInfo(
            id = o.required("id") { string() },
            owner = o["owner"]?.let { try { BrowserTabOwnerSerializer.read(it) } catch (e: MalformedJSON) { null } } ?: BrowserTabOwner.you,
            title = o["title"].string() ?: "",
            url = o["url"].string() ?: "",
            site = o["site"].string() ?: "",
            kind = BrowserPlaceKind.from(o["kind"]),
            status = o["status"].string()?.let { BrowserTabStatus(it) } ?: BrowserTabStatus.Idle,
            loading = o["loading"].bool() ?: false,
            heldBy = o["heldBy"].string(),
            action = o["action"]?.let { try { BrowserAgentActionSerializer.read(it) } catch (e: MalformedJSON) { null } },
            viewport = o["viewport"]?.let { try { BrowserViewportSerializer.read(it) } catch (e: MalformedJSON) { null } } ?: BrowserViewport.standard,
            openedAt = o["openedAt"].long() ?: 0,
        )
    }
}

/** The tabs of one owner, in the order they opened. */
@Serializable(with = BrowserTabGroupSerializer::class)
data class BrowserTabGroup(val owner: BrowserTabOwner, val tabs: List<BrowserTabInfo>) {
    val id: String
        get() = "${owner.kind.rawName}:${owner.id}"
}

/** Swift interpolates the case (`terminal`, `other("x")`); the group id is only a key. */
private val BrowserTabOwner.Kind.rawName: String
    get() = when (this) {
        BrowserTabOwner.Kind.You -> "you"
        BrowserTabOwner.Kind.Terminal -> "terminal"
        BrowserTabOwner.Kind.Task -> "task"
        is BrowserTabOwner.Kind.Other -> "other(\"$value\")"
    }

internal object BrowserTabGroupSerializer : TreeReader<BrowserTabGroup>() {
    override fun read(element: JsonElement): BrowserTabGroup {
        val o = element.obj() ?: throw MalformedJSON()
        val owner = BrowserTabOwnerSerializer.read(o["owner"] ?: throw MalformedJSON())
        val tabs = (o["tabs"] as? JsonArray ?: throw MalformedJSON()).map { BrowserTabInfoSerializer.read(it) }
        return BrowserTabGroup(owner, tabs)
    }
}

/** `GET /browser/tabs`: whether Chrome is up, and the tabs by owner (terminals', tasks', then yours). */
@Serializable(with = BrowserTabListSerializer::class)
data class BrowserTabList(val running: Boolean, val groups: List<BrowserTabGroup>) {
    val tabs: List<BrowserTabInfo> get() = groups.flatMap { it.tabs }

    /** Tabs whose agent waits for you: the tab's badge. */
    val waiting: Int get() = tabs.count { it.status == BrowserTabStatus.Waiting }

    /** Without one tab (closed here, before the next read). */
    fun removing(id: String): BrowserTabList =
        BrowserTabList(running, groups.map { BrowserTabGroup(it.owner, it.tabs.filter { t -> t.id != id }) }.filter { it.tabs.isNotEmpty() })

    /** With a tab of yours just opened, before the next read. */
    fun adding(tab: BrowserTabInfo): BrowserTabList {
        if (tabs.any { it.id == tab.id }) return this
        val i = groups.indexOfFirst { it.owner == tab.owner }
        if (i >= 0) {
            val next = groups.toMutableList()
            next[i] = BrowserTabGroup(groups[i].owner, groups[i].tabs + tab)
            return BrowserTabList(running = true, groups = next)
        }
        return BrowserTabList(running = true, groups = groups + BrowserTabGroup(tab.owner, listOf(tab)))
    }
}

internal object BrowserTabListSerializer : TreeReader<BrowserTabList>() {
    override fun read(element: JsonElement): BrowserTabList {
        val o = element.obj() ?: throw MalformedJSON()
        val groups = try {
            (o["groups"] as? JsonArray)?.map { BrowserTabGroupSerializer.read(it) }
        } catch (e: MalformedJSON) {
            null
        } ?: emptyList()
        return BrowserTabList(running = o["running"].bool() ?: false, groups = groups.filter { it.tabs.isNotEmpty() })
    }
}

/** A server listening on the Mac (`GET /browser/servers`): offered by the new-tab sheet. */
@Serializable(with = BrowserLocalServerSerializer::class)
class BrowserLocalServer(
    val port: Int,
    /** `loopback` or `all`. */
    val bind: String = "loopback",
    val pid: Int = 0,
    /** A short name: `vite`, `next-server`. */
    val name: String,
    val cwd: String,
    url: String? = null,
) {
    val url: String = url ?: "http://localhost:$port/"

    val id: Int get() = port

    override fun equals(other: Any?): Boolean =
        other is BrowserLocalServer && other.port == port && other.bind == bind && other.pid == pid && other.name == name &&
            other.cwd == cwd && other.url == url

    override fun hashCode(): Int = listOf(port, bind, pid, name, cwd, url).hashCode()
    override fun toString(): String = "BrowserLocalServer(port=$port, bind=$bind, pid=$pid, name=$name, cwd=$cwd, url=$url)"
}

internal object BrowserLocalServerSerializer : TreeReader<BrowserLocalServer>() {
    override fun read(element: JsonElement): BrowserLocalServer {
        val o = element.obj() ?: throw MalformedJSON()
        val port = o.required("port") { int() }
        return BrowserLocalServer(
            port = port,
            bind = o["bind"].string() ?: "loopback",
            pid = o["pid"].int() ?: 0,
            name = o["name"].string() ?: "",
            cwd = o["cwd"].string() ?: "",
            url = o["url"].string() ?: "http://localhost:$port/",
        )
    }
}

// MARK: - frames and events

/** One picture of a tab: a JPEG (or PNG) and how its pixels sit on the page (`scale` frame pixels per CSS pixel). */
class BrowserFrame(
    val seq: Int,
    val jpeg: ByteArray,
    val width: Double,
    val height: Double,
    scale: Double = 1.0,
    viewportWidth: Double? = null,
    viewportHeight: Double? = null,
) {
    val scale: Double = if (scale > 0) scale else 1.0

    /** The page's viewport in CSS pixels when it was drawn. */
    val viewportWidth: Double = viewportWidth ?: width
    val viewportHeight: Double = viewportHeight ?: height

    val size: Size get() = Size(width, height)

    /**
     * The page's own size (CSS pixels): the same page at another density (the Mac draws a tab's view at a scale, and
     * at the CSS size around an agent's clicks, docs/browser-v0.md §5) has another `size` but this one.
     */
    val pageSize: Size get() = Size(this.viewportWidth, this.viewportHeight)

    override fun equals(other: Any?): Boolean =
        other is BrowserFrame && other.seq == seq && other.jpeg.contentEquals(jpeg) && other.width == width && other.height == height &&
            other.scale == scale && other.viewportWidth == this.viewportWidth && other.viewportHeight == this.viewportHeight

    override fun hashCode(): Int = (seq * 31 + jpeg.contentHashCode()) * 31 + width.hashCode()
    override fun toString(): String = "BrowserFrame(seq=$seq, ${jpeg.size} bytes, ${width}x$height, scale=$scale)"
}

/** Why a hold ended or moved. */
enum class BrowserHeldReason(val rawValue: String) {
    Take("take"), HandBack("hand-back"), Idle("idle");

    companion object {
        fun fromRawValue(raw: String): BrowserHeldReason? = entries.firstOrNull { it.rawValue == raw }
    }
}

/** Why a tab's stream ended. */
sealed class BrowserClosedReason {
    data object Closed : BrowserClosedReason()
    data object BrowserExited : BrowserClosedReason()
    data object Shutdown : BrowserClosedReason()
    data class Other(val value: String) : BrowserClosedReason()

    /** What the page says, in formal Chinese (ui-v0 §4.1). */
    val said: String
        get() = when (this) {
            Closed -> "此标签已关闭。"
            BrowserExited -> "Mac 上的浏览器意外退出，标签已关闭。再次打开标签时浏览器会重新启动。"
            Shutdown -> "Mac 上的 AgentSwitch 服务已停止，标签已关闭。"
            is Other -> "此标签已关闭。"
        }

    companion object {
        /** Swift's `init(rawValue:)`. */
        operator fun invoke(rawValue: String): BrowserClosedReason = when (rawValue) {
            "closed" -> Closed
            "browser-exited" -> BrowserExited
            "shutdown" -> Shutdown
            else -> Other(rawValue)
        }
    }
}

/**
 * What a tab's stream brings (the SSE event names), plus `dropped`: the connection broke and is being made again
 * (said by the client, never by the Mac).
 */
sealed class BrowserEvent {
    data class Tab(val tab: BrowserTabInfo) : BrowserEvent()
    data class Frame(val frame: BrowserFrame) : BrowserEvent()
    data class Url(val url: String, val site: String, val kind: BrowserPlaceKind) : BrowserEvent()
    data class Title(val title: String) : BrowserEvent()
    data class Loading(val loading: Boolean) : BrowserEvent()
    data class Status(val status: BrowserTabStatus) : BrowserEvent()
    data class Held(val holder: String?, val reason: BrowserHeldReason?) : BrowserEvent()
    data class Action(val action: BrowserAgentAction?) : BrowserEvent()
    data class Viewport(val viewport: BrowserViewport) : BrowserEvent()
    data class Closed(val reason: BrowserClosedReason) : BrowserEvent()
    data object Dropped : BrowserEvent()

    companion object {
        /** One SSE message; null for an event this phone does not know or cannot read (skipped, the stream goes on). */
        fun parse(event: String, data: String): BrowserEvent? {
            val body = try {
                KitJson.parseToJsonElement(data) as? JsonObject
            } catch (e: Exception) {
                null
            }
            try {
                return when (event) {
                    "tab" -> Tab(BrowserTabInfoSerializer.read(body?.get("tab") ?: return null))
                    "frame" -> frame(body ?: return null)
                    "url" -> body?.let {
                        Url(it.required("url") { string() }, site = it.optional("site") { string() } ?: "",
                            kind = BrowserPlaceKind.from(it["kind"]))
                    }
                    "title" -> body?.let { Title(it.required("title") { string() }) }
                    "loading" -> body?.let { Loading(it.required("loading") { bool() }) }
                    "status" -> body?.let { Status(BrowserTabStatusSerializer.read(it["status"] ?: return null)) }
                    "held" -> body?.let { b ->
                        Held(b.optional("heldBy") { string() }, reason = b.optional("reason") { string() }?.let { BrowserHeldReason.fromRawValue(it) })
                    }
                    "action" -> body?.let { b ->
                        val a = b["action"]
                        Action(if (a == null || a is JsonNull) null else BrowserAgentActionSerializer.read(a))
                    }
                    "viewport" -> body?.let { Viewport(BrowserViewportSerializer.read(it["viewport"] ?: return null)) }
                    "closed" -> {
                        val reason = try { body?.optional("reason") { string() } } catch (e: MalformedJSON) { null }
                        Closed(BrowserClosedReason(reason ?: "closed"))
                    }
                    else -> null
                }
            } catch (e: MalformedJSON) {
                return null
            }
        }

        private fun frame(o: JsonObject): BrowserEvent? {
            val seq = o.required("seq") { int() }
            val data = o.required("data") { string() }
            val width = o.required("width") { double() }
            val height = o.required("height") { double() }
            val scale = o.optional("scale") { double() }
            val viewport = o.optional("viewport") { obj() }
            val vw = viewport?.required("width") { double() }
            val vh = viewport?.required("height") { double() }
            // Foundation's `Data(base64Encoded:)`: the standard alphabet, padded, nothing else.
            if (data.length % 4 != 0) return null
            val jpeg = try { java.util.Base64.getDecoder().decode(data) } catch (e: IllegalArgumentException) { return null }
            if (!(width > 0 && height > 0)) return null
            return Frame(BrowserFrame(seq = seq, jpeg = jpeg, width = width, height = height, scale = scale ?: 1.0,
                viewportWidth = vw, viewportHeight = vh))
        }
    }
}

// MARK: - input

/** A named key of the key bar (and the letters, for shortcuts): what `POST /browser/tabs/:id/input` takes. */
@Serializable
enum class BrowserKey(val rawValue: String) {
    @SerialName("Escape") Escape("Escape"), @SerialName("Tab") Tab("Tab"), @SerialName("Enter") Enter("Enter"),
    @SerialName("Backspace") Backspace("Backspace"), @SerialName("Delete") Delete("Delete"),
    @SerialName("ArrowLeft") ArrowLeft("ArrowLeft"), @SerialName("ArrowUp") ArrowUp("ArrowUp"),
    @SerialName("ArrowRight") ArrowRight("ArrowRight"), @SerialName("ArrowDown") ArrowDown("ArrowDown"),
    @SerialName("Home") Home("Home"), @SerialName("End") End("End"), @SerialName("PageUp") PageUp("PageUp"),
    @SerialName("PageDown") PageDown("PageDown"),
}

@Serializable
enum class BrowserMouseButton(val rawValue: String) {
    @SerialName("left") Left("left"), @SerialName("right") Right("right"), @SerialName("middle") Middle("middle"),
}

/** One input event, its point in pixels of frame `seq` (the picture it was aimed at). */
@Serializable(with = BrowserInputSerializer::class)
sealed class BrowserInput {
    data class Click(
        val x: Double,
        val y: Double,
        val button: BrowserMouseButton = BrowserMouseButton.Left,
        val clickCount: Int = 1,
        val seq: Int?,
    ) : BrowserInput()

    data class Wheel(val x: Double, val y: Double, val deltaX: Double, val deltaY: Double, val seq: Int?) : BrowserInput()

    /** Inserted as typed (`Input.insertText`): what the system keyboard committed, Chinese included. */
    data class Text(val text: String) : BrowserInput()

    data class Key(val key: BrowserKey) : BrowserInput()

    companion object {
        /** Whole tenths, and never a value JSON cannot carry. */
        internal fun rounded(v: Double): Double = if (v.isFinite()) (v * 10).roundedHalfAway() / 10 else 0.0
    }
}

internal object BrowserInputSerializer : KSerializer<BrowserInput> {
    override val descriptor: SerialDescriptor = JsonElement.serializer().descriptor
    override fun deserialize(decoder: Decoder): BrowserInput = throw UnsupportedOperationException("only sent")

    override fun serialize(encoder: Encoder, value: BrowserInput) {
        val c = LinkedHashMap<String, JsonElement>()
        when (value) {
            is BrowserInput.Click -> {
                c["type"] = JsonPrimitive("mouse")
                c["action"] = JsonPrimitive("click")
                c["x"] = jsonNumber(BrowserInput.rounded(value.x))
                c["y"] = jsonNumber(BrowserInput.rounded(value.y))
                c["button"] = JsonPrimitive(value.button.rawValue)
                c["clickCount"] = JsonPrimitive(minOf(maxOf(value.clickCount, 1), 3))
                value.seq?.let { c["seq"] = JsonPrimitive(it) }
            }
            is BrowserInput.Wheel -> {
                c["type"] = JsonPrimitive("wheel")
                c["x"] = jsonNumber(BrowserInput.rounded(value.x))
                c["y"] = jsonNumber(BrowserInput.rounded(value.y))
                c["deltaX"] = jsonNumber(BrowserInput.rounded(value.deltaX))
                c["deltaY"] = jsonNumber(BrowserInput.rounded(value.deltaY))
                value.seq?.let { c["seq"] = JsonPrimitive(it) }
            }
            is BrowserInput.Text -> {
                c["type"] = JsonPrimitive("text")
                c["text"] = JsonPrimitive(value.text)
            }
            is BrowserInput.Key -> {
                c["type"] = JsonPrimitive("key")
                c["key"] = JsonPrimitive(value.key.rawValue)
            }
        }
        encoder.encodeObject(c)
    }
}

/**
 * Input waiting to be sent, in order: consecutive wheel turns become one (the sum of their deltas, at the last point),
 * so a drag sends a few requests rather than one per touch move.
 */
class BrowserInputQueue {
    private val queue = ArrayList<BrowserInput>()

    val events: List<BrowserInput> get() = queue.toList()

    fun append(event: BrowserInput) {
        val last = queue.lastOrNull()
        if (event is BrowserInput.Wheel && last is BrowserInput.Wheel) {
            queue[queue.size - 1] = BrowserInput.Wheel(x = event.x, y = event.y, deltaX = last.deltaX + event.deltaX,
                deltaY = last.deltaY + event.deltaY, seq = event.seq)
        } else {
            queue.add(event)
        }
    }

    val isEmpty: Boolean get() = queue.isEmpty()

    /** The next request's events, taken off the queue. */
    fun next(): List<BrowserInput> {
        val out = queue.take(batch)
        repeat(out.size) { queue.removeAt(0) }
        return out
    }

    fun removeAll() = queue.clear()

    override fun equals(other: Any?): Boolean = other is BrowserInputQueue && other.queue == queue
    override fun hashCode(): Int = queue.hashCode()

    companion object {
        /** The most one request carries (the Mac takes 50). */
        const val batch = 50
    }
}

/** What a person opens: what was typed in the address bar, a path of the Mac's, or a local port. */
@Serializable(with = BrowserTargetSerializer::class)
sealed class BrowserTarget {
    data class Url(val value: String) : BrowserTarget()
    data class Path(val value: String) : BrowserTarget()
    data class Port(val value: Int) : BrowserTarget()
}

internal object BrowserTargetSerializer : KSerializer<BrowserTarget> {
    override val descriptor: SerialDescriptor = JsonElement.serializer().descriptor
    override fun deserialize(decoder: Decoder): BrowserTarget = throw UnsupportedOperationException("only sent")
    override fun serialize(encoder: Encoder, value: BrowserTarget) = encoder.encodeObject(fields(value))

    /** The one field of the target (`url`, `path` or `port`). */
    fun fields(value: BrowserTarget): Map<String, JsonElement> = when (value) {
        is BrowserTarget.Url -> mapOf("url" to JsonPrimitive(value.value))
        is BrowserTarget.Path -> mapOf("path" to JsonPrimitive(value.value))
        is BrowserTarget.Port -> mapOf("port" to JsonPrimitive(value.value))
    }
}

@Serializable
enum class BrowserHistoryAction(val rawValue: String) {
    @SerialName("back") Back("back"), @SerialName("forward") Forward("forward"), @SerialName("reload") Reload("reload"),
}

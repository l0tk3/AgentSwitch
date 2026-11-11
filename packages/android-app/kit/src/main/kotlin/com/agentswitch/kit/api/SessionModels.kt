package com.agentswitch.kit.api

import com.agentswitch.kit.feed.ModelName
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.SerializationException

// Lenient field reading for the models with a hand-written `init(from:)` (Swift's `try? decodeIfPresent`): a missing
// key, a null and a value of the wrong type all read as null. Shared by the files of this slice.

internal fun JsonObject.lenientString(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it !is JsonNull && it.isString }?.content

internal fun JsonObject.lenientBool(key: String): Boolean? =
    (this[key] as? JsonPrimitive)?.takeIf { it !is JsonNull && !it.isString }?.booleanOrNull

/** Swift's `Int64`: a whole number (a `3.0` counts, a `3.5` does not). */
internal fun JsonObject.lenientLong(key: String): Long? {
    val p = (this[key] as? JsonPrimitive)?.takeIf { it !is JsonNull && !it.isString } ?: return null
    p.longOrNull?.let { return it }
    val d = p.doubleOrNull ?: return null
    return if (d.isFinite() && d == Math.rint(d) && Math.abs(d) < 9.2e18) d.toLong() else null
}

internal fun JsonObject.lenientDouble(key: String): Double? =
    (this[key] as? JsonPrimitive)?.takeIf { it !is JsonNull && !it.isString }?.doubleOrNull

internal fun JsonObject.lenientInt(key: String): Int? = lenientLong(key)?.takeIf { it in Int.MIN_VALUE..Int.MAX_VALUE }?.toInt()

internal fun Decoder.jsonObject(what: String): JsonObject =
    ((this as? JsonDecoder) ?: throw SerializationException("$what reads JSON only")).decodeJsonElement() as? JsonObject
        ?: throw SerializationException("$what is not an object")

internal fun JsonObject.requireString(key: String): String =
    (this[key] as? JsonPrimitive)?.takeIf { it !is JsonNull && it.isString }?.content
        ?: throw SerializationException("$key missing or not a string")

internal fun Encoder.encodeObject(map: Map<String, JsonElement>) {
    ((this as? JsonEncoder) ?: throw SerializationException("JSON only")).encodeJsonElement(JsonObject(map))
}

/**
 * A coding session on the Mac, outside AgentSwitch (control-v0 §3): Claude Code, Codex or OpenCode, read from their own
 * local records by the daemon. Every field but the harness and id is optional on the wire, so one odd record never
 * empties the list.
 */
@Serializable(with = SessionSummarySerializer::class)
data class SessionSummary(
    val harness: String,
    /** The wire's `id` (Swift's init labels it `id`; its `id` property is the unique [id] below). */
    val sessionId: String,
    val cwd: String,
    val title: String,
    val lastText: String = "",
    val updatedAt: Long,
    /** When it began (its record was made; an older Mac does not say): the tree's fixed order. */
    val startedAt: Long? = null,
    /** Updated within the last 90 seconds (the daemon decides). */
    val active: Boolean = false,
    /** Codex's originator: desktop, command line, editor. */
    val origin: String? = null,
    val branch: String? = null,
    val model: String? = null,
    /** How it last asked before acting (manual · auto · bypass), when the record says: resuming keeps it. */
    val mode: String? = null,
    /** The session this one was forked from. */
    val forkedFrom: String? = null,
    /**
     * The profile it last ran under, by its id, when that is not the Mac's own (docs/profiles-v0.md §3.3): where it
     * goes on unless another is chosen.
     */
    val profile: String? = null,
) {
    /** Unique across harnesses (two tools could reuse an id). */
    val id: String get() = "$harness/$sessionId"

    /**
     * One record of the list: a Codex session's id can stand for several records, each with its own title and times
     * (the Mac lists them all), so a row is told from its twins by when it began and was last written (2026-10-05:
     * the Mac's native list drew such rows empty).
     */
    val recordID: String get() = "$id@${startedAt ?: 0}-$updatedAt"

    /** [updatedAt], milliseconds since 1970. */
    val updated: Long get() = updatedAt
    val harnessName: String get() = ModelName.harness(harness)

    /** The title, else the start of the last text, else a plain placeholder. */
    val displayTitle: String
        get() {
            // Swift: split(separator: "\n") drops empty pieces; trimming whitespace only as .whitespaces (no newlines).
            val firstLine = { s: String -> s.splitNewlines().firstOrNull()?.trim { it.isHorizontalSpace() } ?: "" }
            val t = firstLine(title)
            if (t.isNotEmpty()) return t
            val last = firstLine(lastText)
            return last.ifEmpty { "未命名会话" }
        }
}

/** Foundation's `CharacterSet.whitespaces`: space, tab and the Unicode space separators. */
internal fun Char.isHorizontalSpace(): Boolean =
    this == ' ' || this == '\t' || Character.getType(this) == Character.SPACE_SEPARATOR.toInt()

object SessionSummarySerializer : KSerializer<SessionSummary> {
    override val descriptor: SerialDescriptor = JsonElement.serializer().descriptor

    override fun deserialize(decoder: Decoder): SessionSummary {
        val o = decoder.jsonObject("SessionSummary")
        return SessionSummary(
            harness = o.requireString("harness"),
            sessionId = o.requireString("id"),
            cwd = o.lenientString("cwd") ?: "",
            title = o.lenientString("title") ?: "",
            lastText = o.lenientString("lastText") ?: "",
            // A file's mtime in milliseconds may carry a fraction (older Macs send it as is).
            updatedAt = o.lenientLong("updatedAt") ?: o.lenientDouble("updatedAt")?.let { Math.round(it) } ?: 0,
            startedAt = o.lenientLong("startedAt"),
            active = o.lenientBool("active") ?: false,
            origin = o.lenientString("origin"),
            branch = o.lenientString("branch"),
            model = o.lenientString("model"),
            mode = o.lenientString("mode"),
            forkedFrom = o.lenientString("forkedFrom"),
            profile = o.lenientString("profile")?.takeIf { it.isNotEmpty() },
        )
    }

    override fun serialize(encoder: Encoder, value: SessionSummary) {
        val m = linkedMapOf<String, JsonElement>(
            "harness" to JsonPrimitive(value.harness), "id" to JsonPrimitive(value.sessionId), "cwd" to JsonPrimitive(value.cwd),
            "title" to JsonPrimitive(value.title), "lastText" to JsonPrimitive(value.lastText),
            "updatedAt" to JsonPrimitive(value.updatedAt), "active" to JsonPrimitive(value.active),
        )
        value.startedAt?.let { m["startedAt"] = JsonPrimitive(it) }
        value.origin?.let { m["origin"] = JsonPrimitive(it) }
        value.branch?.let { m["branch"] = JsonPrimitive(it) }
        value.model?.let { m["model"] = JsonPrimitive(it) }
        value.mode?.let { m["mode"] = JsonPrimitive(it) }
        value.forkedFrom?.let { m["forkedFrom"] = JsonPrimitive(it) }
        value.profile?.let { m["profile"] = JsonPrimitive(it) }
        encoder.encodeObject(m)
    }
}

/** One message of a session's transcript. */
@Serializable(with = SessionMessageSerializer::class)
data class SessionMessage(
    val role: Role,
    val text: String,
    /** Milliseconds since 1970. */
    val ts: Long,
    /** The tool's name, for `tool` messages. */
    val tool: String? = null,
) {
    enum class Role(val rawValue: String) {
        User("user"), Assistant("assistant"), Tool("tool"), Other("other");

        companion object {
            /** `Role(rawValue:)`: null for a word not known. */
            fun fromRaw(raw: String): Role? = entries.firstOrNull { it.rawValue == raw }
        }
    }

    /** [ts], milliseconds since 1970. */
    val date: Long get() = ts
}

object SessionMessageSerializer : KSerializer<SessionMessage> {
    override val descriptor: SerialDescriptor = JsonElement.serializer().descriptor

    override fun deserialize(decoder: Decoder): SessionMessage {
        val o = decoder.jsonObject("SessionMessage")
        return SessionMessage(
            role = SessionMessage.Role.fromRaw(o.lenientString("role") ?: "") ?: SessionMessage.Role.Other,
            text = o.lenientString("text") ?: "",
            ts = o.lenientLong("ts") ?: 0,
            tool = o.lenientString("tool"),
        )
    }

    override fun serialize(encoder: Encoder, value: SessionMessage) {
        val m = linkedMapOf<String, JsonElement>(
            "role" to JsonPrimitive(value.role.rawValue), "text" to JsonPrimitive(value.text), "ts" to JsonPrimitive(value.ts),
        )
        value.tool?.let { m["tool"] = JsonPrimitive(it) }
        encoder.encodeObject(m)
    }
}

/** `GET /sessions/:harness/:id`: the session and its latest messages, oldest first. */
@Serializable(with = SessionDetailSerializer::class)
data class SessionDetail(
    val session: SessionSummary,
    val messages: List<SessionMessage>,
)

object SessionDetailSerializer : KSerializer<SessionDetail> {
    override val descriptor: SerialDescriptor = JsonElement.serializer().descriptor

    override fun deserialize(decoder: Decoder): SessionDetail {
        val json = (decoder as? JsonDecoder) ?: throw SerializationException("SessionDetail reads JSON only")
        val o = json.decodeJsonElement() as? JsonObject ?: throw SerializationException("SessionDetail is not an object")
        val session = json.json.decodeFromJsonElement(SessionSummary.serializer(), o["session"] ?: throw SerializationException("session missing"))
        val messages = (o["messages"] as? JsonArray)?.let {
            try {
                json.json.decodeFromJsonElement(ListSerializer(SessionMessage.serializer()), it)
            } catch (_: SerializationException) {
                null
            }
        } ?: emptyList()
        return SessionDetail(session, messages.sortedBy { it.ts })
    }

    override fun serialize(encoder: Encoder, value: SessionDetail) {
        val json = (encoder as? JsonEncoder) ?: throw SerializationException("JSON only")
        json.encodeJsonElement(JsonObject(mapOf(
            "session" to json.json.encodeToJsonElement(SessionSummary.serializer(), value.session),
            "messages" to json.json.encodeToJsonElement(ListSerializer(SessionMessage.serializer()), value.messages),
        )))
    }
}

@Serializable
internal data class SessionList(val sessions: List<SessionSummary>)

/**
 * The sessions screen's order: one group per folder, the folder with the latest activity first, each group newest
 * first.
 */
object SessionGroups {
    data class Group(val folder: String, val sessions: List<SessionSummary>) {
        val id: String get() = folder
    }

    fun grouped(sessions: List<SessionSummary>): List<Group> {
        val newestFirst = sessions.sortedWith(compareByDescending<SessionSummary> { it.updatedAt }.thenByDescending { it.id })
        val order = mutableListOf<String>()
        val byFolder = mutableMapOf<String, MutableList<SessionSummary>>()
        for (session in newestFirst) {
            if (byFolder[session.cwd] == null) order.add(session.cwd)
            byFolder.getOrPut(session.cwd) { mutableListOf() }.add(session)
        }
        return order.map { Group(it, byFolder[it] ?: emptyList()) }
    }
}

/** A value decoded from the JSON under [key]; null when it is missing, null or does not decode (Swift's `try? decodeIfPresent`). */
internal fun <T> JsonObject.lenient(key: String, serializer: KSerializer<T>): T? {
    val element = this[key]?.takeIf { it !is JsonNull } ?: return null
    return try {
        com.agentswitch.kit.support.KitJson.decodeFromJsonElement(serializer, element)
    } catch (_: SerializationException) {
        null
    } catch (_: IllegalArgumentException) {
        null
    }
}

/** A type Swift only decodes (`Decodable`): read by [read] from a JSON object; writing it is not supported. */
internal abstract class ObjectReader<T>(private val what: String) : KSerializer<T> {
    override val descriptor: SerialDescriptor = JsonElement.serializer().descriptor
    abstract fun read(o: JsonObject): T
    override fun deserialize(decoder: Decoder): T = read(decoder.jsonObject(what))
    override fun serialize(encoder: Encoder, value: T) = throw SerializationException("$what is only read, never sent")
}

/**
 * Swift's `split(separator: "\n")`, empty pieces left out: a "\r\n" is one `Character` in Swift and no "\n", so a line
 * end of that kind does not split.
 */
internal fun String.splitNewlines(): List<String> = split(Regex("(?<!\r)\n")).filter { it.isNotEmpty() }

/** Unicode's White_Space, which is what Swift's `Character.isWhitespace` tests (Java's own differs at U+0085 and U+001C..1F). */
internal fun Char.isUnicodeWhitespace(): Boolean =
    this in '\u0009'..'\u000D' || this == ' ' || this == '\u0085' || this == '\u00A0' || this == '\u1680' ||
        this in '\u2000'..'\u200A' || this == '\u2028' || this == '\u2029' || this == '\u202F' || this == '\u205F' || this == '\u3000'

/** C's `printf("%.{digits}f")`: the exact binary value rounded, ties to even (Java's formatter rounds ties up). */
internal fun Double.cFixed(digits: Int): String =
    java.math.BigDecimal(this).setScale(digits, java.math.RoundingMode.HALF_EVEN).toPlainString()

/** A field Swift reads with `try c.decodeIfPresent(Int64.self…)`: missing or null is absent, the wrong type fails. */
internal fun JsonObject.strictLong(key: String): Long? {
    val v = this[key] ?: return null
    if (v is JsonNull) return null
    return lenientLong(key) ?: throw SerializationException("$key is not an integer")
}

internal fun JsonObject.strictInt(key: String): Int? {
    val v = this[key] ?: return null
    if (v is JsonNull) return null
    return lenientInt(key) ?: throw SerializationException("$key is not an integer")
}

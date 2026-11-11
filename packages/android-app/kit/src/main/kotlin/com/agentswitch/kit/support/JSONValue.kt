package com.agentswitch.kit.support

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
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

/**
 * Any JSON value. Event payloads and a few loosely typed daemon fields (`decision`, quota `detail`) decode into it,
 * so a new field on the daemon never breaks the phone.
 */
@Serializable(with = JSONValueSerializer::class)
sealed class JSONValue {
    data object Null : JSONValue()
    data class Bool(val value: Boolean) : JSONValue()
    data class Number(val value: Double) : JSONValue()
    data class Str(val value: String) : JSONValue()
    data class Array(val value: List<JSONValue>) : JSONValue()
    data class Object(val value: Map<String, JSONValue>) : JSONValue()

    operator fun get(key: String): JSONValue? = (this as? Object)?.value?.get(key)

    val string: String? get() = (this as? Str)?.value
    val number: Double? get() = (this as? Number)?.value

    /** A whole number that fits an `Int`; a count or an index. Timestamps, sizes and sequence numbers: [long]. */
    val int: Int? get() = long?.takeIf { it in Int.MIN_VALUE..Int.MAX_VALUE }?.toInt()

    /** A whole number; null for one with a fraction or beyond what a double holds exactly as a `Long`. */
    val long: Long? get() = number?.takeIf { it.isFinite() && it == Math.rint(it) && Math.abs(it) < 9.2e18 }?.toLong()
    val bool: Boolean? get() = (this as? Bool)?.value
    val array: List<JSONValue>? get() = (this as? Array)?.value
    val `object`: Map<String, JSONValue>? get() = (this as? Object)?.value
    val isNull: Boolean get() = this is Null

    /** Compact JSON text with sorted keys, for "show the raw payload" lines. */
    val compactText: String get() = StringBuilder().also { write(it) }.toString()

    private fun write(out: StringBuilder) {
        when (this) {
            is Null -> out.append("null")
            is Bool -> out.append(value)
            is Number -> out.append(numberText(value))
            is Str -> out.append(JsonPrimitive(value).toString())
            is Array -> {
                out.append('[')
                value.forEachIndexed { i, v -> if (i > 0) out.append(','); v.write(out) }
                out.append(']')
            }
            is Object -> {
                out.append('{')
                value.keys.sorted().forEachIndexed { i, k ->
                    if (i > 0) out.append(',')
                    out.append(JsonPrimitive(k).toString()).append(':')
                    value.getValue(k).write(out)
                }
                out.append('}')
            }
        }
    }

    companion object {
        /** A whole number without a fraction (`3`, not `3.0`), as the Mac wrote it. */
        internal fun numberText(n: Double): String =
            if (n.isFinite() && n == Math.rint(n) && Math.abs(n) < 1e15) n.toLong().toString() else n.toString()

        fun from(element: JsonElement): JSONValue = when (element) {
            is JsonNull -> Null
            is JsonPrimitive -> when {
                element.isString -> Str(element.content)
                element.booleanOrNull != null -> Bool(element.booleanOrNull!!)
                else -> element.doubleOrNull?.let { Number(it) } ?: Str(element.content)
            }
            is JsonArray -> Array(element.map { from(it) })
            is JsonObject -> Object(element.mapValues { from(it.value) })
        }
    }

    fun toElement(): JsonElement = when (this) {
        is Null -> JsonNull
        is Bool -> JsonPrimitive(value)
        is Number -> if (value.isFinite() && value == Math.rint(value) && Math.abs(value) < 1e15) JsonPrimitive(value.toLong()) else JsonPrimitive(value)
        is Str -> JsonPrimitive(value)
        is Array -> JsonArray(value.map { it.toElement() })
        is Object -> JsonObject(value.mapValues { it.value.toElement() })
    }
}

object JSONValueSerializer : KSerializer<JSONValue> {
    override val descriptor: SerialDescriptor = JsonElement.serializer().descriptor

    override fun deserialize(decoder: Decoder): JSONValue {
        val json = decoder as? JsonDecoder ?: error("JSONValue reads JSON only")
        return JSONValue.from(json.decodeJsonElement())
    }

    override fun serialize(encoder: Encoder, value: JSONValue) {
        val json = encoder as? JsonEncoder ?: error("JSONValue writes JSON only")
        json.encodeJsonElement(value.toElement())
    }
}

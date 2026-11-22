package com.agentswitch.kit

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** The Swift tests build JSON from dictionaries (`JSONSerialization`); this does the same from maps, lists and primitives. */
internal fun mapToJsonElement(value: Any?): JsonElement = when (value) {
    null -> JsonNull
    is JsonElement -> value
    is Boolean -> JsonPrimitive(value)
    is Number -> JsonPrimitive(value)
    is String -> JsonPrimitive(value)
    is Map<*, *> -> JsonObject(value.entries.associate { (k, v) -> k as String to mapToJsonElement(v) })
    is List<*> -> JsonArray(value.map { mapToJsonElement(it) })
    else -> error("not JSON: $value")
}

internal fun mapToJsonText(value: Any?): String = mapToJsonElement(value).toString()

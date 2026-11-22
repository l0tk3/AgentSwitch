package com.agentswitch.kit.api

import com.agentswitch.kit.support.KitJson
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/**
 * What an agent is writing at the moment (docs/simple-view-v0.md §5.14): the part of its answer being written, its
 * whole text so far, and whether it is what it thinks on the way. Shown while it is written and gone once the part is
 * in the record (a terminal) or the task's events (a task); never stored. The service sends it as a `writing` event:
 * `{text, thinking?}`, or `{done: true}` once nothing is being written.
 */
data class AgentWriting(
    val text: String,
    val thinking: Boolean = false,
) {
    companion object {
        /** A `writing` event's data: what is written now, or null when nothing is (`done`, or not one). */
        fun decode(data: String): AgentWriting? {
            val obj = try {
                KitJson.parseToJsonElement(data) as? JsonObject
            } catch (_: Exception) {
                null
            } ?: return null
            // As Swift's Decodable body: a field of the wrong type fails the whole decode; null counts as absent.
            fun field(key: String): JsonPrimitive? {
                val v = obj[key] ?: return null
                if (v is JsonNull) return null
                return v as? JsonPrimitive ?: throw BadField()
            }
            return try {
                val text = field("text")?.let { if (it.isString) it.content else throw BadField() }
                val thinking = field("thinking")?.let { it.booleanOrNull?.takeIf { _ -> !it.isString } ?: throw BadField() }
                val done = field("done")?.let { it.booleanOrNull?.takeIf { _ -> !it.isString } ?: throw BadField() }
                if (done == true || text == null || text.isEmpty()) null else AgentWriting(text, thinking ?: false)
            } catch (_: BadField) {
                null
            }
        }

        private class BadField : Exception()
    }
}

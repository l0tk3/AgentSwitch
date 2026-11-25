package com.agentswitch.kit.api

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * `GET /settings/workdir` (control-v0 §2): where a task without a folder works. `default` is read either way the
 * daemon may send it: the default path, or whether `path` is the default.
 */
@Serializable(with = WorkdirSettingSerializer::class)
class WorkdirSetting(
    val path: String,
    val defaultPath: String? = null,
    isDefault: Boolean = false,
    /** Why the folder cannot be used right now (missing, not writable…); null when it can. */
    val problem: String? = null,
) {
    val isDefault: Boolean = isDefault || defaultPath == path

    override fun equals(other: Any?): Boolean =
        other is WorkdirSetting && other.path == path && other.defaultPath == defaultPath && other.isDefault == isDefault && other.problem == problem

    override fun hashCode(): Int = listOf(path, defaultPath, isDefault, problem).hashCode()
    override fun toString(): String = "WorkdirSetting(path=$path, defaultPath=$defaultPath, isDefault=$isDefault, problem=$problem)"
}

internal object WorkdirSettingSerializer : ObjectReader<WorkdirSetting>("WorkdirSetting") {
    override fun read(o: JsonObject): WorkdirSetting {
        val path = o.requireString("path")
        val fallback = o["default"]
        val problem = o.lenientString("problem")?.takeIf { it.isNotEmpty() }
        return WorkdirSetting(path, (fallback as? JsonPrimitive)?.takeIf { it !is JsonNull && it.isString }?.content, o.lenientBool("default") ?: false, problem)
    }
}

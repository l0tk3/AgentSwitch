package com.agentswitch.kit.api

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
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * The permission mode (control-v0 §1, daemon engine/approvalPolicy.ts). The phone only shows it: it is changed on the
 * Mac. A mode added later decodes as [Other] instead of failing the settings page.
 */
@Serializable(with = PermissionModeSerializer::class)
sealed class PermissionMode {
    data object Manual : PermissionMode()
    data object Scoped : PermissionMode()
    data object Auto : PermissionMode()
    data object Skip : PermissionMode()
    data class Other(val value: String) : PermissionMode()

    val rawValue: String
        get() = when (this) {
            Manual -> "manual"
            Scoped -> "scoped"
            Auto -> "auto"
            Skip -> "skip"
            is Other -> value
        }

    /** The words of the Mac's picker (control-v0 §1). */
    val label: String
        get() = when (this) {
            Manual -> "Ask Each"
            Scoped -> "Auto"
            Auto -> "All Auto"
            Skip -> "Bypass"
            is Other -> value
        }

    /** What the mode means for you, one sentence without the full stop (the settings footer adds where to change it). */
    val explanation: String
        get() = when (this) {
            Manual -> "执行器的每项操作均需你确认"
            Scoped -> "由调度模型代为审批，删除、推送、付款仍需你确认"
            Auto -> "由调度模型代为处理所有审批"
            Skip -> "审批自动通过；受保护的目录仍禁止访问，提问仍需你回答"
            is Other -> "此 Mac 使用了当前版本无法识别的权限模式"
        }

    companion object {
        /** `PermissionMode(rawValue:)`: the case of that wire word, [Other] for one not known. */
        operator fun invoke(rawValue: String): PermissionMode = when (rawValue) {
            "manual" -> Manual
            "scoped" -> Scoped
            "auto" -> Auto
            "skip" -> Skip
            else -> Other(rawValue)
        }
    }
}

object PermissionModeSerializer : KSerializer<PermissionMode> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("PermissionMode", PrimitiveKind.STRING)
    override fun deserialize(decoder: Decoder): PermissionMode = PermissionMode(decoder.decodeString())
    override fun serialize(encoder: Encoder, value: PermissionMode) = encoder.encodeString(value.rawValue)
}

/** daemon engine/approvalPolicy.ts ApprovalPolicy, as `GET /approvals/policy` returns it. */
@Serializable(with = ApprovalPolicySerializer::class)
data class ApprovalPolicy(
    val mode: PermissionMode,
    /** Categories that stay with you in `scoped` mode. */
    val human: List<String> = emptyList(),
)

internal object ApprovalPolicySerializer : ObjectReader<ApprovalPolicy>("ApprovalPolicy") {
    override fun read(o: JsonObject): ApprovalPolicy {
        // `decodeIfPresent(PermissionMode.self) ?? .scoped`: absent or null is scoped; a value that is no string throws.
        val mode = o["mode"]?.takeIf { it !is JsonNull }?.let { PermissionMode(strictString(it, "mode")) } ?: PermissionMode.Scoped
        return ApprovalPolicy(mode, o.lenient("human", ListSerializer(String.serializer())) ?: emptyList())
    }

    private fun strictString(element: kotlinx.serialization.json.JsonElement, key: String): String =
        (element as? JsonPrimitive)?.takeIf { it.isString }?.content ?: throw SerializationException("$key is not a string")
}

@Serializable
data class PolicyCategory(
    val id: String,
    val title: String,
)

/** `GET /approvals/policy`. */
@Serializable(with = ApprovalPolicyInfoSerializer::class)
data class ApprovalPolicyInfo(
    val policy: ApprovalPolicy,
    val categories: List<PolicyCategory> = emptyList(),
) {
    /** The categories kept for you, by title (scoped mode's "删除、推送…"). */
    val humanTitles: List<String>
        get() = policy.human.map { id -> categories.firstOrNull { it.id == id }?.title ?: id }
}

internal object ApprovalPolicyInfoSerializer : ObjectReader<ApprovalPolicyInfo>("ApprovalPolicyInfo") {
    override fun read(o: JsonObject): ApprovalPolicyInfo {
        val policy = o["policy"]?.let { com.agentswitch.kit.support.KitJson.decodeFromJsonElement(ApprovalPolicy.serializer(), it) }
            ?: throw SerializationException("policy missing")
        return ApprovalPolicyInfo(policy, o.lenient("categories", ListSerializer(PolicyCategory.serializer())) ?: emptyList())
    }
}

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

/** One hit of `GET /search` (control-v0 §4); `snippet` marks the matches with ⟦ and ⟧. */
@Serializable(with = SearchResultSerializer::class)
data class SearchResult(
    val taskId: String,
    val title: String,
    val snippet: String,
    val status: TaskStatus,
    /** Milliseconds since 1970. */
    val updatedAt: Long,
) {
    val id: String get() = taskId

    /** [updatedAt], milliseconds since 1970. */
    val updated: Long get() = updatedAt
}

internal object SearchResultSerializer : ObjectReader<SearchResult>("SearchResult") {
    override fun read(o: JsonObject): SearchResult = SearchResult(
        taskId = o.requireString("taskId"),
        title = o.lenientString("title") ?: "",
        snippet = o.lenientString("snippet") ?: "",
        status = o.lenientString("status")?.let { TaskStatus(it) } ?: TaskStatus.Other(""),
        updatedAt = o.lenientLong("updatedAt") ?: 0,
    )
}

@Serializable
internal data class SearchResults(val results: List<SearchResult>)

/** `POST /tasks/:id/ack`: whatever the daemon answers, the time it recorded if it says (top level or in `task`). */
@Serializable(with = AckReplySerializer::class)
internal data class AckReply(val acknowledgedAt: Long?)

internal object AckReplySerializer : ObjectReader<AckReply>("AckReply") {
    override fun read(o: JsonObject): AckReply {
        val top = o.lenientLong("acknowledgedAt")
        val nested = (o["task"] as? JsonObject)?.lenientDouble("acknowledgedAt")?.takeIf { it.isFinite() }?.toLong()
        return AckReply(top ?: nested)
    }
}

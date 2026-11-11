package com.agentswitch.kit.api

import com.agentswitch.kit.pairing.GateKey
import com.agentswitch.kit.support.JSONValue
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

/** One model on one harness (daemon core/target.ts). */
@Serializable
data class TargetRef(
    val harness: String,
    val model: String,
) {
    val label: String get() = "$harness/$model"
}

/** `GET /healthz`. The remote listener answers only `{ok:true}`; the local one adds version and counts. */
@Serializable
data class Health(
    val ok: Boolean,
    val version: String? = null,
)

/** `POST /pair` response. */
@Serializable
data class PairResult(
    val deviceId: String,
    val token: String,
)

/** `GET /addresses`: where the Mac can be reached now. */
@Serializable
data class MacAddresses(
    val lan: List<String>,
    val tailnet: List<String>,
)

/** `GET /me`. app-v0 does not fix the shape yet; every field is optional and `id`/`deviceId` both count. */
@Serializable(with = MeSerializer::class)
data class Me(
    val deviceId: String?,
    val name: String?,
    val platform: String?,
    val createdAt: Long?,
    val lastSeenAt: Long?,
)

@Serializable
private class MeWire(
    val deviceId: String? = null,
    val id: String? = null,
    val name: String? = null,
    val platform: String? = null,
    val createdAt: Long? = null,
    val lastSeenAt: Long? = null,
)

object MeSerializer : KSerializer<Me> {
    override val descriptor: SerialDescriptor = MeWire.serializer().descriptor

    override fun deserialize(decoder: Decoder): Me {
        val w = MeWire.serializer().deserialize(decoder)
        return Me(w.deviceId ?: w.id, w.name, w.platform, w.createdAt, w.lastSeenAt)
    }

    override fun serialize(encoder: Encoder, value: Me) =
        MeWire.serializer().serialize(encoder, MeWire(value.deviceId, null, value.name, value.platform, value.createdAt, value.lastSeenAt))
}

/** `GET /gate/pubkey`. */
typealias GatePubkey = GateKey

/** quota/types.ts QuotaReading. */
@Serializable
data class QuotaReading(
    val harness: String,
    /** Fraction left, 0...1; null when unknown. */
    val remaining: Double? = null,
    val detail: JSONValue? = null,
    val source: String,
    /** Milliseconds since 1970. */
    val fetchedAt: Long,
    val error: String? = null,
) {
    val id: String get() = harness

    /** [fetchedAt], milliseconds since 1970. */
    val fetched: Long get() = fetchedAt
}

/** router/targets.ts ModelSpec. */
@Serializable
data class ModelSpec(
    val cost: String,
    val strengths: List<String>? = null,
    val efforts: List<String>? = null,
    val unavailable: Boolean? = null,
)

/** router/targets.ts HarnessSpec, the fields the phone shows. */
@Serializable
data class HarnessSpec(
    val quota: String,
    @SerialName("max_concurrent") val maxConcurrent: Int,
    val browser: Boolean,
    @SerialName("default_model") val defaultModel: String,
    val models: Map<String, ModelSpec>,
)

@Serializable
data class RouterSpec(
    val harness: String,
    val model: String,
    @SerialName("default") val defaultTarget: TargetRef? = null,
    val planner: TargetRef? = null,
)

/** `GET /targets`: the catalog plus `quota` (harness → fraction left). */
@Serializable
data class Targets(
    val harnesses: Map<String, HarnessSpec>,
    val router: RouterSpec? = null,
    val quota: Map<String, Double>? = null,
) {
    /** What a task can be pinned to: every listed model not marked unavailable, sorted by harness then model. */
    val pinOptions: List<TargetRef>
        get() = harnesses.keys.sorted().flatMap { name ->
            val spec = harnesses.getValue(name)
            spec.models.keys.sorted().filter { spec.models[it]?.unavailable != true }.map { TargetRef(name, it) }
        }
}

/** threads/types.ts Thread plus the folded fields `GET /threads` adds. Times are ms since 1970. */
@Serializable
data class AgentThread(
    val id: String,
    val createdAt: Long,
    val updatedAt: Long,
    val title: String? = null,
    val cwd: String? = null,
    val status: String,
    val expiresAt: Long? = null,
    val lastTarget: TargetRef? = null,
    val lastActivity: Long? = null,
    val taskCount: Int? = null,
    val handoffs: Int? = null,
)

/** The summarizer's view of a thread (threads-v0 §3), the part the phone shows. */
@Serializable
data class ThreadSummary(
    val title: String? = null,
    val goal: String? = null,
    val progress: String? = null,
)

/** `GET /threads/:id`: the thread, its latest summary and its tasks. The wire object is the thread with both. */
@Serializable(with = ThreadDetailSerializer::class)
data class ThreadDetail(
    val thread: AgentThread,
    val summary: ThreadSummary?,
    val tasks: List<AgentTask>,
)

object ThreadDetailSerializer : KSerializer<ThreadDetail> {
    override val descriptor: SerialDescriptor = JsonElement.serializer().descriptor

    override fun deserialize(decoder: Decoder): ThreadDetail {
        val json = (decoder as? JsonDecoder) ?: error("ThreadDetail reads JSON only")
        val obj = json.decodeJsonElement().jsonObject
        val thread = json.json.decodeFromJsonElement(AgentThread.serializer(), obj)
        // `try?`: a summary of a shape the phone does not know is none.
        val summary = obj["summary"]?.takeIf { it !is JsonNull }?.let {
            try {
                json.json.decodeFromJsonElement(ThreadSummary.serializer(), it)
            } catch (_: IllegalArgumentException) {
                null
            }
        }
        val tasks = obj["tasks"]?.takeIf { it !is JsonNull }
            ?.let { json.json.decodeFromJsonElement(ListSerializer(AgentTask.serializer()), it) } ?: emptyList()
        return ThreadDetail(thread, summary, tasks)
    }

    override fun serialize(encoder: Encoder, value: ThreadDetail) {
        val json = (encoder as? JsonEncoder) ?: error("ThreadDetail writes JSON only")
        val out = json.json.encodeToJsonElement(AgentThread.serializer(), value.thread).jsonObject.toMutableMap()
        value.summary?.let { out["summary"] = json.json.encodeToJsonElement(ThreadSummary.serializer(), it) }
        out["tasks"] = json.json.encodeToJsonElement(ListSerializer(AgentTask.serializer()), value.tasks)
        json.encodeJsonElement(JsonObject(out))
    }
}

// MARK: - request bodies (the daemon takes snake_case in bodies)

/** `POST /tasks`. An empty `attachments` list is left out of the body, as Swift does. */
@Serializable(with = NewTaskRequestSerializer::class)
class NewTaskRequest(
    val task: String,
    val pin: TargetRef? = null,
    val threadId: String? = null,
    val parentId: String? = null,
    /** Ids from `POST /uploads`; the files land in the task's `in/`. */
    attachments: List<String>? = null,
) {
    val attachments: List<String>? = if (attachments?.isEmpty() == true) null else attachments

    override fun equals(other: Any?): Boolean = other is NewTaskRequest && task == other.task && pin == other.pin &&
        threadId == other.threadId && parentId == other.parentId && attachments == other.attachments

    override fun hashCode(): Int = listOf(task, pin, threadId, parentId, attachments).hashCode()
}

@Serializable
private class NewTaskRequestWire(
    val task: String,
    val pin: TargetRef? = null,
    @SerialName("thread_id") val threadId: String? = null,
    @SerialName("parent_id") val parentId: String? = null,
    val attachments: List<String>? = null,
)

object NewTaskRequestSerializer : KSerializer<NewTaskRequest> {
    override val descriptor: SerialDescriptor = NewTaskRequestWire.serializer().descriptor
    override fun deserialize(decoder: Decoder): NewTaskRequest {
        val w = NewTaskRequestWire.serializer().deserialize(decoder)
        return NewTaskRequest(w.task, w.pin, w.threadId, w.parentId, w.attachments)
    }
    override fun serialize(encoder: Encoder, value: NewTaskRequest) = NewTaskRequestWire.serializer()
        .serialize(encoder, NewTaskRequestWire(value.task, value.pin, value.threadId, value.parentId, value.attachments))
}

@Serializable
enum class ApprovalDecision {
    @SerialName("allow") Allow,
    @SerialName("deny") Deny;

    val rawValue: String get() = if (this == Allow) "allow" else "deny"
}

@Serializable
data class ApproveRequest(
    @SerialName("approval_id") val approvalId: String,
    val decision: ApprovalDecision,
)

@Serializable
data class AnswerRequest(
    @SerialName("approval_id") val approvalId: String,
    val answers: Map<String, List<String>>,
)

@Serializable
data class HandoffRequest(val to: TargetRef?)

@Serializable
data class PairRequest(
    val code: String,
    val name: String,
    val platform: String,
)

@Serializable
class EmptyBody

@Serializable
data class SaveContextRequest(val text: String)

/** `GET /context`: the Mac's CONTEXT.md after the daemon's lint (credential-looking plaintext entries removed). */
@Serializable
data class ContextDocument(
    val path: String? = null,
    val text: String,
    val warnings: List<String>,
)

/** One credential the Mac's sealer found in a CONTEXT.md save and replaced with a token (never the value). */
@Serializable
data class SealedField(
    val label: String,
    val field: String,
    val hosts: List<String>,
)

/** `PUT /context`: the lint's warnings and what was sealed. */
@Serializable
data class ContextSaveResult(
    val warnings: List<String> = emptyList(),
    val sealed: List<SealedField> = emptyList(),
)

/** `GET /context/example`. */
@Serializable
data class ContextExample(val text: String)

/** `{ok:true}` replies. */
@Serializable
data class OKReply(val ok: Boolean? = null)

@Serializable
data class ErrorReply(val error: String)

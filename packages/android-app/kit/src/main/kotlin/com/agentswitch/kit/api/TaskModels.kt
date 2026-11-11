package com.agentswitch.kit.api

import com.agentswitch.kit.feed.ModelName
import com.agentswitch.kit.support.JSONValue
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

/** engine/types.ts TaskStatus; anything newer decodes as [Other] instead of failing the whole list. */
@Serializable(with = TaskStatusSerializer::class)
sealed class TaskStatus {
    data object Queued : TaskStatus()
    data object Routing : TaskStatus()
    data object Running : TaskStatus()
    data object WaitingApproval : TaskStatus()
    data object Done : TaskStatus()
    data object Partial : TaskStatus()
    data object Blocked : TaskStatus()
    data object Failed : TaskStatus()
    data object Cancelled : TaskStatus()
    data class Other(val value: String) : TaskStatus()

    val rawValue: String
        get() = when (this) {
            Queued -> "queued"
            Routing -> "routing"
            Running -> "running"
            WaitingApproval -> "waiting_approval"
            Done -> "done"
            Partial -> "partial"
            Blocked -> "blocked"
            Failed -> "failed"
            Cancelled -> "cancelled"
            is Other -> value
        }

    /** engine/types.ts TERMINAL. */
    val isTerminal: Boolean get() = this in listOf(Done, Partial, Blocked, Failed, Cancelled)
    val isActive: Boolean get() = this in listOf(Queued, Routing, Running, WaitingApproval)

    /** The fixed status words on screen, one meaning each (docs/ui-v0.md §7.2.7). */
    val label: String
        get() = when (this) {
            Queued -> "Queued"
            Routing, Running -> "Busy"
            WaitingApproval -> "Waiting"
            Done -> "Done"
            Partial, Blocked -> "Incomplete"
            Failed -> "Failed"
            Cancelled -> "Cancelled"
            is Other -> value
        }

    /** The same, said aloud in Chinese (read-aloud, the Live Activity). */
    val spokenLabel: String
        get() = when (this) {
            Queued -> "排队"
            Routing, Running -> "进行中"
            WaitingApproval -> "等你处理"
            Done -> "已完成"
            Partial, Blocked -> "未完成"
            Failed -> "失败"
            Cancelled -> "已取消"
            is Other -> value
        }

    companion object {
        /** `TaskStatus(rawValue:)`: the case of that wire word, [Other] for one not known. */
        operator fun invoke(rawValue: String): TaskStatus = when (rawValue) {
            "queued" -> Queued
            "routing" -> Routing
            "running" -> Running
            "waiting_approval" -> WaitingApproval
            "done" -> Done
            "partial" -> Partial
            "blocked" -> Blocked
            "failed" -> Failed
            "cancelled" -> Cancelled
            else -> Other(rawValue)
        }
    }
}

object TaskStatusSerializer : KSerializer<TaskStatus> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("TaskStatus", PrimitiveKind.STRING)
    override fun deserialize(decoder: Decoder): TaskStatus = TaskStatus(decoder.decodeString())
    override fun serialize(encoder: Encoder, value: TaskStatus) = encoder.encodeString(value.rawValue)
}

@Serializable
data class Attachment(
    val name: String,
    val path: String,
    val size: Long,
    val type: String,
)

/** One failed execution attempt (router/reroute.ts Attempt), the part the phone shows. */
@Serializable
data class Attempt(
    val harness: String,
    val model: String,
    val kind: String,
    val excerpt: String,
)

/** engine/types.ts Task. Named AgentTask as in Swift (where it never shadows `Task`). Times are ms since 1970. */
@Serializable
data class AgentTask(
    val id: String,
    val createdAt: Long,
    val updatedAt: Long,
    val status: TaskStatus,
    val task: String,
    val cwd: String? = null,
    val pin: TargetRef? = null,
    val ephemeral: Boolean? = null,
    val parentId: String? = null,
    val attachments: List<Attachment>? = null,
    val threadId: String? = null,
    val harness: String? = null,
    val model: String? = null,
    val effort: String? = null,
    val brief: String? = null,
    val attempts: List<Attempt>? = null,
    val result: String? = null,
    val error: String? = null,
    val rating: Int? = null,
    val spoken: String? = null,
    /** The result retold for listening (threads-v0 §3), for 朗读. */
    val speech: String? = null,
    /** `question` (waits for your answer) or `interrupted` (the Mac's service restarted mid-run, control-v0 §4). */
    val blockCause: String? = null,
    /** When the phone last opened it (control-v0 §4, ms); older than `updatedAt` or missing means unread once ended. */
    val acknowledgedAt: Long? = null,
) {
    /** [createdAt], milliseconds since 1970 (Swift's `Date`). */
    val created: Long get() = createdAt

    /** [updatedAt], milliseconds since 1970. */
    val updated: Long get() = updatedAt

    /** Where it ran (or is pinned to run), `harness/model`. */
    val targetLabel: String?
        get() {
            if (harness != null) return model?.let { "$harness/$it" } ?: harness
            return pin?.label
        }

    /** The status word; a blocked task that waits for an answer says so (its `blockCause`). */
    val statusLabel: String
        get() = if (status == TaskStatus.Blocked && blockCause == "question") TaskStatus.WaitingApproval.label else status.label

    val spokenStatus: String
        get() = if (status == TaskStatus.Blocked && blockCause == "question") TaskStatus.WaitingApproval.spokenLabel else status.spokenLabel

    /** The model at work, as people say it (Opus 5.5), else the executor, else null. */
    val modelName: String?
        get() {
            if (model != null) return ModelName.display(model)
            return harness?.let(ModelName::harness) ?: pin?.let { ModelName.display(it.model) }
        }

    companion object {
        /** What an interrupted task says when the daemon gives no reason of its own (task page and process line). */
        const val interruptedText = "服务重启时任务仍在进行，执行进度无法确认。"
    }
}

/** `GET /tasks/:id`: the task plus its pending approvals and questions. The wire object is the task with `approvals`. */
@Serializable(with = TaskDetailSerializer::class)
data class TaskDetail(
    val task: AgentTask,
    val approvals: List<Approval>,
)

object TaskDetailSerializer : KSerializer<TaskDetail> {
    override val descriptor: SerialDescriptor = JsonElement.serializer().descriptor

    override fun deserialize(decoder: Decoder): TaskDetail {
        val json = (decoder as? JsonDecoder) ?: error("TaskDetail reads JSON only")
        val obj = json.decodeJsonElement().jsonObject
        val task = json.json.decodeFromJsonElement(AgentTask.serializer(), obj)
        val approvals = obj["approvals"]?.takeIf { it !is JsonNull }
            ?.let { json.json.decodeFromJsonElement(kotlinx.serialization.builtins.ListSerializer(Approval.serializer()), it) }
            ?: emptyList()
        return TaskDetail(task, approvals)
    }

    override fun serialize(encoder: Encoder, value: TaskDetail) {
        val json = (encoder as? JsonEncoder) ?: error("TaskDetail writes JSON only")
        val task = json.json.encodeToJsonElement(AgentTask.serializer(), value.task).jsonObject
        val approvals = json.json.encodeToJsonElement(kotlinx.serialization.builtins.ListSerializer(Approval.serializer()), value.approvals)
        json.encodeJsonElement(JsonObject(task + ("approvals" to approvals)))
    }
}

/** engine/types.ts TaskEvent. `type` stays a string: the daemon adds event types faster than a phone app ships. */
@Serializable
data class TaskEvent(
    val taskId: String,
    val seq: Long,
    /** Milliseconds since 1970. */
    val ts: Long,
    val type: String,
    val payload: JSONValue,
) {
    val id: String get() = "$taskId#$seq"

    /** [ts], milliseconds since 1970. */
    val date: Long get() = ts

    /** The daemon closes the event stream after one of these (TERMINAL in engine/types.ts). */
    val endsStream: Boolean get() = TaskStatus(type).isTerminal

    /** Events after which the pending approvals of the task may have changed. */
    val touchesApprovals: Boolean get() = type == "approval_request" || type == "approval_resolved" || endsStream
}

// extension Date: timestamps are milliseconds since 1970 in a Long here; Swift's `Date(milliseconds:)` is the identity
// and `Date.timeIntervalSince1970` is this.

/** Swift's `Date.timeIntervalSince1970` of a timestamp held as milliseconds since 1970: seconds. */
fun Long.timeIntervalSince1970(): Double = this.toDouble() / 1000.0

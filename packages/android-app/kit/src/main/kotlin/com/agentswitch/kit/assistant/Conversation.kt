package com.agentswitch.kit.assistant

import com.agentswitch.kit.api.AgentTask
import com.agentswitch.kit.api.RawValueEnumSerializer
import com.agentswitch.kit.api.TargetRef
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import java.util.UUID

internal object AssistantMessageKindSerializer : RawValueEnumSerializer<AssistantMessage.Kind>(
    "AssistantMessage.Kind", AssistantMessage.Kind.entries.toTypedArray(), { it.rawValue }, AssistantMessage.Kind.Other,
)

/** One message of the assistant conversation (assistant-v0 §1.1); the text is sealed (ciphertexts, never plaintext). */
@Serializable
data class AssistantMessage(
    val seq: Int,
    /** Milliseconds since 1970. */
    val ts: Long,
    val role: Role,
    val text: String,
    val kind: Kind,
    val taskIds: List<String>,
    /** The phone's id for a message it sent (user messages only): how a send the phone never heard back from is found. */
    val clientId: String? = null,
    /** On an answer: the message it answers. */
    val replyTo: Int? = null,
) {
    @Serializable
    enum class Role(val rawValue: String) {
        @SerialName("user") User("user"),
        @SerialName("assistant") Assistant("assistant"),
    }

    /**
     * `notice`: a task ended; `waiting`: a task waits for you (its card shows the question); `progress`: a
     * watched task's line; `watch`: the answer that set or stopped a watch. An unknown kind reads as [Other].
     */
    @Serializable(with = AssistantMessageKindSerializer::class)
    enum class Kind(val rawValue: String) {
        @SerialName("message") Message("message"),
        @SerialName("reply") Reply("reply"),
        @SerialName("task") Task("task"),
        @SerialName("status") Status("status"),
        @SerialName("cancel") Cancel("cancel"),
        @SerialName("fallback") Fallback("fallback"),
        @SerialName("notice") Notice("notice"),
        @SerialName("waiting") Waiting("waiting"),
        @SerialName("watch") Watch("watch"),
        @SerialName("progress") Progress("progress"),
        @SerialName("other") Other("other"),
    }

    val id: Int get() = seq

    /** [ts], milliseconds since 1970. */
    val date: Long get() = ts

    /** A reply that created its tasks (as opposed to one that only talks about them). */
    val createdTasks: Boolean get() = kind == Kind.Task || kind == Kind.Fallback

    /** Said by the assistant on its own, not in answer to a message. */
    val unprompted: Boolean get() = kind == Kind.Notice || kind == Kind.Waiting || kind == Kind.Progress
}

/**
 * The conversation as the phone holds it: each message once, by sequence number, the newest `keep`. Values, not
 * shared state: merging returns a new log.
 */
class ConversationLog(messages: List<AssistantMessage> = emptyList(), keep: Int = ConversationLog.keep) {
    val messages: List<AssistantMessage>
    private val keep: Int

    init {
        val unique = LinkedHashMap<Int, AssistantMessage>()
        for (m in messages) unique[m.seq] = m // a later one with the same seq wins
        this.messages = unique.values.sortedBy { it.seq }.takeLast(keep.coerceAtLeast(0))
        this.keep = keep
    }

    /** The highest sequence number held: the next poll asks for what came after it. */
    val lastSeq: Int get() = messages.lastOrNull()?.seq ?: 0
    val isEmpty: Boolean get() = messages.isEmpty()

    fun merging(incoming: List<AssistantMessage>): ConversationLog =
        if (incoming.isEmpty()) this else ConversationLog(messages + incoming, keep)

    /** Whether the Mac stored the message sent with this client id (a send whose answer was lost on the way). */
    fun contains(clientId: String): Boolean =
        messages.any { it.role == AssistantMessage.Role.User && it.clientId == clientId }

    /**
     * The entry `message` belongs to, as a delete takes it (threads-v0 手动删除): a message you sent with every answer to
     * it, or a line said on its own; with the tasks its answers created.
     */
    fun entry(of: AssistantMessage): ConversationEntry {
        val message = of
        val root = if (message.role == AssistantMessage.Role.User) message.seq else message.replyTo
        val lines = (root?.let { r -> messages.filter { it.seq == r || it.replyTo == r } } ?: emptyList()).toMutableList()
        if (message !in lines) lines.add(message)
        val created = lines.filter { it.createdTasks }.flatMap { it.taskIds }.distinct()
        return ConversationEntry(seq = message.seq, seqs = lines.map { it.seq }.sorted(), exchange = root != null, createdTaskIds = created)
    }

    /**
     * Without the lines the Mac no longer has. `recent` is the Mac's newest messages, read whole: a line held here that
     * is as new as the oldest of them and not among them was taken out there (deleted on the Mac, or an install's
     * notice a later one replaced). Lines older than what was read are left as they are.
     */
    fun agreeing(with: List<AssistantMessage>): ConversationLog {
        val oldest = with.minOfOrNull { it.seq } ?: return this
        val there = with.map { it.seq }.toSet()
        val kept = messages.filter { it.seq < oldest || it.seq in there }
        return if (kept.size == messages.size) this else ConversationLog(kept, keep)
    }

    /** Without these lines (deleted on the Mac); the next full load confirms. */
    fun removing(seqs: List<Int>): ConversationLog {
        val gone = seqs.toSet()
        return ConversationLog(messages.filter { it.seq !in gone }, keep)
    }

    /** Assistant messages in `incoming` this log does not hold yet, oldest first (what to sound or read aloud). */
    fun newAssistantMessages(`in`: List<AssistantMessage>): List<AssistantMessage> {
        val known = messages.map { it.seq }.toSet()
        return `in`.filter { it.role == AssistantMessage.Role.Assistant && it.seq !in known }.sortedBy { it.seq }
    }

    override fun equals(other: Any?): Boolean = other is ConversationLog && messages == other.messages && keep == other.keep
    override fun hashCode(): Int = 31 * messages.hashCode() + keep

    companion object {
        const val keep = 200
    }
}

/** One entry of the home screen (ConversationLog.entry): the Mac finds all of it from any one line. */
data class ConversationEntry(
    /** The line it was chosen by. */
    val seq: Int,
    /** The lines the phone holds of it. */
    val seqs: List<Int>,
    /** A message and its answers, rather than one line said on its own. */
    val exchange: Boolean,
    /** The tasks its answers created: deleted with it. */
    val createdTaskIds: List<String>,
)

/** `POST /assistant`: the stored message, the answer, and the task when one was created. */
@Serializable
data class AssistantReply(
    val user: AssistantMessage,
    val assistant: AssistantMessage,
    val task: AgentTask? = null,
)

@Serializable
data class AssistantMessages(val messages: List<AssistantMessage>)

/** What the input box sends. The client id stays the same across a resend, so the Mac acts on it once. */
@Serializable(with = NewMessageSerializer::class)
class NewMessage(
    val text: String,
    val clientId: String,
    attachments: List<String>? = null,
    val pin: TargetRef? = null,
) {
    val attachments: List<String>? = if (attachments?.isEmpty() == true) null else attachments
}

@Serializable
private class NewMessageWire(
    val text: String,
    @SerialName("client_id") val clientId: String,
    val attachments: List<String>? = null,
    val pin: TargetRef? = null,
)

object NewMessageSerializer : KSerializer<NewMessage> {
    override val descriptor: SerialDescriptor = NewMessageWire.serializer().descriptor
    override fun deserialize(decoder: Decoder): NewMessage {
        val w = NewMessageWire.serializer().deserialize(decoder)
        return NewMessage(w.text, w.clientId, w.attachments, w.pin)
    }
    override fun serialize(encoder: Encoder, value: NewMessage) =
        NewMessageWire.serializer().serialize(encoder, NewMessageWire(value.text, value.clientId, value.attachments, value.pin))
}

/**
 * The home screen's timeline: the conversation, each task under the reply that created it, and tasks created
 * elsewhere (the web console, before the assistant) on their own, all by time.
 */
object Conversation {
    sealed class Item {
        data class User(val message: AssistantMessage) : Item()
        data class Assistant(val message: AssistantMessage, val created: List<AgentTask>) : Item()
        data class Task(val task: AgentTask) : Item()

        /** Said by the assistant on its own (an end, a question, progress). */
        val unprompted: Boolean get() = this is Assistant && message.unprompted

        val id: String
            get() = when (this) {
                is User -> "m${message.seq}"
                is Assistant -> "m${message.seq}"
                is Task -> "task-${task.id}"
            }

        /** Tasks an answer talks about without owning them (a status or a cancel), for small links. */
        val mentions: List<String>
            get() = if (this is Assistant && !message.createdTasks) message.taskIds else emptyList()

        /** Milliseconds since 1970. */
        val time: Long
            get() = when (this) {
                is User -> message.ts
                is Assistant -> message.ts
                is Task -> task.createdAt
            }
    }

    const val defaultLimit = 60

    /**
     * A task's end is said once (ui-v0 §7.4): the card has the result, so a "task ended" line right under its card —
     * nothing but other such lines in between — is left out; further down it stays, as one line (the view's part).
     */
    fun timeline(messages: List<AssistantMessage>, tasks: List<AgentTask>, limit: Int = defaultLimit): List<Item> {
        val byId = HashMap<String, AgentTask>()
        for (t in tasks) byId.putIfAbsent(t.id, t) // the first of two with one id
        val owned = messages.filter { it.createdTasks }.flatMap { it.taskIds }.toSet()
        val talk: List<Item> = messages.map { m ->
            if (m.role == AssistantMessage.Role.User) Item.User(m)
            else Item.Assistant(m, if (m.createdTasks) m.taskIds.mapNotNull { byId[it] } else emptyList())
        }
        val loose: List<Item> = tasks.filter { it.id !in owned }.map { Item.Task(it) }
        val ordered = (talk + loose).sortedBy { it.time } // stable: equal times keep their order
        val kept = ArrayList<Item>()
        val cardAt = HashMap<String, Int>()
        for (item in ordered) {
            when (item) {
                is Item.Assistant -> {
                    val m = item.message
                    if (m.kind == AssistantMessage.Kind.Notice) {
                        val card = m.taskIds.firstOrNull()?.let { cardAt[it] }
                        if (card != null && kept.subList(card + 1, kept.size).all { it.unprompted }) continue
                    }
                    for (task in item.created) cardAt[task.id] = kept.size
                }
                is Item.Task -> cardAt[item.task.id] = kept.size
                is Item.User -> {}
            }
            kept.add(item)
        }
        return kept.takeLast(limit.coerceAtLeast(0))
    }

    /** A fresh id for a new message (not for a resend). */
    fun newClientId(): String = UUID.randomUUID().toString().replace("-", "").lowercase()
}

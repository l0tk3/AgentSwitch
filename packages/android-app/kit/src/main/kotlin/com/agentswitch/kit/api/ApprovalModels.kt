package com.agentswitch.kit.api

import com.agentswitch.kit.support.KitJson
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerialName
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import java.text.BreakIterator

/** An enum read from its raw string whose unknown values become [fallback] instead of failing. */
internal open class RawValueEnumSerializer<E : Enum<E>>(
    name: String,
    private val values: Array<E>,
    private val raw: (E) -> String,
    private val fallback: E,
) : KSerializer<E> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor(name, PrimitiveKind.STRING)
    override fun deserialize(decoder: Decoder): E {
        val s = decoder.decodeString()
        return values.firstOrNull { raw(it) == s } ?: fallback
    }
    override fun serialize(encoder: Encoder, value: E) = encoder.encodeString(raw(value))
}

internal object ApprovalKindSerializer : RawValueEnumSerializer<ApprovalKind>(
    "ApprovalKind", ApprovalKind.entries.toTypedArray(), { it.rawValue }, ApprovalKind.Other,
)

internal object ApprovalStatusSerializer : RawValueEnumSerializer<ApprovalStatus>(
    "ApprovalStatus", ApprovalStatus.entries.toTypedArray(), { it.rawValue }, ApprovalStatus.Other,
)

/** An unknown value from a newer Mac reads as [Other]. */
@Serializable(with = ApprovalKindSerializer::class)
enum class ApprovalKind(val rawValue: String) {
    @SerialName("approval") Approval("approval"),
    @SerialName("question") Question("question"),
    @SerialName("other") Other("other"),
}

@Serializable(with = ApprovalStatusSerializer::class)
enum class ApprovalStatus(val rawValue: String) {
    /** `withdrawn`: the executor cancelled its own request (control-v0 §4); only `pending` ones are ever shown. */
    @SerialName("pending") Pending("pending"),
    @SerialName("allowed") Allowed("allowed"),
    @SerialName("denied") Denied("denied"),
    @SerialName("expired") Expired("expired"),
    @SerialName("withdrawn") Withdrawn("withdrawn"),
    @SerialName("other") Other("other"),
}

/** engine/types.ts Approval: allow/deny for a dangerous action, or a question that needs text from the user. */
@Serializable
data class Approval(
    val id: String,
    val taskId: String,
    /** Milliseconds since 1970. */
    val createdAt: Long,
    val kind: ApprovalKind,
    val action: String,
    val evidence: String,
    val status: ApprovalStatus,
    val resolvedAt: Long? = null,
    val answer: String? = null,
) {
    /** [createdAt], milliseconds since 1970. */
    val created: Long get() = createdAt

    /** For a question, the structured evidence (core/questions.ts); null for allow/deny approvals. */
    val questionEvidence: QuestionEvidence?
        get() {
            if (kind != ApprovalKind.Question) return null
            val parsed = try {
                KitJson.decodeFromString(QuestionEvidence.serializer(), evidence)
            } catch (_: SerializationException) {
                return null
            } catch (_: IllegalArgumentException) {
                return null
            }
            return if (parsed.questions.isEmpty()) null else parsed
        }
}

/** core/questions.ts QuestionEvidence. */
@Serializable
data class QuestionEvidence(
    val source: String,
    val questions: List<UserQuestion>,
)

/** core/questions.ts UserQuestion, with the schema's defaults applied. */
@Serializable
data class UserQuestion(
    val id: String,
    val header: String = "",
    val text: String,
    val options: List<Option> = emptyList(),
    val multi: Boolean = false,
    /** The harness flagged the answer as sensitive: answer with a ciphertext, never plaintext. */
    val secret: Boolean = false,
) {
    @Serializable
    data class Option(
        val label: String,
        val description: String = "",
    )
}

/** Answers keyed by question id, validated like core/questions.ts validateAnswers before they are sent. */
object AnswerCheck {
    const val maxLength = 4000

    fun problem(questions: List<UserQuestion>, answers: Map<String, List<String>>): String? {
        for (q in questions) {
            val values = (answers[q.id] ?: emptyList()).map { it.trim() }.filter { it.isNotEmpty() }
            if (values.isEmpty()) return "未回答：${q.text}"
            if (!q.multi && values.size > 1) return "仅可选择一项：${q.text}"
            if (values.any { characterCount(it) > maxLength }) return "回答过长（最多 $maxLength 字）"
        }
        val extra = answers.keys - questions.map { it.id }.toSet()
        return if (extra.isEmpty()) null else "无对应问题的回答：${extra.sorted().joinToString(", ")}"
    }

    /** Drops blanks and trims, so what is sent is what was checked. */
    fun cleaned(answers: Map<String, List<String>>): Map<String, List<String>> =
        answers.mapValues { (_, v) -> v.map { it.trim() }.filter { it.isNotEmpty() } }

    /** Characters the way Swift's `String.count` counts them (grapheme clusters). */
    private fun characterCount(s: String): Int {
        if (s.length <= maxLength) return s.length // graphemes never outnumber UTF-16 units
        val it = BreakIterator.getCharacterInstance()
        it.setText(s)
        var n = 0
        while (it.next() != BreakIterator.DONE) n++
        return n
    }
}

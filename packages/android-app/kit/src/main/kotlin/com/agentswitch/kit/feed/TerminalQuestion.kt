package com.agentswitch.kit.feed

import com.agentswitch.kit.api.TerminalQuestion
import com.agentswitch.kit.api.isHorizontalSpace
import com.agentswitch.kit.api.isUnicodeWhitespace
import kotlinx.serialization.Serializable

/**
 * What is picked on a question card (docs/terminal-v0.md §3 "选择题", 2026-10-01, user: 能不能hook的更精细，直接用这个框来选
 * agent给的选项): per question, its options by label — one, or several when it takes several — and the words written
 * in Other. Writing in Other picks it: in place of the option picked (one), or beside them (several). Submit once every
 * question has an answer.
 *
 * Swift's struct with `mutating` functions: here a class whose functions change it in place; [copy] makes the value
 * copy Swift's assignment would, and `equals` compares what is picked.
 */
class QuestionPicks(val questions: List<TerminalQuestion>) {
    /** One question's answer as the Mac takes it (`POST /terminals/:id/permissions/:pid {answers}`). */
    @Serializable
    data class Answer(
        val labels: List<String>,
        val other: String? = null,
    )

    private var labels: MutableList<MutableList<String>> = questions.map { mutableListOf<String>() }.toMutableList()
    private var others: MutableList<String> = questions.map { "" }.toMutableList()

    /** A copy that is changed apart from this one. */
    fun copy(): QuestionPicks {
        val c = QuestionPicks(questions)
        c.labels = labels.map { it.toMutableList() }.toMutableList()
        c.others = others.toMutableList()
        return c
    }

    fun isPicked(label: String, question: Int): Boolean = label in labels[question]
    fun other(question: Int): String = others[question]
    fun hasOther(question: Int): Boolean = others[question].trim { it.isUnicodeWhitespace() }.isNotEmpty()

    /** A tap on an option: the one picked (one), or on and off (several). */
    fun pick(label: String, question: Int) {
        if (questions[question].multiSelect) {
            val at = labels[question].indexOf(label)
            if (at >= 0) labels[question].removeAt(at) else labels[question].add(label)
        } else {
            labels[question] = mutableListOf(label)
            others[question] = ""
        }
    }

    fun write(text: String, question: Int) {
        others[question] = text
        if (!questions[question].multiSelect && hasOther(question)) labels[question] = mutableListOf()
    }

    fun isAnswered(question: Int): Boolean = labels[question].isNotEmpty() || hasOther(question)
    val isComplete: Boolean get() = questions.indices.all { isAnswered(it) }

    /** By question text, as the Mac checks them: the labels in the order of the options, Other's words trimmed. */
    val answers: Map<String, Answer>
        get() {
            val out = LinkedHashMap<String, Answer>()
            for ((i, q) in questions.withIndex()) {
                if (!isAnswered(i)) continue
                val picked = q.options.map { it.label }.filter { it in labels[i] }
                out[q.question] = Answer(labels = picked, other = if (hasOther(i)) others[i].trim { it.isUnicodeWhitespace() } else null)
            }
            return out
        }

    override fun equals(other: Any?): Boolean =
        other is QuestionPicks && questions == other.questions && labels == other.labels && others == other.others

    override fun hashCode(): Int = 31 * (31 * questions.hashCode() + labels.hashCode()) + others.hashCode()
}

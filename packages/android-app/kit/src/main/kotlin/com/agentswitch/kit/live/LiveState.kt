package com.agentswitch.kit.live

import com.agentswitch.kit.api.graphemeCount
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * What the Live Activity and the Dynamic Island show (assistant-v0 §4): one summary for all tasks, not one activity
 * per task — at most three in progress, the one that needs you first, how many run and wait in all, and the last
 * conclusion once everything has ended. Terminals waiting for you are rows too (terminal-v0 §1). Its own module with no
 * dependencies, so the widget extension stays small; the app builds it from tasks (AgentSwitchKit's LiveSummary). On
 * Android it feeds an ongoing notification. (ActivityKit keeps a state under 4 KB: every text is short.)
 * Times are milliseconds since 1970 (Swift's `Date`).
 */
@Serializable
data class LiveState(
    val rows: List<Row>,
    /** Tasks in progress and not waiting (a terminal is a row only while it waits). */
    val running: Int,
    /** Tasks and terminals waiting for you. */
    val waiting: Int,
    val ended: Ended? = null,
    /**
     * The look the app is kept in (docs/ui-v0.md §8): true draws the activity as a standard app's. It rides with the
     * state because the widget extension reads none of the app's settings; null (the pixel look) from an activity
     * saved before 2026-10-04.
     */
    val classic: Boolean? = null,
) {
    @Serializable
    data class Row(
        val id: String,
        /** The thread's title, else the start of what was asked; a terminal's name. */
        val title: String,
        /** The latest step, or the question when it waits for you; what a terminal asks to run. */
        val step: String,
        /** The model at work, if one has the task yet; a terminal's agent. */
        val model: String? = null,
        /** For the running clock; a terminal's from when it asked. Milliseconds since 1970. */
        val startedAt: Long,
        val needsYou: Boolean,
        /** A state saved before rows had a kind (an activity left from an earlier version) reads as tasks. */
        val kind: Kind = Kind.Task,
        /**
         * What it is doing now in one short word, for the compact island (`Run`, `Edit`, `Read`, `Search`, `Web`,
         * `Agents`…; `Allow?` or `Answer` while it waits for you). Null from an activity saved before 2026-10-01.
         */
        val doing: String? = null,
    ) {
        /** A task, or one of AgentSwitch's terminals waiting for you. */
        @Serializable
        enum class Kind(val rawValue: String) {
            @SerialName("task") Task("task"),
            @SerialName("terminal") Terminal("terminal"),
        }

        /** Where a tap on it goes: the task's card, or the terminal (as an `agentswitch://` link). */
        val link: String get() = if (kind == Kind.Terminal) LiveLink.terminal(id) else LiveLink.task(id)
    }

    /** The last conclusion after every task ended: shown for a minute, then the activity goes. */
    @Serializable
    data class Ended(
        val taskId: String,
        val title: String,
        val line: String,
        val ok: Boolean,
    )

    enum class Phase(val rawValue: String) { Running("running"), NeedsYou("needsYou"), Ended("ended") }

    /** The same state, drawn in the classic look or the pixel one. */
    fun looking(classic: Boolean): LiveState = LiveState(rows, running, waiting, ended, if (classic) true else null)

    /** Whether it is drawn in the classic look. */
    val isClassic: Boolean get() = classic == true

    val phase: Phase get() = if (waiting > 0) Phase.NeedsYou else if (rows.isEmpty() && ended != null) Phase.Ended else Phase.Running

    /** The row the island expands to: the one waiting for you, else the newest. */
    val lead: Row? get() = rows.firstOrNull()

    /** Tasks are in it (not only terminals): once they are over, the last conclusion is worth a minute. */
    val hasTasks: Boolean get() = running > 0 || rows.any { it.kind == Row.Kind.Task }

    companion object {
        fun finished(ended: Ended): LiveState = LiveState(emptyList(), 0, 0, ended)
    }
}

/**
 * The links the activity opens: a task's card or a terminal in the app. (Swift's `URL` is the link as text here.)
 */
object LiveLink {
    const val scheme = "agentswitch"

    fun task(id: String): String = link("task", id)
    fun terminal(id: String): String = link("terminal", id)

    /** The task id of an `agentswitch://task/<id>` link, or null for any other link (a pairing link, say). */
    fun taskId(url: String): String? = id(url, "task")

    /** The terminal id of an `agentswitch://terminal/<id>` link. */
    fun terminalId(url: String): String? = id(url, "terminal")

    private fun link(host: String, id: String): String = "$scheme://$host/${alphanumericsOnly(id)}"

    /** `addingPercentEncoding(withAllowedCharacters: .alphanumerics)`: letters, marks and numbers stay, the rest is %XX of its UTF-8. */
    private fun alphanumericsOnly(id: String): String {
        val out = StringBuilder()
        var i = 0
        while (i < id.length) {
            val cp = id.codePointAt(i)
            i += Character.charCount(cp)
            val t = Character.getType(cp)
            val allowed = Character.isLetter(cp) || t == Character.NON_SPACING_MARK.toInt() || t == Character.COMBINING_SPACING_MARK.toInt() ||
                t == Character.ENCLOSING_MARK.toInt() || t == Character.DECIMAL_DIGIT_NUMBER.toInt() || t == Character.LETTER_NUMBER.toInt() ||
                t == Character.OTHER_NUMBER.toInt()
            if (allowed) out.appendCodePoint(cp)
            else for (b in String(Character.toChars(cp)).toByteArray(Charsets.UTF_8)) out.append('%').append("%02X".format(b.toInt() and 0xFF))
        }
        return out.toString()
    }

    private val shape = Regex("^([A-Za-z][A-Za-z0-9+.\\-]*):(?://([^/?#]*))?([^?#]*)")

    private fun id(url: String, host: String): String? {
        val m = shape.find(url) ?: return null
        if (m.groupValues[1] != scheme || m.groups[2]?.value != host) return null
        val first = m.groupValues[3].split("/").firstOrNull { it.isNotEmpty() }
        val id = first?.let { percentDecoded(it) ?: it } ?: ""
        return if (id.isEmpty() || id.graphemeCount() > 64) null else id
    }

    /** Swift's `removingPercentEncoding`: null when a `%` is not followed by two hex digits. */
    private fun percentDecoded(s: String): String? {
        if (!s.contains('%')) return s
        val bytes = java.io.ByteArrayOutputStream()
        val raw = s.toByteArray(Charsets.UTF_8)
        var i = 0
        while (i < raw.size) {
            val b = raw[i].toInt() and 0xFF
            if (b == '%'.code) {
                if (i + 2 >= raw.size) return null
                val hi = Character.digit(raw[i + 1].toInt(), 16)
                val lo = Character.digit(raw[i + 2].toInt(), 16)
                if (hi < 0 || lo < 0) return null
                bytes.write(hi * 16 + lo)
                i += 3
            } else {
                bytes.write(b)
                i += 1
            }
        }
        return String(bytes.toByteArray(), Charsets.UTF_8)
    }
}

package com.agentswitch.kit.live

import com.agentswitch.kit.api.graphemeCount
import kotlinx.serialization.Serializable

/**
 * What the Live Activity and the Dynamic Island show (assistant-v0 §4): one summary, not one activity per terminal —
 * at most three rows, the one that needs you first, and how many are at work and wait in all (terminal-v0 §1). Its own
 * module with no dependencies, so the widget extension stays small; the app builds it from the terminals
 * (AgentSwitchKit's LiveSummary). On Android it feeds an ongoing notification. (ActivityKit keeps a state under 4 KB:
 * every text is short.) Times are milliseconds since 1970 (Swift's `Date`).
 */
@Serializable
data class LiveState(
    val rows: List<Row>,
    /** Terminals at work. */
    val running: Int,
    /** Terminals waiting for you. */
    val waiting: Int,
    /**
     * The look the app is kept in (docs/ui-v0.md §8): true draws the activity as a standard app's. It rides with the
     * state because the widget extension reads none of the app's settings; null: the pixel look.
     */
    val classic: Boolean? = null,
) {
    @Serializable
    data class Row(
        val id: String,
        /** The terminal's name. */
        val title: String,
        /** What it is using, or what it asks to run while it waits for you. */
        val step: String,
        /** The terminal's agent. */
        val model: String? = null,
        /** For the running clock; from when it asked, while it waits. Milliseconds since 1970. */
        val startedAt: Long,
        val needsYou: Boolean,
        /**
         * What it is doing now in one short word, for the compact island (`Run`, `Edit`, `Read`, `Search`, `Web`,
         * `Agents`…; `Allow?` or `Answer` while it waits for you).
         */
        val doing: String? = null,
    ) {
        /** Where a tap on it goes: the terminal (as an `agentswitch://` link). */
        val link: String get() = LiveLink.terminal(id)
    }

    enum class Phase(val rawValue: String) { Running("running"), NeedsYou("needsYou") }

    /** The same state, drawn in the classic look or the pixel one. */
    fun looking(classic: Boolean): LiveState = LiveState(rows, running, waiting, if (classic) true else null)

    /** Whether it is drawn in the classic look. */
    val isClassic: Boolean get() = classic == true

    val phase: Phase get() = if (waiting > 0) Phase.NeedsYou else Phase.Running

    /** The row the island expands to: the one waiting for you, else the newest. */
    val lead: Row? get() = rows.firstOrNull()
}

/**
 * The links the activity opens: a terminal in the app. (Swift's `URL` is the link as text here.)
 */
object LiveLink {
    const val scheme = "agentswitch"

    fun terminal(id: String): String = link("terminal", id)

    /** The terminal id of an `agentswitch://terminal/<id>` link, or null for any other link (a pairing link, say). */
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

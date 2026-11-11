package com.agentswitch.kit.feed

import com.agentswitch.kit.api.AgentTask
import com.agentswitch.kit.api.SearchResult
import com.agentswitch.kit.api.graphemePrefix
import com.agentswitch.kit.api.isUnicodeWhitespace
import java.text.BreakIterator

/**
 * Search results as the phone shows them (control-v0 §4): the daemon marks each hit in `snippet` with ⟦ and ⟧; the
 * marks go and the hits are bold.
 */
object SearchSnippet {
    const val open: Char = '⟦'
    const val close: Char = '⟧'

    data class Part(val text: String, val hit: Boolean)

    /**
     * The snippet in runs of plain text and hits, the marks removed; an unclosed mark runs to the end, a stray close
     * mark is dropped.
     */
    fun parts(snippet: String): List<Part> {
        val parts = mutableListOf<Part>()
        val current = StringBuilder()
        var inHit = false
        fun flush() {
            if (current.isNotEmpty()) parts.add(Part(current.toString(), inHit))
            current.setLength(0)
        }
        for (ch in MessageDisplay.readable(snippet)) {
            when {
                ch == open && !inHit -> { flush(); inHit = true }
                ch == close && inHit -> { flush(); inHit = false }
                ch == open || ch == close -> continue
                else -> current.append(ch)
            }
        }
        flush()
        return parts
    }

    /** The snippet as plain text (accessibility, copying). */
    fun plain(snippet: String): String = parts(snippet).joinToString("") { it.text }

    /**
     * Search over the tasks the phone already has, marked the daemon's way: for a Mac without `/search` and for the
     * demo screens. Case-insensitive; the snippet is cut around the first hit, taken from what came of the task before
     * its own text (which is already the title).
     */
    fun local(tasks: List<AgentTask>, query: String, limit: Int = 30): List<SearchResult> {
        val q = query.trim { it.isUnicodeWhitespace() }
        if (q.isEmpty()) return emptyList()
        val hits = tasks.mapNotNull { task ->
            val fields = listOf(task.speech, task.result, task.error, task.spoken, task.task).mapNotNull { it?.let(MessageDisplay::readable) }
            val text = fields.firstOrNull { it.indexOf(q, ignoreCase = true) >= 0 } ?: return@mapNotNull null
            SearchResult(
                taskId = task.id,
                title = LiveSummary.clip(MessageDisplay.readable(task.task), 40),
                snippet = marked(text, q),
                status = task.status,
                updatedAt = task.updatedAt,
            )
        }
        return hits.sortedByDescending { it.updatedAt }.take(limit)
    }

    internal const val context = 30

    /** Every occurrence of `query` in a window around the first one, wrapped in ⟦⟧. */
    internal fun marked(text: String, query: String): String {
        val flat = text.replace("\n", " ")
        val first = flat.indexOf(query, ignoreCase = true)
        if (first < 0) return flat.graphemePrefix(context * 2)
        // Counted in characters (grapheme clusters), as Swift's `index(_:offsetBy:limitedBy:)`.
        val bounds = ArrayList<Int>()
        val it = BreakIterator.getCharacterInstance()
        it.setText(flat)
        var b = it.first()
        while (b != BreakIterator.DONE) { bounds.add(b); b = it.next() }
        val lowerAt = bounds.indexOfLast { it <= first }
        val upperAt = bounds.indexOfFirst { it >= first + query.length }
        val start = if (lowerAt - context >= 0) bounds[lowerAt - context] else 0
        val end = if (upperAt + context * 2 <= bounds.size - 1) bounds[upperAt + context * 2] else flat.length
        var window = flat.substring(start, end)
        val out = StringBuilder()
        while (true) {
            val hit = window.indexOf(query, ignoreCase = true)
            if (hit < 0) break
            out.append(window.substring(0, hit))
            out.append("⟦").append(window.substring(hit, hit + query.length)).append("⟧")
            window = window.substring(hit + query.length)
        }
        out.append(window)
        return (if (start > 0) "…" else "") + out + (if (end < flat.length) "…" else "")
    }
}

package com.agentswitch.kit.feed

/**
 * A terminal reply with pictures and files in it (docs/terminal-v0.md §4 `attachments`), as Claude Code shows them: each
 * stands in the text as its placeholder, where the user put it — `[Image #1]`, `[File #2]` — and goes where it stands
 * when the reply is sent. Deleting the placeholder drops the file.
 *
 * Offsets are UTF-16 indexes into the text (Android's own caret positions); Swift counted `Character`s.
 */
object TerminalDraft {
    fun token(image: Boolean, number: Int): String = if (image) "[Image #$number]" else "[File #$number]"

    /** What `insert` returns: the new text and where the caret goes. */
    data class Inserted(val text: String, val caret: Int)

    /**
     * `tokens` put into `text` at the character `offset` (null: at the end), as typing them would: a space before when
     * the text there does not already have one, a space after each. Returns the text and where the caret goes after.
     */
    fun insert(tokens: List<String>, text: String, offset: Int?): Inserted {
        if (tokens.isEmpty()) return Inserted(text, offset ?: text.length)
        val at = (offset ?: text.length).coerceIn(0, text.length)
        val before = text.substring(0, at)
        val after = text.substring(at)
        val lead = if (before.isEmpty() || before.last().isWhitespace()) "" else " "
        val inserted = lead + tokens.joinToString("") { "$it " }
        // A space already after the caret is not doubled.
        val joined = if (after.firstOrNull()?.isWhitespace() == true) inserted.dropLast(1) else inserted
        return Inserted(before + joined + after, at + joined.length)
    }

    /** `text` without `token` and the space typed after it. */
    fun remove(token: String, text: String): String = text.replace("$token ", "").replace(token, "")
}

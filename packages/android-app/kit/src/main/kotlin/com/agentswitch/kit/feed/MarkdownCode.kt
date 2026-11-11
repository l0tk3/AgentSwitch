package com.agentswitch.kit.feed

// Code in what Dispatch shows (docs/dispatch-v0.md §2, 2026-10-03, user: dispatch里加上代码块支持吧，这样看着太难受了 ……
// 手机上也是): fenced blocks and backtick spans. Model output is Markdown as a whole (Markdown.blocks); what a person typed
// goes through these two only, so nothing else they typed is read as Markdown. Same as the Mac Core's DispatchCode.

/**
 * A fence line as people and models write it (CommonMark's rule): three or more backticks or tildes, then an optional
 * info string — for backticks one without a backtick, so ```ls``` on a line is a code span, not a fence.
 */
internal data class MarkdownFence(
    val mark: Char,
    val length: Int,
    /** The info string's first word (`bash`, `json`), if any. */
    val language: String?,
    /** The opening line's leading spaces, taken off the block's lines too (a fence under a list item). */
    val indent: Int,
) {
    /** Whether `line` ends the block: the same mark, at least as many, nothing else on the line. */
    fun closes(line: String): Boolean {
        val trimmed = line.trimSpaces()
        return trimmed.length >= length && trimmed.all { it == mark }
    }

    /** A line of the block without the fence's own indentation (no more than the line has). */
    fun body(line: String): String = line.drop(minOf(indent, line.takeWhile { it == ' ' }.length))

    companion object {
        /** The fence `line` opens, or null when it opens none. */
        fun opening(line: String): MarkdownFence? {
            val trimmed = line.trimSpaces()
            val mark = trimmed.firstOrNull() ?: return null
            if (mark != '`' && mark != '~') return null
            val length = trimmed.takeWhile { it == mark }.length
            val info = trimmed.drop(length).trimSpaces()
            if (length < 3 || !(mark == '~' || !info.contains('`'))) return null
            val language = info.split(" ").firstOrNull { it.isNotEmpty() }
            return MarkdownFence(mark, length, language, line.takeWhile { it == ' ' }.length)
        }
    }
}

/**
 * What a person typed, as typed, with only its code read: fenced blocks become `.Code`, the text between them one
 * `.Paragraph` each, whole — blank lines, `#`, `*`, `-` and `1.` stay as typed (draw it with `codeSpans`). A fence
 * left open runs to the end, as in model output.
 */
fun Markdown.typedBlocks(source: String): List<MarkdownBlock> {
    val lines = source.replace("\r\n", "\n").split("\n")
    val out = mutableListOf<MarkdownBlock>()
    var text = mutableListOf<String>()
    fun endText() {
        while (text.firstOrNull()?.trimSpaces()?.isEmpty() == true) text.removeAt(0)
        while (text.lastOrNull()?.trimSpaces()?.isEmpty() == true) text.removeAt(text.size - 1)
        if (text.isNotEmpty()) out.add(MarkdownBlock.Paragraph(text.joinToString("\n")))
        text = mutableListOf()
    }
    var i = 0
    while (i < lines.size) {
        val fence = MarkdownFence.opening(lines[i])
        if (fence == null) { text.add(lines[i]); i += 1; continue }
        endText()
        val body = mutableListOf<String>()
        i += 1
        while (i < lines.size && !fence.closes(lines[i])) { body.add(fence.body(lines[i])); i += 1 }
        i += 1   // the closing fence, or past the end
        while (body.lastOrNull()?.trimSpaces()?.isEmpty() == true) body.removeAt(body.size - 1)
        out.add(MarkdownBlock.Code(fence.language, body.joinToString("\n")))
    }
    endText()
    return out
}

/**
 * `text` with its backtick code spans marked as code (the `code` flag of a run) and nothing else read. A span is
 * closed by a run of as many backticks on the same line (CommonMark's rule, kept to one line so a stray backtick
 * never turns a paragraph into code); one space inside both ends is taken off; a run with no partner stays as typed.
 */
fun Markdown.codeSpans(text: String): InlineText {
    var out = InlineText.empty
    for ((n, line) in text.split("\n").withIndex()) {
        if (n > 0) out += InlineText.plain("\n")
        out += spans(line)
    }
    return out
}

private fun spans(chars: String): InlineText {
    val runs = mutableListOf<InlineRun>()
    val plain = StringBuilder()
    var i = 0
    while (i < chars.length) {
        if (chars[i] != '`') { plain.append(chars[i]); i += 1; continue }
        val open = backtickRun(chars, i)
        val close = closingRun(chars, open, i + open)
        if (close == null) {
            plain.append(chars, i, i + open)
            i += open
            continue
        }
        var code = chars.substring(i + open, close)
        if (code.length >= 2 && code.first() == ' ' && code.last() == ' ' && code.any { it != ' ' }) {
            code = code.substring(1, code.length - 1)
        }
        if (plain.isNotEmpty()) { runs.add(InlineRun(plain.toString())); plain.setLength(0) }
        runs.add(InlineRun(code, code = true))
        i = close + open
    }
    if (plain.isNotEmpty()) runs.add(InlineRun(plain.toString()))
    return InlineText.of(runs)
}

/** How many backticks run from `start`. */
private fun backtickRun(chars: String, start: Int): Int {
    var n = 0
    while (start + n < chars.length && chars[start + n] == '`') n += 1
    return n
}

/** Where the next run of exactly `length` backticks starts, from `start` on. */
private fun closingRun(chars: String, length: Int, start: Int): Int? {
    var j = start
    while (j < chars.length) {
        if (chars[j] != '`') { j += 1; continue }
        val n = backtickRun(chars, j)
        if (n == length) return j
        j += n
    }
    return null
}

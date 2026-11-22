package com.agentswitch.kit.feed

/**
 * A shell command in parts, for colouring (the simple view's opened step, docs/simple-view-v0.md §5.1): the word each
 * command begins with, what is quoted — a here-document's body with it —, comments, and the rest. It reads the
 * command only as far as that takes: no expansion, no nesting inside quotes. The kinds are neutral: the app picks the colours.
 */
object ShellHighlight {
    enum class Kind { Plain, Command, String, Comment }

    data class Run(val text: String, val kind: Kind)

    /** Words a command may begin after (`if make; then …`), and words that begin none. */
    private val leading: Set<String> = setOf("if", "then", "else", "elif", "while", "until", "do", "time", "!", "{", "exec", "sudo", "env", "nohup", "xargs")
    private val closing: Set<String> = setOf("fi", "done", "esac", "for", "case", "in", "function", "select", "}")
    private val breaks: Set<Char> = setOf(' ', '\t', '\n', ';', '|', '&', '(', ')', '<', '>', '\'', '"', '`')
    private val assignment = Regex("^[A-Za-z_][A-Za-z0-9_]*\\+?=")

    private class Doc(val mark: String, val tabs: Boolean)

    fun runs(source: String): List<Run> {
        val c = source.toCharArray()
        val runs = mutableListOf<Run>()
        val plain = StringBuilder()
        fun flush() { if (plain.isNotEmpty()) { runs.add(Run(plain.toString(), Kind.Plain)); plain.setLength(0) } }
        fun emit(text: String, kind: Kind) {
            if (text.isEmpty()) return
            if (kind == Kind.Plain) plain.append(text) else { flush(); runs.add(Run(text, kind)) }
        }
        fun str(from: Int, to: Int) = String(c, from, to - from)
        var i = 0
        // The next word begins a command.
        var first = true
        // Here-documents announced on this line: their bodies begin after its end.
        var docs = mutableListOf<Doc>()

        while (i < c.size) {
            val ch = c[i]
            if (ch == '\n') {
                emit("\n", Kind.Plain)
                i += 1
                first = true
                for (doc in docs) {
                    // Up to the line that is the mark alone (after its tabs, for `<<-`).
                    val body = StringBuilder()
                    while (i < c.size) {
                        var end = i
                        while (end < c.size && c[end] != '\n') end += 1
                        val line = str(i, end)
                        body.append(line)
                        if (end < c.size) body.append('\n')
                        i = minOf(end + 1, c.size)
                        if ((if (doc.tabs) line.dropWhile { it == '\t' } else line) == doc.mark) break
                    }
                    // Its last newline is the line's, not the body's.
                    if (body.endsWith("\n")) { emit(body.substring(0, body.length - 1), Kind.String); emit("\n", Kind.Plain) } else emit(body.toString(), Kind.String)
                }
                docs = mutableListOf()
                continue
            }
            if (ch == ' ' || ch == '\t') { emit(ch.toString(), Kind.Plain); i += 1; continue }
            if (ch == '\\' && i + 1 < c.size) {
                // An escaped character is itself; a line carried on is still the same command.
                emit(str(i, i + 2), Kind.Plain)
                i += 2
                continue
            }
            if (ch == '#' && (i == 0 || c[i - 1] == ' ' || c[i - 1] == '\t' || c[i - 1] == '\n' || c[i - 1] == ';')) {
                var end = i
                while (end < c.size && c[end] != '\n') end += 1
                emit(str(i, end), Kind.Comment)
                i = end
                continue
            }
            if (ch == '\'' || ch == '"' || ch == '`') {
                var end = i + 1
                while (end < c.size && c[end] != ch) {
                    if (ch != '\'' && c[end] == '\\' && end + 1 < c.size) end += 1
                    end += 1
                }
                end = minOf(end + 1, c.size)
                emit(str(i, end), Kind.String)
                i = end
                first = false
                continue
            }
            if (ch == '<' && i + 1 < c.size && c[i + 1] == '<' && !(i + 2 < c.size && c[i + 2] == '<')) {
                // `<<EOF`, `<<-EOF`, `<<'EOF'`, `<< "EOF"`.
                var at = i + 2
                var tabs = false
                if (at < c.size && c[at] == '-') { tabs = true; at += 1 }
                emit(str(i, at), Kind.Plain)
                while (at < c.size && (c[at] == ' ' || c[at] == '\t')) { emit(c[at].toString(), Kind.Plain); at += 1 }
                var end = at
                if (end < c.size && (c[end] == '\'' || c[end] == '"')) {
                    val quote = c[end]
                    end += 1
                    while (end < c.size && c[end] != quote && c[end] != '\n') end += 1
                    end = minOf(end + 1, c.size)
                } else {
                    while (end < c.size && c[end] !in breaks) end += 1
                }
                val word = str(at, end)
                val mark = word.trim { it == '\'' || it == '"' || it == '\\' }
                emit(word, Kind.String)
                if (mark.isNotEmpty()) docs.add(Doc(mark, tabs))
                i = end
                continue
            }
            if (ch == ';' || ch == '|' || ch == '&' || ch == '(') {
                emit(ch.toString(), Kind.Plain)
                i += 1
                // `2>&1`, `&>file`: where output goes, not the end of a command.
                val redirects = ch == '&' && ((i >= 2 && (c[i - 2] == '>' || c[i - 2] == '<')) || (i < c.size && c[i] == '>'))
                if (!redirects) first = true
                continue
            }
            if (ch == ')' || ch == '<' || ch == '>') { emit(ch.toString(), Kind.Plain); i += 1; continue }
            // A word, up to what ends one. `$(` begins a command inside it.
            var end = i
            var opens = false
            while (end < c.size && c[end] !in breaks) {
                if (c[end] == '\\' && end + 1 < c.size) { end += 2; continue }
                if (c[end] == '$' && end + 1 < c.size && c[end + 1] == '(') { end += 2; opens = true; break }
                end += 1
            }
            if (end == i) end = i + 1
            val word = str(i, end)
            if (opens) {
                emit(word, Kind.Plain)
                first = true
            } else if (!first) {
                emit(word, Kind.Plain)
            } else if (assignment.containsMatchIn(word) || word in leading) {
                emit(word, Kind.Plain)   // `FOO=1 make`, `if make`: the command is still to come
            } else if (word in closing) {
                emit(word, Kind.Plain)
                first = false
            } else {
                emit(word, Kind.Command)
                first = false
            }
            i = end
        }
        flush()
        return runs
    }
}

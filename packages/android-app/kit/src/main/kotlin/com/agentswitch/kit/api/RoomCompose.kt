package com.agentswitch.kit.api

import com.agentswitch.kit.feed.InlineRun
import com.agentswitch.kit.feed.InlineText
import com.agentswitch.kit.feed.Markdown
import com.agentswitch.kit.feed.ModelName

// The box, the add-sessions search and a message's Markdown, as the Mac does them since 2026-11-23. The iPhone's
// `RoomCompose.swift`, in Kotlin.

/**
 * What stands in the message box for a file it comes with (the Mac's `RoomAttachTokens`): `[Image #1]` for a picture,
 * `[File name.ext]` for anything else, put in the box when the file is picked. Deleting the token takes the file off;
 * taking the file off deletes the token. The tokens go out with the text, so the reader sees where each file belongs.
 * A file is known by a key (its path on the Mac, or the id of a picture picked on the phone).
 */
class RoomAttachTokens {
    /** Key → its token. */
    private val tokens = LinkedHashMap<String, String>()

    /** The tokens the box has shown: one not yet put in is not "deleted". */
    private val shown = HashSet<String>()

    val all: Map<String, String> get() = tokens

    /** A new token for `key` (named `name`, by default the key's last part), unlike any the box has now. */
    fun add(key: String, name: String = key.trimEnd('/').substringAfterLast('/')): String {
        tokens[key]?.let { return it }
        val used = tokens.values.toSet()
        var token: String
        if (isPicture(name)) {
            var n = 1
            do { token = "[Image #$n]"; n++ } while (token in used)
        } else {
            token = "[File $name]"
            var n = 2
            while (token in used) { token = "[File $name #$n]"; n++ }
        }
        tokens[key] = token
        return token
    }

    /** The box now says `draft`: the keys whose token was there and is gone. */
    fun gone(draft: String): List<String> {
        val out = ArrayList<String>()
        for ((key, token) in tokens) {
            if (draft.contains(token)) shown += token else if (token in shown) out += key
        }
        out.forEach { forget(it) }
        return out.sorted()
    }

    /** `key` taken off: its token, to be cut from the box. */
    fun forget(key: String): String? {
        val token = tokens.remove(key) ?: return null
        shown.remove(token)
        return token
    }

    fun clear() { tokens.clear(); shown.clear() }

    companion object {
        val pictureKinds = setOf("png", "jpg", "jpeg", "gif", "heic", "webp", "tiff", "bmp")

        fun isPicture(name: String): Boolean {
            val last = name.substringAfterLast('/')
            return last.contains('.') && last.substringAfterLast('.').lowercase() in pictureKinds
        }

        /** What goes in the box for new tokens: a space before them unless the box is empty or ends in one. */
        fun appended(new: List<String>, draft: String): String {
            if (new.isEmpty()) return draft
            val lead = if (draft.isEmpty() || draft.endsWith(" ") || draft.endsWith("\n")) "" else " "
            return draft + lead + new.joinToString(" ") + " "
        }

        /** The box without `token` (and the space after it). */
        fun removing(token: String, draft: String): String = draft.replace("$token ", "").replace(token, "")
    }
}

/** The sessions to seat, searched (the Mac's add-sessions search): by name, agent, model, profile and folder at once, case aside. */
object RoomSessionSearch {
    /** What a session is searched by. */
    fun words(t: TerminalInfo): String = listOfNotNull(
        t.name, t.harness, ModelName.harness(t.harness), t.model, t.model?.let(ModelName::display),
        t.modelNow, t.modelNow?.let(ModelName::display), t.profile?.name, t.workdir, t.cwd,
    ).joinToString("  ")

    fun filter(terminals: List<TerminalInfo>, query: String): List<TerminalInfo> {
        val q = query.trim()
        if (q.isEmpty()) return terminals
        return terminals.filter { words(it).contains(q, ignoreCase = true) }
    }
}

/**
 * The Markdown of a stretch of a message's plain text (the Mac's `RoomRich.markdown`): bold, italic, strikethrough and
 * links as they read (the feed's inline Markdown, `Markdown.inline`, which also closes CJK `**原因**：`); a heading's
 * line bold; a list's `-` / `*` / `+` a bullet. Lines stay as written (no reflowing), and what does not parse is shown
 * as typed. `code` is cut out before (RoomText). `lineStart`: the stretch begins a line.
 */
object RoomMarkdown {
    fun runs(s: String, lineStart: Boolean): InlineText {
        val out = ArrayList<InlineRun>()
        s.split("\n").forEachIndexed { i, raw ->
            if (i > 0) out += InlineRun("\n")
            var line = raw
            var heading = false
            if (i > 0 || lineStart) {
                val rest = headingRest(line)
                val bullet = if (rest == null) bulletRest(line) else null
                if (rest != null) { line = rest; heading = true }
                else if (bullet != null) { out += InlineRun(bullet.first + "• "); line = bullet.second }
            }
            // Spaces at the ends of a stretch are kept: they sit between it and a mention or `code`.
            val lead = line.takeWhile { it == ' ' || it == '\t' }
            val trail = if (lead.length == line.length) "" else line.takeLastWhile { it == ' ' || it == '\t' }
            val core = line.substring(lead.length, line.length - trail.length)
            out += InlineRun(lead)
            val parsed = if (core.isEmpty()) emptyList() else Markdown.inline(core).runs
            out += if (heading) parsed.map { it.copy(bold = true) } else parsed
            out += InlineRun(trail)
        }
        return InlineText.of(out)
    }

    internal fun headingRest(line: String): String? {
        val hashes = line.takeWhile { it == '#' }.length
        if (hashes !in 1..6) return null
        val after = line.substring(hashes)
        val space = after.takeWhile { it == ' ' || it == '\t' }.length
        if (space == 0) return null
        return after.substring(space)
    }

    internal fun bulletRest(line: String): Pair<String, String>? {
        val indent = line.takeWhile { it == ' ' || it == '\t' }
        val after = line.substring(indent.length)
        if (after.isEmpty() || after[0] !in "-*+") return null
        val rest = after.substring(1)
        val space = rest.takeWhile { it == ' ' || it == '\t' }.length
        if (space == 0) return null
        return indent to rest.substring(space)
    }
}

/**
 * A search hit as the search page shows it (2026-11-24 design: 命中前后一小段，命中的字高亮): one line around the first
 * place the words are found, `…` where it was cut, and where every place they are found stands in that line.
 */
object RoomSearch {
    data class Snippet(val text: String, val hits: List<IntRange>)

    fun snippet(text: String, query: String, around: Int = 24): Snippet {
        val line = text.replace(Regex("\\s+"), " ").trim()
        val q = query.trim()
        val first = if (q.isEmpty()) -1 else line.indexOf(q, ignoreCase = true)
        if (first < 0) {
            val cut = line.length > around * 2
            return Snippet(if (cut) line.take(around * 2) + "…" else line, emptyList())
        }
        val from = (first - around).coerceAtLeast(0)
        val to = (first + q.length + around).coerceAtMost(line.length)
        val lead = if (from > 0) "…" else ""
        val shown = lead + line.substring(from, to) + if (to < line.length) "…" else ""
        val hits = ArrayList<IntRange>()
        var at = line.indexOf(q, from, ignoreCase = true)
        while (at >= 0 && at + q.length <= to) {
            val start = at - from + lead.length
            hits += start until start + q.length
            at = line.indexOf(q, at + q.length, ignoreCase = true)
        }
        return Snippet(shown, hits)
    }
}

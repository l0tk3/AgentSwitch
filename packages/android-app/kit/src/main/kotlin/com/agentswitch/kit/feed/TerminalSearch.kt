package com.agentswitch.kit.feed

import com.agentswitch.kit.api.GitSummary
import com.agentswitch.kit.api.SessionSummary
import com.agentswitch.kit.api.TerminalInfo
import com.agentswitch.kit.api.isUnicodeWhitespace
import java.text.BreakIterator
import java.text.Normalizer
import kotlinx.serialization.Serializable

/**
 * Searching the terminals tab (docs/terminal-v0.md §1 搜索), as the web page's list does: folders by name, terminals and
 * sessions by name, and sessions by what was said in them (`said`, from the Mac's `GET /sessions/search`). The tree
 * keeps its order; what is left is what matched — a folder whose name matched with all it holds, else only its rows
 * that did — and a match in the words carries a line of them.
 */
object TerminalSearch {
    sealed class Item {
        data class Terminal(val value: TerminalInfo) : Item()
        data class Session(val value: SessionSummary) : Item()
    }

    data class Row(
        val item: Item,
        /** Its name matched. */
        val titleHit: Boolean,
        /** The words around the match in what was said, when that matched and the name did not. */
        val said: String?,
    ) {
        val id: String
            get() = when (item) {
                is Item.Terminal -> "t:${item.value.id}"
                is Item.Session -> "s:${item.value.recordID}"
            }
    }

    data class Folder(
        val cwd: String,
        /** As the tree names it, under the names of the folders it sits in ("Worktop/Codex", "Worktop/培训/靶场"). */
        val name: String,
        val git: GitSummary?,
        val nameHit: Boolean,
        val rows: List<Row>,
    ) {
        val id: String get() = cwd
    }

    data class Result(
        val folders: List<Folder>,
        val folderHits: Int,
        val titleHits: Int,
        val textHits: Int,
    ) {
        /** `// 1 folder · 2 titles · 3 in text` */
        val summary: String
            get() {
                fun n(k: Int, one: String, many: String): String = if (k == 0) "" else "$k ${if (k == 1) one else many}"
                val parts = listOf(n(folderHits, "folder", "folders"), n(titleHits, "title", "titles"), n(textHits, "in text", "in text")).filter { it.isNotEmpty() }
                return "// " + parts.joinToString(" · ")
            }
    }

    /**
     * `said`: a session's words around the match, by `harness:id` (a terminal by the session it writes). Each folder
     * with terminals or sessions of its own, named by the folders it sits in ("Worktop/培训/靶场"): a match on a
     * folder's name keeps every folder under it as well.
     */
    fun run(tree: List<TerminalTree.Folder>, query: String, said: Map<String, String> = emptyMap()): Result {
        val q = query.trim { it.isUnicodeWhitespace() }.lowercase()
        if (q.isEmpty()) return Result(emptyList(), 0, 0, 0)
        val folders = mutableListOf<Folder>()
        var folderHits = 0
        var titleHits = 0
        var textHits = 0
        for ((group, name) in TerminalTree.flatten(tree)) {
            if (!group.holdsOwn) continue
            val nameHit = name.lowercase().contains(q) || tilde(group.cwd).lowercase().contains(q)
            val rows = mutableListOf<Row>()
            for (t in group.terminals) {
                val title = t.name.lowercase().contains(q)
                val words = t.agentSessionId?.let { said["${t.harness}:$it"] }
                if (nameHit || title || words != null) rows.add(Row(Item.Terminal(t), title, if (title) null else words))
            }
            for (s in group.sessions) {
                val title = s.displayTitle.lowercase().contains(q)
                val words = said["${s.harness}:${s.sessionId}"]
                if (nameHit || title || words != null) rows.add(Row(Item.Session(s), title, if (title) null else words))
            }
            if (!(nameHit || rows.isNotEmpty())) continue
            if (nameHit) folderHits += 1
            titleHits += rows.count { it.titleHit }
            textHits += rows.count { it.said != null }
            folders.add(Folder(group.cwd, name, group.git, nameHit, rows))
        }
        return Result(folders, folderHits, titleHits, textHits)
    }

    /** `text` folded for a search: case and diacritics aside, with where each folded unit stands in `text`. */
    private class Folded(val text: String, val starts: IntArray, val ends: IntArray)

    private fun fold(text: String): Folded {
        val sb = StringBuilder()
        val starts = ArrayList<Int>()
        val ends = ArrayList<Int>()
        var i = 0
        while (i < text.length) {
            val cp = text.codePointAt(i)
            val len = Character.charCount(cp)
            val piece = Normalizer.normalize(String(Character.toChars(cp)), Normalizer.Form.NFD)
                .filter { Character.getType(it) != Character.NON_SPACING_MARK.toInt() }.lowercase()
            for (c in piece) { sb.append(c); starts.add(i); ends.add(i + len) }
            i += len
        }
        return Folded(sb.toString(), starts.toIntArray(), ends.toIntArray())
    }

    /** Where `query` is in `text` (case and diacritics aside), for marking it: UTF-16 `start until end` (Swift's `Range<String.Index>`). */
    fun match(query: String, text: String): IntRange? {
        val q = query.trim { it.isUnicodeWhitespace() }
        if (q.isEmpty()) return null
        val folded = fold(text)
        val needle = fold(q).text
        if (needle.isEmpty()) return null
        val at = folded.text.indexOf(needle)
        if (at < 0) return null
        return folded.starts[at] until folded.ends[at + needle.length - 1]
    }

    /** The words from a little before the match: the row is narrow, and the match must show. */
    fun near(query: String, text: String): String {
        val range = match(query, text) ?: return text
        val bounds = ArrayList<Int>()
        val it = BreakIterator.getCharacterInstance()
        it.setText(text)
        var b = it.first()
        while (b != BreakIterator.DONE) { bounds.add(b); b = it.next() }
        val index = bounds.indexOfLast { it <= range.first }
        val before = index
        if (before <= 8) return text
        val start = bounds[index - 6]
        return "…" + text.substring(start).dropWhile { it == '…' }
    }

    /** `/Users/<name>/x` as `~/x`, as the web page shows paths. */
    internal fun tilde(path: String): String = TerminalTree.tilde(path)
}

/** A session whose words matched a search (`GET /sessions/search`). */
@Serializable
data class SessionHit(
    val harness: String,
    val id: String,
    val excerpt: String,
)

@Serializable
internal data class SessionHits(val hits: List<SessionHit>)

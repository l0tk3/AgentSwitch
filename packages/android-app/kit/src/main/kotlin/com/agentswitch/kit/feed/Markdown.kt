package com.agentswitch.kit.feed

import com.agentswitch.kit.support.unicodePattern
import java.util.regex.Pattern

/**
 * One block of model output. Executors and the router write Markdown; the phone shows it by blocks, with an inline
 * parser (bold, italics, code, links) inside each. Images are never loaded: only their alt text.
 *
 * (Swift used Foundation's inline Markdown parser; here `Markdown.inline` is a parser of this module's own that
 * produces `InlineText`, the neutral model the app draws.)
 */
sealed class MarkdownBlock {
    data class Heading(val level: Int, val text: String) : MarkdownBlock()
    /** Single line breaks are kept: model output uses them on purpose. */
    data class Paragraph(val text: String) : MarkdownBlock()
    data class ListItem(val depth: Int, val ordinal: Int?, val text: String) : MarkdownBlock()
    data class Quote(val text: String) : MarkdownBlock()
    data class Code(val language: String?, val text: String) : MarkdownBlock()
    data class Table(val header: List<String>, val rows: List<List<String>>) : MarkdownBlock()
    data object Rule : MarkdownBlock()
}

/** A run of text with the same look all through (Swift: a run of an `AttributedString`). */
data class InlineRun(
    val text: String,
    val bold: Boolean = false,
    val italic: Boolean = false,
    /** Monospaced (Swift: the `.code` inline presentation intent). */
    val code: Boolean = false,
    val strikethrough: Boolean = false,
    /** The link's target (an absolute address), or null. */
    val link: String? = null,
)

/**
 * Styled text: runs, none empty, no two neighbours alike (as an `AttributedString`'s runs). Build it with `of`, which
 * drops empty runs and joins neighbours with the same look.
 */
data class InlineText(val runs: List<InlineRun>) {
    /** The characters without their looks (Swift: `String(attributed.characters)`). */
    val text: String get() = runs.joinToString("") { it.text }

    operator fun plus(other: InlineText): InlineText = of(runs + other.runs)

    companion object {
        val empty = InlineText(emptyList())

        fun of(runs: List<InlineRun>): InlineText {
            val out = ArrayList<InlineRun>()
            for (run in runs) {
                if (run.text.isEmpty()) continue
                val last = out.lastOrNull()
                if (last != null && last.copy(text = "") == run.copy(text = "")) out[out.size - 1] = last.copy(text = last.text + run.text)
                else out.add(run)
            }
            return InlineText(out)
        }

        fun plain(text: String): InlineText = of(listOf(InlineRun(text)))
    }
}

object Markdown {
    /**
     * The blocks of `source`: line based, the subset models write (ATX headings, `-`/`*`/`+` and `1.`/`1)` lists
     * nested by indentation, fenced code, `>` quotes, pipe tables with a separator row, rules, paragraphs).
     */
    fun blocks(source: String): List<MarkdownBlock> =
        BlockParser(source.replace("\r\n", "\n").split("\n")).parse()

    /** Blocks of a stored text as the phone shows it: the sealer's legend cut off, ciphertexts as locks. */
    fun readableBlocks(source: String): List<MarkdownBlock> = blocks(MessageDisplay.readable(source))

    /**
     * Inline Markdown of one block; the text as is when it does not parse. Only http(s) links stay links: a model
     * could otherwise put this app's own `agentswitch://pair` link (or any other scheme) behind friendly text.
     * Images are only their alt text; raw HTML stays text.
     */
    fun inline(text: String): InlineText {
        val source = cjkEmphasis(text)
        var runs = InlineParser.parse(source)
        runs = runs.map { if (it.link != null && !isWebLink(it.link)) it.copy(link = null) else it }
        runs = relinked(InlineText.of(runs)).runs
        if (source != text) runs = runs.map { it.copy(text = it.text.replace(zeroWidthSpace, "")) }
        return InlineText.of(runs)
    }

    private const val zeroWidthSpace = "\u200B"

    /**
     * `**未解决阻塞。**本次`: CommonMark does not close a `**` that follows punctuation and precedes a letter (or open
     * one the other way round), which Chinese text does all the time. A zero-width space between the punctuation and
     * the `**` makes it count (it is neither space nor punctuation); inline() takes it out again.
     */
    private val closingAfterPunctuation: Pattern = unicodePattern("(\\p{P})(\\*\\*)(?=[^\\s\\p{P}*])")
    private val openingBeforePunctuation: Pattern = unicodePattern("(?<=[^\\s\\p{P}*])(\\*\\*)(\\p{P})")

    internal fun cjkEmphasis(text: String): String {
        if (!text.contains("**")) return text
        var out = text
        for (regex in listOf(closingAfterPunctuation, openingBeforePunctuation)) {
            out = regex.matcher(out).replaceAll("\$1\u200B\$2")
        }
        return out
    }

    /** Whether a link's address is http or https (Swift took a `URL`; here the address as text). */
    fun isWebLink(url: String): Boolean {
        val scheme = Regex("^([A-Za-z][A-Za-z0-9+.\\-]*):").find(url)?.groupValues?.get(1)?.lowercase() ?: return false
        return scheme == "http" || scheme == "https"
    }

    /**
     * Addresses written out, linked where they stand (2026-10-03, user: 手机上现在点击和复制链接还是费劲). The inline
     * parser links a bare address up to the next space, and Chinese text has none after it: `https://example.com/a。然后`
     * came out as one link to an address nobody wrote, the next address inside it. Such a link is cut at the first
     * character that is not an address's and what follows is read again. An address in backticks is a link too.
     */
    internal fun relinked(input: InlineText): InlineText {
        val out = ArrayList<InlineRun>()
        for (run in input.runs) {
            val text = run.text
            val written = LinkText.schemeStart(text) == 0
            val base: InlineRun
            if (run.link != null) {
                // `[说明](https://…)` is as its writer made it; only an address standing as its own text is read again.
                if (!written || text.all { LinkText.inAddress(it) }) { out.add(run); continue }
                base = run.copy(link = null)
            } else {
                if (!(run.code && written && LinkText.webAddresses(text).firstOrNull()?.address == text)) { out.add(run); continue }
                base = run
            }
            var at = 0
            for (found in LinkText.webAddresses(text)) {
                if (found.start > at) out.add(base.copy(text = text.substring(at, found.start)))
                out.add(base.copy(text = text.substring(found.start, found.end), link = found.address))
                at = found.end
            }
            if (at < text.length) out.add(base.copy(text = text.substring(at)))
        }
        return InlineText.of(out)
    }

    /**
     * The web addresses in a text as the phone shows it, in the order they stand, each once: what a long press on it
     * offers to open or copy. Those in code are read too (a command's address is as good to open).
     */
    fun links(source: String, limit: Int = 6): List<TappedLink> {
        val out = mutableListOf<TappedLink>()
        fun add(address: String) {
            val link = TappedLink.fromAddress(address)
            if (link == null || link !is TappedLink.Web || link in out) return
            out.add(link)
        }
        fun read(text: String) { for (run in inline(text).runs) run.link?.let { add(it) } }
        for (block in readableBlocks(source)) {
            when (block) {
                is MarkdownBlock.Heading -> read(block.text)
                is MarkdownBlock.Paragraph -> read(block.text)
                is MarkdownBlock.Quote -> read(block.text)
                is MarkdownBlock.ListItem -> read(block.text)
                is MarkdownBlock.Code -> for (found in LinkText.webAddresses(block.text)) add(found.address)
                is MarkdownBlock.Table -> for (cell in block.header + block.rows.flatten()) read(cell)
                MarkdownBlock.Rule -> {}
            }
        }
        return out.take(limit)
    }

    /**
     * One styled text for a preview or an event line (a text with a line limit): list markers, bold headings,
     * monospaced code, table rows joined with " · ".
     */
    fun flattened(source: String): InlineText {
        var out = InlineText.empty
        for ((i, block) in readableBlocks(source).withIndex()) {
            if (i > 0) out += InlineText.plain("\n")
            out += flat(block)
        }
        return out
    }

    private fun flat(block: MarkdownBlock): InlineText = when (block) {
        is MarkdownBlock.Heading -> {
            // Swift assigns the intent to the whole string: strong replaces whatever each run had (links stay).
            InlineText.of(inline(block.text).runs.map { it.copy(bold = true, italic = false, code = false, strikethrough = false) })
        }
        is MarkdownBlock.Paragraph -> inline(block.text)
        is MarkdownBlock.Quote -> inline(block.text)
        is MarkdownBlock.ListItem ->
            InlineText.plain("  ".repeat(block.depth) + (block.ordinal?.let { "$it. " } ?: "• ")) + inline(block.text)
        is MarkdownBlock.Code -> InlineText.of(listOf(InlineRun(block.text, code = true)))
        is MarkdownBlock.Table -> {
            var table = InlineText.empty
            for ((r, row) in (listOf(block.header) + block.rows).withIndex()) {
                if (r > 0) table += InlineText.plain("\n")
                for ((c, cell) in row.withIndex()) {
                    if (c > 0) table += InlineText.plain(" · ")
                    table += inline(cell)
                }
            }
            table
        }
        MarkdownBlock.Rule -> InlineText.plain("—")
    }
}

/** Foundation's `.whitespaces` set: tab and the space separators (not line breaks). */
internal fun Char.isInlineSpace(): Boolean = this == '\t' || Character.getType(this) == Character.SPACE_SEPARATOR.toInt()

/** `trimmingCharacters(in: .whitespaces)`. */
internal fun String.trimSpaces(): String {
    var a = 0
    var b = length
    while (a < b && this[a].isInlineSpace()) a++
    while (b > a && this[b - 1].isInlineSpace()) b--
    return substring(a, b)
}

private class BlockParser(private val lines: List<String>) {
    private class Item(val depth: Int, val ordinal: Int?, val lines: MutableList<String>, val indent: Int)
    private class Marker(val indent: Int, val ordinal: Int?, val text: String)

    private var i = 0
    private val out = mutableListOf<MarkdownBlock>()
    private var paragraph = mutableListOf<String>()
    /** The open list item: its depth, ordinal, text lines and the column its marker starts at. */
    private var item: Item? = null
    /** Marker columns of the enclosing list items, outermost first. */
    private var listIndents = mutableListOf<Int>()

    fun parse(): List<MarkdownBlock> {
        while (i < lines.size) {
            val line = lines[i]
            val trimmed = line.trimSpaces()
            val open = MarkdownFence.opening(line)
            if (open != null) { fence(open); continue }
            if (trimmed.isEmpty()) { flush(); i += 1; continue }
            val heading = heading(trimmed)
            if (heading != null) { endList(); out.add(heading); i += 1; continue }
            if (isRule(trimmed)) { endList(); out.add(MarkdownBlock.Rule); i += 1; continue }
            if (trimmed.contains("|") && i + 1 < lines.size && isTableSeparator(lines[i + 1])) { table(); continue }
            if (trimmed.startsWith(">")) { quote(); continue }
            val marker = listMarker(line)
            if (marker != null) { startItem(marker); i += 1; continue }
            val current = item
            if (current != null && indent(line) > current.indent) {
                current.lines.add(trimmed)
            } else {
                if (item != null) endList()
                paragraph.add(trimmed)
            }
            i += 1
        }
        flush()
        return out
    }

    private fun flush() {
        if (paragraph.isNotEmpty()) { out.add(MarkdownBlock.Paragraph(paragraph.joinToString("\n"))); paragraph = mutableListOf() }
        item?.let { out.add(MarkdownBlock.ListItem(it.depth, it.ordinal, it.lines.joinToString("\n"))); item = null }
    }

    private fun endList() {
        flush()
        listIndents = mutableListOf()
    }

    private fun startItem(marker: Marker) {
        if (paragraph.isNotEmpty()) endList() else flush()
        while (listIndents.isNotEmpty() && listIndents.last() > marker.indent) listIndents.removeAt(listIndents.size - 1)
        if (listIndents.lastOrNull() != marker.indent) listIndents.add(marker.indent)
        item = Item(listIndents.size - 1, marker.ordinal, mutableListOf(marker.text), marker.indent)
    }

    /** A fenced block (MarkdownFence): to a bare fence of the same mark and at least its length, or to the end. */
    private fun fence(open: MarkdownFence) {
        endList()
        val body = mutableListOf<String>()
        i += 1
        while (i < lines.size && !open.closes(lines[i])) {
            body.add(open.body(lines[i]))
            i += 1
        }
        i += 1   // the closing fence, or past the end
        while (body.lastOrNull()?.trimSpaces()?.isEmpty() == true) body.removeAt(body.size - 1)
        out.add(MarkdownBlock.Code(open.language, body.joinToString("\n")))
    }

    private fun table() {
        endList()
        val header = cells(lines[i])
        i += 2
        val rows = mutableListOf<List<String>>()
        while (i < lines.size && lines[i].contains("|") && lines[i].trimSpaces().isNotEmpty()) {
            rows.add(cells(lines[i]))
            i += 1
        }
        out.add(MarkdownBlock.Table(header, rows))
    }

    private fun quote() {
        endList()
        val body = mutableListOf<String>()
        while (i < lines.size) {
            val trimmed = lines[i].trimSpaces()
            if (!trimmed.startsWith(">")) break
            val rest = trimmed.drop(1)
            body.add(if (rest.startsWith(" ")) rest.drop(1) else rest)
            i += 1
        }
        out.add(MarkdownBlock.Quote(body.joinToString("\n")))
    }

    // MARK: - line tests

    private val headingPattern = unicodePattern("^(#{1,6})\\s+(.*?)\\s*#*$")
    private val listPattern = unicodePattern("^([ \\t]*)([-*+]|(\\d{1,9})[.)])\\s+(.*)$")
    private val separatorCell = Pattern.compile("^:?-{3,}:?$")

    private fun heading(trimmed: String): MarkdownBlock? {
        val m = headingPattern.matcher(trimmed)
        if (!m.find()) return null
        return MarkdownBlock.Heading(m.group(1).length, m.group(2))
    }

    private fun isRule(trimmed: String): Boolean {
        val chars = trimmed.filter { !it.isWhitespace() }
        val first = chars.firstOrNull() ?: return false
        if (first !in "-*_" || chars.length < 3) return false
        return chars.all { it == first }
    }

    private fun isTableSeparator(line: String): Boolean {
        val cells = cells(line)
        return cells.isNotEmpty() && cells.all { separatorCell.matcher(it).find() }
    }

    private fun cells(line: String): List<String> {
        var row = line.trimSpaces()
        if (row.startsWith("|")) row = row.drop(1)
        if (row.endsWith("|")) row = row.dropLast(1)
        return row.split("|").map { it.trimSpaces() }
    }

    private fun listMarker(line: String): Marker? {
        val m = listPattern.matcher(line)
        if (!m.find()) return null
        val digits = m.group(3)
        // Swift's Int(...) takes ASCII digits only.
        val ordinal = if (digits != null && digits.all { it in '0'..'9' }) digits.toIntOrNull() else null
        return Marker(indent(m.group(1)), ordinal, m.group(4))
    }

    /** Leading columns, a tab counting as four. */
    private fun indent(line: String): Int {
        var n = 0
        for (ch in line) {
            if (ch == ' ') n += 1 else if (ch == '\t') n += 4 else break
        }
        return n
    }
}

/**
 * The inline parser: CommonMark's inline rules (code spans, `*` `_` emphasis with the flanking rules, `~` strikethrough,
 * inline links, images as alt text, `<…>` autolinks, backslash escapes, entities) and GFM's bare-address autolinks
 * (`http(s)://`, `ftp://`, `www.`), which is what Foundation's inline-only parser does with whitespace preserved.
 * Raw HTML is not interpreted: it stays text. Reference links are not supported (no definitions in a block).
 */
internal object InlineParser {
    private class Node(var text: String) {
        var bold = false
        var italic = false
        var strike = false
        var code = false
        var link: String? = null

        // a delimiter run (`*`, `_`, `~`) still undecided
        var isDelim = false
        var ch = ' '
        var count = 0
        var origCount = 0
        var canOpen = false
        var canClose = false

        // a `[` or `![` still undecided
        var isBracket = false
        var image = false
        var active = true
    }

    fun parse(s: String): List<InlineRun> {
        val nodes = ArrayList<Node>()
        val brackets = ArrayList<Node>()
        val plain = StringBuilder()
        fun flushPlain() { if (plain.isNotEmpty()) { nodes.add(Node(plain.toString())); plain.setLength(0) } }
        var i = 0
        while (i < s.length) {
            val c = s[i]
            when {
                c == '\\' && i + 1 < s.length && s[i + 1] == '\n' -> { plain.append('\n'); i += 2 }
                c == '\\' && i + 1 < s.length && isAsciiPunct(s[i + 1]) -> { plain.append(s[i + 1]); i += 2 }
                c == '`' -> {
                    var n = 0
                    while (i + n < s.length && s[i + n] == '`') n++
                    val close = closingTicks(s, n, i + n)
                    if (close < 0) { plain.append(s, i, i + n); i += n } else {
                        flushPlain()
                        var code = s.substring(i + n, close).replace('\n', ' ')
                        if (code.length >= 2 && code.first() == ' ' && code.last() == ' ' && code.any { it != ' ' }) code = code.substring(1, code.length - 1)
                        nodes.add(Node(code).also { it.code = true })
                        i = close + n
                    }
                }
                c == '*' || c == '_' || c == '~' -> {
                    var n = 0
                    while (i + n < s.length && s[i + n] == c) n++
                    if (c == '~' && n > 2) { plain.append(s, i, i + n); i += n; continue }
                    flushPlain()
                    val before = if (i == 0) ' '.code else s.codePointBefore(i)
                    val after = if (i + n >= s.length) ' '.code else s.codePointAt(i + n)
                    val beforeWs = isUnicodeSpace(before)
                    val afterWs = isUnicodeSpace(after)
                    val beforeP = isPunct(before)
                    val afterP = isPunct(after)
                    val left = !afterWs && (!afterP || beforeWs || beforeP)
                    val right = !beforeWs && (!beforeP || afterWs || afterP)
                    val node = Node(c.toString().repeat(n))
                    node.isDelim = true
                    node.ch = c
                    node.count = n
                    node.origCount = n
                    if (c == '_') {
                        node.canOpen = left && (!right || beforeP)
                        node.canClose = right && (!left || afterP)
                    } else {
                        node.canOpen = left
                        node.canClose = right
                    }
                    nodes.add(node)
                    i += n
                }
                c == '[' || (c == '!' && i + 1 < s.length && s[i + 1] == '[') -> {
                    flushPlain()
                    val image = c == '!'
                    val node = Node(if (image) "![" else "[")
                    node.isBracket = true
                    node.image = image
                    nodes.add(node)
                    brackets.add(node)
                    i += if (image) 2 else 1
                }
                c == ']' -> {
                    val opener = brackets.lastOrNull()
                    if (opener == null) { plain.append(']'); i += 1; continue }
                    if (!opener.active) { brackets.removeAt(brackets.size - 1); opener.isBracket = false; plain.append(']'); i += 1; continue }
                    val dest = inlineLinkTail(s, i + 1)
                    if (dest == null) { brackets.removeAt(brackets.size - 1); opener.isBracket = false; plain.append(']'); i += 1; continue }
                    flushPlain()
                    val at = nodes.indexOf(opener)
                    processEmphasis(nodes, at + 1)
                    for (k in at + 1 until nodes.size) {
                        val n = nodes[k]
                        // Foundation keeps only the text of what stands inside a link or an image: its own looks are dropped.
                        n.bold = false; n.italic = false; n.strike = false; n.code = false
                        n.link = if (opener.image) null else dest.first
                    }
                    opener.text = ""
                    opener.isBracket = false
                    brackets.removeAt(brackets.size - 1)
                    if (!opener.image) for (b in brackets) if (!b.image) b.active = false
                    i = dest.second
                }
                c == '<' -> {
                    val auto = autolink(s, i)
                    if (auto == null) { plain.append(c); i += 1 } else {
                        flushPlain()
                        nodes.add(Node(auto.first).also { it.link = auto.second })
                        i = auto.third
                    }
                }
                c == '&' -> {
                    val entity = entity(s, i)
                    if (entity == null) { plain.append(c); i += 1 } else { plain.append(entity.first); i = entity.second }
                }
                else -> { plain.append(c); i += 1 }
            }
        }
        flushPlain()
        processEmphasis(nodes, 0)
        val runs = nodes.map { InlineRun(it.text, it.bold, it.italic, it.code, it.strike, it.link) }
        return autolinked(InlineText.of(runs).runs)
    }

    // MARK: emphasis

    private fun processEmphasis(nodes: List<Node>, from: Int) {
        var c = from
        while (c < nodes.size) {
            val closer = nodes[c]
            if (!closer.isDelim || !closer.canClose || closer.count == 0) { c++; continue }
            var found = -1
            var o = c - 1
            while (o >= from) {
                val op = nodes[o]
                if (op.isDelim && op.canOpen && op.ch == closer.ch && op.count > 0 && matches(op, closer)) { found = o; break }
                o--
            }
            if (found < 0) {
                if (!closer.canOpen) closer.isDelim = false
                c++
                continue
            }
            val opener = nodes[found]
            val use = if (closer.ch == '~') closer.count else if (opener.count >= 2 && closer.count >= 2) 2 else 1
            for (k in found + 1 until c) {
                val n = nodes[k]
                n.isDelim = false
                when {
                    closer.ch == '~' -> n.strike = true
                    use == 2 -> n.bold = true
                    else -> n.italic = true
                }
            }
            opener.count -= use
            closer.count -= use
            opener.text = opener.ch.toString().repeat(opener.count)
            closer.text = closer.ch.toString().repeat(closer.count)
            if (closer.count == 0) c++
        }
        for (k in from until nodes.size) nodes[k].isDelim = false
    }

    private fun matches(opener: Node, closer: Node): Boolean {
        if (opener.ch == '~') return opener.count == closer.count
        return !((opener.canClose || closer.canOpen) && (opener.origCount + closer.origCount) % 3 == 0 &&
            !(opener.origCount % 3 == 0 && closer.origCount % 3 == 0))
    }

    // MARK: pieces

    private fun closingTicks(s: String, n: Int, from: Int): Int {
        var j = from
        while (j < s.length) {
            if (s[j] != '`') { j++; continue }
            var m = 0
            while (j + m < s.length && s[j + m] == '`') m++
            if (m == n) return j
            j += m
        }
        return -1
    }

    /** `(destination "title")` at `at` (just after a `]`): the destination as an address, and where the link ends. */
    private fun inlineLinkTail(s: String, at: Int): Pair<String, Int>? {
        var i = at
        if (i >= s.length || s[i] != '(') return null
        i++
        i = skipSpaceAndLine(s, i)
        val dest = StringBuilder()
        if (i < s.length && s[i] == '<') {
            i++
            while (true) {
                if (i >= s.length) return null
                val c = s[i]
                if (c == '\n' || c == '<') return null
                if (c == '>') { i++; break }
                if (c == '\\' && i + 1 < s.length && isAsciiPunct(s[i + 1])) { dest.append(s[i + 1]); i += 2; continue }
                dest.append(c); i++
            }
        } else {
            var depth = 0
            while (i < s.length) {
                val c = s[i]
                if (c == '\\' && i + 1 < s.length && isAsciiPunct(s[i + 1])) { dest.append(s[i + 1]); i += 2; continue }
                if (c == '(') depth++
                if (c == ')') { if (depth == 0) break; depth-- }
                if (c == ' ' || c == '\n' || c == '\t' || c.code < 0x20) break
                dest.append(c); i++
            }
            if (depth != 0) return null
        }
        val afterDest = i
        i = skipSpaceAndLine(s, i)
        if (i > afterDest && i < s.length && (s[i] == '"' || s[i] == '\'' || s[i] == '(')) {
            val closeCh = if (s[i] == '(') ')' else s[i]
            var j = i + 1
            while (j < s.length && s[j] != closeCh) { if (s[j] == '\\' && j + 1 < s.length) j++; j++ }
            if (j >= s.length) return null
            i = skipSpaceAndLine(s, j + 1)
        }
        if (i >= s.length || s[i] != ')') return null
        return Pair(escapeHref(entityDecoded(dest.toString())), i + 1)
    }

    private fun skipSpaceAndLine(s: String, from: Int): Int {
        var i = from
        while (i < s.length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n')) i++
        return i
    }

    /** `<scheme:…>` and `<email>`: the text, the link's target, and where it ends. */
    private fun autolink(s: String, at: Int): Triple<String, String, Int>? {
        val end = s.indexOf('>', at + 1)
        if (end < 0) return null
        val body = s.substring(at + 1, end)
        if (uriAutolink.matcher(body).matches()) return Triple(body, escapeHref(body), end + 1)
        if (emailAutolink.matcher(body).matches()) return Triple(body, "mailto:$body", end + 1)
        return null
    }

    private val uriAutolink: Pattern = Pattern.compile("[A-Za-z][A-Za-z0-9+.\\-]{1,31}:[^\\s<>]*")
    private val emailAutolink: Pattern = Pattern.compile("[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*")

    private val entityNames = mapOf(
        "amp" to "&", "lt" to "<", "gt" to ">", "quot" to "\"", "apos" to "'", "nbsp" to " ", "copy" to "©", "reg" to "®",
        "hellip" to "…", "mdash" to "—", "ndash" to "–", "lsquo" to "‘", "rsquo" to "’", "ldquo" to "“", "rdquo" to "”",
        "middot" to "·", "times" to "×", "trade" to "™", "deg" to "°", "laquo" to "«", "raquo" to "»", "bull" to "•",
    )
    private val entityPattern: Pattern = Pattern.compile("&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});")

    /** An entity at `at`: its text and where it ends; null when it is not one this knows. */
    private fun entity(s: String, at: Int): Pair<String, Int>? {
        val m = entityPattern.matcher(s)
        m.region(at, s.length)
        if (!m.lookingAt()) return null
        val name = m.group(1)
        val text = if (name.startsWith("#")) {
            val cp = if (name[1] == 'x' || name[1] == 'X') name.substring(2).toIntOrNull(16) else name.substring(1).toIntOrNull()
            if (cp == null || cp == 0 || cp > 0x10FFFF || cp in 0xD800..0xDFFF) "�" else String(Character.toChars(cp))
        } else entityNames[name] ?: return null
        return Pair(text, m.end())
    }

    private fun entityDecoded(text: String): String {
        if (!text.contains('&')) return text
        val sb = StringBuilder()
        var i = 0
        while (i < text.length) {
            val e = if (text[i] == '&') entity(text, i) else null
            if (e != null) { sb.append(e.first); i = e.second } else { sb.append(text[i]); i++ }
        }
        return sb.toString()
    }

    /** An address as the parser writes it out: bytes outside the URL-safe set percent-encoded, `%` kept. */
    private fun escapeHref(url: String): String {
        val safe = "-_.~!#$%&'()*+,/:;=?@"
        val sb = StringBuilder()
        for (b in url.toByteArray(Charsets.UTF_8)) {
            val ch = (b.toInt() and 0xFF).toChar()
            if (b >= 0 && (ch.isLetterOrDigit() || ch in safe)) sb.append(ch)
            else sb.append('%').append("0123456789ABCDEF"[(b.toInt() shr 4) and 0xF]).append("0123456789ABCDEF"[b.toInt() and 0xF])
        }
        return sb.toString()
    }

    // MARK: bare addresses

    private fun autolinked(runs: List<InlineRun>): List<InlineRun> {
        val out = ArrayList<InlineRun>()
        for (run in runs) {
            if (run.code || run.link != null) { out.add(run); continue }
            val text = run.text
            var at = 0
            var from = 0
            while (from < text.length) {
                val m = bareAddress(text, from)
                if (m == null) break
                if (m.start > at) out.add(run.copy(text = text.substring(at, m.start)))
                out.add(run.copy(text = text.substring(m.start, m.end), link = m.target))
                at = m.end
                from = m.end
            }
            if (at < text.length) out.add(run.copy(text = text.substring(at)))
        }
        return out
    }

    private class Bare(val start: Int, val end: Int, val target: String)

    private fun bareAddress(t: String, from: Int): Bare? {
        var i = from
        while (i < t.length) {
            // `www.`
            if ((t[i] == 'w' || t[i] == 'W') && t.regionMatches(i, "www.", 0, 4, ignoreCase = true)) {
                val prev = if (i > 0) t[i - 1] else null
                if (prev == null || prev.isAsciiSpace() || prev in "*_~(") {
                    val end = linkEnd(t, i, i + 4, requireDot = true)
                    if (end > i) return Bare(i, end, "http://" + escapeHref(t.substring(i, end)))
                }
            }
            // `scheme://`
            if (t[i] == ':' && t.startsWith("//", i + 1)) {
                var s = i
                while (s > from && t[s - 1].isAsciiLetter()) s--
                val scheme = t.substring(s, i).lowercase()
                if (scheme == "http" || scheme == "https" || scheme == "ftp") {
                    val end = linkEnd(t, s, i + 3, requireDot = false)
                    if (end > i + 3) return Bare(s, end, escapeHref(t.substring(s, end)))
                }
            }
            i++
        }
        return null
    }

    private fun Char.isAsciiLetter() = this in 'a'..'z' || this in 'A'..'Z'
    private fun Char.isAsciiSpace() = this == ' ' || this == '\t' || this == '\n' || this == '\r' || this == '\u000B' || this == '\u000C'

    /** Where the address that starts at `start` (its domain at `domainFrom`) ends; `start` when it is none. */
    private fun linkEnd(t: String, start: Int, domainFrom: Int, requireDot: Boolean): Int {
        var dots = 0
        var u1 = 0
        var u2 = 0
        var j = domainFrom
        while (j < t.length) {
            val c = t[j]
            if (c == '\\' && j < t.length - 1) { j += 2; continue }
            if (c == '_') u2++
            else if (c == '.') { u1 = u2; u2 = 0; dots++ }
            else if (c == '-' ) { }
            else if (!isHostChar(t.codePointAt(j))) break
            j += Character.charCount(t.codePointAt(j))
        }
        if (j == domainFrom && !requireDot) return start
        if (u1 > 0 || u2 > 0) return start
        if (requireDot && dots == 0) return start
        var end = j
        while (end < t.length && !t[end].isAsciiSpace() && t[end] != '<') end++
        end = trimEnd(t, start, end)
        return if (end > domainFrom) end else start
    }

    private fun trimEnd(t: String, start: Int, endIn: Int): Int {
        var end = endIn
        while (end > start) {
            val close = t[end - 1]
            if (close in "?!.,:*_~'\"") { end--; continue }
            if (close == ';') {
                var k = end - 2
                while (k > start && t[k].isAsciiLetter()) k--
                if (k < end - 2 && t[k] == '&') end = k else end--
                continue
            }
            if (close == ')') {
                val open = t.substring(start, end).count { it == '(' }
                val closing = t.substring(start, end).count { it == ')' }
                if (closing <= open) break
                end--
                continue
            }
            break
        }
        return end
    }

    private fun isHostChar(cp: Int): Boolean = !isUnicodeSpace(cp) && !isPunct(cp)

    // MARK: character classes

    private fun isAsciiPunct(c: Char) = c in "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"

    private fun isUnicodeSpace(cp: Int): Boolean =
        cp == 0x09 || cp == 0x0A || cp == 0x0C || cp == 0x0D || Character.getType(cp) == Character.SPACE_SEPARATOR.toInt()

    private fun isPunct(cp: Int): Boolean {
        if (cp < 128) return isAsciiPunct(cp.toChar())
        return when (Character.getType(cp).toByte()) {
            Character.CONNECTOR_PUNCTUATION, Character.DASH_PUNCTUATION, Character.START_PUNCTUATION, Character.END_PUNCTUATION,
            Character.INITIAL_QUOTE_PUNCTUATION, Character.FINAL_QUOTE_PUNCTUATION, Character.OTHER_PUNCTUATION -> true
            else -> false
        }
    }
}

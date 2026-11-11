package com.agentswitch.kit.feed

import com.agentswitch.kit.api.graphemeCount
import com.agentswitch.kit.api.isUnicodeWhitespace

// The links on a terminal's screen (docs/terminal-v0.md §1 iPhone 链接, 2026-10-03): found in the rows as the screen
// holds them, cell by cell, so a touch can be matched to one. Three kinds are read: an OSC 8 link (the agents' status
// lines), a web address written out, and a path of the Mac's. An address or a path that runs over a line's end is one
// link: the terminal's own wrap, and the break an agent makes itself (Claude Code and Codex wrap by words and cut a word
// only when it is longer than a whole line, so the line it was cut on is filled to the width and the rest starts the
// next, indented), and for a path the wrap of a column of its own (Claude Code's row for a file on a narrow screen: the
// mark, the path and the size each wrapped in its column, so the path's rest starts under its first cell, whatever else
// the row holds). A touch need not be exact: the nearest link within a finger's slop takes it.
//
// A row is a `List<String>`, one string a cell (Swift's `[Character]`; a cell may hold several code units).

/** A link on the screen and the cells it covers. */
data class ScreenLink(
    val link: TappedLink,
    val spans: List<Span>,
    /**
     * For a path that may or may not go on over the next line: the other readings, longest first. The phone cannot
     * look on the Mac's disk; the Mac says which one is there (`404` for one that is not).
     */
    val alternates: List<TappedLink> = emptyList(),
) {
    /** Cells of one row: its index among the rows given, and the columns (`a until b`). */
    data class Span(val row: Int, val columns: IntRange)
}

object TerminalLinks {
    /** The second cell of a wide character (CJK takes two), in a row given cell by cell. */
    const val wideTail: String = "\uFFFF"

    /** Lines a link may run on over. */
    const val reach = 4

    /** An OSC 8 link's cells on one row, with the address it carries. */
    data class Explicit(val row: Int, val columns: IntRange, val address: String)

    /** A cell's size in points (Swift's `(width:, height:)` tuple). */
    data class CellSize(val width: Double, val height: Double)

    /** The address in an OSC 8 payload as the terminal keeps it (`params;address`). */
    fun address(payload: String): String? {
        val cut = payload.indexOf(';')
        if (cut < 0) return null
        val address = payload.substring(cut + 1)
        return address.ifEmpty { null }
    }

    private val IntRange.lowerBound: Int get() = first
    private val IntRange.upperBound: Int get() = last + 1
    private val IntRange.count: Int get() = if (isEmpty()) 0 else last - first + 1
    private fun IntRange.overlaps(other: IntRange): Boolean =
        !isEmpty() && !other.isEmpty() && first <= other.last && other.first <= last

    /**
     * The links in `rows` (a string a cell; `wideTail` for a wide character's second cell, NUL or a space for an
     * empty one). `wrapped`: the rows the terminal itself continued from the row above. `explicit`: the OSC 8 links'
     * cells. `workdir`: the folder the agent works in, for relative paths.
     */
    fun find(rows: List<List<String>>, wrapped: Set<Int> = emptySet(), explicit: List<Explicit> = emptyList(), workdir: String? = null): List<ScreenLink> {
        val out = mutableListOf<ScreenLink>()
        // OSC 8: cells carrying one address, on one row or on rows one after another, are one link.
        val covered = HashMap<Int, MutableList<IntRange>>()
        val open = mutableListOf<Pair<String, MutableList<ScreenLink.Span>>>()
        for (e in explicit.sortedWith(compareBy({ it.row }, { it.columns.lowerBound })).filter { !it.columns.isEmpty() }) {
            covered.getOrPut(e.row) { mutableListOf() }.add(e.columns)
            val span = ScreenLink.Span(e.row, e.columns)
            val i = open.indexOfLast { it.first == e.address && e.row - (it.second.lastOrNull()?.row ?: e.row) <= 1 }
            if (i >= 0) open[i].second.add(span) else open.add(e.address to mutableListOf(span))
        }
        for (o in open) { TappedLink.fromAddress(o.first)?.let { out.add(ScreenLink(it, o.second.toList())) } }

        val used = HashMap<Int, MutableList<IntRange>>()   // cells taken as a link's continuation, by row
        // Words a path above may or may not go on into: their own link also reads as the whole path (tapping the rest of
        // a path cut over lines finds the whole, files-v0 §12.4.2), by row.
        val maybe = HashMap<Int, MutableList<Pair<IntRange, List<TappedLink>>>>()
        for ((r, line) in rows.withIndex()) {
            for (word in words(line)) {
                if (used[r]?.any { it.overlaps(word) } == true || covered[r]?.any { it.overlaps(word) } == true) continue
                val cells = cellsOf(line, word, r)
                val free = { pieces: List<Piece> -> pieces.takeWhile { p -> covered[p.row]?.any { it.overlaps(p.word) } != true } }
                val pieces = free(chain(word, r, rows, wrapped))
                // A path that does not go on at its row's end may go on down its own column.
                var later: List<Piece> = emptyList()
                var found: Found? = address(cells, pieces, rows)
                if (found == null) {
                    val p = path(cells, if (pieces.isEmpty()) free(column(word, r, rows, wrapped)) else pieces, rows, workdir)
                    if (p != null) {
                        later = p.maybe
                        found = Found(p.link, p.used)
                    }
                }
                if (found == null) continue
                val above = maybe[r]?.firstOrNull { it.first.overlaps(word) }?.second
                if (above != null) {
                    val more = above.filter { it != found!!.link.link && !found!!.link.alternates.contains(it) }
                    found = Found(ScreenLink(found.link.link, found.link.spans, found.link.alternates + more), found.used)
                }
                for (p in found.used) used.getOrPut(p.row) { mutableListOf() }.add(p.word)
                for (p in later) maybe.getOrPut(p.row) { mutableListOf() }.add(p.word to found.link.alternates)
                out.add(found.link)
            }
        }
        return out
    }

    /**
     * The link a touch at (`column`, `row`) — in cells, fractions and all — lands on: the nearest one no further than
     * `slop` points away (`cell`: a cell's size in points); a touch inside a link is on it. Lines of text on a phone
     * are about a third of a fingertip high.
     */
    fun hit(links: List<ScreenLink>, column: Double, row: Double, cell: CellSize, slop: Double): ScreenLink? {
        var best: Pair<ScreenLink, Double>? = null
        for (link in links) {
            for (span in link.spans) {
                val left = span.columns.lowerBound.toDouble()
                val right = span.columns.upperBound.toDouble()
                val top = span.row.toDouble()
                val bottom = (span.row + 1).toDouble()
                val dx = (if (column < left) left - column else if (column > right) column - right else 0.0) * cell.width
                val dy = (if (row < top) top - row else if (row > bottom) row - bottom else 0.0) * cell.height
                val distance = Math.sqrt(dx * dx + dy * dy)
                if (distance <= slop && distance < (best?.second ?: Double.POSITIVE_INFINITY)) best = link to distance
            }
        }
        return best?.first
    }

    // MARK: - an address, a path

    private class Cell(
        val char: String,
        val row: Int,
        val column: Int,
        /** 2 for a wide character. */
        val width: Int,
    )

    private class Piece(
        val row: Int,
        val word: IntRange,
        /** Surely a continuation: the terminal's own wrap, or a line the agent filled to the width. */
        val sure: Boolean,
        /** The room a whole line has for a word (the width less the indent): a word cut over lines is longer. */
        val room: Int,
        /**
         * The rest of a word wrapped in a column of its own (`column`): its place alone does not say it is one word
         * with what is above it — a list reads the same —, the joined path does (`path`).
         */
        val boxed: Boolean = false,
    )

    private class Found(val link: ScreenLink, val used: List<Piece>)

    private class Reading(val link: TappedLink, val cells: List<Cell>, val pieces: List<Piece>, val sure: Boolean)

    private class PathFound(val link: ScreenLink, val used: List<Piece>, val maybe: List<Piece>)

    /**
     * A web address in the word, going on over the pieces it surely continues in while they hold only address
     * characters.
     */
    private fun address(cells: List<Cell>, pieces: List<Piece>, rows: List<List<String>>): Found? {
        val chars = cells.map { it.char }
        val start = LinkText.schemeStart(chars) ?: return null
        var taken = cells.drop(start).takeWhile { LinkText.inAddress(it.char) }
        val used = mutableListOf<Piece>()
        if (start + taken.size == cells.size) {
            // It reaches the word's end: it may go on in the next line's first word.
            val more = mutableListOf<Pair<Piece, List<Cell>>>()
            for (piece in pieces) {
                val next = cellsOf(rows[piece.row], piece.word, piece.row)
                val part = next.takeWhile { LinkText.inAddress(it.char) }
                if (!(piece.sure && part.isNotEmpty() && LinkText.schemeStart(part.map { it.char }) == null)) break
                more.add(piece to part)
                if (part.size < next.size) break
            }
            // A word is cut only when it does not fit a line of its own.
            val first = more.firstOrNull()
            if (first != null && (soft(first.first) || taken.size + more.sumOf { it.second.size } > first.first.room)) {
                for ((piece, part) in more) { taken = taken + part; used.add(piece) }
            }
        }
        val text = taken.joinToString("") { it.char }
        val kept = LinkText.trimmed(text)
        val link = TappedLink.fromAddress(kept) ?: return null
        return Found(ScreenLink(link, spans(taken.take(kept.length))), used)
    }

    /**
     * A path of the Mac's in the word. It may go on over the next lines (`pieces`): the reading taken is the longest
     * that is surely one word; the others are kept as alternates for the Mac to tell apart.
     */
    private fun path(cells: List<Cell>, pieces: List<Piece>, rows: List<List<String>>, workdir: String?): PathFound? {
        if (cells.none { it.char == "/" }) return null
        val readings = mutableListOf<Reading>()
        var joined = cells
        var sure = true
        var boxed = false
        val taken = mutableListOf<Piece>()
        for (k in 0..pieces.size) {
            if (k > 0) {
                val piece = pieces[k - 1]
                val part = cellsOf(rows[piece.row], piece.word, piece.row)
                boxed = boxed || piece.boxed
                sure = sure && piece.sure && (soft(piece) || joined.size + part.size > piece.room)
                joined = joined + part
                taken.add(piece)
            }
            val kept = stripped(joined)
            // `Read(src/a.ts)`, `--out=build/a.html`: the path is what follows the bracket or the equals sign.
            val at = kept.indexOfLast { it.char == "(" || it.char == "=" }
            val inner = if (at >= 0) kept.drop(at + 1) else emptyList()
            var read: Pair<String, List<Cell>>? = null
            for (candidate in listOf(inner, kept)) {
                if (candidate.isEmpty()) continue
                val p = LinkText.macPath(candidate.joinToString("") { it.char }, workdir) ?: continue
                read = p to candidate
                break
            }
            if (read == null) continue
            // Down a column the join is surely one path when it names a file and the first row alone does not: a file
            // listed with its name whole does not go on in the row under it.
            val whole = if (!boxed) sure else k > 0 && named(read.first) && readings.firstOrNull()?.let { it.pieces.isEmpty() && named(it.link.text) } != true
            readings.add(Reading(TappedLink.File(read.first), read.second, taken.toList(), whole))
        }
        if (readings.isEmpty()) return null
        // The longest sure reading; with none sure but the word itself, that.
        val primary = readings.lastOrNull { it.sure } ?: readings[0]
        val others = readings.reversed().map { it.link }.filter { it != primary.link }
        // The words the longer readings go on into that the one taken does not: theirs to read as these too.
        val maybe = readings.last().pieces.filter { p -> primary.pieces.none { it.row == p.row && it.word == p.word } }
        return PathFound(ScreenLink(primary.link, spans(primary.cells), others), primary.pieces, maybe)
    }

    private val opening: Set<String> = setOf("(", "[", "{", "<", "\"", "'", "`", "“", "‘", "「", "『", "（", "【", "《")
    private val closing: Set<String> = setOf(")", "]", "}", ">", "\"", "'", "`", "”", "’", "」", "』", "）", "】", "》",
        ",", ";", ":", ".", "!", "?", "，", "。", "；", "：", "、", "！", "？")

    /** The word without the quotes or brackets around it and the sentence's punctuation after it. */
    private fun stripped(cells: List<Cell>): List<Cell> {
        var lower = 0
        var upper = cells.size
        while (lower < upper && cells[lower].char in opening) lower += 1
        while (upper > lower && cells[upper - 1].char in closing) upper -= 1
        return cells.subList(lower, upper)
    }

    private fun soft(piece: Piece): Boolean = piece.room == Int.MAX_VALUE

    /** The path ends in a file's name with an extension (`a.png`, `terminal.js`). */
    private fun named(path: String): Boolean {
        val name = path.split("/").lastOrNull { it.isNotEmpty() } ?: ""
        val dot = name.lastIndexOf('.')
        if (dot <= 0) return false
        val tail = name.substring(dot + 1)
        return tail.graphemeCount() in 1..8 && tail.all { it.code < 0x80 && (it.isLetter() || it.isDigit()) }
    }

    /**
     * Where a word wrapped in a column of its own goes on (Claude Code's row for a file on a narrow screen: the mark,
     * the path and the size, each wrapped in its column): under its first cell on the next row, from there to the next
     * blank cell — whatever the row holds before it, be it another column's word right against it (`[image]-rest.png`),
     * though not the middle of a word — and no longer than the first row's part, which is the column's width; on to a
     * third row only when the second fills the column. Not a row the terminal wrapped itself (that goes on at the row's
     * first cell), nor the start of another path.
     */
    private fun column(word: IntRange, row: Int, rows: List<List<String>>, wrapped: Set<Int>): List<Piece> {
        val out = mutableListOf<Piece>()
        val start = word.lowerBound
        val width = word.count
        if (start <= 0) return emptyList()
        var next = row + 1
        while (out.size < reach && next in rows.indices && next !in wrapped) {
            val line = rows[next]
            if (!(start < line.size && !blank(line[start]) && line[start] != wideTail)) break
            val before = line[start - 1]
            if (!(blank(before) || !(before == wideTail || isLetter(before) || isNumber(before)))) break
            var upper = start + 1
            while (upper < line.size && !blank(line[upper])) upper += 1
            val piece = start until upper
            val text = cellsOf(line, piece, next).joinToString("") { it.char }
            if (!(piece.count <= width && listOf("~/", "./", "../").none { text.startsWith(it) })) break
            out.add(Piece(next, piece, sure = false, room = width, boxed = true))
            if (piece.count != width) break
            next += 1
        }
        return out
    }

    // MARK: - rows and words

    /**
     * The words a link broken at the end of `word`'s row may go on in, nearest first: each the next row's first word,
     * while the word before it ends its row. The terminal's own wrap goes on at the row's first cell. An agent's own
     * break goes on in an indented row no longer than the one it left; it is `sure` when that row was filled as far as
     * any row of its paragraph (a line cut inside a word is filled to the width).
     */
    private fun chain(word: IntRange, row: Int, rows: List<List<String>>, wrapped: Set<Int>): List<Piece> {
        val out = mutableListOf<Piece>()
        var current = word
        var r = row
        while (out.size < reach) {
            val next = r + 1
            if (next !in rows.indices) break
            val upper = rows[r]
            val lower = rows[next]
            val dent = indent(lower)
            if (!(current.upperBound == end(upper) && dent < lower.size)) break
            val first = wordAt(lower, dent) ?: break
            if (next in wrapped) {
                if (dent != 0) break
                out.add(Piece(next, first, sure = true, room = Int.MAX_VALUE))
            } else {
                if (!(dent > 0 && end(upper) >= end(lower))) break
                out.add(Piece(next, first, sure = end(upper) >= widest(r, rows), room = end(upper) - dent))
            }
            current = first
            r = next
        }
        return out
    }

    /**
     * How far the text rows of the paragraph around `row` reach: the rows up and down to the first blank one, but for
     * those a frame ends (a box's side is not text).
     */
    private fun widest(row: Int, rows: List<List<String>>): Int {
        var top = row
        var bottom = row
        while (top > 0 && row - top < 12 && end(rows[top - 1]) > 0) top -= 1
        while (bottom + 1 < rows.size && bottom - row < 12 && end(rows[bottom + 1]) > 0) bottom += 1
        return (top..bottom).filter { !framed(rows[it]) }.maxOfOrNull { end(rows[it]) } ?: 0
    }

    /** The row ends in a box-drawing character. */
    private fun framed(line: List<String>): Boolean {
        val last = line.lastOrNull { !blank(it) && it != wideTail } ?: return false
        if (last.isEmpty()) return false
        return last.codePointAt(0) in 0x2500..0x259F
    }

    private fun cellsOf(line: List<String>, word: IntRange, row: Int): List<Cell> {
        val out = mutableListOf<Cell>()
        for (column in word) {
            if (line[column] == wideTail) continue
            out.add(Cell(line[column], row, column, if (column + 1 < line.size && line[column + 1] == wideTail) 2 else 1))
        }
        return out
    }

    private fun spans(cells: List<Cell>): List<ScreenLink.Span> {
        val out = mutableListOf<ScreenLink.Span>()
        for (cell in cells) {
            val last = out.lastOrNull()
            if (last != null && last.row == cell.row && last.columns.upperBound == cell.column) {
                out[out.size - 1] = ScreenLink.Span(cell.row, last.columns.lowerBound until (cell.column + cell.width))
            } else {
                out.add(ScreenLink.Span(cell.row, cell.column until (cell.column + cell.width)))
            }
        }
        return out
    }

    /** The runs of non-blank cells in a row. */
    private fun words(line: List<String>): List<IntRange> {
        val out = mutableListOf<IntRange>()
        var column = 0
        while (column < line.size) {
            val found = wordAt(line, column)
            if (found != null) { out.add(found); column = found.upperBound } else column += 1
        }
        return out
    }

    /** The run of non-blank cells at `column`. */
    private fun wordAt(line: List<String>, column: Int): IntRange? {
        if (column !in line.indices || blank(line[column])) return null
        var lower = column
        var upper = column + 1
        while (lower > 0 && !blank(line[lower - 1])) lower -= 1
        while (upper < line.size && !blank(line[upper])) upper += 1
        return lower until upper
    }

    /** Blank cells before the row's first word (the whole row when it is blank). */
    private fun indent(line: List<String>): Int = line.indexOfFirst { !blank(it) }.let { if (it < 0) line.size else it }

    /** Where the row's last word ends (0: a blank row). */
    private fun end(line: List<String>): Int = line.indexOfLast { !blank(it) } + 1

    /** A space, a tab, or a cell nothing was written to (the terminal's NUL). */
    private fun blank(c: String): Boolean = c != wideTail && ((c.length == 1 && c[0].isUnicodeWhitespace()) || c == "\u0000")

    /** Swift's `Character.isLetter` / `isNumber`, by the cell's first code point. */
    private fun isLetter(c: String): Boolean = c.isNotEmpty() && Character.isLetter(c.codePointAt(0))
    private fun isNumber(c: String): Boolean {
        if (c.isEmpty()) return false
        val t = Character.getType(c.codePointAt(0))
        return t == Character.DECIMAL_DIGIT_NUMBER.toInt() || t == Character.LETTER_NUMBER.toInt() || t == Character.OTHER_NUMBER.toInt()
    }
}

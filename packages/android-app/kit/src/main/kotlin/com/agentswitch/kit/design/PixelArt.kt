package com.agentswitch.kit.design

import com.agentswitch.kit.live.LiveArt
import com.agentswitch.kit.live.Point

/**
 * The app's pixel marks (docs/ui-v0.md §7.3) as data: the views draw them. The same shapes as the terminal page's
 * `packages/daemon/ui/pixel.js` and the Mac app's `PixelArt` — keep the three in step (PixelArtTests pins them).
 */
object PixelArt {
    /** A cell of a mark: its place, and whether it belongs to the lit lane (the icon's highlighted one) and its end. */
    data class Cell(val x: Int, val y: Int, val lit: Boolean, val end: Boolean)

    /**
     * One source switched onto three lanes, as the app icon: S = source, a/b/c = lanes, A/B/C = their ends; the top
     * lane is the lit one. 14 × 11, y down.
     */
    val markRows: List<String> = LiveArt.markRows
    const val markWidth = 14
    const val markHeight = 11

    val markCells: List<Cell> = cells(markRows)

    /** The lit lane from the source to its end, the way the busy block runs. */
    val laneA: List<Point> = LiveArt.laneA

    /**
     * Empty cells in an inside corner of a diagonal step: a half-lit pixel there smooths the step (sub-pixel
     * anti-aliasing, for marks of 20 pt and up). Each carries the lit/dim role of the cell it leans on.
     */
    val markSmoothing: List<Cell> = smoothing(markRows)

    /**
     * How the mark shows the whole app: the lit lane (idle), a block running along it (busy), its end in amber
     * (waiting) or red (error), or dithered to half (off).
     */
    enum class MarkState { Idle, Busy, Waiting, Error, Off }

    /** The phone's state for the mark: the Mac out of reach first, then what waits for the user, then work under way. */
    fun markState(reachable: Boolean, waiting: Int, busy: Boolean): MarkState {
        if (!reachable) return MarkState.Off
        if (waiting > 0) return MarkState.Waiting
        return if (busy) MarkState.Busy else MarkState.Idle
    }

    /** Off: every other cell, a checkerboard. */
    fun dithered(cell: Cell): Boolean = (cell.x + cell.y) % 2 == 1

    // MARK: sprites (5 × 5 and smaller), "#" lit

    val square = listOf("####", "####", "####", "####")
    /** Share: a tray with an arrow out of it (the select bar of the Files tab, docs/files-v0.md §12.3). */
    val share = listOf("....#....", "...###...", "..#.#.#..", "....#....", "##..#..##", "#.......#", "#.......#", "#########")
    /** The Trash: a can with its lid. */
    val trash = listOf("...###...", "#########", ".#.....#.", ".#.#.#.#.", ".#.#.#.#.", ".#.#.#.#.", ".#.....#.", "..#####..")
    val hollow = listOf("####", "#..#", "#..#", "####")
    val lock = listOf(".###.", "#...#", "#####", "##.##", "#####")
    /** A picture (a frame, a hill, the sun): the terminal reply box's photo button. */
    val picture = listOf("#######", "#....##", "#.....#", "#..#..#", "#.###.#", "#######")
    /** Each agent's mark, from its own logo: Claude Code's spark, Codex's >_, OpenCode's brackets, pi's π. */
    val agents: Map<String, List<String>> = LiveArt.agents
    /** The terminals tab and window: a framed terminal (">_" alone means Codex). */
    val terminalWindow = listOf("#########", "#.......#", "#.#.....#", "#..#....#", "#.#..##.#", "#.......#", "#########")
    /**
     * The Browser tab (browser-v0 §1): a globe, the plainest mark of the web — a one-pixel circle, a meridian and the
     * equator — 11 × 11, at 2 pt cells in the tab bar and 1 pt beside the page's title (2026-10-03: drawn again without
     * the old one's crossing lines; for a day a fox, then user: 浏览器是不是可以再换个通用点的图标).
     */
    val globe = listOf("...#####...", ".##.....##.", ".#.#...#.#.", "#..#...#..#", "#..#...#..#", "###########",
        "#..#...#..#", "#..#...#..#", ".#.#...#.#.", ".##.....##.", "...#####...")

    /** The lit cells of a sprite. */
    fun sprite(rows: List<String>): List<Point> =
        rows.flatMapIndexed { y, row -> row.mapIndexedNotNull { x, c -> if (c == '#') Point(x, y) else null } }

    // MARK: the wordmark

    /** The wordmark's letters, 5 × 7 (pixel.js `FONT`). */
    val letters: Map<Char, List<String>> = mapOf(
        'A' to listOf(".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"),
        'G' to listOf(".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".###."),
        'E' to listOf("#####", "#....", "#....", "####.", "#....", "#....", "#####"),
        'N' to listOf("#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"),
        'T' to listOf("#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."),
        'S' to listOf(".####", "#....", "#....", ".###.", "....#", "....#", "####."),
        'W' to listOf("#...#", "#...#", "#...#", "#.#.#", "#.#.#", "##.##", "#...#"),
        'I' to listOf("#####", "..#..", "..#..", "..#..", "..#..", "..#..", "#####"),
        'C' to listOf(".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."),
        'H' to listOf("#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"),
    )

    /** A word in the wordmark's letters, 7 rows, one empty column between letters; letters it lacks are left out. */
    fun wordRows(word: String): List<String> {
        val glyphs = word.uppercase().mapNotNull { letters[it] }
        return (0 until 7).map { y -> glyphs.joinToString(".") { it[y] } }
    }

    /**
     * The same rows with 2-cell strokes on half-size cells: the settled wordmark's grid (its signal offset is one of
     * these cells, half a stroke).
     */
    fun fine(rows: List<String>): List<String> = rows.flatMap { row ->
        val wide = row.map { "$it$it" }.joinToString("")
        listOf(wide, wide)
    }

    /** The half-lit cells in the diagonal steps of any "#" sprite (as `markSmoothing` for the mark). */
    fun halfLit(rows: List<String>): List<Point> = smoothing(rows).map { Point(it.x, it.y) }

    // MARK: helpers

    internal fun cells(rows: List<String>): List<Cell> =
        rows.flatMapIndexed { y, row ->
            row.mapIndexedNotNull { x, c -> if (c == '.') null else Cell(x, y, lit = c in "aAS", end = c == 'A') }
        }

    internal fun smoothing(rows: List<String>): List<Cell> {
        fun at(x: Int, y: Int): Char? = if (y >= 0 && y < rows.size && x >= 0 && x < rows[y].length) rows[y][x] else null
        fun on(x: Int, y: Int): Boolean = at(x, y)?.let { it != '.' } ?: false
        val out = mutableListOf<Cell>()
        for ((y, row) in rows.withIndex()) {
            for ((x, c) in row.withIndex()) {
                if (c != '.') continue
                val n = on(x, y - 1)
                val s = on(x, y + 1)
                val w = on(x - 1, y)
                val e = on(x + 1, y)
                val corner = (n && e && !on(x + 1, y - 1)) || (n && w && !on(x - 1, y - 1)) ||
                    (s && e && !on(x + 1, y + 1)) || (s && w && !on(x - 1, y + 1))
                if (!corner || listOf(n, s, w, e).count { it } != 2) continue
                val lean = (if (n) at(x, y - 1) else at(x, y + 1)) ?: continue
                out.add(Cell(x, y, lit = lean in "aAS", end = false))
            }
        }
        return out
    }
}

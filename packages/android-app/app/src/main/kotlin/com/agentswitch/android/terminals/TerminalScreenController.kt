package com.agentswitch.android.terminals

import android.graphics.RectF
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.agentswitch.android.terminal.TerminalDisplayView
import com.agentswitch.kit.api.TerminalStyle
import com.agentswitch.kit.feed.ScreenLink
import com.agentswitch.kit.feed.TerminalLinks
import com.termux.terminal.WcWidth
import java.lang.ref.WeakReference
import kotlin.math.abs
import kotlin.math.max

/**
 * What one terminal's screen is told to draw (the iPhone's `TerminalScreenController`, which owned a SwiftTerm view):
 * the stream drawn into it, the Mac's colours, the size of its text, and when the grid it fits changes (the page tells
 * the service).
 *
 * On Android the view ([TerminalDisplayView]) belongs to the composition and comes and goes (a configuration change, the
 * page scrolled away): the page model owns this controller instead, which keeps what the view was last told — the last
 * snapshot and the output since (bounded), the colours, the font size — and forwards to the view while one is attached.
 * A view attached later is brought up to date. The view is held weakly: [detach] (or the view going away) lets it go.
 *
 * The view is a display only (docs/terminal-v0.md §1 iPhone): it never takes the keyboard and never sends what it would
 * type or report. Its links are read off its screen and handled by the page ([link]).
 *
 * Coordinates: pixels in the view's own coordinates. The view does not scroll as SwiftTerm's does (its history is drawn
 * from [TerminalDisplayView.topVisibleRow]), so a point's row is its y over the cell's height, whatever is scrolled.
 */
@Stable
class TerminalScreenController(fontSize: Float) {
    /** The grid this view fits at its size and font: cols, rows. */
    var onSize: ((Int, Int) -> Unit)? = null

    private var attached: WeakReference<TerminalDisplayView>? = null
    private val view: TerminalDisplayView? get() = attached?.get()

    /** The last snapshot (null: none yet) and what the stream wrote since. */
    private var lastSnapshot: String? = null
    private val since = StringBuilder()

    /** The grid last heard from a view: what [grid] says while none is attached. */
    private var lastGrid: Pair<Int, Int>? = null

    /** The text size, sp (points on the iPhone), within [fontRange]. */
    val fontSize: Float get() = size
    private var size: Float by mutableStateOf(fontSize.coerceIn(fontRange))

    /** The screen's background and text colours (ARGB), as the Mac's style says; black and a light grey until it does. */
    var background: Int by mutableStateOf(DEFAULT_BACKGROUND)
        private set
    var foreground: Int by mutableStateOf(DEFAULT_FOREGROUND)
        private set

    /** The 16 ANSI colours (ARGB), null until the Mac's style has all of them. */
    var ansi: IntArray? by mutableStateOf(null)
        private set

    /** The link lit up for a moment (which one the finger took): the page draws [LinkFlash.rects] and fades them. */
    var flash: LinkFlash? by mutableStateOf(null)
        private set
    private var flashes = 0

    /** A link's cells lit up: one each time ([serial] tells two flashes of the same link apart). */
    data class LinkFlash(val link: ScreenLink, val rects: List<RectF>, val serial: Int)

    // MARK: the view

    /**
     * The composition's view, from now on told everything; brought up to date at once (the colours, the font, the
     * screen as it was last drawn). Its `onGrid` is this controller's; its other callbacks are the page's.
     */
    fun attach(view: TerminalDisplayView) {
        if (this.view === view) return
        attached = WeakReference(view)
        view.onGrid = { cols, rows ->
            lastGrid = cols to rows
            onSize?.invoke(cols, rows)
        }
        view.applyColors(background, foreground, ansi)
        view.setFontSize(fontSize)
        // Fed into a fresh screen, whatever the view showed before (a view attached again).
        view.snapshot((lastSnapshot ?: "") + since)
        val grid = view.grid
        if (grid.first > 0 && grid.second > 0) lastGrid = grid
    }

    /** The view leaves the composition: nothing is forwarded to it any more. */
    fun detach(view: TerminalDisplayView) {
        if (this.view !== view) return
        // A pinch changed the size in the view itself: kept.
        size = view.fontSizeSp.coerceIn(fontRange)
        view.onGrid = null
        attached = null
    }

    // MARK: what the page tells it

    /** Clamped to [fontRange]; a change of less than 0.01 is none. The view's grid follows (and [onSize] says so). */
    fun setFontSize(sp: Float) {
        val clamped = sp.coerceIn(fontRange)
        val current = view?.fontSizeSp ?: fontSize
        if (abs(clamped - current) <= 0.01f && abs(clamped - fontSize) <= 0.01f) return
        size = clamped
        view?.setFontSize(clamped)
    }

    /** The user's iTerm colours from the Mac (`GET /terminals/style`), as on the Mac. */
    fun apply(style: TerminalStyle) {
        style.background?.let { background = argb(it) }
        style.foreground?.let { foreground = argb(it) }
        style.ansi?.let { colors -> ansi = IntArray(colors.size) { argb(colors[it]) } }
        view?.applyColors(background, foreground, ansi)
    }

    /** The screen as the service has it: drawn afresh. */
    fun snapshot(data: String) {
        lastSnapshot = data
        since.setLength(0)
        view?.snapshot(data)
    }

    fun output(data: String) {
        keep(data)
        view?.output(data)
    }

    /** A line of the page's own (`[exited · code 0]`), drawn as the stream's output is. */
    fun write(line: String) = output(line)

    /**
     * The output kept for a view attached later is bounded: past [KEPT_OUTPUT] characters the older half goes, cut at
     * a line's start, and the snapshot with it (what is kept then redraws the screen's lower part, not all of it — a
     * view attached later after that much output may show less above).
     */
    private fun keep(data: String) {
        since.append(data)
        if (since.length <= KEPT_OUTPUT) return
        val from = since.length - KEPT_OUTPUT / 2
        val cut = since.indexOf("\n", from).let { if (it < 0) from else it + 1 }
        since.delete(0, cut)
        lastSnapshot = null
    }

    /** The grid the view fits: cols, rows. Before any view has had a size, 80 × 24 (a terminal's own default). */
    val grid: Pair<Int, Int>
        get() {
            val now = view?.grid
            if (now != null && now.first > 0 && now.second > 0) return now
            return lastGrid ?: (80 to 24)
        }

    /**
     * A drag scrolls the program rather than this screen: it tracks the mouse, or it is full screen (no history of the
     * terminal's own; Claude Code's current screen is both).
     */
    val scrollsByWheel: Boolean get() = view?.scrollsByWheel ?: false

    /** One notch of the wheel per this much drag, in pixels: a line, at least 8 dp. */
    val notch: Float
        get() {
            val v = view ?: return 8f
            return max(8f * v.resources.displayMetrics.density, v.cellHeight.toFloat())
        }

    // MARK: links (docs/terminal-v0.md §1 iPhone 链接, 2026-10-03)

    /** A cell's size in pixels; null before the screen has a grid. */
    private fun cell(v: TerminalDisplayView): Pair<Float, Float>? {
        val t = v.terminal ?: return null
        if (t.mColumns <= 0 || t.mRows <= 0 || v.cellWidth <= 0f || v.cellHeight <= 0) return null
        return v.cellWidth to v.cellHeight.toFloat()
    }

    /**
     * The links on the screen now, read afresh at each touch (the screen changes under the finger): the rows shown, cell
     * by cell, and the rows the terminal wrapped itself. The Kit finds them ([TerminalLinks]).
     *
     * OSC 8 links are not read: Termux's emulator (v0.118) does not keep them (it parses OSC 8 and drops it; a cell holds
     * a character and a style only), so none are passed — an agent's status line links are found only where their
     * address is written out.
     */
    fun links(workdir: String?): List<ScreenLink> {
        val v = view ?: return emptyList()
        val t = v.terminal ?: return emptyList()
        val buffer = t.screen
        val cols = t.mColumns
        val top = v.topVisibleRow
        val oldest = -buffer.activeTranscriptRows
        val rows = ArrayList<List<String>>(t.mRows)
        val wrapped = HashSet<Int>()
        for (r in 0 until t.mRows) {
            val external = top + r
            // The terminal continued this row from the one above (Termux marks the row that wraps, SwiftTerm the next).
            if (external - 1 >= oldest && buffer.getLineWrap(external - 1)) wrapped.add(r)
            rows.add(cells(buffer.allocateFullLineIfNecessary(buffer.externalToInternalRow(external)), cols))
        }
        return TerminalLinks.find(rows, wrapped = wrapped, explicit = emptyList(), workdir = workdir)
    }

    /** One string a cell; a wide character's second cell is [TerminalLinks.wideTail], combining marks stay with theirs. */
    private fun cells(row: com.termux.terminal.TerminalRow, cols: Int): List<String> {
        val text = row.mText
        val used = row.spaceUsed
        val out = ArrayList<String>(cols)
        var i = 0
        while (i < used && out.size < cols) {
            val start = i
            val cp = Character.codePointAt(text, i)
            i += Character.charCount(cp)
            // What follows with no width of its own (a combining mark, a variation selector) belongs to this cell.
            while (i < used) {
                val next = Character.codePointAt(text, i)
                if (WcWidth.width(next) > 0) break
                i += Character.charCount(next)
            }
            val width = WcWidth.width(cp)
            if (width <= 0) continue
            out.add(String(text, start, i - start))
            if (width == 2 && out.size < cols) out.add(TerminalLinks.wideTail)
        }
        while (out.size < cols) out.add(" ")
        return out
    }

    /**
     * The link a touch at (`x`, `y`) (the view's pixels) lands on: the nearest within the slop — `tap`: narrower while
     * the program tracks the mouse, where a tap has another meaning.
     */
    fun link(x: Float, y: Float, workdir: String?, tap: Boolean = false): ScreenLink? {
        val v = view ?: return null
        val (w, h) = cell(v) ?: return null
        val slop = (if (tap && v.tracksMouse) LINK_SLOP_CLICKING else LINK_SLOP) * v.resources.displayMetrics.density
        return TerminalLinks.hit(links(workdir), column = (x / w).toDouble(), row = (y / h).toDouble(),
            cell = TerminalLinks.CellSize(w.toDouble(), h.toDouble()), slop = slop.toDouble())
    }

    /** Where a link's cells are, row by row, in the view's pixels. */
    fun rects(link: ScreenLink): List<RectF> {
        val v = view ?: return emptyList()
        val (w, h) = cell(v) ?: return emptyList()
        return link.spans.map { span ->
            val count = if (span.columns.isEmpty()) 0 else span.columns.last - span.columns.first + 1
            RectF(span.columns.first * w, span.row * h, (span.columns.first + count) * w, (span.row + 1) * h)
        }
    }

    /** The link's place on the screen (the view's pixels; the iPhone's was the window's): its menu opens by it. */
    fun frame(link: ScreenLink): RectF {
        val all = rects(link)
        val out = RectF(all.firstOrNull() ?: RectF())
        for (r in all.drop(1)) out.union(r)
        return out
    }

    /**
     * The link touched lights up for a moment: which one the finger took. The page draws [flash]'s rectangles in the
     * signal colour at 40 % and fades them to nothing over [FLASH_FADE_MS] after [FLASH_DELAY_MS] (at once when the
     * system has animations removed).
     */
    fun flash(link: ScreenLink) {
        flashes += 1
        flash = LinkFlash(link, rects(link), flashes)
    }

    /** The flash has faded (the page says so): nothing is lit. */
    fun flashEnded(serial: Int) {
        if (flash?.serial == serial) flash = null
    }

    /**
     * The cell under a point of the view while the program tracks the mouse (a tap then clicks there): (col, row); null
     * when it does not, or the point is off the grid. The program's own full screen has no history, so the top of what
     * shows is row 0.
     */
    fun clickCell(x: Float, y: Float): Pair<Int, Int>? {
        val v = view ?: return null
        val t = v.terminal ?: return null
        if (!v.tracksMouse || t.mColumns <= 0 || t.mRows <= 0) return null
        val (w, h) = cell(v) ?: return null
        if (x < 0 || y < 0) return null
        val col = (x / w).toInt()
        val row = (y / h).toInt()
        if (col !in 0 until t.mColumns || row !in 0 until t.mRows) return null
        return col to row
    }

    companion object {
        val fontRange: ClosedFloatingPointRange<Float> = TerminalDisplayView.FONT_MIN..TerminalDisplayView.FONT_MAX

        /** A finger's slop around a link, in dp: about a line of text (12 at the usual size). */
        const val LINK_SLOP = 14f

        /**
         * The slop of a tap while the program tracks the mouse, in dp: half a line. A tap beside a link is then a click
         * the program may be waiting for (an option on the line under an address), not the link's.
         */
        const val LINK_SLOP_CLICKING = 6f

        /** The flash of a link touched: held this long, then faded over [FLASH_FADE_MS]. */
        const val FLASH_DELAY_MS = 140L
        const val FLASH_FADE_MS = 180L

        /** Characters of output kept for a view attached later (see `keep`). */
        const val KEPT_OUTPUT = 512 * 1024

        const val DEFAULT_BACKGROUND = 0xFF000000.toInt()
        /** UIColor(white: 0.9). */
        const val DEFAULT_FOREGROUND = 0xFFE6E6E6.toInt()

        private fun argb(c: TerminalStyle.RGB): Int = (0xFF shl 24) or ((c.r and 0xFF) shl 16) or ((c.g and 0xFF) shl 8) or (c.b and 0xFF)
    }
}

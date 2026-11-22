package com.agentswitch.android.terminal

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Typeface
import android.util.TypedValue
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import android.widget.OverScroller
import androidx.core.content.res.ResourcesCompat
import com.agentswitch.android.R
import com.termux.terminal.TerminalEmulator
import com.termux.terminal.TerminalOutput
import com.termux.terminal.TerminalSession
import com.termux.terminal.TerminalSessionClient
import com.termux.terminal.TextStyle
import com.termux.view.TerminalRenderer
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * A terminal's screen as a display only (docs/terminal-v0.md §1 手机; the iPhone's `DisplayTerminalView` over SwiftTerm):
 * Termux's emulator reads what the Mac's terminal wrote and its renderer draws the cells. It never takes the keyboard
 * and never sends what it would type or report — the phone has no raw keystroke route; replies go through the box, keys
 * and the wheel by name.
 *
 * Touch (terminal-v0 §1 second round): a drag scrolls — this screen's history, or the program itself by wheel notches
 * when it is full screen or tracks the mouse (a flick carries on a little); a pinch changes the text size (the grid
 * follows, and with it the agent); a tap and a press held are told to the page with their place.
 */
@SuppressLint("ViewConstructor")
class TerminalDisplayView(context: Context, fontSizeSp: Float) : View(context) {
    /** The grid this view fits at its size and font: cols, rows. */
    var onGrid: ((Int, Int) -> Unit)? = null
    /** Wheel notches for the program: up (back through what it showed), and how many. */
    var onWheel: ((Boolean, Int) -> Unit)? = null
    var onTap: ((Float, Float) -> Unit)? = null
    /** A press held where it began, at that point. */
    var onHold: ((Float, Float) -> Unit)? = null
    /** The pinch ended at this text size (sp): the page keeps it. */
    var onPinchEnded: ((Float) -> Unit)? = null

    private val typeface: Typeface = ResourcesCompat.getFont(context, R.font.jetbrains_mono) ?: Typeface.MONOSPACE
    private var renderer = TerminalRenderer(px(fontSizeSp), typeface)
    private var emulator: TerminalEmulator? = null
    /** The top row shown: 0 at the live screen, negative into the history. */
    private var topRow = 0
    private var scrollRemainder = 0f
    private var wheelRemainder = 0f
    /** What was fed before the view had a size: drawn once it has one. */
    private var pending = StringBuilder()
    private var pendingFresh = false
    private var background = 0xFF000000.toInt()
    private var foreground = 0xFFE6E6E6.toInt()
    private var ansi: IntArray? = null
    private val scroller = OverScroller(context)
    private val ground = android.graphics.Paint()
    private var coast: Runnable? = null

    var fontSizeSp: Float = fontSizeSp
        private set

    init {
        isFocusable = false
        isFocusableInTouchMode = false
    }

    private fun px(sp: Float): Int = max(1, TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, sp, resources.displayMetrics).roundToInt())

    // MARK: what the page tells it

    fun setFontSize(sp: Float) {
        val clamped = min(max(sp, FONT_MIN), FONT_MAX)
        if (abs(clamped - fontSizeSp) < 0.01f) return
        fontSizeSp = clamped
        renderer = TerminalRenderer(px(clamped), typeface)
        fit()
        invalidate()
    }

    /** The user's terminal colours from the Mac (`GET /terminals/style`): background, foreground, the 16 ANSI colours. */
    fun applyColors(background: Int?, foreground: Int?, ansi: IntArray?) {
        if (background != null) this.background = background
        if (foreground != null) this.foreground = foreground
        if (ansi != null) this.ansi = ansi
        emulator?.let { paint(it) }
        invalidate()
    }

    /** The screen as the service has it: drawn afresh. */
    fun snapshot(data: String) {
        val current = emulator
        if (current == null) {
            pending = StringBuilder(data)
            pendingFresh = true
            return
        }
        emulator = make(current.mColumns, current.mRows)
        topRow = 0
        feed(data)
    }

    fun output(data: String) {
        if (emulator == null) { pending.append(data); return }
        feed(data)
    }

    val grid: Pair<Int, Int> get() = emulator?.let { it.mColumns to it.mRows } ?: (0 to 0)

    /** A drag scrolls the program rather than this screen: it tracks the mouse, or it is full screen (no history of its own). */
    val scrollsByWheel: Boolean get() = emulator?.let { it.isMouseTrackingActive || it.isAlternateBufferActive } ?: false

    val tracksMouse: Boolean get() = emulator?.isMouseTrackingActive ?: false

    /** A cell's size in pixels. */
    val cellWidth: Float get() = renderer.fontWidth
    val cellHeight: Int get() = renderer.fontLineSpacing

    /** The top row shown now (0 or negative), for the page's reading of the screen. */
    val topVisibleRow: Int get() = topRow

    /** The emulator as it stands, for reading its rows (links, the cell under a tap); null before the view has a size. */
    val terminal: TerminalEmulator? get() = emulator

    // MARK: the emulator

    private fun make(cols: Int, rows: Int): TerminalEmulator =
        TerminalEmulator(Silent, cols, rows, max(1, cellWidth.roundToInt()), max(1, cellHeight), HISTORY_ROWS, Quiet).also { paint(it) }

    private fun paint(emulator: TerminalEmulator) {
        val colors = emulator.mColors.mCurrentColors
        ansi?.let { for (i in 0 until min(16, it.size)) colors[i] = it[i] }
        colors[TextStyle.COLOR_INDEX_BACKGROUND] = background
        colors[TextStyle.COLOR_INDEX_FOREGROUND] = foreground
        colors[TextStyle.COLOR_INDEX_CURSOR] = foreground
    }

    private fun feed(data: String) {
        val emulator = emulator ?: return
        val bytes = data.toByteArray(Charsets.UTF_8)
        emulator.append(bytes, bytes.size)
        // Reading back through the history stays where it is while new lines arrive under it.
        val scrolled = emulator.scrollCounter
        emulator.clearScrollCounter()
        if (topRow != 0 && scrolled != 0) topRow = max(-emulator.screen.activeTranscriptRows, topRow - scrolled)
        invalidate()
    }

    /** The grid for the size and font now; the emulator made or resized to it, and the page told when it changed. */
    private fun fit() {
        if (width <= 0 || height <= 0) return
        val cols = max(MIN_COLS, (width / cellWidth).toInt())
        val rows = max(MIN_ROWS, height / cellHeight)
        val current = emulator
        if (current == null) {
            emulator = make(cols, rows)
            if (pending.isNotEmpty()) { feed(pending.toString()); pending = StringBuilder() }
            onGrid?.invoke(cols, rows)
        } else if (current.mColumns != cols || current.mRows != rows) {
            current.resize(cols, rows, max(1, cellWidth.roundToInt()), max(1, cellHeight))
            topRow = 0
            onGrid?.invoke(cols, rows)
        }
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        fit()
    }

    override fun onDraw(canvas: Canvas) {
        // Its own rectangle only: a canvas that is not clipped to the view would be painted whole (the page's bar with it).
        ground.color = background
        canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), ground)
        val emulator = emulator ?: return
        renderer.render(emulator, canvas, topRow, -1, -1, -1, -1)
    }

    // MARK: touch

    private val gestures = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
        override fun onDown(e: MotionEvent): Boolean {
            scroller.forceFinished(true)
            coast?.let { removeCallbacks(it) }
            scrollRemainder = 0f
            wheelRemainder = 0f
            return true
        }

        override fun onSingleTapUp(e: MotionEvent): Boolean {
            onTap?.invoke(e.x, e.y)
            return true
        }

        override fun onLongPress(e: MotionEvent) {
            onHold?.invoke(e.x, e.y)
        }

        override fun onScroll(e1: MotionEvent?, e2: MotionEvent, distanceX: Float, distanceY: Float): Boolean {
            if (scaling) return true
            if (scrollsByWheel) {
                // The finger going down brings back what was above: the wheel turns up.
                wheelRemainder -= distanceY
                val notch = max(8f * resources.displayMetrics.density, cellHeight.toFloat())
                val notches = (wheelRemainder / notch).toInt()
                if (notches != 0) {
                    wheelRemainder -= notches * notch
                    onWheel?.invoke(notches > 0, abs(notches))
                }
            } else {
                scrollBy(distanceY)
            }
            return true
        }

        override fun onFling(e1: MotionEvent?, e2: MotionEvent, velocityX: Float, velocityY: Float): Boolean {
            if (scaling) return true
            if (scrollsByWheel) {
                // A flick carries on, slowing: a few more notches, fewer each time.
                val pointsPerSecond = abs(velocityY) / resources.displayMetrics.density
                var left = min(24, (pointsPerSecond / 220).toInt())
                if (left <= 0) return true
                val up = velocityY > 0
                val step = object : Runnable {
                    override fun run() {
                        if (left <= 0) return
                        val now = max(1, left / 2)
                        onWheel?.invoke(up, now)
                        left -= now
                        if (left > 0) postDelayed(this, 70)
                    }
                }
                coast = step
                post(step)
            } else {
                val history = emulator?.screen?.activeTranscriptRows ?: 0
                scroller.fling(0, topRow * cellHeight, 0, -velocityY.toInt(), 0, 0, -history * cellHeight, 0)
                postInvalidateOnAnimation()
            }
            return true
        }
    })

    private var scaling = false
    private var pinchStart = fontSizeSp
    private val pinch = ScaleGestureDetector(context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
        private var factor = 1f

        override fun onScaleBegin(detector: ScaleGestureDetector): Boolean {
            scaling = true
            pinchStart = fontSizeSp
            factor = 1f
            return true
        }

        override fun onScale(detector: ScaleGestureDetector): Boolean {
            factor *= detector.scaleFactor
            setFontSize((pinchStart * factor).roundToInt().toFloat())
            return true
        }

        override fun onScaleEnd(detector: ScaleGestureDetector) {
            scaling = false
            onPinchEnded?.invoke(fontSizeSp)
        }
    })

    private fun scrollBy(pixels: Float) {
        val emulator = emulator ?: return
        scrollRemainder += pixels
        val rows = (scrollRemainder / cellHeight).toInt()
        if (rows == 0) return
        scrollRemainder -= rows * cellHeight
        val next = (topRow + rows).coerceIn(-emulator.screen.activeTranscriptRows, 0)
        if (next != topRow) { topRow = next; invalidate() }
    }

    override fun computeScroll() {
        if (scroller.computeScrollOffset()) {
            val emulator = emulator ?: return
            val next = (scroller.currY / max(1, cellHeight)).coerceIn(-emulator.screen.activeTranscriptRows, 0)
            if (next != topRow) { topRow = next; invalidate() }
            postInvalidateOnAnimation()
        }
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
        pinch.onTouchEvent(event)
        gestures.onTouchEvent(event)
        return true
    }

    companion object {
        const val FONT_MIN = 7f
        const val FONT_MAX = 16f
        private const val MIN_COLS = 4
        private const val MIN_ROWS = 2
        private const val HISTORY_ROWS = 2000
    }

    /** What the emulator would type back or report (it has no keyboard here): never sent. */
    private object Silent : TerminalOutput() {
        override fun write(data: ByteArray?, offset: Int, count: Int) = Unit
        override fun titleChanged(oldTitle: String?, newTitle: String?) = Unit
        override fun onCopyTextToClipboard(text: String?) = Unit
        override fun onPasteTextFromClipboard() = Unit
        override fun onBell() = Unit
        override fun onColorsChanged() = Unit
    }

    private object Quiet : TerminalSessionClient {
        override fun onTextChanged(changedSession: TerminalSession) = Unit
        override fun onTitleChanged(changedSession: TerminalSession) = Unit
        override fun onSessionFinished(finishedSession: TerminalSession) = Unit
        override fun onCopyTextToClipboard(session: TerminalSession, text: String?) = Unit
        override fun onPasteTextFromClipboard(session: TerminalSession?) = Unit
        override fun onBell(session: TerminalSession) = Unit
        override fun onColorsChanged(session: TerminalSession) = Unit
        override fun onTerminalCursorStateChange(state: Boolean) = Unit
        override fun getTerminalCursorStyle(): Int? = null
        override fun logError(tag: String?, message: String?) = Unit
        override fun logWarn(tag: String?, message: String?) = Unit
        override fun logInfo(tag: String?, message: String?) = Unit
        override fun logDebug(tag: String?, message: String?) = Unit
        override fun logVerbose(tag: String?, message: String?) = Unit
        override fun logStackTraceWithMessage(tag: String?, message: String?, e: Exception?) = Unit
        override fun logStackTrace(tag: String?, e: Exception?) = Unit
    }
}

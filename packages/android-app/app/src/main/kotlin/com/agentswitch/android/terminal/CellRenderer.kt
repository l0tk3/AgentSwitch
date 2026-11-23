package com.agentswitch.android.terminal

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.Typeface
import com.termux.terminal.TerminalEmulator
import com.termux.terminal.TextStyle
import com.termux.terminal.WcWidth
import kotlin.math.abs
import kotlin.math.ceil

/**
 * Draws an emulator's cells. Termux's `TerminalRenderer` (Apache 2.0) with one thing changed: a character whose own
 * width is not its cells' — a Chinese character is one em wide, its two cells 1.2 — was stretched sideways to fill them
 * and came out flat. Here it keeps its shape and stands in the middle of its cells, as on the Mac and the iPhone; only
 * one too wide for its cells is narrowed to fit.
 */
class CellRenderer(textSize: Int, typeface: Typeface) {
    private val paint = Paint().apply { this.typeface = typeface; isAntiAlias = true; this.textSize = textSize.toFloat() }
    val fontLineSpacing: Int = ceil(paint.fontSpacing).toInt()
    private val fontAscent: Int = ceil(paint.ascent()).toInt()
    private val lineSpacingAndAscent: Int = fontLineSpacing + fontAscent
    val fontWidth: Float = paint.measureText("X")
    private val asciiMeasures = FloatArray(127).also { widths ->
        val one = CharArray(1)
        for (i in widths.indices) { one[0] = i.toChar(); widths[i] = paint.measureText(one, 0, 1) }
    }

    /** The screen from `topRow` (0: the live screen; negative: into the history). */
    fun render(emulator: TerminalEmulator, canvas: Canvas, topRow: Int) {
        val reverseVideo = emulator.isReverseVideo
        val endRow = topRow + emulator.mRows
        val columns = emulator.mColumns
        val cursorCol = emulator.cursorCol
        val cursorRow = emulator.cursorRow
        val cursorVisible = emulator.shouldCursorBeVisible()
        val screen = emulator.screen
        val palette = emulator.mColors.mCurrentColors
        val cursorShape = emulator.cursorStyle

        if (reverseVideo) canvas.drawColor(palette[TextStyle.COLOR_INDEX_FOREGROUND], PorterDuff.Mode.SRC)

        var y = lineSpacingAndAscent.toFloat()
        for (row in topRow until endRow) {
            y += fontLineSpacing
            val cursorX = if (row == cursorRow && cursorVisible) cursorCol else -1
            val lineObject = screen.allocateFullLineIfNecessary(screen.externalToInternalRow(row))
            val line = lineObject.mText
            val used = lineObject.spaceUsed

            var runStyle = 0L
            var runInsideCursor = false
            var runStartColumn = -1
            var runStartIndex = 0
            var runMismatch = false
            var index = 0
            var runMeasured = 0f

            fun draw(untilColumn: Int) {
                if (runStartColumn < 0) return
                val cursorColor = if (runInsideCursor) palette[TextStyle.COLOR_INDEX_CURSOR] else 0
                val invert = runInsideCursor && cursorShape == TerminalEmulator.TERMINAL_CURSOR_STYLE_BLOCK
                drawRun(canvas, line, palette, y, runStartColumn, untilColumn - runStartColumn, runStartIndex, index - runStartIndex,
                    runMeasured, cursorColor, cursorShape, runStyle, reverseVideo || invert)
            }

            var column = 0
            while (column < columns) {
                val char = line[index]
                val high = Character.isHighSurrogate(char)
                val chars = if (high) 2 else 1
                val codePoint = if (high) Character.toCodePoint(char, line[index + 1]) else char.code
                val cells = WcWidth.width(codePoint)
                val insideCursor = cursorX == column || (cells == 2 && cursorX == column + 1)
                val style = lineObject.getStyle(column)
                // A character whose width is not what its cells are (a font that is not all one width, wide characters,
                // smileys) is a run of its own, placed by itself.
                val measured = if (codePoint < asciiMeasures.size) asciiMeasures[codePoint] else paint.measureText(line, index, chars)
                val mismatch = abs(measured / fontWidth - cells) > 0.01f

                if (style != runStyle || insideCursor != runInsideCursor || mismatch || runMismatch) {
                    if (column != 0) draw(column)
                    runMeasured = 0f
                    runStyle = style
                    runInsideCursor = insideCursor
                    runStartColumn = column
                    runStartIndex = index
                    runMismatch = mismatch
                }
                runMeasured += measured
                column += cells
                index += chars
                // Combining characters belong to the one before them.
                while (index < used && WcWidth.width(line, index) <= 0) index += if (Character.isHighSurrogate(line[index])) 2 else 1
            }
            draw(columns)
        }
    }

    private fun drawRun(
        canvas: Canvas, text: CharArray, palette: IntArray, y: Float, startColumn: Int, runColumns: Int, startIndex: Int, runChars: Int,
        measured: Float, cursor: Int, cursorStyle: Int, textStyle: Long, reverseVideo: Boolean,
    ) {
        var fore = TextStyle.decodeForeColor(textStyle)
        val effect = TextStyle.decodeEffect(textStyle)
        var back = TextStyle.decodeBackColor(textStyle)
        val bold = effect and (TextStyle.CHARACTER_ATTRIBUTE_BOLD or TextStyle.CHARACTER_ATTRIBUTE_BLINK) != 0
        val underline = effect and TextStyle.CHARACTER_ATTRIBUTE_UNDERLINE != 0
        val italic = effect and TextStyle.CHARACTER_ATTRIBUTE_ITALIC != 0
        val strike = effect and TextStyle.CHARACTER_ATTRIBUTE_STRIKETHROUGH != 0
        val dim = effect and TextStyle.CHARACTER_ATTRIBUTE_DIM != 0

        if (fore and 0xff000000.toInt() != 0xff000000.toInt()) {
            // Bold has the bright colour when it is one of the first eight.
            if (bold && fore in 0..7) fore += 8
            fore = palette[fore]
        }
        if (back and 0xff000000.toInt() != 0xff000000.toInt()) back = palette[back]

        if (reverseVideo xor (effect and TextStyle.CHARACTER_ATTRIBUTE_INVERSE != 0)) { val t = fore; fore = back; back = t }

        val left = startColumn * fontWidth
        var right = left + runColumns * fontWidth
        val cellsWidth = runColumns * fontWidth

        if (back != palette[TextStyle.COLOR_INDEX_BACKGROUND]) {
            paint.color = back
            canvas.drawRect(left, y - lineSpacingAndAscent + fontAscent, right, y, paint)
        }

        if (cursor != 0) {
            paint.color = cursor
            var cursorHeight = (lineSpacingAndAscent - fontAscent).toFloat()
            if (cursorStyle == TerminalEmulator.TERMINAL_CURSOR_STYLE_UNDERLINE) cursorHeight /= 4f
            else if (cursorStyle == TerminalEmulator.TERMINAL_CURSOR_STYLE_BAR) right -= (right - left) * 3 / 4f
            canvas.drawRect(left, y - cursorHeight, right, y, paint)
        }

        if (effect and TextStyle.CHARACTER_ATTRIBUTE_INVISIBLE != 0) return
        if (dim) {
            // Dim: each colour part at two thirds.
            val r = (fore shr 16 and 0xff) * 2 / 3
            val g = (fore shr 8 and 0xff) * 2 / 3
            val b = (fore and 0xff) * 2 / 3
            fore = 0xff000000.toInt() or (r shl 16) or (g shl 8) or b
        }
        paint.isFakeBoldText = bold
        paint.isUnderlineText = underline
        paint.textSkewX = if (italic) -0.35f else 0f
        paint.isStrikeThruText = strike
        paint.color = fore

        val baseline = y - lineSpacingAndAscent
        val spare = cellsWidth - measured
        if (spare < -0.01f * fontWidth && measured > 0f) {
            // Wider than its cells: narrowed to fit them.
            val scale = cellsWidth / measured
            canvas.save()
            canvas.scale(scale, 1f)
            canvas.drawTextRun(text, startIndex, runChars, startIndex, runChars, left / scale, baseline, false, paint)
            canvas.restore()
        } else {
            // Its own shape, in the middle of its cells.
            canvas.drawTextRun(text, startIndex, runChars, startIndex, runChars, left + maxOf(0f, spare) / 2f, baseline, false, paint)
        }
    }
}

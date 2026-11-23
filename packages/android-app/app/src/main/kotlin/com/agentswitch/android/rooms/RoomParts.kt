package com.agentswitch.android.rooms

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentswitch.android.components.inlineAnnotated
import com.agentswitch.android.design.BrailleSpinner
import com.agentswitch.android.design.ClassicWaitingDot
import com.agentswitch.android.design.Fonts
import com.agentswitch.android.design.LocalLook
import com.agentswitch.android.design.PixelSprite
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.WaitingSquare
import com.agentswitch.android.design.colorOf
import com.agentswitch.kit.api.RoomFace
import com.agentswitch.kit.api.RoomMarkdown
import com.agentswitch.kit.api.RoomSeat
import com.agentswitch.kit.api.RoomText
import com.agentswitch.kit.api.SeatState
import com.agentswitch.kit.design.PixelArt
import com.agentswitch.kit.feed.ModelName
import com.agentswitch.kit.live.ShadedSprite
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.roundToInt

// The pieces a room is drawn with (docs/chatroom-v0.md §1 头像, §6.1, §10): a seat's face, its state's mark and word,
// a message's text with its `@names`, and the pictures Chat Room adds. The iPhone's `RoomParts.swift`.

/**
 * A seat's face: its 5 × 5 pattern in its colour — square cells in the pixel look, round dots in the classic one. The
 * user is a fixed `YOU`. `side`: the side of the box; the cells are a fifth of what is left inside it.
 */
@Composable
fun RoomFaceView(face: RoomFace?, modifier: Modifier = Modifier, you: Boolean = false, side: Dp = 26.dp) {
    val classic = LocalLook.current.isClassic
    if (you) {
        Box(
            modifier.size(side).background(if (classic) Theme.signal else Theme.ink, if (classic) RoundedCornerShape(side * 0.3f) else RectangleShape)
                .semantics { contentDescription = "You" },
            contentAlignment = Alignment.Center,
        ) {
            Text("YOU", color = if (classic) Color.White else Theme.base, fontSize = (side.value * 0.38f).sp, fontWeight = FontWeight.Bold,
                fontFamily = if (classic) FontFamily.Default else Fonts.mono, maxLines = 1)
        }
        return
    }
    val shown = face ?: RoomFace.fallback
    val color = colorOf(shown.rgb(Theme.isDark))
    val cells = shown.cells
    Canvas(
        modifier.size(side)
            .then(if (classic) Modifier.background(color.copy(alpha = 0.2f), RoundedCornerShape(side * 0.3f)) else Modifier.border(1.dp, color.copy(alpha = 0.45f), RectangleShape))
            .clearAndSetSemantics { },
    ) {
        // Whole pixels per cell; the classic look's dots stand a gap apart.
        val unit = max(1f, 1.dp.toPx().roundToInt().toFloat())
        val gap = if (classic) unit else 0f
        val cell = max(unit, floor((size.width - 4.dp.toPx()) / 5 / unit) * unit - gap)
        val step = cell + gap
        val drawn = step * 5 - gap
        val origin = Offset(((size.width - drawn) / 2).roundToInt().toFloat(), ((size.height - drawn) / 2).roundToInt().toFloat())
        for ((x, y) in cells) {
            val at = Offset(origin.x + x * step, origin.y + y * step)
            if (classic) drawRoundRect(color, at, Size(cell, cell), CornerRadius(cell * 0.35f)) else drawRect(color, at, Size(cell, cell))
        }
    }
}

/**
 * A seat's state as a mark (§6.1). Amber is what needs the user's hands, red what went wrong; what mends itself has no
 * colour — a spinner while it tries again, a dim key while it only waits. Never the colour alone: the word stands
 * beside it.
 */
@Composable
fun SeatStateMark(state: SeatState?, modifier: Modifier = Modifier) {
    val classic = LocalLook.current.isClassic
    Box(modifier, contentAlignment = Alignment.Center) {
        when (state?.mark) {
            SeatState.Mark.Spinner -> BrailleSpinner(color = if (state == SeatState.Reconnecting) Theme.secondaryInk else Theme.busy)
            SeatState.Mark.Amber -> if (classic) ClassicWaitingDot() else WaitingSquare()
            SeatState.Mark.Ready -> PixelSprite(PixelArt.square, pixel = 2.dp, color = Theme.done)
            SeatState.Mark.Red -> PixelSprite(PixelArt.square, pixel = 2.dp, color = Theme.failed)
            SeatState.Mark.Held -> PixelSprite(if (classic) PixelArt.square else RoomArt.dither, Modifier.alpha(if (classic) 0.45f else 1f), pixel = 2.dp, color = Theme.secondaryInk)
            SeatState.Mark.Ended, null -> PixelSprite(PixelArt.hollow, pixel = 2.dp, color = Theme.inkDim)
        }
    }
}

/** The colour a state's word is written in beside the mark: only what needs the user or went wrong has one. */
@Composable
fun SeatState?.wordColor(): Color = when (this?.mark) {
    SeatState.Mark.Amber -> Theme.waiting
    SeatState.Mark.Red -> Theme.failed
    else -> Theme.secondaryInk
}

/**
 * Chat Room's own 1-bit pictures (the concept page's): people, a reply's arrow, the Files folder of the Terminals
 * page's top bar, and the dithered key of a seat that only waits.
 */
object RoomArt {
    val people = listOf("..##...##", "..##...##", ".####.###", ".####.###")
    val reply = listOf("..#....", ".##....", "#######", ".##...#", "..#...#")
    val files = listOf("####.....", "#...#####", "#.......#", "#.......#", "#.......#", "#.......#", "#########")
    val dither = listOf("#.#.", ".#.#", "#.#.", ".#.#")

    fun agentName(harness: String): String = ModelName.harness(harness)
}

/**
 * The Rooms tab's picture in the pixel look (the app's own): a speech box raised off the ground — a light edge above
 * and left, a dark one below and right — two lines written in it, its tail below.
 */
val ShadedSprite.Companion.rooms: ShadedSprite
    get() = roomsSprite

private val roomsSprite = ShadedSprite(listOf(
    "WWWWWWWWWWWWWWW#", "W##############m", "W##############m", "W##kkkkkkkkk###m", "W##############m", "W##kkkkkk######m",
    "W##############m", "W##############m", "#mmmW##mmmmmmmmd", "....W#m.........", "....W#d.........", "....#d..........",
))

/** An agent's mark at a line's size, dim: beside a name, in a member's row. */
@Composable
fun RoomAgentMark(agent: String, modifier: Modifier = Modifier, pixel: Dp = 2.dp) {
    Box(modifier.semantics { contentDescription = RoomArt.agentName(agent) }) {
        PixelSprite(PixelArt.agents[agent] ?: PixelArt.square, pixel = pixel, color = Theme.secondaryInk, strength = 0.9f, shadow = false)
    }
}

object RoomWords {
    private fun at(ms: Long) = Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault())

    /** A message's time in its head: the hour and minute. */
    fun time(ms: Long): String = at(ms).let { "%02d:%02d".format(it.hour, it.minute) }

    /** The day written above the first message of a day. */
    fun day(ms: Long): String {
        val day = at(ms).toLocalDate()
        val today = LocalDate.now()
        return when (day) {
            today -> "Today"
            today.minusDays(1) -> "Yesterday"
            else -> "${day.monthValue}/${day.dayOfMonth}"
        }
    }

    fun who(handle: String): String = if (handle == RoomSeat.you) "You" else handle

    /** A file of a message as it is named: its last part. */
    fun fileName(path: String): String = path.trimEnd('/').substringAfterLast('/').ifEmpty { path }

    /**
     * A message's text as it is drawn: `@names` of seats firm (the classic look: in the accent), the user's own on a
     * ground, `code` in the code font; the plain words' Markdown as it reads (RoomMarkdown), a link tapped to `onLink`.
     */
    fun text(text: String, handles: Set<String>, classic: Boolean, ink: Color, base: Color, signal: Color, code: Color, onLink: (String) -> Unit = {}): AnnotatedString = buildAnnotatedString {
        var lineStart = true
        for (piece in RoomText.pieces(text, handles)) {
            when (piece) {
                is RoomText.Piece.Text -> append(inlineAnnotated(RoomMarkdown.runs(piece.text, lineStart), onLink, signal, code))
                is RoomText.Piece.Code -> withStyle(SpanStyle(fontFamily = Fonts.mono, fontSize = 14.sp, background = code)) { append(piece.text) }
                is RoomText.Piece.Mention -> {
                    val me = piece.name == RoomSeat.you
                    val style = if (classic) {
                        SpanStyle(fontWeight = FontWeight.Medium, color = if (me) Color.White else signal, background = if (me) signal else Color.Unspecified)
                    } else {
                        SpanStyle(fontFamily = Fonts.mono, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, color = if (me) base else ink, background = if (me) ink else Color.Unspecified)
                    }
                    withStyle(style) { append(if (me) " @${piece.name} " else "@${piece.name}") }
                }
            }
            lineStart = when (piece) {
                is RoomText.Piece.Text -> piece.text.endsWith("\n")
                is RoomText.Piece.Code -> piece.text.endsWith("\n")
                is RoomText.Piece.Mention -> false
            }
        }
    }
}

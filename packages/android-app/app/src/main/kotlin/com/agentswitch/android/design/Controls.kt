package com.agentswitch.android.design

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// The controls every page is made of (ios-app App/Sources/Design/Theme.swift, PixelViews.swift), drawn by the look.

/**
 * A square button in brackets, `[ Allow ]` (as the web page's .btn): the primary one filled with ink and turning to the
 * signal colour while pressed; the others a 1 dp frame; a destructive one says so in red. `expand` fills the width.
 * In the classic look a standard button: the primary one filled with the accent, the others on a quiet ground, round.
 */
@Composable
fun SquareButton(
    word: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    prominent: Boolean = false,
    destructive: Boolean = false,
    expand: Boolean = true,
    enabled: Boolean = true,
) {
    val source = remember { MutableInteractionSource() }
    val pressed = source.collectIsPressedAsState().value && enabled
    val classic = LocalLook.current.isClassic
    val width = if (expand) Modifier.fillMaxWidth() else Modifier
    if (classic) {
        Box(
            modifier.then(width).alpha(if (!enabled) 0.45f else if (pressed) 0.7f else 1f)
                .background(if (prominent) Theme.fill else Theme.raised, RoundedCornerShape(10.dp))
                .clickable(source, null, enabled, role = Role.Button, onClick = onClick)
                .padding(vertical = 10.dp, horizontal = if (expand) 0.dp else 16.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(buttonWord(word), color = if (prominent) Theme.onFill else if (destructive) Theme.failed else Theme.ink, style = plain(15, FontWeight.SemiBold), maxLines = 1)
        }
    } else {
        val ink = if (prominent) (if (pressed) Color.Black else Theme.base) else if (destructive) Theme.failed else Theme.ink
        val fill = if (prominent) (if (pressed) Theme.signal else Theme.fill) else (if (pressed) Theme.line else Color.Transparent)
        Box(
            modifier.then(width).alpha(if (enabled) 1f else 0.45f)
                .background(fill)
                .border(1.dp, if (prominent) fill else Theme.line, RectangleShape)
                .clickable(source, null, enabled, role = Role.Button, onClick = onClick)
                .padding(vertical = 10.dp, horizontal = if (expand) 0.dp else 12.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(buttonWord(word), color = ink, style = mono(14, FontWeight.Medium), maxLines = 1)
        }
    }
}

/**
 * A square icon-sized button (send, +): ink when it can act, a 1 dp frame when not; the signal colour while pressed.
 * In the classic look a disc: the accent when it can act, a quiet ground when not. `content` is given the colour to
 * draw its glyph in.
 */
@Composable
fun SquareIconButton(
    onClick: () -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    active: Boolean = true,
    side: Dp = 38.dp,
    content: @Composable (Color) -> Unit,
) {
    val source = remember { MutableInteractionSource() }
    val pressed = source.collectIsPressedAsState().value && active
    if (LocalLook.current.isClassic) {
        Box(
            modifier.size(side).alpha(if (pressed) 0.7f else 1f).clickable(source, null, active, onClickLabel = label, role = Role.Button, onClick = onClick),
            contentAlignment = Alignment.Center,
        ) {
            Box(Modifier.size(side - 6.dp).background(if (active) Theme.fill else Theme.raised, CircleShape), contentAlignment = Alignment.Center) {
                content(if (active) Theme.onFill else Theme.inkDim)
            }
        }
    } else {
        Box(
            modifier.size(side)
                .background(if (active) (if (pressed) Theme.signal else Theme.fill) else Color.Transparent)
                .border(1.dp, if (active) Color.Transparent else Theme.line, RectangleShape)
                .clickable(source, null, active, onClickLabel = label, role = Role.Button, onClick = onClick),
            contentAlignment = Alignment.Center,
        ) {
            content(if (active) (if (pressed) Color.Black else Theme.base) else Theme.inkDim)
        }
    }
}

/** A 1 dp solid rule, where a divider would be (2026-10-03, user: 分割线也别弄虚线了，改成实线吧，看着累人). */
@Composable
fun HairRule(modifier: Modifier = Modifier, color: Color = Theme.line) {
    Box(modifier.fillMaxWidth().height(1.dp).background(color).clearAndSetSemantics { })
}

/** `// Status`: a group's label in title case (§7.2.7), monospaced, spaced out. A plain small heading in the classic look. */
@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier) {
    if (LocalLook.current.isClassic) {
        Text(text, modifier, color = Theme.secondaryInk, style = plain(13, FontWeight.SemiBold))
    } else {
        Text("// $text", modifier, color = Theme.secondaryInk, style = mono(11).copy(letterSpacing = 1.4.sp))
    }
}

/**
 * `████░░░░ 62%` in characters: the used part in green (red when `high`), the rest faint. Drawn as cells, so it reads
 * the same in any font. A thin bar in the classic look.
 */
@Composable
fun CharMeter(fraction: Double, modifier: Modifier = Modifier, high: Boolean = false, cells: Int = 10) {
    val color = if (high) Theme.failed else Theme.done
    if (LocalLook.current.isClassic) {
        ClassicBar(fraction, modifier, color, (cells * 6.5f).dp)
    } else {
        val used = Math.round(fraction * cells).toInt().coerceIn(0, cells)
        val rest = Theme.inkDim
        // A cell is a character of 11 sp mono: about 6.1 wide and 11 high, the full block filling it.
        Canvas(modifier.size(width = (cells * 6.1f).dp, height = 11.dp).clearAndSetSemantics { }) {
            val w = size.width / cells
            for (i in 0 until cells) {
                if (i < used) {
                    drawRect(color, Offset(i * w, 0f), Size(w, size.height))
                } else {
                    // The light shade: every other pixel of a coarse grid.
                    val dot = (size.height / 8f).coerceAtLeast(1f)
                    var y = 0f
                    var row = 0
                    while (y < size.height) {
                        var x = i * w + (if (row % 2 == 0) 0f else dot * 2)
                        while (x < (i + 1) * w - dot / 2) { drawRect(rest, Offset(x, y), Size(dot, dot)); x += dot * 4 }
                        y += dot * 2; row += 1
                    }
                }
            }
        }
    }
}

/**
 * In progress, everywhere the same (web page, Mac, phones): ⠋⠙⠹…, drawn as the dots of a braille cell so it does not
 * depend on a font having them. A still first frame under Remove Animations. It turns only while the app is in front,
 * every spinner on the same beat (ui-v0 §7.4, 2026-10-03). The system's spinner in the classic look.
 */
@Composable
fun BrailleSpinner(modifier: Modifier = Modifier, color: Color = Theme.busy, size: Int = 13) {
    if (LocalLook.current.isClassic) {
        ClassicSpinner(modifier, size, color)
        return
    }
    val step = rememberBeat(Beat.spinner)
    val dots = BrailleFrames[step % BrailleFrames.size]
    // A braille cell: two columns of four dots. Sized like a 13 sp mono glyph in a 9 dp slot.
    Canvas(modifier.size(width = 9.dp, height = (size + 3).dp).clearAndSetSemantics { }) {
        val dot = (this.size.height / 9f)
        val left = (this.size.width - dot * 4) / 2f
        val top = (this.size.height - dot * 7) / 2f
        for (i in 0 until 8) {
            if (dots and (1 shl i) == 0) continue
            // Bits 0–2: the left column's upper three; 3–5: the right column's; 6, 7: the bottom row.
            val col = if (i == 6) 0 else if (i == 7) 1 else i / 3
            val row = if (i >= 6) 3 else i % 3
            drawRect(color, Offset(left + col * dot * 3, top + row * dot * 2), Size(dot, dot))
        }
    }
}

/** ⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏ as the dot bits of their code points (U+2800 + bits). */
private val BrailleFrames = intArrayOf(0x0B, 0x19, 0x39, 0x38, 0x3C, 0x34, 0x26, 0x27, 0x07, 0x0F)

/** A word alone on a line, centred: an empty state's sentence. */
@Composable
fun Centered(text: String, modifier: Modifier = Modifier, color: Color = Theme.secondaryInk) {
    Text(text, modifier.fillMaxWidth().padding(horizontal = 24.dp), color = color, style = plain(15), textAlign = TextAlign.Center)
}

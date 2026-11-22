package com.agentswitch.android.terminals

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.design.ClassicWaitingDot
import com.agentswitch.android.design.BrailleSpinner
import com.agentswitch.android.design.Fonts
import com.agentswitch.android.design.LocalLook
import com.agentswitch.android.design.PixelSprite
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.WaitingSquare
import com.agentswitch.android.design.colorOf
import com.agentswitch.android.design.lookWord
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.kit.api.ProfileColor
import com.agentswitch.kit.api.TerminalStatus
import com.agentswitch.kit.connection.ConnectionPhase
import com.agentswitch.kit.design.PixelArt
import java.util.Calendar

// The small parts the Terminals tab is made of and that other pages use too (TerminalsTab.swift's `TerminalStatusMark`,
// `ProfileDot`; Components.swift's `ConnectionBanner`, `Date.relative`; Look.swift's `LookGlyph`).

/** The agents whose sessions can be gone on with (pi's since 2026-10-11, Grok's since 2026-11-11, docs/terminal-v0.md §5). */
val terminalsResumable: Set<String> = setOf("claude-code", "codex", "opencode", "pi", "grok")

/**
 * Sessions whose record the Mac can delete: every agent's (docs/terminal-v0.md §5; OpenCode, through its own command,
 * and pi since 2026-10-01, user: opencode、pi 都加上删除支持).
 */
val terminalsDeletable: Set<String> = setOf("claude-code", "codex", "opencode", "pi", "grok")

/**
 * Now · 3m ago · Today 14:20 · Yesterday 14:20 · 9/24 (docs/ui-v0.md §7.2.7, as on the Mac). `ms`: milliseconds since
 * 1970 (Components.swift's `Date.relative`).
 */
fun relativeTime(ms: Long, now: Long = System.currentTimeMillis()): String {
    val seconds = (now - ms) / 1000.0
    if (seconds < 60) return "Now"
    if (seconds < 3600) return "${(seconds / 60).toInt()}m ago"
    val then = Calendar.getInstance().apply { timeInMillis = ms }
    val today = Calendar.getInstance().apply { timeInMillis = now }
    val time = "%02d:%02d".format(then.get(Calendar.HOUR_OF_DAY), then.get(Calendar.MINUTE))
    fun sameDay(a: Calendar, b: Calendar) = a.get(Calendar.YEAR) == b.get(Calendar.YEAR) && a.get(Calendar.DAY_OF_YEAR) == b.get(Calendar.DAY_OF_YEAR)
    if (sameDay(then, today)) return "Today $time"
    val yesterday = (today.clone() as Calendar).apply { add(Calendar.DAY_OF_YEAR, -1) }
    if (sameDay(then, yesterday)) return "Yesterday $time"
    return "${then.get(Calendar.MONTH) + 1}/${then.get(Calendar.DAY_OF_MONTH)}"
}

/**
 * A terminal's state in pixels (§7.2.5: only running terminals carry one): the spinner while busy, a square while
 * waiting (blinking) or idle, hollow once exited.
 * In the classic look: the system's spinner, a dot (its ring breathing while it waits), a ring once exited.
 */
@Composable
fun TerminalStatusMark(status: TerminalStatus, modifier: Modifier = Modifier) {
    val classic = LocalLook.current.isClassic
    Box(modifier, contentAlignment = Alignment.Center) {
        when (status) {
            TerminalStatus.Working -> BrailleSpinner()
            TerminalStatus.Waiting -> if (classic) ClassicWaitingDot() else WaitingSquare()
            TerminalStatus.Exited -> PixelSprite(PixelArt.hollow, pixel = 2.dp, color = Theme.inkDim)
            else -> PixelSprite(PixelArt.square, pixel = 2.dp, color = Theme.done)
        }
    }
}

/**
 * A profile's mark (docs/profiles-v0.md §3.2, ui-v0 §7.2.11): a small lit dot in the profile's colour on what runs
 * under it. Told from a state's mark by more than its colour: it is smaller, flat, has a glow, and sits at the
 * row's end beside the agent, where a state's mark leads the row. A square in the pixel look.
 */
@Composable
fun ProfileDot(color: ProfileColor, modifier: Modifier = Modifier, side: Dp = 7.dp) {
    val fill = colorOf(if (Theme.isDark) color.dark else color.light)
    val classic = LocalLook.current.isClassic
    Canvas(modifier.size(side).clearAndSetSemantics { }) {
        // The glow: a few widening, fainter copies behind the dot (the iPhone's shadow of 0.8 opacity, radius 0.45 side).
        val spread = size.width * 0.45f
        for ((grow, alpha) in listOf(1f to 0.12f, 0.6f to 0.18f, 0.25f to 0.28f)) {
            val g = spread * grow
            val r = Rect(Offset(-g, -g), Size(size.width + 2 * g, size.height + 2 * g))
            if (classic) drawOval(fill.copy(alpha = alpha), r.topLeft, r.size) else drawRect(fill.copy(alpha = alpha), r.topLeft, r.size)
        }
        if (classic) drawOval(fill, Offset.Zero, size) else drawRect(fill, Offset.Zero, size)
    }
}

/**
 * The connection line shown on top of the lists (control-v0 §5): 连接中 → 重连中 → 无法连接（第 N 次）→ 未找到 Mac →
 * 配对已失效, so a blip and a Mac that is gone read differently. The phone keeps retrying on its own; Retry only does
 * it now.
 */
@Composable
fun ConnectionBanner(modifier: Modifier = Modifier) {
    val model = LocalAppModel.current
    val phase = model.connectionPhase
    when (phase) {
        is ConnectionPhase.Connected -> Unit
        ConnectionPhase.Connecting, ConnectionPhase.Reconnecting ->
            // As wide as the page, like the other lines: alone in a scroll view this one line made the whole list as
            // narrow as itself (2026-11-11, user: 这是个啥玩意).
            Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                BrailleSpinner(color = Theme.secondaryInk)
                Text(lookWord(phase.text), color = Theme.secondaryInk, style = mono(12))
            }
        is ConnectionPhase.Failing, ConnectionPhase.Lost ->
            Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Theme.Space.xs)) {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    PixelSprite(PixelArt.square, pixel = 2.dp, color = Theme.waiting)
                    Text(phase.text, color = Theme.waiting, style = mono(12))
                    Spacer(Modifier.weight(1f))
                    Text("Retry", Modifier.clickable(role = Role.Button) { model.reconnect() }.padding(horizontal = 6.dp, vertical = 4.dp), color = Theme.signal, style = mono(12))
                }
                if (phase == ConnectionPhase.Lost) {
                    Text("Mac 可能处于睡眠状态或已离线。请查看 Settings › Mac › Troubleshooting。", color = Theme.secondaryInk, style = plain(13))
                }
            }
        ConnectionPhase.Unpaired ->
            Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                PixelSprite(PixelArt.square, pixel = 2.dp, color = Theme.failed)
                Text(phase.text, color = Theme.failed, style = mono(12))
                Spacer(Modifier.weight(1f))
                Text("Pair Again", Modifier.clickable(role = Role.Button) { model.pairAgain() }.padding(horizontal = 6.dp, vertical = 4.dp), color = Theme.signal, style = mono(12))
            }
        ConnectionPhase.CertificateChanged ->
            Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                PixelSprite(PixelArt.square, pixel = 2.dp, color = Theme.failed, modifier = Modifier.padding(top = 4.dp))
                Text("Mac 的证书与配对时不一致，已拒绝连接。", color = Theme.failed, style = plain(13))
            }
    }
}

/** The system symbols the classic look uses in place of the pixel look's glyphs, drawn as lines. */
enum class LookSymbol { ChevronRight, ChevronDown, ChevronUp, Folder, Clock, Magnifier, XCircleFill, Circle, CheckCircleFill }

/**
 * A pixel glyph (`×`, `›`, `▾`) or the symbol that stands for it in the classic look (Look.swift's `LookGlyph`).
 * `size`: the glyph's size in sp; the symbol is `scale` of it.
 */
@Composable
fun LookGlyph(glyph: String, symbol: LookSymbol, modifier: Modifier = Modifier, color: Color = Theme.secondaryInk, size: Int = 13, scale: Float = 0.85f, bold: Boolean = true) {
    if (LocalLook.current.isClassic) {
        LookSymbolIcon(symbol, modifier, (size * scale).dp, color, bold)
    } else {
        Text(glyph, modifier, color = color, style = androidx.compose.ui.text.TextStyle(fontSize = size.sp, fontFamily = Fonts.mono))
    }
}

/** A symbol of [LookSymbol] drawn in a square of `side`. */
@Composable
fun LookSymbolIcon(symbol: LookSymbol, modifier: Modifier = Modifier, side: Dp = 14.dp, color: Color = Theme.secondaryInk, bold: Boolean = false) {
    Canvas(modifier.size(side).clearAndSetSemantics { }) {
        val s = size.width
        val line = maxOf(1f, s * (if (bold) 0.14f else 0.09f))
        val stroke = Stroke(line, cap = StrokeCap.Round, join = StrokeJoin.Round)
        fun p(x: Float, y: Float) = Offset(x * s, y * s)
        fun path(vararg points: Pair<Float, Float>) = Path().apply {
            points.forEachIndexed { i, (x, y) -> if (i == 0) moveTo(x * s, y * s) else lineTo(x * s, y * s) }
        }
        when (symbol) {
            LookSymbol.ChevronRight -> drawPath(path(0.35f to 0.15f, 0.7f to 0.5f, 0.35f to 0.85f), color, style = stroke)
            LookSymbol.ChevronDown -> drawPath(path(0.15f to 0.35f, 0.5f to 0.7f, 0.85f to 0.35f), color, style = stroke)
            LookSymbol.ChevronUp -> drawPath(path(0.15f to 0.65f, 0.5f to 0.3f, 0.85f to 0.65f), color, style = stroke)
            LookSymbol.Folder -> {
                val body = Path().apply {
                    moveTo(s * 0.06f, s * 0.28f)
                    lineTo(s * 0.06f, s * 0.8f)
                    quadraticTo(s * 0.06f, s * 0.86f, s * 0.12f, s * 0.86f)
                    lineTo(s * 0.88f, s * 0.86f)
                    quadraticTo(s * 0.94f, s * 0.86f, s * 0.94f, s * 0.8f)
                    lineTo(s * 0.94f, s * 0.34f)
                    quadraticTo(s * 0.94f, s * 0.28f, s * 0.88f, s * 0.28f)
                    lineTo(s * 0.46f, s * 0.28f)
                    lineTo(s * 0.38f, s * 0.14f)
                    lineTo(s * 0.12f, s * 0.14f)
                    quadraticTo(s * 0.06f, s * 0.14f, s * 0.06f, s * 0.2f)
                    close()
                }
                drawPath(body, color, style = stroke)
            }
            LookSymbol.Clock -> {
                drawCircle(color, s * 0.44f, p(0.5f, 0.5f), style = stroke)
                drawPath(path(0.5f to 0.25f, 0.5f to 0.5f, 0.68f to 0.6f), color, style = stroke)
            }
            LookSymbol.Magnifier -> {
                drawCircle(color, s * 0.3f, p(0.42f, 0.42f), style = stroke)
                drawLine(color, p(0.64f, 0.64f), p(0.9f, 0.9f), line, StrokeCap.Round)
            }
            LookSymbol.XCircleFill -> {
                drawCircle(color, s * 0.5f, p(0.5f, 0.5f))
                val knock = Color.Black.copy(alpha = 0.55f)
                drawLine(knock, p(0.34f, 0.34f), p(0.66f, 0.66f), line, StrokeCap.Round)
                drawLine(knock, p(0.66f, 0.34f), p(0.34f, 0.66f), line, StrokeCap.Round)
            }
            LookSymbol.Circle -> drawCircle(color, s * 0.46f, p(0.5f, 0.5f), style = Stroke(maxOf(1f, s * 0.09f)))
            LookSymbol.CheckCircleFill -> {
                drawCircle(color, s * 0.5f, p(0.5f, 0.5f))
                drawPath(path(0.28f to 0.52f, 0.44f to 0.68f, 0.74f to 0.34f), Color.White, style = Stroke(maxOf(1f, s * 0.11f), cap = StrokeCap.Round, join = StrokeJoin.Round))
            }
        }
    }
}

/** `Needs You` on a terminal's row in the classic look: the amber dot said in words. */
@Composable
fun NeedsYouPill(modifier: Modifier = Modifier) {
    Text(
        lookWord("Waiting"),
        modifier.background(Theme.waiting.copy(alpha = 0.18f), androidx.compose.foundation.shape.RoundedCornerShape(50)).padding(horizontal = 7.dp, vertical = 2.dp),
        color = Theme.waiting, style = plain(11, FontWeight.SemiBold), maxLines = 1,
    )
}

/** A horizontal gap the width of `width` (the classic look's tree indentation). */
@Composable
fun Gap(width: Dp) { Spacer(Modifier.width(width)) }

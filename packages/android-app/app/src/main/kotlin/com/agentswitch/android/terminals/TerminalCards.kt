package com.agentswitch.android.terminals

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentswitch.android.design.Checker
import com.agentswitch.android.design.DitherShadow
import com.agentswitch.android.design.HairRule
import com.agentswitch.android.design.LocalLook
import com.agentswitch.android.design.PixelSprite
import com.agentswitch.android.design.PlainField
import com.agentswitch.android.design.SquareButton
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.code
import com.agentswitch.android.design.floatingShadow
import com.agentswitch.android.design.glitch
import com.agentswitch.android.design.labelWord
import com.agentswitch.android.design.lookWord
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.kit.api.TerminalPermission
import com.agentswitch.kit.design.PixelArt
import kotlinx.coroutines.launch

// What floats over a terminal's screen on the phone (docs/terminal-v0.md §1, §3), and the key bar's caps: a permission
// request, a question the agent asks, the placeholder while the terminal is in use elsewhere. Each is drawn by the look
// (docs/ui-v0.md §8): the pixel look's framed box with its dithered hard shadow, glitching in; the classic look's round
// card with a soft shadow, standard buttons and line icons. What they say and do is the same in both.
//
// A question that asks for a secret (the Mac's `secret` flag, sealed before it reaches the agent) is not drawn apart
// here: the iPhone's card (this port's source) has no such flag in its model yet; Other's words already go through the
// Mac's sealer (`TerminalPageModel.answer` notes how many it sealed).

/**
 * A floating card's ground and edge: an ink frame over a dithered shadow, glitching as it comes; round with a soft
 * shadow in the classic look.
 */
@Composable
private fun FloatingCard(trigger: Any?, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    if (LocalLook.current.isClassic) {
        val shape = RoundedCornerShape(14.dp)
        Box(modifier.floatingShadow(shape).clip(shape).background(Theme.panel, shape)) { content() }
    } else {
        Box(modifier.glitch(trigger, onAppear = true)) {
            // The floating layer's hard, dithered shadow (§7.3), not a blur.
            DitherShadow(Modifier.matchParentSize().offset(6.dp, 6.dp))
            Box(Modifier.background(Theme.base).border(1.dp, Theme.ink, RectangleShape)) { content() }
        }
    }
}

/** A permission request: what the agent wants to run, `Deny` and `Allow`. */
@Composable
fun TerminalPermissionCard(page: TerminalPageModel, permission: TerminalPermission, modifier: Modifier = Modifier) {
    val scope = rememberCoroutineScope()
    val classic = LocalLook.current.isClassic
    FloatingCard(permission.id, modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (classic) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                    WarningTriangle(Theme.waiting)
                    Text("[!] Approval", color = Theme.ink, style = plain(15, FontWeight.SemiBold))
                    Box(Modifier.weight(1f))
                    Text(permission.tool, color = Theme.secondaryInk, style = plain(13), maxLines = 1)
                }
                // The command, as code, in a field of its own.
                SelectionContainer {
                    Text(
                        permission.detail, Modifier.fillMaxWidth().background(Theme.code, RoundedCornerShape(8.dp)).padding(10.dp),
                        color = Theme.ink, style = code(16), maxLines = 6, overflow = TextOverflow.Ellipsis,
                    )
                }
            } else {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    PixelSprite(PixelArt.square, pixel = 2.dp, color = Theme.waiting)
                    Text("Permission · ${permission.tool}", color = Theme.waiting, style = mono(12, FontWeight.SemiBold))
                }
                SelectionContainer { Text(permission.detail, color = Theme.ink, style = code(16), maxLines = 6, overflow = TextOverflow.Ellipsis) }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Theme.Space.m)) {
                SquareButton("Deny", { scope.launch { page.decide(permission, allow = false) } }, Modifier.weight(1f), destructive = true)
                SquareButton("Allow", { scope.launch { page.decide(permission, allow = true) } }, Modifier.weight(1f), prominent = true)
            }
        }
    }
}

/**
 * A question the agent asks (Claude Code's AskUserQuestion; docs/terminal-v0.md §3 "选择题", phone.html?ask;
 * 2026-10-01, user: 能不能hook的更精细，直接用这个框来选agent给的选项): no allow / deny — each question with its options
 * to tap, one (`< >` / `<x>`) or several (`[ ]` / `[x]`), and Other to write in; `[ Submit ]` once every question
 * has an answer. The agent gets them as its own dialog would give them, and that dialog closes. In the classic look
 * the marks are a ring and a box.
 */
@Composable
fun TerminalQuestionCard(page: TerminalPageModel, permission: TerminalPermission, modifier: Modifier = Modifier) {
    val scope = rememberCoroutineScope()
    val picks = page.picks(permission)
    val classic = LocalLook.current.isClassic
    FloatingCard(permission.id, modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth()) {
            QuestionHead()
            // Four questions of four options each may not fit over the screen: then they scroll.
            Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState())) { Questions(page, permission) }
            Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, top = 8.dp, bottom = 12.dp), horizontalArrangement = Arrangement.End) {
                SquareButton(
                    "Submit", { scope.launch { page.answer(permission) } }, prominent = true, expand = false,
                    enabled = picks.isComplete && permission.id !in page.answering,
                )
            }
        }
    }
}

@Composable
private fun QuestionHead() {
    if (LocalLook.current.isClassic) {
        Row(Modifier.fillMaxWidth().padding(start = 14.dp, end = 14.dp, top = 14.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
            Box(Modifier.size(16.dp).background(Theme.signal, androidx.compose.foundation.shape.CircleShape), contentAlignment = Alignment.Center) {
                Text("?", color = Theme.onFill, style = plain(11, FontWeight.Bold))
            }
            Text("Question", color = Theme.ink, style = plain(15, FontWeight.SemiBold))
        }
    } else {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 24.dp).background(Theme.waiting).padding(horizontal = 8.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            PixelSprite(PixelArt.square, pixel = 2.dp, color = Color.Black)
            Text("Question", color = Color.Black, style = mono(12, FontWeight.SemiBold))
        }
    }
}

@Composable
private fun Questions(page: TerminalPageModel, p: TerminalPermission) {
    val classic = LocalLook.current.isClassic
    val picks = page.picks(p)
    Column(
        Modifier.fillMaxWidth().padding(start = if (classic) 14.dp else 12.dp, end = if (classic) 14.dp else 12.dp, top = 10.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        for ((i, q) in p.questions.withIndex()) {
            Column(Modifier.fillMaxWidth()) {
                if (q.header.isNotEmpty()) Text(labelWord(q.header), color = Theme.secondaryInk, style = mono(11, if (classic) FontWeight.SemiBold else FontWeight.Normal))
                Text(q.question, Modifier.padding(top = 2.dp, bottom = 4.dp), color = Theme.ink, style = plain(16))
                for (o in q.options) {
                    val on = picks.isPicked(o.label, i)
                    ChoiceRow(q.multiSelect, on, Modifier.clickable(role = Role.Button) { page.updatePicks(p) { it.pick(o.label, i) } }) {
                        Text(o.label, color = if (on) Theme.ink else Theme.secondaryInk, style = mono(if (classic) 15 else 13))
                        if (o.description.isNotEmpty()) Text(o.description, color = Theme.secondaryInk, style = plain(12))
                    }
                }
                // Writing in Other picks it: in place of the option picked (one), or beside them (several).
                ChoiceRow(q.multiSelect, picks.hasOther(i), Modifier) {
                    PlainField(
                        value = picks.other(i), onValueChange = { text -> page.updatePicks(p) { it.write(text, i) } },
                        placeholder = if (q.options.isEmpty()) "Answer" else "Other", style = mono(if (classic) 15 else 13),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    HairRule()
                }
            }
        }
    }
}

/**
 * One option's row: its mark — `< >` / `<x>` for one, `[ ]` / `[x]` for several (ui-v0 §7.2.6), a ring or a box in
 * the classic look — and what it says, in ink once picked.
 */
@Composable
private fun ChoiceRow(multi: Boolean, on: Boolean, modifier: Modifier, content: @Composable () -> Unit) {
    val classic = LocalLook.current.isClassic
    Row(modifier.fillMaxWidth().padding(vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (classic) {
            ClassicChoiceMark(multi, on)
        } else {
            Text(if (multi) (if (on) "[x]" else "[ ]") else (if (on) "<x>" else "< >"), color = if (on) Theme.ink else Theme.secondaryInk, style = mono(13))
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) { content() }
    }
}

/** A ring or a box, filled and in the accent when picked (the SF symbols `circle`, `largecircle.fill.circle`, `square`, `checkmark.square.fill`). */
@Composable
private fun ClassicChoiceMark(multi: Boolean, on: Boolean) {
    val color = if (on) Theme.signal else Theme.secondaryInk
    val mark = Theme.onFill
    Canvas(Modifier.size(17.dp)) {
        val line = 1.5.dp.toPx()
        val inset = line / 2
        if (multi) {
            val corner = CornerRadius(3.dp.toPx())
            if (on) {
                drawRoundRect(color, Offset.Zero, size, corner)
                val s = size.width
                drawLine(mark, Offset(s * 0.26f, s * 0.52f), Offset(s * 0.43f, s * 0.70f), line * 1.2f, StrokeCap.Round)
                drawLine(mark, Offset(s * 0.43f, s * 0.70f), Offset(s * 0.76f, s * 0.30f), line * 1.2f, StrokeCap.Round)
            } else {
                drawRoundRect(color, Offset(inset, inset), Size(size.width - line, size.height - line), corner, Stroke(line))
            }
        } else {
            drawCircle(color, radius = size.minDimension / 2 - inset, style = Stroke(line))
            if (on) drawCircle(color, radius = size.minDimension * 0.27f)
        }
    }
}

/**
 * The terminal is in use on another screen (terminal-v0 §1 "不在用的一端显示占位", phone.html?away): the frame as it
 * was behind a 50 % dither, a box saying where, glitching in; a tap anywhere takes the size back here. In the classic
 * look a quiet veil and a round card. `place`: where the terminal is in use instead ("mac", "web", "iphone").
 */
@Composable
fun TerminalAwayCover(page: TerminalPageModel, place: String, modifier: Modifier = Modifier) {
    val classic = LocalLook.current.isClassic
    val (head, line) = awayCopy[place] ?: awayCopy.getValue("web")
    val ground = page.ground
    Box(modifier.fillMaxSize().clickable(MutableInteractionSource(), null) { page.claim() }, contentAlignment = Alignment.Center) {
        Box(Modifier.fillMaxSize().background(ground.copy(alpha = if (classic) 0.62f else 0.45f)))
        if (!classic) Checker(Modifier.fillMaxSize(), color = ground)
        FloatingCard(place, Modifier.padding(horizontal = 28.dp).fillMaxWidth()) {
            Column(Modifier.fillMaxWidth()) {
                if (classic) {
                    Text(lookWord(head), Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp), color = Theme.ink, style = plain(16, FontWeight.SemiBold))
                } else {
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = 24.dp).background(Theme.ink).padding(horizontal = 10.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        PixelSprite(PixelArt.square, pixel = 2.dp, color = Theme.base)
                        Text(head, color = Theme.base, style = mono(12, FontWeight.SemiBold))
                    }
                }
                Text(
                    line, Modifier.padding(start = if (classic) 16.dp else 12.dp, end = if (classic) 16.dp else 12.dp, top = if (classic) 6.dp else 12.dp),
                    color = if (classic) Theme.secondaryInk else Theme.ink, style = plain(16),
                )
                Row(Modifier.fillMaxWidth().padding(if (classic) 16.dp else 12.dp), horizontalArrangement = Arrangement.End) {
                    SquareButton("Take Over", { page.claim() }, prominent = true, expand = false)
                }
            }
        }
    }
}

private val awayCopy: Map<String, Pair<String, String>> = mapOf(
    "mac" to ("On Mac" to "这个终端正在 Mac 上使用。"),
    "iphone" to ("On iPhone" to "这个终端正在另一台 iPhone 上使用。"),
    "web" to ("On Web" to "这个终端正在浏览器中使用。"),
)

/**
 * A key of the key bar: a small square cap with a 3 dp base; pressed, it sinks 2 dp onto a 1 dp base (the demo page's
 * key caps). The browser page's key bar uses the same caps. In the classic look a round key as the system keyboard's,
 * the one that stands out in the accent. `solid`: the one key that stands out (⏎): ink ground, the base colour's
 * letters, a wider cap. `compact`: narrower caps, for a bar that holds a long key too (the browser page's).
 */
@Composable
fun KeyCap(word: String, onClick: () -> Unit, modifier: Modifier = Modifier, solid: Boolean = false, compact: Boolean = false, enabled: Boolean = true) {
    KeyCapBox(onClick, modifier, solid, compact, enabled) { color ->
        Text(word, color = color, style = mono(13, if (solid) FontWeight.SemiBold else FontWeight.Normal), maxLines = 1)
    }
}

/** A key cap with a picture or any content on it (`content` is given the colour to draw in). */
@Composable
internal fun KeyCapBox(onClick: () -> Unit, modifier: Modifier = Modifier, solid: Boolean = false, compact: Boolean = false, enabled: Boolean = true, content: @Composable (Color) -> Unit) {
    val source = remember { MutableInteractionSource() }
    val pressed = source.collectIsPressedAsState().value && enabled
    val min = if (compact) (if (solid) 36.dp else 26.dp) else (if (solid) 46.dp else 34.dp)
    val click = Modifier.clickable(source, null, enabled, role = Role.Button, onClick = onClick)
    if (LocalLook.current.isClassic) {
        val ink = if (solid) Theme.onFill else Theme.ink
        Box(
            modifier.alpha(if (!enabled) 0.45f else if (pressed) 0.6f else 1f)
                .background(if (solid) Theme.fill else if (Theme.isDark) Color(0xFF3B3B3B) else Theme.raised, RoundedCornerShape(6.dp))
                .then(click).widthIn(min = min).padding(horizontal = if (compact) 5.dp else 6.dp, vertical = 7.dp),
            contentAlignment = Alignment.Center,
        ) { content(ink) }
    } else {
        val ink = if (solid) Theme.base else Theme.ink
        val base = if (solid) Theme.secondaryInk else Theme.inkDim
        // The cap sinks 2 dp: the space above grows by what the lower edge loses, so the bar keeps its height.
        Box(modifier.alpha(if (enabled) 1f else 0.45f).padding(top = if (pressed) 2.dp else 0.dp).then(click)) {
            Box(
                Modifier
                    .background(if (solid) (if (pressed) Theme.secondaryInk else Theme.ink) else (if (pressed) Theme.line else Theme.raised))
                    .border(1.dp, if (solid) Theme.ink else Theme.line, RectangleShape)
                    .drawBehind {
                        val h = (if (pressed) 1.dp else 3.dp).toPx()
                        drawRect(base, Offset(0f, size.height - h), Size(size.width, h))
                    }
                    .widthIn(min = min)
                    .padding(start = if (compact) 5.dp else 6.dp, end = if (compact) 5.dp else 6.dp, top = 6.dp, bottom = if (pressed) 6.dp else 8.dp),
                contentAlignment = Alignment.Center,
            ) { content(ink) }
        }
    }
}

/** The SF symbol `exclamationmark.triangle.fill`: a rounded triangle with its mark cut out. */
@Composable
private fun WarningTriangle(color: Color) {
    Canvas(Modifier.size(width = 16.dp, height = 14.dp)) {
        val path = androidx.compose.ui.graphics.Path().apply {
            moveTo(size.width / 2, 0f); lineTo(size.width, size.height); lineTo(0f, size.height); close()
        }
        drawPath(path, color)
        val w = 1.6.dp.toPx()
        drawLine(Color.Black.copy(alpha = 0.85f), Offset(size.width / 2, size.height * 0.36f), Offset(size.width / 2, size.height * 0.68f), w, StrokeCap.Round)
        drawCircle(Color.Black.copy(alpha = 0.85f), w * 0.6f, Offset(size.width / 2, size.height * 0.84f))
    }
}

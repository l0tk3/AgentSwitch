package com.agentswitch.android.terminals

import android.content.ClipData
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.draw.clip
import com.agentswitch.android.BuildConfig
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.LocalNav
import com.agentswitch.android.components.MarkdownView
import com.agentswitch.android.components.TypedText
import com.agentswitch.android.components.shellColoured
import com.agentswitch.android.demo.DemoData
import com.agentswitch.android.demo.LocalDemoScreen
import com.agentswitch.android.design.BarWord
import com.agentswitch.android.design.BrailleSpinner
import com.agentswitch.android.design.HairRule
import com.agentswitch.android.design.LocalLook
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.code
import com.agentswitch.android.design.framed
import com.agentswitch.android.design.grounded
import com.agentswitch.android.design.lookShape
import com.agentswitch.android.design.lookWord
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.android.design.rememberBeat
import com.agentswitch.android.design.shimmer
import com.agentswitch.kit.api.FileDiff
import com.agentswitch.kit.api.PlanEntry
import com.agentswitch.kit.api.RecordFile
import com.agentswitch.kit.api.RecordItem
import com.agentswitch.kit.api.RecordStep
import com.agentswitch.kit.api.RecordStepDetail
import com.agentswitch.kit.api.TerminalActivity
import com.agentswitch.kit.api.TerminalSubagent
import com.agentswitch.kit.api.ToolDisplay
import com.agentswitch.kit.api.TurnProgress
import com.agentswitch.kit.api.sessionChanges
import com.agentswitch.kit.api.sessionStep
import com.agentswitch.kit.feed.MessageDisplay
import com.agentswitch.kit.feed.RecordDisplay
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

// The rows of a session's record (docs/simple-view-v0.md §2, §5; docs/design/concepts/simple-view.html): what you said on
// the right, the agent's answers as Markdown, a run of work as one line that opens into its steps, with what it changed
// beside it. The read-only page of an earlier session and a running terminal's simple view draw the same rows.
// (ios-app App/Sources/Terminals/RecordViews.swift)
//
// Left out on Android: the link menu a long press on an answer's link opens (a tap on a link works, LocalOpenLink), the
// iPhone's long-press context menu on a file chip (a long press copies its path instead).

/** `Now` · `3m ago` · `Today 14:20` · `Yesterday 14:20` · `9/24` (docs/ui-v0.md §7.2.7, as on the Mac). `ms`: since 1970. */
internal fun recordRelative(ms: Long, now: Long = System.currentTimeMillis()): String {
    val seconds = (now - ms) / 1000.0
    if (seconds < 60) return "Now"
    if (seconds < 3600) return "${(seconds / 60).toInt()}m ago"
    val zone = ZoneId.systemDefault()
    val at = Instant.ofEpochMilli(ms).atZone(zone)
    val time = at.format(DateTimeFormatter.ofPattern("HH:mm"))
    val today = LocalDate.now(zone)
    if (at.toLocalDate() == today) return "Today $time"
    if (at.toLocalDate() == today.minusDays(1)) return "Yesterday $time"
    return "${at.monthValue}/${at.dayOfMonth}"
}

/** One item of a record: what you said, an answer, a run of work. `changes`: opens what that run changed. */
@Composable
fun RecordItemRow(item: RecordItem, modifier: Modifier = Modifier, verbose: Boolean = false, running: Boolean = false, changes: (() -> Unit)? = null, pictures: RecordPictureSource? = null) {
    Box(modifier) {
        when {
            item.kind == RecordItem.Kind.User && item.from != null -> PeerRow(item)
            item.kind == RecordItem.Kind.User -> UserRow(item, pictures)
            item.kind == RecordItem.Kind.Answer -> AnswerRow(item)
            item.kind == RecordItem.Kind.Work -> WorkRow(item, verbose, running, changes, pictures)
            else -> Text(lookWord(item.text), Modifier.fillMaxWidth(), color = Theme.inkDim, style = mono(11), textAlign = TextAlign.Center)
        }
    }
}

/** What you said: its time over a raised box at the right, its pictures under it. */
@Composable
private fun UserRow(item: RecordItem, pictures: RecordPictureSource?) {
    Column(Modifier.fillMaxWidth().padding(top = Theme.Space.s), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        // Typed while it worked: it has not read it yet.
        Text(if (item.queued) lookWord("Queued") else recordRelative(item.date), Modifier.fillMaxWidth(), color = Theme.inkDim, style = mono(11), textAlign = TextAlign.End)
        if (item.text.isNotEmpty()) RecordUserBubble(item.text, faded = item.queued)
        if (item.images > 0) {
            if (pictures != null) {
                RecordPictures(pictures, item.id, item.images)
            } else {
                Text(if (item.images == 1) "1 image" else "${item.images} images", color = Theme.secondaryInk, style = mono(11))
            }
        }
    }
}

/** Your message: ink on a quiet ground in both looks (the classic look's is the raised grey, round), selectable. */
@Composable
private fun RecordUserBubble(text: String, faded: Boolean) {
    val classic = LocalLook.current.isClassic
    Row(Modifier.fillMaxWidth()) {
        Spacer(Modifier.weight(1f).widthIn(min = 56.dp))
        SelectionContainer {
            Box(
                Modifier.alpha(if (faded) 0.55f else 1f)
                    .grounded(Theme.raised, Theme.Radius.bubble)
                    .framed(if (classic) Color.Transparent else Theme.line, Theme.Radius.bubble)
                    .padding(horizontal = 14.dp, vertical = if (classic) 9.dp else 10.dp),
            ) { TypedText(MessageDisplay.readable(text)) }
        }
    }
}

/**
 * Another session's message (docs/talk-v0.md §10.5): not yours, so not your bubble — on the agent's side, under who
 * sent it.
 */
@Composable
private fun PeerRow(item: RecordItem) {
    val classic = LocalLook.current.isClassic
    val from = item.from?.takeIf { it.isNotEmpty() } ?: "Another Session"
    val radius = if (classic) 10.dp else 0.dp
    Column(Modifier.fillMaxWidth().padding(top = Theme.Space.s), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text("From $from · ${recordRelative(item.date)}", color = Theme.inkDim, style = mono(11))
        SelectionContainer {
            val signal = Theme.signal
            val bar = if (classic) 3.dp else 2.dp
            Box(
                Modifier.grounded(Theme.raised, radius).framed(if (classic) Color.Transparent else Theme.line, radius)
                    .drawBehind { drawRect(signal, Offset.Zero, Size(bar.toPx(), size.height)) }
                    .padding(start = 12.dp, end = 14.dp, top = if (classic) 9.dp else 10.dp, bottom = if (classic) 9.dp else 10.dp),
            ) { TypedText(MessageDisplay.readable(item.text)) }
        }
    }
}

/** An answer: Markdown, its file chips, `Show More` where it is long. */
@Composable
private fun AnswerRow(item: RecordItem) {
    var whole by remember(item.id) { mutableStateOf(false) }
    val model = LocalAppModel.current
    val openMacFile = LocalOpenMacFile.current
    val head = if (whole) null else RecordDisplay.preview(item.text)
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        // What it thought on the way reads quieter than what it has to say to you.
        if (item.text.isNotEmpty()) {
            SelectionContainer {
                MarkdownView(head ?: item.text, Modifier.alpha(if (item.thinking) 0.62f else 1f))
            }
        }
        if (item.files.isNotEmpty()) {
            RecordFileChips(item.files) { file -> if (openMacFile != null) openMacFile(file) else model.showInFiles(file.folder) }
        }
        if (head != null) {
            Text(
                lookWord("Show More"),
                Modifier.clickable(remember { MutableInteractionSource() }, null, role = Role.Button) { whole = true }.padding(vertical = 4.dp),
                color = Theme.signal, style = mono(13, FontWeight.Medium),
            )
        } else if (item.clipped) {
            Text("这条回答很长，Mac 只发来了开头。", color = Theme.inkDim, style = plain(13))
        }
    }
}

/**
 * A run of work: one line (`Worked 1m 12s · Read 1 · Ran 2 · Edited 1`) with the lines it added and took away beside
 * it; opened, each step on a line.
 */
@Composable
private fun WorkRow(item: RecordItem, verbose: Boolean, running: Boolean, changes: (() -> Unit)?, source: RecordPictureSource?) {
    // The sample screen `simplestep` shows a step opened (the iPhone's `-uiDemoOpenTools`).
    val demoOpen = BuildConfig.DEBUG && LocalDemoScreen.current == "simplestep"
    var open by remember(item.id) { mutableStateOf(demoOpen) }
    // Each with its place among the run's steps: that is how one is asked for whole.
    val steps = remember(item.steps, verbose) { item.steps.withIndex().filter { verbose || it.value.kind != RecordStep.Kind.Think } }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            val toggles = !(verbose || steps.isEmpty())
            Row(
                Modifier.weight(1f).then(
                    if (toggles) Modifier.clickable(remember { MutableInteractionSource() }, null, role = Role.Button) { open = !open } else Modifier,
                ),
                horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically,
            ) {
                FoldGlyph(open || verbose)
                Text(
                    RecordDisplay.summary(item, running = running), Modifier.weight(1f, fill = false).shimmer(running),
                    color = Theme.secondaryInk, style = mono(12), maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
            val stat = RecordDisplay.stat(item.steps)
            if (stat != null) {
                Box(Modifier.then(if (changes != null) Modifier.clickable(remember { MutableInteractionSource() }, null, role = Role.Button) { changes() } else Modifier).semantics { contentDescription = "changes" }) {
                    DiffStat(stat.added, stat.removed)
                }
            }
        }
        if (open || verbose) {
            for ((index, step) in steps) StepRow(step, verbose, source, item.id, index, demoOpen)
        }
    }
}

/** `▸` closed, `▾` open (the classic look: a chevron). The fold glyph of the look. */
@Composable
internal fun FoldGlyph(open: Boolean, modifier: Modifier = Modifier) {
    if (LocalLook.current.isClassic) {
        val color = Theme.inkDim
        androidx.compose.foundation.Canvas(modifier.size(12.dp)) {
            val w = size.width
            val path = Path().apply {
                if (open) { moveTo(w * 0.2f, w * 0.35f); lineTo(w * 0.5f, w * 0.65f); lineTo(w * 0.8f, w * 0.35f) }
                else { moveTo(w * 0.35f, w * 0.2f); lineTo(w * 0.65f, w * 0.5f); lineTo(w * 0.35f, w * 0.8f) }
            }
            drawPath(path, color, style = Stroke(1.6.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
        }
    } else {
        Text(if (open) "▾" else "▸", modifier.width(12.dp), color = Theme.inkDim, style = code(12), textAlign = TextAlign.Center)
    }
}

/** A small line drawing for a step's kind (the classic look puts one before the line; the SF Symbol names are RecordDisplay's). */
@Composable
internal fun KindIcon(symbol: String, color: Color, modifier: Modifier = Modifier, side: Dp = 13.dp) {
    androidx.compose.foundation.Canvas(modifier.size(side)) { drawKind(symbol, color) }
}

private fun DrawScope.drawKind(symbol: String, color: Color) {
    val w = size.width
    val stroke = Stroke(w * 0.1f, cap = StrokeCap.Round, join = StrokeJoin.Round)
    fun p(x: Float, y: Float) = Offset(w * x, w * y)
    fun line(a: Offset, b: Offset) = drawLine(color, a, b, w * 0.1f, StrokeCap.Round)
    fun rect(l: Float, t: Float, r: Float, b: Float) = drawRoundRect(color, p(l, t), Size(w * (r - l), w * (b - t)), androidx.compose.ui.geometry.CornerRadius(w * 0.1f), style = stroke)
    when (symbol) {
        "doc.text", "doc" -> { rect(0.2f, 0.08f, 0.8f, 0.92f); line(p(0.34f, 0.4f), p(0.66f, 0.4f)); line(p(0.34f, 0.58f), p(0.66f, 0.58f)); line(p(0.34f, 0.76f), p(0.55f, 0.76f)) }
        "doc.badge.plus" -> { rect(0.2f, 0.08f, 0.8f, 0.92f); line(p(0.5f, 0.35f), p(0.5f, 0.7f)); line(p(0.33f, 0.52f), p(0.67f, 0.52f)) }
        "magnifyingglass" -> { drawCircle(color, w * 0.28f, p(0.42f, 0.42f), style = stroke); line(p(0.63f, 0.63f), p(0.9f, 0.9f)) }
        "folder" -> { rect(0.06f, 0.24f, 0.94f, 0.82f); line(p(0.06f, 0.24f), p(0.4f, 0.24f)) }
        "terminal" -> { rect(0.06f, 0.16f, 0.94f, 0.84f); line(p(0.24f, 0.38f), p(0.4f, 0.5f)); line(p(0.4f, 0.5f), p(0.24f, 0.62f)); line(p(0.5f, 0.64f), p(0.72f, 0.64f)) }
        "pencil" -> { line(p(0.2f, 0.8f), p(0.28f, 0.55f)); line(p(0.28f, 0.55f), p(0.68f, 0.15f)); line(p(0.68f, 0.15f), p(0.85f, 0.32f)); line(p(0.85f, 0.32f), p(0.45f, 0.72f)); line(p(0.45f, 0.72f), p(0.2f, 0.8f)) }
        "globe" -> { drawCircle(color, w * 0.42f, p(0.5f, 0.5f), style = stroke); drawOval(color, p(0.29f, 0.08f), Size(w * 0.42f, w * 0.84f), style = stroke); line(p(0.08f, 0.5f), p(0.92f, 0.5f)) }
        "arrow.triangle.branch" -> {
            drawCircle(color, w * 0.09f, p(0.25f, 0.2f)); drawCircle(color, w * 0.09f, p(0.25f, 0.8f)); drawCircle(color, w * 0.09f, p(0.75f, 0.35f))
            line(p(0.25f, 0.28f), p(0.25f, 0.72f)); line(p(0.25f, 0.6f), p(0.7f, 0.42f))
        }
        "checklist" -> { for (i in 0..2) { val y = 0.22f + i * 0.28f; line(p(0.12f, y), p(0.22f, y + 0.04f)); line(p(0.4f, y), p(0.9f, y)) } }
        "sparkle" -> { line(p(0.5f, 0.1f), p(0.5f, 0.9f)); line(p(0.1f, 0.5f), p(0.9f, 0.5f)) }
        "arrow.down.right.and.arrow.up.left" -> { line(p(0.15f, 0.15f), p(0.45f, 0.45f)); line(p(0.85f, 0.85f), p(0.55f, 0.55f)); line(p(0.45f, 0.2f), p(0.45f, 0.45f)); line(p(0.2f, 0.45f), p(0.45f, 0.45f)); line(p(0.55f, 0.8f), p(0.55f, 0.55f)); line(p(0.8f, 0.55f), p(0.55f, 0.55f)) }
        "checkmark.circle.fill" -> { drawCircle(color, w * 0.45f, p(0.5f, 0.5f)); line(p(0.3f, 0.5f), p(0.45f, 0.65f)); line(p(0.45f, 0.65f), p(0.72f, 0.36f)) }
        "circle.dotted.circle" -> { drawCircle(color, w * 0.42f, p(0.5f, 0.5f), style = stroke); drawCircle(color, w * 0.14f, p(0.5f, 0.5f)) }
        "circle" -> drawCircle(color, w * 0.42f, p(0.5f, 0.5f), style = stroke)
        else -> { line(p(0.2f, 0.8f), p(0.55f, 0.45f)); drawCircle(color, w * 0.2f, p(0.65f, 0.35f), style = stroke) } // a tool
    }
}

/**
 * One step: on its line what the agent said it is for, where it said; a command opens into itself — as it was
 * written, whole, in colour — and all it printed.
 */
@Composable
private fun StepRow(step: RecordStep, verbose: Boolean, source: RecordPictureSource?, work: String, index: Int, demoOpen: Boolean) {
    val model = LocalAppModel.current
    val classic = LocalLook.current.isClassic
    val isFile = step.kind in listOf(RecordStep.Kind.Read, RecordStep.Kind.Edit, RecordStep.Kind.Write, RecordStep.Kind.List)
    // A command opens into itself whole, a step that brought pictures back into them (2026-10-07, user: 这种readpng
    // 能不能展开后看到真的png内容呢).
    val opens = (step.kind == RecordStep.Kind.Run || step.images > 0) && source != null
    val isCommand = step.kind == RecordStep.Kind.Run
    var whole by remember(work, index) { mutableStateOf(demoOpen && opens && (step.note != null || step.images > 0)) }
    var detail by remember(work, index) { mutableStateOf<RecordStepDetail?>(null) }

    // Asked again once it has printed (a command still running has not).
    LaunchedEffect(if (whole && opens && isCommand) "$work/$index/${step.out?.length ?: -1}" else "") {
        if (!(whole && opens && isCommand) || source == null) return@LaunchedEffect
        val api = model.api
        if (api == null) {
            if (BuildConfig.DEBUG) detail = DemoData.stepDetail
            return@LaunchedEffect
        }
        try {
            api.sessionStep(source.harness, source.session, work, index)?.let { detail = it }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
        }
    }

    Column(Modifier.fillMaxWidth().padding(start = 18.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        val headModifier = if (opens) Modifier.clickable(remember { MutableInteractionSource() }, null, role = Role.Button) { whole = !whole } else Modifier
        Box(headModifier) { StepHead(step, verbose, classic, isFile, opens, isCommand, whole) }
        if (whole && opens) {
            if (isCommand) {
                CommandBlock(detail?.text ?: step.text)
                val out = detail?.out ?: step.out
                if (!out.isNullOrEmpty()) StepOutput(out, step.failed, lines = null)
                if (detail?.clipped == true) Text("很长：只有命令的开头和输出的末尾。", color = Theme.inkDim, style = plain(11))
            }
            if (step.images > 0 && source != null) RecordPictures(source, work, step.images, Modifier.padding(top = 2.dp), step = index, height = 140.dp)
        } else {
            // Under what it is for, the command itself on a line.
            if (step.note != null && step.kind == RecordStep.Kind.Run) {
                Text(MessageDisplay.readable(step.text), color = Theme.inkDim, style = code(11), maxLines = if (verbose) 6 else 1, overflow = TextOverflow.Ellipsis)
            }
            // What it printed, at a glance: where nothing says what the step was for, or it failed.
            val out = step.out
            if (!out.isNullOrEmpty() && (step.note == null || step.failed || verbose)) StepOutput(out, step.failed, lines = if (verbose) 14 else 4)
        }
    }
}

@Composable
private fun StepHead(step: RecordStep, verbose: Boolean, classic: Boolean, isFile: Boolean, opens: Boolean, isCommand: Boolean, whole: Boolean) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.Top) {
        // The classic look puts a small picture of the kind before the line; the pixel look's word is its mark.
        if (classic) {
            Box(Modifier.width(20.dp).padding(top = 2.dp), contentAlignment = Alignment.TopCenter) {
                KindIcon(RecordDisplay.symbol(step.kind), if (step.failed) Theme.failed else Theme.secondaryInk)
            }
        }
        Text(
            RecordDisplay.label(step), color = if (step.failed) Theme.failed else Theme.ink.copy(alpha = 0.72f),
            style = mono(12, FontWeight.Medium), maxLines = 1,
        )
        val note = step.note
        val text = MessageDisplay.readable(step.text)
        Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.Top) {
            if (note != null) {
                Text(note, Modifier.weight(1f, fill = false), color = Theme.ink.copy(alpha = 0.85f), style = plain(13), maxLines = 2, overflow = TextOverflow.Ellipsis)
            } else if (opens && isCommand) {
                Text(text, Modifier.weight(1f, fill = false), color = Theme.secondaryInk, style = code(12), maxLines = if (verbose) 6 else 2, overflow = TextOverflow.Ellipsis)
            } else {
                // A file by the end of its path (its name); a command or a query from its start.
                SelectionContainer(Modifier.weight(1f, fill = false)) {
                    Text(
                        text, color = Theme.secondaryInk, style = code(12), maxLines = if (verbose) 6 else if (isFile) 1 else 2,
                        overflow = if (isFile) TextOverflow.StartEllipsis else TextOverflow.Ellipsis,
                    )
                }
            }
            if (opens) FoldGlyph(whole, Modifier.padding(top = 2.dp))
        }
        if (step.added != null || step.removed != null) DiffStat(step.added ?: 0, step.removed ?: 0, plain = true, modifier = Modifier.padding(top = 1.dp))
    }
}

@Composable
private fun StepOutput(out: String, failed: Boolean, lines: Int?) {
    SelectionContainer {
        Text(
            out, Modifier.fillMaxWidth().background(Theme.code, lookShape(6.dp)).padding(horizontal = 8.dp, vertical = 6.dp),
            color = if (failed) Theme.failed else Theme.secondaryInk, style = code(11), maxLines = lines ?: Int.MAX_VALUE, overflow = TextOverflow.Ellipsis,
        )
    }
}

/**
 * A command as it was written: its lines kept and wrapped where the block ends, the word each command begins with,
 * what is quoted and comments in colour, `Copy` under it.
 */
@Composable
private fun CommandBlock(command: String) {
    var copied by remember { mutableStateOf(false) }
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    val shape = lookShape(6.dp)
    LaunchedEffect(copied) { if (copied) { delay(1600); copied = false } }
    Column(
        Modifier.fillMaxWidth().background(Theme.code, shape).border(1.dp, Theme.line, shape).padding(horizontal = 9.dp, vertical = 7.dp),
        horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("$", color = Theme.inkDim, style = code(12))
            SelectionContainer(Modifier.weight(1f)) { Text(shellColoured(command), style = code(12).copy(lineHeight = 18.sp)) }
        }
        Text(
            lookWord(if (copied) "Copied" else "Copy"),
            Modifier.clickable(remember { MutableInteractionSource() }, null, role = Role.Button) {
                scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("command", command))) }
                copied = true
            }.padding(vertical = 2.dp),
            color = if (copied) Theme.done else Theme.signal, style = mono(11, FontWeight.Medium),
        )
    }
}

/** Lines in and out: `+14 −2`. `plain`: without its ground (inside a row that has one). */
@Composable
fun DiffStat(added: Int, removed: Int, modifier: Modifier = Modifier, plain: Boolean = false) {
    Row(
        modifier.then(if (plain) Modifier else Modifier.background(Theme.code, lookShape(6.dp)).padding(horizontal = 7.dp, vertical = 3.dp)),
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Text("+$added", color = Theme.done, style = code(11, FontWeight.Medium), maxLines = 1)
        Text("−$removed", color = Theme.failed, style = code(11, FontWeight.Medium), maxLines = 1)
    }
}

/**
 * What it is doing now: the tool, what on, and for how long; each sub-agent on a line of its own under it. `since`:
 * when this began (the activity, else the turn), milliseconds since 1970. `progress`: how far the turn has come, as
 * the agent's own screen counts it: the number moves while it thinks, which a clock alone does not say (2026-10-08,
 * user: working 建议加上token数量，不然都不知道是不是卡死了).
 */
@Composable
fun NowLine(activity: TerminalActivity?, subagents: List<TerminalSubagent>, since: Long?, modifier: Modifier = Modifier, progress: TurnProgress? = null) {
    val classic = LocalLook.current.isClassic
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(7.dp), verticalAlignment = Alignment.CenterVertically) {
            // Still going: its words are quiet, a band of light running across them — and that says it, so no spinner
            // turns beside them (2026-10-07, user: 加载图标实际上转圈圈可以去掉了，有流光特效的话). The classic look has the
            // small picture a step of that kind has; the pixel look, its words alone.
            val symbol = RecordDisplay.toolSymbol(activity?.tool)
            if (classic && symbol != null) {
                Box(Modifier.width(20.dp), contentAlignment = Alignment.Center) { KindIcon(symbol, Theme.secondaryInk) }
            }
            Row(Modifier.weight(1f).shimmer(), horizontalArrangement = Arrangement.spacedBy(7.dp), verticalAlignment = Alignment.CenterVertically) {
                if (activity != null) {
                    Text(ToolDisplay.word(activity.tool), color = Theme.secondaryInk, style = mono(12, FontWeight.SemiBold), maxLines = 1)
                    val note = activity.note
                    if (!note.isNullOrEmpty()) {
                        Text(note, Modifier.weight(1f, fill = false), color = Theme.secondaryInk, style = plain(13), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    } else {
                        Text(MessageDisplay.readable(activity.target), Modifier.weight(1f, fill = false), color = Theme.secondaryInk, style = code(12), maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
                    }
                } else {
                    Text(lookWord("Busy"), color = Theme.secondaryInk, style = mono(12, FontWeight.SemiBold))
                }
            }
            RecordDisplay.turnTokens(progress)?.let { tokens ->
                Text(tokens, color = Theme.inkDim, style = mono(11).copy(fontFeatureSettings = "tnum"), maxLines = 1, softWrap = false)
            }
            if (since != null) {
                val tick = rememberBeat(1000)
                val seconds = remember(tick, since) { ((System.currentTimeMillis() - since) / 1000).toInt().coerceAtLeast(0) }
                Text(RecordDisplay.clock(seconds), color = Theme.inkDim, style = mono(11).copy(fontFeatureSettings = "tnum"), maxLines = 1)
            }
        }
        for (agent in subagents) {
            Row(Modifier.padding(start = 18.dp), horizontalArrangement = Arrangement.spacedBy(7.dp), verticalAlignment = Alignment.CenterVertically) {
                if (classic) Box(Modifier.width(20.dp), contentAlignment = Alignment.Center) { KindIcon(RecordDisplay.symbol(RecordStep.Kind.Agent), Theme.secondaryInk) }
                Row(Modifier.weight(1f).shimmer(), horizontalArrangement = Arrangement.spacedBy(7.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(agent.name, color = Theme.secondaryInk, style = mono(12, FontWeight.Medium), maxLines = 1)
                    Text(agent.doing, Modifier.weight(1f, fill = false), color = Theme.secondaryInk, style = code(12), maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

/**
 * What a session changed (`work` null: all of it), as a page of its own: present it with
 * `LocalNav.current.present("changes") { ChangesSheet(…) }`; it closes itself.
 */
@Composable
fun ChangesSheet(harness: String, session: String, work: String?) {
    val model = LocalAppModel.current
    val nav = LocalNav.current
    var files by remember { mutableStateOf<List<FileDiff>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(harness, session, work) {
        val api = model.api
        if (api == null) {
            if (BuildConfig.DEBUG) files = DemoData.changes
            return@LaunchedEffect
        }
        try {
            files = api.sessionChanges(harness, session, work)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.message ?: e.toString()
        }
    }
    Column(Modifier.fillMaxSize().background(Theme.base)) {
        Column(Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.statusBars)) {
            Box(Modifier.fillMaxWidth().heightIn(min = 48.dp), contentAlignment = Alignment.Center) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("Changes", color = Theme.ink, style = plain(17, FontWeight.SemiBold))
                    val list = files
                    if (list != null && list.isNotEmpty()) DiffStat(list.sumOf { it.added }, list.sumOf { it.removed })
                }
                Box(Modifier.align(Alignment.CenterEnd).padding(end = 8.dp)) { BarWord("Done", { nav.pop() }, color = Theme.signal) }
            }
            HairRule()
        }
        Column(
            Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).windowInsetsPadding(WindowInsets.navigationBars)
                .padding(horizontal = Theme.Space.l, vertical = Theme.Space.m),
            verticalArrangement = Arrangement.spacedBy(Theme.Space.l),
        ) {
            error?.let { Text(it, color = Theme.failed, style = plain(13)) }
            val list = files
            if (list != null) {
                if (list.isEmpty()) Text("没有记录到改动。", color = Theme.inkDim, style = plain(13))
                for (file in list) FileDiffView(file)
            } else if (error == null) {
                Box(Modifier.fillMaxWidth().padding(top = Theme.Space.xl), contentAlignment = Alignment.Center) { BrailleSpinner(color = Theme.secondaryInk) }
            }
        }
    }
}

@Composable
private fun FileDiffView(file: FileDiff) {
    val radius = Theme.Radius.card
    val shape = lookShape(radius)
    Column(Modifier.fillMaxWidth().grounded(Theme.panel, radius).clip(shape).framed(Theme.line, radius)) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(file.path, Modifier.weight(1f), color = Theme.ink, style = code(12, FontWeight.Medium), maxLines = 1, overflow = TextOverflow.StartEllipsis)
            DiffStat(file.added, file.removed, plain = true)
        }
        HairRule()
        // Code keeps its lines: a long one scrolls sideways, with the whole file's hunks.
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val least = maxWidth
            Column(Modifier.horizontalScroll(rememberScrollState()).widthIn(min = least).width(IntrinsicSize.Max)) {
                for (hunk in file.hunks) {
                    if (hunk.header.isNotEmpty()) DiffLine(hunk.header, Theme.secondaryInk, Theme.code)
                    for (text in hunk.lines) {
                        DiffLine(
                            text,
                            if (text.startsWith("+")) Theme.done else if (text.startsWith("-")) Theme.failed else Theme.ink.copy(alpha = 0.75f),
                            if (text.startsWith("+")) Theme.done.copy(alpha = 0.1f) else if (text.startsWith("-")) Theme.failed.copy(alpha = 0.1f) else Color.Transparent,
                        )
                    }
                }
            }
        }
        if (file.clipped) {
            HairRule()
            Text("改动很长，只显示开头。", Modifier.padding(horizontal = 10.dp, vertical = 6.dp), color = Theme.inkDim, style = plain(12))
        }
    }
}

@Composable
private fun DiffLine(text: String, color: Color, ground: Color) {
    Text(
        if (text.isEmpty()) " " else text, Modifier.fillMaxWidth().background(ground).padding(horizontal = 10.dp, vertical = 1.5.dp),
        color = color, style = code(12), maxLines = 1, softWrap = false,
    )
}

/** The agent's own task list, on one line above the reply box (`Tasks 2/4` and the one in progress); opened, the list. */
@Composable
fun TasksRow(plan: List<PlanEntry>, modifier: Modifier = Modifier) {
    val line = RecordDisplay.plan(plan) ?: return
    var open by remember { mutableStateOf(false) }
    val classic = LocalLook.current.isClassic
    Column(modifier.fillMaxWidth().padding(horizontal = Theme.Space.l, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(
            Modifier.fillMaxWidth().clickable(remember { MutableInteractionSource() }, null, role = Role.Button) { open = !open },
            horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically,
        ) {
            FoldGlyph(open)
            Text("Tasks ${line.done}/${line.total}", color = Theme.ink, style = mono(12, FontWeight.SemiBold), maxLines = 1)
            Text(line.now, Modifier.weight(1f), color = Theme.secondaryInk, style = plain(13), maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (open) {
            Column(
                Modifier.fillMaxWidth().heightIn(max = 180.dp).verticalScroll(rememberScrollState()).padding(start = 18.dp),
                verticalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                for (entry in plan) {
                    Row(horizontalArrangement = Arrangement.spacedBy(7.dp), verticalAlignment = Alignment.Top) {
                        PlanMark(entry.state, classic)
                        Text(
                            entry.text, Modifier.weight(1f),
                            color = if (entry.state == PlanEntry.State.Done) Theme.secondaryInk else Theme.ink, style = plain(13),
                            textDecoration = if (entry.state == PlanEntry.State.Done) TextDecoration.LineThrough else null,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun PlanMark(state: PlanEntry.State, classic: Boolean) {
    if (classic) {
        when (state) {
            PlanEntry.State.Done -> KindIcon("checkmark.circle.fill", Theme.done)
            PlanEntry.State.Doing -> KindIcon("circle.dotted.circle", Theme.signal)
            else -> KindIcon("circle", Theme.inkDim)
        }
    } else {
        Text(
            when (state) { PlanEntry.State.Done -> "[x]"; PlanEntry.State.Doing -> "[>]"; else -> "[ ]" },
            color = when (state) { PlanEntry.State.Doing -> Theme.busy; PlanEntry.State.Done -> Theme.done; else -> Theme.secondaryInk },
            style = mono(12),
        )
    }
}

/**
 * The files an answer points at (Codex's file citations): each a chip — a sheet, its name, its kind in the agent's
 * word — a tap opening it; a long press copies its path.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun RecordFileChips(files: List<RecordFile>, open: (RecordFile) -> Unit) {
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    val classic = LocalLook.current.isClassic
    var copied by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(copied) { if (copied != null) { delay(1400); copied = null } }
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.Start, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        for (file in files) {
            val shape = lookShape(Theme.Radius.control)
            Row(
                Modifier.background(Theme.raised, shape).then(if (classic) Modifier else Modifier.border(1.dp, Theme.line, shape))
                    .combinedClickable(
                        remember { MutableInteractionSource() }, null, role = Role.Button,
                        onLongClick = {
                            scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("path", file.path))) }
                            copied = file.path
                        },
                    ) { open(file) }
                    .padding(horizontal = 10.dp, vertical = 7.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically,
            ) {
                KindIcon("doc", Theme.ink, side = 12.dp)
                Text(file.name, Modifier.weight(1f, fill = false), color = Theme.ink, style = mono(12), maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
                if (copied == file.path) Text("Path Copied", color = Theme.done, style = mono(12), maxLines = 1)
                else file.kindWord?.let { Text(it, color = Theme.secondaryInk, style = mono(12), maxLines = 1) }
            }
        }
    }
}

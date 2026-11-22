package com.agentswitch.android.dispatch

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.LocalNav
import com.agentswitch.android.components.ErrorText
import com.agentswitch.android.components.LocalOpenLink
import com.agentswitch.android.components.MarkdownView
import com.agentswitch.android.components.StaleNote
import com.agentswitch.android.components.StatusLabel
import com.agentswitch.android.components.TypedText
import com.agentswitch.android.components.inlineAnnotated
import com.agentswitch.android.design.BarBack
import com.agentswitch.android.design.BrailleSpinner
import com.agentswitch.android.design.LocalLook
import com.agentswitch.android.design.NavBar
import com.agentswitch.android.design.PixelBox
import com.agentswitch.android.design.PixelBoxEffect
import com.agentswitch.android.design.SectionLabel
import com.agentswitch.android.design.SquareButton
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.card
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.android.terminals.LookGlyph
import com.agentswitch.android.terminals.LookSymbol
import com.agentswitch.android.terminals.relativeTime
import com.agentswitch.kit.api.AgentTask
import com.agentswitch.kit.api.EventDescriber
import com.agentswitch.kit.api.Targets
import com.agentswitch.kit.api.TargetRef
import com.agentswitch.kit.api.TaskEvent
import com.agentswitch.kit.feed.Markdown
import com.agentswitch.kit.feed.MessageDisplay
import com.agentswitch.kit.feed.ModelName
import com.agentswitch.kit.feed.ProcessFolding
import com.agentswitch.kit.feed.Speech
import com.agentswitch.kit.feed.TaskDuration
import com.agentswitch.kit.feed.displayName
import com.agentswitch.kit.feed.isInterrupted
import com.agentswitch.kit.files.TaskFile
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * A task (docs/ui-v0.md): what was asked and its state on top; what waits for you; the summary, the result, the files;
 * then the whole process, one line per event. Actions in the bar: read aloud, and `⋯` with cancel while active, give it
 * to another model, delete the task. A page: push it with `LocalNav`.
 */
@Composable
fun TaskDetailView(taskId: String) {
    val model = LocalAppModel.current
    val nav = LocalNav.current
    val scope = rememberCoroutineScope()
    val detail = remember(taskId) { TaskDetailModel(taskId) }
    val opener = remember { TaskFileOpener() }
    var files by remember { mutableStateOf<List<TaskFile>>(emptyList()) }
    var targets by remember { mutableStateOf<Targets?>(null) }
    var menu by remember { mutableStateOf<TaskMenu?>(null) }
    var confirmCancel by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf<DeleteRequest?>(null) }
    val task = detail.task
    val speaker = model.dispatch.speaker

    DisposableEffect(detail) {
        detail.start(model)
        onDispose {
            if (speaker.speakingKey == taskId) speaker.stop()
            detail.stop()
        }
    }
    // Deliverables appear as the task runs: list them again whenever its state changes.
    LaunchedEffect(task?.status) {
        val api = model.api ?: return@LaunchedEffect
        try {
            // Deliverables first: they are what the task was for.
            files = api.taskFiles(taskId).sortedWith(compareBy({ if (it.isDeliverable) 0 else 1 }, { it.path }))
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
        }
    }
    // Opening a task reads it (control-v0 §4); one that ends or changes while it is open is read again.
    LaunchedEffect(task?.updatedAt) {
        val open = detail.task ?: return@LaunchedEffect
        if (model.dispatch.isUnread(open)) model.dispatch.acknowledge(open)
    }
    LaunchedEffect(Unit) {
        targets = model.dispatch.targets
        val api = model.api ?: return@LaunchedEffect
        try { targets = api.targets() } catch (e: CancellationException) { throw e } catch (_: Exception) {}
    }

    PixelBoxEffect(menu, { menu = null }) { PixelBox(head = it.head, cancel = null, actions = it.actions, anchor = it.anchor) }
    PixelBoxEffect(confirmCancel, { confirmCancel = false }) {
        PixelBox(
            head = "Cancel Task", tone = PixelBox.Tone.Red, message = "取消此任务？",
            actions = listOf(PixelBox.Action("Cancel Task", PixelBox.Action.Role.Destructive) { scope.launch { detail.cancel(model) } }),
        )
    }
    DeleteConfirmation(deleting, onDismiss = { deleting = null }, onError = { detail.error = it }, done = { nav.pop() })
    TaskFilePreview(opener)

    fun openMenu(anchor: Rect) {
        val current = detail.task ?: return
        val rows = ArrayList<PixelBox.Action>()
        if (current.status.isActive) rows += PixelBox.Action("Cancel Task", PixelBox.Action.Role.Destructive) { confirmCancel = true }
        rows += PixelBox.Action("Hand to Another Model ▸") {
            val options = listOf(PixelBox.Action("Auto") { scope.launch { detail.handoff(null, model) } }) +
                (targets?.pinOptions ?: emptyList()).map { ref: TargetRef -> PixelBox.Action(ref.displayName) { scope.launch { detail.handoff(ref, model) } } }
            menu = TaskMenu("Hand to Another Model", anchor, options)
        }
        if (!current.status.isActive) rows += PixelBox.Action("Delete Task", PixelBox.Action.Role.Destructive) { deleting = DeleteRequest.Task(current) }
        menu = TaskMenu(null, anchor, rows)
    }

    Column(Modifier.fillMaxSize().background(Theme.base)) {
        TaskBar(
            task = task, speaking = speaker.speakingKey == taskId,
            onBack = { nav.pop() }, onSpeak = { task?.let { speaker.toggle(it) } }, onMore = ::openMenu,
        )
        LazyColumn(
            Modifier.fillMaxSize(),
            contentPadding = PaddingValues(start = Theme.Space.l, end = Theme.Space.l, top = Theme.Space.m, bottom = Theme.Space.m),
        ) {
            if (task != null) {
                item("header") { Header(detail, task, Modifier.padding(bottom = Theme.Space.xl)) }
                items(detail.pending, key = { "approval:" + it.id }) { approval ->
                    ApprovalCard(
                        approval, Modifier.card().padding(bottom = 0.dp),
                        onDecide = { d -> detail.decide(approval, d, model) },
                        onAnswer = { a -> detail.answer(approval, a, model) },
                    )
                    Spacer(Modifier.size(Theme.Space.xl))
                }
                outcome(detail, task) { scope.launch { detail.handoff(null, model) } }
                if (files.isNotEmpty()) item("files") { Box(Modifier.padding(bottom = Theme.Space.xl)) { TaskFilesSection(task.id, files, opener) } }
                detail.handedOffTo?.let { next ->
                    item("next") {
                        LinkRow("已交给新任务", next.modelName, Modifier.padding(bottom = Theme.Space.xl)) { nav.push("task:${next.id}") { TaskDetailView(next.id) } }
                    }
                }
            } else if (detail.error == null) {
                item("spinner") { Box(Modifier.fillMaxWidth().padding(top = Theme.Space.xl, bottom = Theme.Space.xl), contentAlignment = Alignment.Center) { BrailleSpinner(color = Theme.secondaryInk) } }
            }
            if (detail.error != null) item("error") { ErrorText(detail.error, { detail.error = null }, Modifier.padding(bottom = Theme.Space.xl)) }
            process(detail)
            item("end") { Spacer(Modifier.windowInsetsPadding(WindowInsets.navigationBars).size(1.dp)) }
        }
    }
}

private class TaskMenu(val head: String?, val anchor: Rect, val actions: List<PixelBox.Action>)

private fun androidx.compose.foundation.lazy.LazyListScope.outcome(detail: TaskDetailModel, task: AgentTask, onContinue: () -> Unit) {
    val speech = if (task.status.isTerminal) task.speech?.let { Speech.speakable(it) } else null
    if (task.status.isTerminal && !speech.isNullOrEmpty()) {
        item("summary") { Block("Summary", Modifier.padding(bottom = Theme.Space.xl)) { SelectionContainer { Text(speech, color = Theme.ink, style = plain(17)) } } }
    } else if (task.status.isTerminal && detail.awaitingSummary) {
        item("awaiting") { Text("摘要生成中", Modifier.padding(bottom = Theme.Space.xl), color = Theme.secondaryInk, style = plain(13)) }
    }
    val result = task.result
    if (!result.isNullOrEmpty()) {
        item("result") { Block("Result", Modifier.padding(bottom = Theme.Space.xl)) { SelectionContainer { MarkdownView(result) } } }
    }
    val error = task.error
    if (task.isInterrupted) {
        item("reason") {
            Block("Reason", Modifier.padding(bottom = Theme.Space.xl)) {
                Column(verticalArrangement = Arrangement.spacedBy(Theme.Space.m)) {
                    SelectionContainer { Text(error?.let { MessageDisplay.readable(it) } ?: AgentTask.interruptedText, color = Theme.ink, style = plain(17)) }
                    // Stopped by a restart of the Mac's service (control-v0 §4): never rerun by itself; 继续执行 hands it on.
                    if (detail.handedOffTo == null) SquareButton("Continue", onContinue, expand = false)
                }
            }
        }
    } else if (!error.isNullOrEmpty() && task.status != com.agentswitch.kit.api.TaskStatus.Done) {
        item("reason") { Block("Reason", Modifier.padding(bottom = Theme.Space.xl)) { SelectionContainer { FailedMarkdown(error) } } }
    }
}

/** A reason in the failure colour (MarkdownView draws in the ink, so the text is flattened to its runs here). */
@Composable
private fun FailedMarkdown(text: String) {
    val onLink = LocalOpenLink.current
    val signal = Theme.signal
    val wash = Theme.code
    val line: AnnotatedString = remember(text, signal, wash) { inlineAnnotated(Markdown.flattened(MessageDisplay.readable(text)), onLink, signal, wash) }
    Text(line, color = Theme.failed, style = plain(17))
}

/**
 * Every event, oldest first; "Live" while the stream is open. A tool call opens to its input and result; the results
 * are not rows of their own. Calls in a row fold into one line (control-v0 §5); a finished task ends with how long it took.
 */
private fun androidx.compose.foundation.lazy.LazyListScope.process(detail: TaskDetailModel) {
    val events = detail.events
    val active = detail.task?.status?.isActive ?: false
    val results = HashMap<String, TaskEvent>()
    for (e in events) if (e.type == "tool_result") e.payload["id"]?.string?.let { results.putIfAbsent(it, e) }
    val folded = ProcessFolding.items(events)
    item("process") { Block("Process", Modifier.padding(bottom = Theme.Space.s), trailing = if (detail.live) "Live" else null) {} }
    if (events.isEmpty()) {
        item("noprocess") { Text(if (detail.live) "暂无记录" else "无记录", color = Theme.inkDim, style = plain(13)) }
    } else {
        items(folded, key = { it.id }) { item ->
            Box(Modifier.padding(bottom = 10.dp)) {
                when (item) {
                    is ProcessFolding.Item.Event -> ProcessEventRow(item.event, results, active = active)
                    is ProcessFolding.Item.Tools -> ToolGroupRow(item.calls, results, active = active, ongoing = active && item.id == folded.lastOrNull()?.id)
                }
            }
        }
        // What its run is writing now, as its answer will read (docs/simple-view-v0.md §5.14).
        val writing = detail.writing
        if (active && writing != null) {
            item("writing") {
                Box(Modifier.alpha(if (writing.thinking) 0.62f else 1f).padding(bottom = 10.dp).semantics { contentDescription = if (writing.thinking) "Thinking" else "Writing" }) {
                    MarkdownView(writing.text + " ▍")
                }
            }
        }
        // Not for a task a restart stopped: its end is when the service went down, not when it finished.
        val task = detail.task
        val seconds = if (task != null && !task.isInterrupted) TaskDuration.seconds(task, events) else null
        if (seconds != null) {
            item("duration") { Text(TaskDuration.text(seconds), Modifier.padding(start = EventRowTimeWidth + 10.dp), color = Theme.inkDim, style = plain(12)) }
        }
    }
}

/** What was asked, then one line of state: status, model, harness, when; the thread it belongs to under it. */
@Composable
private fun Header(detail: TaskDetailModel, task: AgentTask, modifier: Modifier = Modifier) {
    val model = LocalAppModel.current
    val nav = LocalNav.current
    val waiting = detail.pending.isNotEmpty()
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Theme.Space.s)) {
        // As typed, its code drawn as code (TypedText).
        SelectionContainer { TypedText(MessageDisplay.readable(task.task), fontSize = 20, weight = FontWeight.SemiBold) }
        val harness = if (task.model == null) null else task.harness?.let { ModelName.harness(it) }
        val parts = listOfNotNull(task.modelName, harness, relativeTime(task.created))
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            StatusLabel(task, waiting = waiting)
            parts.forEachIndexed { i, part ->
                Text("·", color = Theme.inkDim, style = mono(12))
                Text(part, Modifier, color = Theme.secondaryInk, style = mono(12), maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
            }
        }
        StaleNote(task, lastEventAt = detail.events.lastOrNull()?.ts, waiting = waiting)
        val threadId = task.threadId
        val title = threadId?.let { model.dispatch.thread(it)?.title }
        if (threadId != null && !title.isNullOrEmpty()) {
            Row(
                Modifier.clickable(role = Role.Button) { nav.push("thread:$threadId") { ThreadView(threadId) } },
                horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("Topic", color = Theme.inkDim, style = mono(12))
                Text(title, Modifier.weight(1f, fill = false), color = Theme.secondaryInk, style = plain(13), maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
                LookGlyph("›", LookSymbol.ChevronRight, color = Theme.inkDim, size = 12)
            }
        }
    }
}

// MARK: the bar

@Composable
private fun TaskBar(task: AgentTask?, speaking: Boolean, onBack: () -> Unit, onSpeak: () -> Unit, onMore: (Rect) -> Unit) {
    var more by remember { mutableStateOf(Rect.Zero) }
    val classic = LocalLook.current.isClassic
    val tint = if (classic) Theme.signal else Theme.ink
    NavBar(
        "Task",
        leading = { BarBack(onBack) },
        trailing = {
            if (task != null && task.status.isTerminal) {
                BarButton(onSpeak, if (speaking) "停止朗读" else "朗读") { Canvas(Modifier.size(22.dp)) { drawSpeaker(tint, speaking) } }
            }
            Box(Modifier.onGloballyPositioned { more = it.boundsInRoot() }) {
                BarButton({ if (task != null) onMore(more) }, "more", enabled = task != null) {
                    if (classic) Canvas(Modifier.size(22.dp)) { drawEllipsis(tint) } else Text("⋯", color = tint, style = mono(17))
                }
            }
        },
    )
}

@Composable
private fun BarButton(onClick: () -> Unit, label: String, enabled: Boolean = true, content: @Composable () -> Unit) {
    Box(
        Modifier.size(width = 44.dp, height = 48.dp).alpha(if (enabled) 1f else 0.4f).clickable(enabled, role = Role.Button, onClickLabel = label, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { content() }
}

private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawEllipsis(color: Color) {
    val w = size.width
    drawCircle(color, w * 0.46f, center, style = Stroke(w * 0.08f))
    for (x in listOf(0.3f, 0.5f, 0.7f)) drawCircle(color, w * 0.045f, Offset(w * x, w * 0.5f))
}

/** The speaker with its waves (the iPhone's `speaker.wave.2`), or a stop circle while it reads. */
private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawSpeaker(color: Color, speaking: Boolean) {
    val w = size.width
    val stroke = Stroke(w * 0.08f, cap = StrokeCap.Round, join = StrokeJoin.Round)
    if (speaking) {
        drawCircle(color, w * 0.44f, center, style = stroke)
        drawRect(color, Offset(w * 0.35f, w * 0.35f), androidx.compose.ui.geometry.Size(w * 0.3f, w * 0.3f))
        return
    }
    val body = Path().apply {
        moveTo(w * 0.1f, w * 0.4f); lineTo(w * 0.28f, w * 0.4f); lineTo(w * 0.5f, w * 0.2f)
        lineTo(w * 0.5f, w * 0.8f); lineTo(w * 0.28f, w * 0.6f); lineTo(w * 0.1f, w * 0.6f); close()
    }
    drawPath(body, color, style = stroke)
    for (r in listOf(0.14f, 0.26f)) {
        val arc = Path().apply { arcTo(androidx.compose.ui.geometry.Rect(Offset(w * (0.5f - r), w * (0.5f - r * 1.5f)), Offset(w * (0.5f + r + 0.04f) + w * r * 0.0f, w * (0.5f + r * 1.5f))), -55f, 110f, true) }
        drawPath(arc, color, style = stroke)
    }
}

// MARK: shared parts

/** A part of a content page: a `// label` heading, then its content; no box (docs/ui-v0.md §1.3, §7.2.7). */
@Composable
fun Block(title: String, modifier: Modifier = Modifier, trailing: String? = null, content: @Composable () -> Unit) {
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Theme.Space.s)) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            SectionLabel(title)
            Spacer(Modifier.weight(1f))
            if (trailing != null) {
                BrailleSpinner()
                Text(trailing, color = Theme.busy, style = mono(11))
            }
        }
        content()
    }
}

/** A card that leads somewhere: a title, a grey detail, a chevron. */
@Composable
fun LinkRow(title: String, detail: String? = null, modifier: Modifier = Modifier, onClick: () -> Unit = {}) {
    Row(
        modifier.fillMaxWidth().card().clickable(role = Role.Button, onClick = onClick).padding(Theme.Space.m),
        horizontalArrangement = Arrangement.spacedBy(Theme.Space.s), verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(title, color = Theme.ink, style = plain(15))
        if (detail != null) Text(detail, color = Theme.secondaryInk, style = plain(15), maxLines = 1)
        Spacer(Modifier.weight(1f))
        LookGlyph("›", LookSymbol.ChevronRight, color = Theme.inkDim, size = 13)
    }
}

/** The time column, one width for every row so an opened tool call lines up under its text. */
val EventRowTimeWidth: Dp = 52.dp

private val clock = object : ThreadLocal<SimpleDateFormat>() {
    override fun initialValue() = SimpleDateFormat("HH:mm:ss", Locale.US)
}

@Composable
fun EventTime(event: TaskEvent) {
    val text = remember(event.ts) { clock.get()!!.format(Date(event.ts)) }
    Text(text, Modifier.width(EventRowTimeWidth), color = Theme.inkDim, style = mono(11).copy(fontFeatureSettings = "tnum"), maxLines = 1, softWrap = false)
}

/**
 * Model-written lines (its text, the final result or error) are Markdown; the daemon's own lines (tool calls, routing)
 * stay plain, so a `*` in a command is never taken for emphasis.
 */
private val markdownTypes = setOf("text", "done", "partial", "blocked", "failed")

/**
 * One event: its time, then the line. What the model wrote reads as text; the rest is smaller and grey, with the status
 * colours for questions, the end and failures.
 */
@Composable
fun EventRow(event: TaskEvent, modifier: Modifier = Modifier) {
    val onLink = LocalOpenLink.current
    val signal = Theme.signal
    val wash = Theme.code
    val line: AnnotatedString = remember(event, signal, wash) {
        val text = EventDescriber.line(event)
        if (event.type in markdownTypes) inlineAnnotated(Markdown.flattened(text), onLink, signal, wash) else AnnotatedString(text)
    }
    val color = when (EventDescriber.tone(event)) {
        EventDescriber.Tone.Normal -> Theme.ink
        EventDescriber.Tone.Muted -> Theme.secondaryInk
        EventDescriber.Tone.Attention -> Theme.waiting
        EventDescriber.Tone.Success -> Theme.done
        EventDescriber.Tone.Failure -> Theme.failed
    }
    Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        EventTime(event)
        SelectionContainer(Modifier.weight(1f)) { Text(line, color = color, style = plain(if (event.type == "text") 15 else 13)) }
    }
}

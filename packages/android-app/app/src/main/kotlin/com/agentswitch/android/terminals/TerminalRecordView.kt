package com.agentswitch.android.terminals

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.LocalNav
import com.agentswitch.android.components.MarkdownView
import com.agentswitch.android.design.BrailleSpinner
import com.agentswitch.android.design.LocalLook
import com.agentswitch.android.design.SquareButton
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.WaitingSquare
import com.agentswitch.android.design.framed
import com.agentswitch.android.design.grounded
import com.agentswitch.android.design.lookShape
import com.agentswitch.android.design.lookWord
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.android.design.rememberBeat
import com.agentswitch.kit.api.RecordItem
import com.agentswitch.kit.api.RecordQuestion
import com.agentswitch.kit.api.ScreenChoices
import com.agentswitch.kit.api.ScreenNotice
import com.agentswitch.kit.api.SentReply
import com.agentswitch.kit.api.TerminalInfo
import com.agentswitch.kit.api.TerminalStatus
import com.agentswitch.kit.feed.MessageDisplay
import com.agentswitch.kit.feed.ModelName
import com.agentswitch.kit.feed.RecordDisplay
import com.agentswitch.kit.support.PathDisplay
import kotlinx.coroutines.launch

/**
 * A terminal's simple view (docs/simple-view-v0.md §5.1; docs/design/concepts/simple-view.html): the session's record —
 * its title, what was said, each run of work on a line — then what it is doing now and what waits for you, last. It
 * draws no terminal, so it takes no size: the terminal can be in use on the Mac meanwhile. `terminal`: the terminal as
 * the list has it now (its folder, model, session). `openTerminal`: to the program's own screen (a prompt it drew
 * itself).
 *
 * Kept to the end as new items arrive, unless the reader went up: then a `New` pill says there is more below. Left out
 * (the page's shell owns them on Android): putting the keyboard away on a tap in the record.
 */
@Composable
fun TerminalRecordView(page: TerminalPageModel, record: SessionRecordModel, terminal: TerminalInfo, git: String?, verbose: Boolean, openTerminal: () -> Unit, modifier: Modifier = Modifier) {
    val model = LocalAppModel.current
    val nav = LocalNav.current
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()
    val working = page.status == TerminalStatus.Working
    val classic = LocalLook.current.isClassic
    // The program waits on something it drew itself (a menu, a login): no card of ours says what.
    val prompting = page.status == TerminalStatus.Waiting && page.permissions.isEmpty()
    val canShowChanges = terminal.agentSessionId != null && (terminal.harness == "claude-code" || terminal.harness == "codex")
    val source = terminal.agentSessionId?.let { RecordPictureSource(terminal.harness, it) }
    // What was sent and is not in the record yet stands at its end (2026-10-08).
    val shown = remember(record.items, page.notices, page.sent, working) {
        SentReply.appended(ScreenNotice.placed(record.items, page.notices), page.sent, working)
    }

    var atEnd by remember { mutableStateOf(true) }
    var unseen by remember { mutableStateOf(false) }
    // The end is where the reader is while the list is not being moved by a finger; once it is, the end is where it ends.
    LaunchedEffect(listState) {
        snapshotFlow { listState.isScrollInProgress to !listState.canScrollForward }.collect { (moving, end) ->
            if (moving || end) { atEnd = end; if (end) unseen = false }
        }
    }
    // The end is what matters: there when it opens, and following it while the user is there. Scrolled back to read, the
    // page stays put and says there is more below.
    LaunchedEffect(record.loaded) { if (record.loaded) listState.scrollToEnd(false) }
    suspend fun follow(always: Boolean = false) {
        if (atEnd || always) listState.scrollToEnd(true) else unseen = true
    }
    val last = record.items.lastOrNull()
    LaunchedEffect(last) { follow() }
    LaunchedEffect(page.sent.size, page.notices.size) { follow() }
    LaunchedEffect(page.writing?.text?.length) { if (page.writing != null && atEnd) listState.scrollToEnd(false) }
    LaunchedEffect(page.permissions.size) { follow(always = true) }
    LaunchedEffect(page.status) { follow() }

    fun showChanges(work: String?) {
        val session = terminal.agentSessionId ?: return
        nav.present("changes") { ChangesSheet(terminal.harness, session, work) }
    }

    Box(modifier.fillMaxSize().background(Theme.base)) {
        LazyColumn(
            Modifier.fillMaxSize(), listState,
            contentPadding = PaddingValues(horizontal = Theme.Space.l, vertical = Theme.Space.m),
            verticalArrangement = Arrangement.spacedBy(Theme.Space.l),
        ) {
            item(key = "header") { Header(page, record, terminal, git) }
            record.error?.let { error -> item(key = "error") { Text(error, color = Theme.failed, style = plain(13)) } }
            if (record.more) {
                item(key = "earlier") {
                    Row(
                        Modifier.fillMaxWidth().clickable(remember { MutableInteractionSource() }, null, enabled = !record.loadingEarlier, role = Role.Button) {
                            scope.launch { record.earlier(model.api) }
                        }.padding(vertical = 4.dp),
                        horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically,
                    ) {
                        if (record.loadingEarlier) BrailleSpinner(color = Theme.secondaryInk)
                        Text(lookWord("Earlier"), color = Theme.signal, style = mono(13, FontWeight.Medium))
                    }
                }
            }
            if (!record.loaded) {
                item(key = "loading") {
                    Box(Modifier.fillMaxWidth().padding(top = Theme.Space.xl), contentAlignment = Alignment.Center) { BrailleSpinner(color = Theme.secondaryInk) }
                }
            } else if (record.items.isEmpty() && page.sent.isEmpty() && page.notices.isEmpty() && !working && page.permissions.isEmpty() && page.choices == null) {
                item(key = "empty") { EmptyState(page, record, terminal, openTerminal) }
            }
            items(shown, key = { it.id }) { item ->
                RecordItemRow(
                    item, verbose = verbose, running = working && item.id == record.items.lastOrNull()?.id && item.kind == RecordItem.Kind.Work,
                    changes = if (canShowChanges) ({ showChanges(item.id) }) else null, pictures = source,
                )
            }
            // What it is writing now, as its answer will read (docs/simple-view-v0.md §5.14).
            page.writing?.let { writing ->
                item(key = "writing") {
                    val said = if (writing.thinking) "Thinking" else "Writing"
                    MarkdownView(writing.text + " ▍", Modifier.fillMaxWidth().alpha(if (writing.thinking) 0.62f else 1f).semantics { contentDescription = said })
                }
            }
            if (working && page.permissions.isEmpty()) {
                item(key = "now") {
                    NowLine(page.activity ?: terminal.activity, if (page.activityKnown) page.subagents else terminal.subagents, page.activitySince, progress = page.progress)
                }
            }
            items(page.permissions, key = { "permission-${it.id}" }) { p ->
                if (p.isQuestion) TerminalQuestionCard(page, p) else TerminalPermissionCard(page, p)
            }
            // A list of its own on its screen (Codex's `/model`, a question of its own): the same rows here.
            val choices = page.choices
            if (choices != null && page.permissions.isEmpty()) {
                item(key = "choices") {
                    ChoiceCard(
                        said = choices.said, rows = choices.options.map { it.label to it.detail }, selected = choices.selected,
                        foot = "这是它自己屏幕上的列表：点一行，等于在终端里选中并回车。",
                    ) { pick -> scope.launch { page.choose(pick) } }
                }
            } else if (prompting) {
                item(key = "prompt") { PromptCard(openTerminal) }
            } else if (!working && page.permissions.isEmpty()) {
                // What its last message asks, with the answers it offers (Codex): one of them as your reply.
                val questions = RecordQuestion.open(record.items, page.sent)
                itemsIndexed(questions, key = { i, _ -> "question-$i" }) { _, question ->
                    ChoiceCard(
                        said = ScreenChoices.said(question.title, null), rows = question.options.map { it to null }, selected = null,
                        foot = "点一个作为回复发出；也可以在下面自己写。",
                    ) { pick -> scope.launch { page.send(question.options[pick], sealed = false) } }
                }
            }
            if (page.status == TerminalStatus.Exited) {
                item(key = "exited") { Text(lookWord("Exited"), Modifier.fillMaxWidth(), color = Theme.inkDim, style = mono(11), textAlign = TextAlign.Center) }
            }
            item(key = "end") { Spacer(Modifier.height(1.dp)) }
        }
        if (!atEnd) {
            Box(Modifier.align(Alignment.BottomCenter).padding(bottom = 8.dp)) {
                Row(
                    Modifier.grounded(Theme.panel, 16.dp).framed(Theme.line, 16.dp)
                        .clickable(remember { MutableInteractionSource() }, null, role = Role.Button) { scope.launch { listState.scrollToEnd(true) } }
                        .padding(horizontal = 12.dp, vertical = 7.dp),
                    horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically,
                ) {
                    val tint = if (unseen) Theme.signal else Theme.ink
                    Text("↓", color = tint, style = if (classic) plain(13, FontWeight.SemiBold) else mono(13))
                    Text(lookWord(if (unseen) "New" else "Latest"), color = tint, style = mono(12, FontWeight.Medium))
                }
            }
        }
    }
}

/** To the last item (the end marker), one frame later so what just arrived is in the list. */
private suspend fun LazyListState.scrollToEnd(animate: Boolean) {
    withFrameNanos { }
    val last = layoutInfo.totalItemsCount - 1
    if (last < 0) return
    if (animate) animateScrollToItem(last) else scrollToItem(last)
}

@Composable
private fun Header(page: TerminalPageModel, record: SessionRecordModel, terminal: TerminalInfo, git: String?) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Theme.Space.s)) {
        SelectionContainer { Text(MessageDisplay.readable(page.name), color = Theme.ink, style = plain(20, FontWeight.SemiBold)) }
        Text(
            listOfNotNull(
                ModelName.harness(terminal.harness),
                RecordDisplay.model(page.modelNow ?: terminal.modelNow, record.usage?.model, terminal.model)?.let { ModelName.display(it) },
                git,
            ).joinToString(" · "),
            color = Theme.secondaryInk, style = mono(12), maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
        Text(PathDisplay.short(terminal.workdir), color = Theme.secondaryInk, style = mono(12), maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
    }
}

@Composable
private fun EmptyState(page: TerminalPageModel, record: SessionRecordModel, terminal: TerminalInfo, openTerminal: () -> Unit) {
    if (!record.hasSession && page.status == TerminalStatus.Exited) {
        // It ended before it had a session: it did not start. What it said is on its own screen.
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("没有启动起来就结束了。它最后说了什么在终端里。", color = Theme.secondaryInk, style = plain(13))
            SquareButton("Open Terminal", openTerminal)
        }
    } else {
        // A terminal seconds old with no session yet is still starting (2026-10-08).
        rememberBeat(1000)
        if (!record.hasSession && System.currentTimeMillis() - terminal.createdAt < 8000) {
            Column(Modifier.fillMaxWidth().padding(top = Theme.Space.xl), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                BrailleSpinner(color = Theme.secondaryInk)
                Text("Starting…", color = Theme.inkDim, style = mono(11))
            }
        } else {
            Text(if (record.hasSession) "还没有记录。" else "还没有开始对话。在下面回复，或切到终端。", color = Theme.inkDim, style = plain(13))
        }
    }
}

/** Rows to take one of: a list the agent's own screen shows, or the answers its last message offers. */
@Composable
private fun ChoiceCard(said: List<ScreenChoices.Line>, rows: List<Pair<String, String?>>, selected: Int?, foot: String, take: (Int) -> Unit) {
    val classic = LocalLook.current.isClassic
    val radius = Theme.Radius.card
    Column(
        Modifier.fillMaxWidth().grounded(Theme.panel, radius).framed(if (classic) Theme.line else Theme.ink, radius).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        // What is asked: the question, and with a list off the agent's screen whatever else it says there (which folder,
        // what trusting it allows — docs/simple-view-v0.md §5.17).
        if (said.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                for (line in said) {
                    Text(
                        line.text, color = if (line.asks) Theme.ink else Theme.secondaryInk,
                        style = if (line.asks) plain(15, FontWeight.SemiBold) else plain(13),
                    )
                }
            }
        }
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            rows.forEachIndexed { index, (label, detail) ->
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 44.dp)
                        .background(Theme.ink.copy(alpha = if (index == selected) 0.10f else 0.05f), lookShape(10.dp))
                        .clickable(remember { MutableInteractionSource() }, null, role = Role.Button) { take(index) }
                        .padding(horizontal = 10.dp, vertical = 9.dp),
                    horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top,
                ) {
                    Text(
                        "${index + 1}", Modifier.width(20.dp), color = if (index == selected) Theme.signal else Theme.secondaryInk,
                        style = mono(12, FontWeight.Medium), textAlign = TextAlign.End,
                    )
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(label, color = Theme.ink, style = plain(15))
                        if (!detail.isNullOrEmpty()) Text(detail, color = Theme.secondaryInk, style = plain(12))
                    }
                }
            }
        }
        Text(foot, color = Theme.inkDim, style = plain(12))
    }
}

/** The program drew something of its own and waits: the keys are under the record now; its screen is one tap away. */
@Composable
private fun PromptCard(openTerminal: () -> Unit) {
    val classic = LocalLook.current.isClassic
    val radius = Theme.Radius.card
    Column(
        Modifier.fillMaxWidth().grounded(Theme.panel, radius).framed(if (classic) Theme.line else Theme.ink, radius).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(7.dp), verticalAlignment = Alignment.CenterVertically) {
            WaitingSquare()
            Text(lookWord("Waiting"), color = Theme.waiting, style = mono(13, FontWeight.SemiBold))
        }
        Text("程序在等你操作。这是它自己画的界面，记录里没有：用下面的按键回答，或打开终端查看。", color = Theme.secondaryInk, style = plain(13))
        SquareButton("Open Terminal", openTerminal, prominent = true)
    }
}

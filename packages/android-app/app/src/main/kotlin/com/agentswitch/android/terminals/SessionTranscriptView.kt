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
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.agentswitch.android.BuildConfig
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.LocalNav
import com.agentswitch.android.WhileStarted
import com.agentswitch.android.demo.DemoData
import com.agentswitch.android.demo.LocalDemoScreen
import com.agentswitch.android.design.BarBack
import com.agentswitch.android.design.BarWord
import com.agentswitch.android.design.BrailleSpinner
import com.agentswitch.android.design.LocalLook
import com.agentswitch.android.design.NavBar
import com.agentswitch.android.design.PixelBox
import com.agentswitch.android.design.PixelBoxEffect
import com.agentswitch.android.design.SquareButton
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.lookShape
import com.agentswitch.android.design.lookWord
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.kit.api.SessionSummary
import com.agentswitch.kit.feed.MessageDisplay
import com.agentswitch.kit.feed.ModelName
import com.agentswitch.kit.support.PathDisplay
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** The agents a past session can be resumed in (the iPhone's `TerminalsTab.resumable`). */
private val resumable = setOf("claude-code", "codex", "opencode", "pi", "grok")

/** A running session is read again this often (the iPhone's `SessionsView.activePoll`). */
private const val activePollMs = 10_000L

/**
 * One coding session, read only (control-v0 §3; terminal-v0 §1 second round; simple-view-v0 §0): its record, oldest
 * first — what you wrote on the right under its time, the agent's answers laid out as Markdown, each run of work on
 * one line that opens into its steps, with what it changed beside it. The same rows as a running terminal's simple
 * view: `Resume` goes on with it in a terminal here, which opens as that view. A running session is read again every
 * 10 s. `resuming`: opening it in a terminal is under way (the button turns). A page: push it with `LocalNav`.
 *
 * `Show in Files` goes to the session's folder on the Files tab (the iPhone laid the Files browser over this page).
 * Left out: pull to refresh (the page reads again on its own while the session runs).
 */
@Composable
fun SessionTranscriptView(session: SessionSummary, resuming: Boolean = false, resume: (() -> Unit)? = null) {
    val model = LocalAppModel.current
    val nav = LocalNav.current
    val scope = rememberCoroutineScope()
    val screen = LocalDemoScreen.current
    val record = remember(session.id) {
        SessionRecordModel(demo = if (BuildConfig.DEBUG) ({ h, id -> DemoData.sessionRecord(h, id, screen) }) else null)
    }
    val shown = record.session ?: session
    val hasChanges = session.harness == "claude-code" || session.harness == "codex"
    val listState = rememberLazyListState()
    var menu by remember { mutableStateOf(false) }
    var anchor by remember { mutableStateOf<Rect?>(null) }

    suspend fun load() {
        record.follow(session.harness, session.sessionId)
        record.refresh(model.api)
    }
    WhileStarted(session.id) {
        load()
        while ((record.session ?: session).active) {
            delay(activePollMs)
            load()
        }
    }
    // The latest is what matters: opened at the end, and following it as it grows.
    val last = record.items.lastOrNull()
    LaunchedEffect(last) {
        withFrameNanos { }
        val end = listState.layoutInfo.totalItemsCount - 1
        if (end >= 0) listState.scrollToItem(end)
    }
    // `transcriptfiles`: ⋯ › Show in Files, as a tap would open it (the menu's own state; the Files tab has no sheet here).
    LaunchedEffect(Unit) { if (BuildConfig.DEBUG && screen == "transcriptfiles") { delay(800); menu = true } }

    fun showInFiles() {
        menu = false
        nav.popToRoot()
        model.showInFiles(shown.cwd)
    }
    PixelBoxEffect(menu, onDismiss = { menu = false }) {
        PixelBox(anchor = anchor, cancel = null, actions = listOf(PixelBox.Action("Show in Files") { showInFiles() }))
    }

    Column(Modifier.fillMaxSize().background(Theme.base)) {
        NavBar(
            MessageDisplay.readable(shown.displayTitle),
            leading = { BarBack({ nav.pop() }) },
            trailing = {
                BarWord(
                    "⋯", { menu = true }, enabled = shown.cwd.isNotEmpty(),
                    modifier = Modifier.onGloballyPositioned { anchor = it.boundsInRoot() },
                    color = if (LocalLook.current.isClassic) Theme.signal else Theme.ink,
                )
            },
        )
        LazyColumn(
            Modifier.weight(1f).fillMaxWidth(), listState,
            contentPadding = PaddingValues(horizontal = Theme.Space.l, vertical = Theme.Space.m),
            verticalArrangement = Arrangement.spacedBy(Theme.Space.l),
        ) {
            item(key = "header") { Header(shown) }
            record.error?.let { error -> item(key = "error") { Text(error, color = Theme.failed, style = plain(13)) } }
            if (record.loaded) {
                if (record.items.isEmpty() && record.error == null) {
                    item(key = "empty") { Text("无记录。会话可能已被删除。", color = Theme.inkDim, style = plain(13)) }
                }
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
                items(record.items, key = { it.id }) { item ->
                    RecordItemRow(
                        item,
                        changes = if (hasChanges) ({ nav.present("changes") { ChangesSheet(session.harness, session.sessionId, item.id) } }) else null,
                        pictures = RecordPictureSource(session.harness, session.sessionId),
                    )
                }
            } else if (record.error == null) {
                item(key = "loading") {
                    Box(Modifier.fillMaxWidth().padding(top = Theme.Space.xl), contentAlignment = Alignment.Center) { BrailleSpinner(color = Theme.secondaryInk) }
                }
            }
            item(key = "end") { Spacer(Modifier.height(1.dp)) }
        }
        if (resume != null && session.harness in resumable) {
            Box(Modifier.fillMaxWidth().background(Theme.base).windowInsetsPadding(WindowInsets.navigationBars).padding(horizontal = Theme.Space.l, vertical = Theme.Space.s)) {
                if (resuming) {
                    Box(
                        Modifier.fillMaxWidth().background(Theme.fill, lookShape(10.dp)).padding(vertical = 10.dp),
                        contentAlignment = Alignment.Center,
                    ) { BrailleSpinner(color = if (LocalLook.current.isClassic) Theme.onFill else Theme.base) }
                } else {
                    SquareButton("Resume", resume, prominent = true)
                }
            }
        }
    }
}

@Composable
private fun Header(s: SessionSummary) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Theme.Space.s)) {
        SelectionContainer { Text(MessageDisplay.readable(s.displayTitle), color = Theme.ink, style = plain(20, FontWeight.SemiBold)) }
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            if (s.active) {
                BrailleSpinner()
                Text("Busy", color = Theme.busy, style = mono(12, FontWeight.Medium))
                Text("·", color = Theme.inkDim, style = mono(12))
            }
            Text(
                listOfNotNull(s.harnessName, s.model?.let { ModelName.display(it) }, s.branch, recordRelative(s.updated)).joinToString(" · "),
                Modifier.weight(1f, fill = false), color = Theme.secondaryInk, style = mono(12), maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
        if (s.cwd.isNotEmpty()) {
            Text(PathDisplay.short(s.cwd), color = Theme.secondaryInk, style = mono(12), maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
        }
    }
}

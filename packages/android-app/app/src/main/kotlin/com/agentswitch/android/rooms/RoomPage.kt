package com.agentswitch.android.rooms

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.LocalNav
import com.agentswitch.android.WhileStarted
import com.agentswitch.android.components.ErrorText
import com.agentswitch.android.demo.LocalDemoScreen
import com.agentswitch.android.design.BarBack
import com.agentswitch.android.design.BrailleSpinner
import com.agentswitch.android.design.ClassicIcon
import com.agentswitch.android.design.ClassicIconKind
import com.agentswitch.android.design.HairRule
import com.agentswitch.android.design.LocalLook
import com.agentswitch.android.design.NavBar
import com.agentswitch.android.design.PixelBox
import com.agentswitch.android.design.PixelBoxEffect
import com.agentswitch.android.design.PixelSprite
import com.agentswitch.android.design.PlainField
import com.agentswitch.android.design.Scanlines
import com.agentswitch.android.design.SquareButton
import com.agentswitch.android.design.SquareIconButton
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.framed
import com.agentswitch.android.design.grounded
import com.agentswitch.android.design.lookWord
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.android.files.MoreGlyph
import com.agentswitch.android.terminals.ProfileDot
import com.agentswitch.kit.api.RoomDetail
import com.agentswitch.kit.api.RoomFilePath
import com.agentswitch.kit.api.RoomMention
import com.agentswitch.kit.api.RoomMessage
import com.agentswitch.kit.api.RoomReceiptLine
import com.agentswitch.kit.api.RoomRow
import com.agentswitch.kit.api.RoomSeat
import com.agentswitch.kit.api.RoomTask
import com.agentswitch.kit.api.RoomTaskState
import com.agentswitch.kit.api.RoomText
import com.agentswitch.android.components.LocalOpenLink
import com.agentswitch.kit.api.roundsSeen
import com.agentswitch.kit.api.updateRoom
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * One room (docs/chatroom-v0.md §10): its timeline and the box the user writes in; its members from the bar. The
 * timeline is a chat's: one head per speaker — face, name, time — with what they say next under it; the message a
 * reply answers above it; under a message, one small line only while it has not reached someone. The room is read
 * again every few seconds while the page is on screen, and what is in it is then seen. The iPhone's `RoomPage`.
 */
@Composable
fun RoomPage(id: String) {
    val app = LocalAppModel.current
    val nav = LocalNav.current
    val classic = LocalLook.current.isClassic
    // A sample screen's room (no Mac) opens with what the demo holds for it.
    val model = remember(id) { RoomPageModel(id, app.rooms.demoDetails[id], app.rooms.demoFiles[id], app.rooms.demoBytes) }
    val scope = rememberCoroutineScope()
    val detail = model.detail
    val focus = remember { FocusRequester() }
    var menu by remember { mutableStateOf<PixelBox?>(null) }
    var confirmDelete by remember { mutableStateOf(false) }
    var moreBounds by remember { mutableStateOf(Rect.Zero) }

    WhileStarted(app.connection.endpoint) {
        while (true) {
            model.refresh(app.api)
            delay(RoomPageModel.pollIntervalMs)
        }
    }
    // How large the files the messages come with are is what the shared folder's list says: read when there are such
    // files, and again when a message brings another.
    val shared = remember(detail?.messages, detail?.folder) {
        val folder = detail?.folder ?: ""
        detail?.messages?.flatMap { it.files }?.filter { RoomFilePath.under(folder, it) != null }?.toSet() ?: emptySet()
    }
    LaunchedEffect(shared, app.api) { if (shared.isNotEmpty()) model.loadFiles(app.api) }
    // Deleted, here or from another screen: back to the list.
    LaunchedEffect(model.gone) {
        if (model.gone) { nav.dismiss("room:$id"); app.rooms.refresh(app.api) }
    }

    fun act(work: suspend (com.agentswitch.kit.api.AgentSwitchAPI) -> Unit) { scope.launch { model.run(app.api, work) } }

    /** `@name` put at the end of what is being written. */
    fun mention(handle: String) {
        if (handle == RoomSeat.you) return
        val draft = model.draft
        model.draft = draft + (if (draft.isEmpty() || draft.endsWith(" ") || draft.endsWith("\n")) "" else " ") + "@$handle "
        runCatching { focus.requestFocus() }
    }

    fun members(card: String? = null) = nav.present("roommembers:$id") {
        RoomMembersSheet(model, card, add = { nav.present("roomadd:$id") { RoomSessionsSheet(RoomSessionsPurpose.Add(id, model.detail?.sessions?.mapNotNull { it.terminal }?.toSet() ?: emptySet()), onDone = { act { } }) } }, mention = ::mention)
    }

    // The sample screens that open on one of the room's sheets (`roomtasks`, `roomfiles`, `roommembers`).
    val demoScreen = LocalDemoScreen.current
    LaunchedEffect(demoScreen) {
        when (demoScreen) {
            "roomtasks", "roomtask", "roomtasknew" -> nav.present("roomtasks:$id") { RoomTasksSheet(model, opening = if (demoScreen == "roomtask") 2 else null, adding = demoScreen == "roomtasknew") }
            "roomfiles" -> nav.present("roomfiles:$id") { RoomFilesSheet(model) }
            "roommembers" -> members()
            "roomcard" -> members(model.detail?.sessions?.firstOrNull()?.handle)
        }
    }

    fun moreMenu() {
        val d = model.detail ?: return
        menu = PixelBox(
            anchor = moreBounds, cancel = null,
            actions = listOf(
                if (d.room.paused) PixelBox.Action("Resume") { act { it.updateRoom(id, paused = false) } }
                else PixelBox.Action("Pause") { act { it.updateRoom(id, paused = true) } },
                PixelBox.Action("Add Sessions…") { nav.present("roomadd:$id") { RoomSessionsSheet(RoomSessionsPurpose.Add(id, model.detail?.sessions?.mapNotNull { it.terminal }?.toSet() ?: emptySet()), onDone = { act { } }) } },
                PixelBox.Action("Rename…") { nav.present("roomedit:$id") { RoomEditSheet(model) } },
                PixelBox.Action("Notes…") { nav.present("roomnotes:$id") { RoomNotesSheet(model) } },
                PixelBox.Action("Tasks…") { nav.present("roomtasks:$id") { RoomTasksSheet(model) } },
                PixelBox.Action("Files…") { nav.present("roomfiles:$id") { RoomFilesSheet(model) } },
                PixelBox.Action("Delete Room…", PixelBox.Action.Role.Destructive, icon = "trash") { confirmDelete = true },
            ),
        )
    }

    Column(Modifier.fillMaxSize().background(Theme.base).imePadding()) {
        NavBar(
            detail?.room?.name ?: "Room",
            subtitle = {
                if (detail != null) {
                    val n = detail.sessions.size
                    Text("$n ${if (n == 1) "Session" else "Sessions"}${if (detail.room.paused) " · Paused" else ""}", color = Theme.secondaryInk, style = mono(11), maxLines = 1)
                }
            },
            leading = { BarBack({ nav.pop(); scope.launch { app.rooms.refresh(app.api) } }, "Rooms") },
            trailing = {
                Box(
                    Modifier.heightIn(min = 44.dp).width(40.dp).clickable(detail != null, role = Role.Button, onClickLabel = "Members") { members() },
                    contentAlignment = Alignment.Center,
                ) {
                    if (classic) ClassicIcon(ClassicIconKind.Symbol("person.2"), 22.dp, 20.dp, Theme.signal)
                    else PixelSprite(RoomArt.people, pixel = 2.dp, color = Theme.ink)
                }
                Box(
                    Modifier.onGloballyPositioned { moreBounds = it.boundsInRoot() }.heightIn(min = 44.dp).width(44.dp)
                        .clickable(detail != null, role = Role.Button, onClickLabel = "More") { moreMenu() },
                    contentAlignment = Alignment.Center,
                ) { MoreGlyph(if (classic) Theme.signal else Theme.ink) }
            },
        )
        if (detail != null && detail.room.paused) PausedBanner { act { it.updateRoom(id, paused = false) } }
        // The sessions have gone back and forth among themselves (§7): the user is told; nothing was stopped.
        val rounds = detail?.room?.rounds
        if (detail != null && rounds != null && !detail.room.paused) {
            RoundsNotice(rounds, ok = { act { it.roundsSeen(id) } }, pause = { act { it.updateRoom(id, paused = true) } })
        }
        ErrorText(model.error, { model.error = null }, Modifier.padding(horizontal = Theme.Space.l, vertical = 6.dp))
        Box(Modifier.weight(1f).fillMaxWidth()) {
            if (!classic) Scanlines(Modifier.fillMaxSize())
            if (detail != null) {
                Column(Modifier.fillMaxSize()) {
                model.taskFilter?.let { n -> TaskFilterBar(n, detail) { model.taskFilter = null } }
                Box(Modifier.weight(1f).fillMaxWidth()) {
                Timeline(detail, model, openCard = { members(it) }, reply = { model.replyTo = it; runCatching { focus.requestFocus() } }, mention = ::mention, showMenu = { menu = it })
                }
                }
            }
        }
        if (detail != null) RoomWriter(model, detail, focus, showMenu = { menu = it }) { scope.launch { model.send(app.api) } }
    }
    PixelBoxEffect(menu, { menu = null }) { it }
    PixelBoxEffect(confirmDelete, { confirmDelete = false }) {
        PixelBox(
            head = "Delete Room", tone = PixelBox.Tone.Red,
            message = "删除“${detail?.room?.name ?: ""}”？房间里的消息一并删除，无法恢复。成员的会话不受影响。",
            actions = listOf(PixelBox.Action("Delete", PixelBox.Action.Role.Destructive) { scope.launch { model.delete(app.api) } }),
        )
    }
}

/** Messages are written and not handed over (§2 暂停). */
@Composable
private fun PausedBanner(resume: () -> Unit) {
    Column(Modifier.fillMaxWidth().background(Theme.waiting.copy(alpha = 0.14f))) {
        Row(Modifier.fillMaxWidth().padding(horizontal = Theme.Space.l, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            SeatStateMark(com.agentswitch.kit.api.SeatState.Waiting)
            Text("房间已暂停。消息照写，不投递。", Modifier.weight(1f), color = Theme.ink, style = plain(13))
            SquareButton("Resume", resume, prominent = true, expand = false)
        }
        HairRule()
    }
}

/**
 * The sessions have sent one another this many messages with no word from the user (§7; 2026-11-22, user: 多轮没我的参与
 * 就提醒我一下就行不用中断他们): `OK` counts from here again, `Pause` is the user's to stop them.
 */
@Composable
private fun RoundsNotice(rounds: Int, ok: () -> Unit, pause: () -> Unit) {
    Column(Modifier.fillMaxWidth().background(Theme.waiting.copy(alpha = 0.14f))) {
        Row(Modifier.fillMaxWidth().padding(horizontal = Theme.Space.l, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            SeatStateMark(com.agentswitch.kit.api.SeatState.Waiting)
            Text("会话之间已连续往返 $rounds 条，没有你的参与。它们没有被打断。", Modifier.weight(1f), color = Theme.ink, style = plain(13))
            SquareButton("OK", ok, prominent = true, expand = false)
            SquareButton("Pause", pause, expand = false)
        }
        HairRule()
    }
}

@Composable
private fun Timeline(
    detail: RoomDetail, model: RoomPageModel, openCard: (String) -> Unit, reply: (Int) -> Unit, mention: (String) -> Unit, showMenu: (PixelBox) -> Unit,
) {
    val rows = remember(detail.messages, model.taskFilter) { RoomRow.rows(detail.messages, task = model.taskFilter) }
    val handles = remember(detail.seats) { RoomText.handles(detail.seats) }
    val state = rememberLazyListState()
    val last = detail.messages.lastOrNull()?.seq
    val scope = rememberCoroutineScope()
    // The reader is at the end (2026-11-24, user: 应该加一个回到底部的按钮): `↓ Latest` is away. `unseen`: a message
    // came while they read further up, and they were left where they were. As on a terminal's record.
    var atEnd by remember { mutableStateOf(true) }
    var unseen by remember { mutableStateOf(false) }
    LaunchedEffect(state) {
        androidx.compose.runtime.snapshotFlow { state.isScrollInProgress to !state.canScrollForward }.collect { (moving, end) ->
            if (moving || end) { atEnd = end; if (end) unseen = false }
        }
    }
    // The newest is at the bottom, and stays in sight as more come while the reader is there; the user's own always.
    LaunchedEffect(last, rows.size) {
        if (rows.isEmpty()) return@LaunchedEffect
        if (atEnd || detail.messages.lastOrNull()?.from == RoomSeat.you) state.scrollToItem(rows.size + 1) else unseen = true
    }
    // A picture that comes after its message was drawn makes it taller: the end stays in sight when it was.
    LaunchedEffect(model.picturesShown) {
        if (model.picturesShown > 0 && rows.isNotEmpty() && (state.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0) >= rows.size) state.scrollToItem(rows.size + 1)
    }
    if (rows.isEmpty()) {
        val first = detail.sessions.firstOrNull()?.handle
        Column(Modifier.fillMaxWidth().padding(horizontal = 40.dp).padding(top = 120.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("这个房间里还没有消息。", color = Theme.secondaryInk, style = plain(14))
            Text(
                if (first != null) "写一句并用 @ 指定收件人，例如：\n@$first 现在在做什么" else "房间里还没有会话。点右上角 ⋯ 里的 Add Sessions，把正在运行的会话拉进来。",
                color = Theme.inkDim, style = plain(13), textAlign = TextAlign.Center,
            )
        }
        return
    }
    Box(Modifier.fillMaxSize()) {
    LazyColumn(Modifier.fillMaxSize(), state = state) {
        item("topic") {
            if (detail.room.topic.isNotEmpty()) Text(detail.room.topic, Modifier.fillMaxWidth().padding(horizontal = 12.dp).padding(top = 10.dp), color = Theme.secondaryInk, style = plain(12))
        }
        items(rows, key = { it.message.seq }) { row ->
            MessageRow(
                row, detail, model, handles,
                forMe = RoomSeat.you in row.message.to && row.message.seq > (model.seenAtOpen ?: Int.MAX_VALUE),
                openCard = openCard, reply = { reply(row.message.seq) }, mention = mention, showMenu = showMenu,
            )
        }
        item("end") { Spacer(Modifier.height(8.dp)) }
    }
    if (!atEnd) {
        Box(Modifier.align(Alignment.BottomCenter).padding(bottom = 8.dp)) {
            androidx.compose.foundation.layout.Row(
                Modifier.grounded(Theme.panel, 16.dp).framed(Theme.line, 16.dp)
                    .clickable(remember { androidx.compose.foundation.interaction.MutableInteractionSource() }, null, role = Role.Button) {
                        unseen = false
                        scope.launch { state.animateScrollToItem(rows.size + 1) }
                    }
                    .padding(horizontal = 12.dp, vertical = 7.dp),
                horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically,
            ) {
                val tint = if (unseen) Theme.signal else Theme.ink
                Text("↓", color = tint, style = mono(13))
                Text(lookWord(if (unseen) "New" else "Latest"), color = tint, style = mono(12, FontWeight.Medium))
            }
        }
    }
    }
}

private val faceSide = 26.dp

/** One message of the timeline. `forMe`: it names the user and came after what the user had seen — marked amber. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun MessageRow(
    row: RoomRow, detail: RoomDetail, model: RoomPageModel, handles: Set<String>, forMe: Boolean,
    openCard: (String) -> Unit, reply: () -> Unit, mention: (String) -> Unit, showMenu: (PixelBox) -> Unit,
) {
    val classic = LocalLook.current.isClassic
    val m = row.message
    val seat = detail.seat(m.from)
    val clipboard = LocalClipboardManager.current
    var bounds by remember { mutableStateOf(Rect.Zero) }
    Column(Modifier.fillMaxWidth()) {
        if (row.newDay) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp).padding(top = 8.dp, bottom = 2.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                HairRule(Modifier.weight(1f))
                Text(RoomWords.day(m.at), color = Theme.inkDim, style = mono(11), maxLines = 1)
                HairRule(Modifier.weight(1f))
            }
        }
        Box(
            Modifier.fillMaxWidth().onGloballyPositioned { bounds = it.boundsInRoot() }
                .background(if (forMe && classic) Theme.waiting.copy(alpha = 0.09f) else androidx.compose.ui.graphics.Color.Transparent)
                .combinedClickable(
                    remember { androidx.compose.foundation.interaction.MutableInteractionSource() }, null,
                    onLongClick = {
                        // A long press: answer it, name who said it, take its words.
                        showMenu(PixelBox(anchor = bounds, cancel = null, actions = listOfNotNull(
                            PixelBox.Action("Reply") { reply() },
                            if (m.from != RoomSeat.you && seat?.here == true) PixelBox.Action("Mention") { mention(m.from) } else null,
                            PixelBox.Action("Copy", icon = "doc.on.clipboard") { clipboard.setText(AnnotatedString(m.text)) },
                        )))
                    },
                    onClick = { },
                ),
        ) {
            // As tall as the message (the row has no height of its own to fill until it is measured).
            if (forMe) Box(Modifier.matchParentSize()) { Box(Modifier.width(3.dp).fillMaxHeight().background(Theme.waiting)) }
            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp).padding(top = if (row.continues) 1.dp else 9.dp, bottom = 3.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                if (row.continues) Spacer(Modifier.size(faceSide, 1.dp))
                else RoomFaceView(seat?.face, Modifier.padding(top = 1.dp).clickable(m.from != RoomSeat.you, role = Role.Button) { openCard(m.from) }, you = m.from == RoomSeat.you, side = faceSide)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    row.quoted?.let { Quote(it) }
                    // Who and when, nothing more (2026-11-22, user: 聊天中的信息展示能不能精简一些): the agent is the picture
                    // beside the name; the model, the folder and the mode are on the card.
                    if (!row.continues) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(
                                RoomWords.who(m.from), Modifier.clickable(m.from != RoomSeat.you, role = Role.Button) { openCard(m.from) },
                                color = Theme.ink, style = if (classic) plain(15, FontWeight.SemiBold) else mono(14, FontWeight.SemiBold), maxLines = 1,
                            )
                            seat?.card?.agent?.takeIf { it.isNotEmpty() }?.let { RoomAgentMark(it) }
                            Text(RoomWords.time(m.at), color = Theme.inkDim, style = mono(11))
                            m.task?.let { n -> TaskLabel(n, detail.task(n)?.title) { model.taskFilter = n } }
                        }
                    }
                    Text(
                        RoomWords.text(m.text, handles, classic, Theme.ink, Theme.base, Theme.signal, Theme.code, LocalOpenLink.current),
                        Modifier.fillMaxWidth(), color = Theme.ink, style = plain(15).copy(lineHeight = 21.sp),
                    )
                    // The files it comes with (they are on the Mac): a picture shown, another file as a card; a tap opens one.
                    MessageFiles(model, m.files)
                    Receipts(m, detail)
                }
            }
        }
    }
}

@Composable
private fun Quote(quoted: RoomMessage) {
    val classic = LocalLook.current.isClassic
    Row(Modifier.padding(bottom = 1.dp).height(androidx.compose.foundation.layout.IntrinsicSize.Min), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        if (classic) Box(Modifier.width(2.dp).fillMaxHeight().background(Theme.line)) else Text("┌─", color = Theme.inkDim, style = mono(12))
        Text(RoomWords.who(quoted.from), color = Theme.secondaryInk, style = plain(12, FontWeight.Medium), maxLines = 1)
        Text(RoomRow.quote(quoted.text), Modifier.weight(1f), color = Theme.secondaryInk, style = plain(12), maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** Said only while it matters: who it has not reached, and where it is; one that can not be handed over, in red. */
@Composable
private fun Receipts(m: RoomMessage, detail: RoomDetail) {
    val lines = RoomReceiptLine.lines(m, detail)
    if (lines.isEmpty()) return
    val dim = Theme.inkDim
    val failed = Theme.failed
    val words = lines.map { lookWord(it.word) }
    Text(
        androidx.compose.ui.text.buildAnnotatedString {
            lines.forEachIndexed { i, line ->
                if (i > 0) append("   ")
                pushStyle(androidx.compose.ui.text.SpanStyle(color = if (line.failed) failed else dim))
                append("${line.tick} ${RoomWords.who(line.handle)} · ${words[i]}")
                pop()
            }
        },
        Modifier.padding(top = 1.dp), style = mono(11),
    )
}

/**
 * The box the user writes in: the `@name` being typed offers the members, a reply says what it answers. The button
 * before the field picks photos; they wait above it, and go with the message (RoomFileViews).
 */
@Composable
private fun RoomWriter(model: RoomPageModel, detail: RoomDetail, focus: FocusRequester, showMenu: (PixelBox) -> Unit, send: () -> Unit) {
    val seats = detail.seats
    val classic = LocalLook.current.isClassic
    val offers = RoomMention.query(model.draft)?.let { RoomMention.offers(it, seats) } ?: emptyList()
    var preparing by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().background(Theme.base)) {
        HairRule()
        Column(
            Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.navigationBars).padding(horizontal = Theme.Space.l, vertical = Theme.Space.s),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (offers.isNotEmpty()) MentionPicker(offers.takeLast(6), seats) { model.draft = RoomMention.complete(model.draft, it) }
            model.replyTo?.let { n ->
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (classic) ClassicIcon(ClassicIconKind.Symbol("arrowshape.turn.up.left"), 14.dp, 13.dp, Theme.secondaryInk)
                    else PixelSprite(RoomArt.reply, pixel = 2.dp, color = Theme.secondaryInk)
                    Text("Reply to ${RoomWords.who(model.detail?.message(n)?.from ?: "#$n")}", Modifier.weight(1f), color = Theme.secondaryInk, style = mono(12), maxLines = 1)
                    Text("×", Modifier.clickable(role = Role.Button, onClickLabel = "Close") { model.replyTo = null }.padding(horizontal = 6.dp), color = Theme.secondaryInk, style = mono(15))
                }
            }
            if (detail.tasks.isNotEmpty()) TaskPicker(model, detail, showMenu)
            RoomAttachmentStrip(model, preparing)
            Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(Theme.Space.s)) {
                RoomPhotosButton(model) { preparing = it }
                Box(
                    Modifier.weight(1f).grounded(if (classic) Theme.panel else androidx.compose.ui.graphics.Color.Transparent, 18.dp).framed(Theme.line, 18.dp)
                        .padding(horizontal = if (classic) 14.dp else 12.dp, vertical = 9.dp),
                ) {
                    PlainField(
                        model.draft, { model.draft = it }, Modifier.fillMaxWidth().heightIn(max = 140.dp).focusRequester(focus),
                        placeholder = "Message", singleLine = false,
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
                    )
                }
                SquareIconButton(send, "Send", active = model.canSend || model.sending) { tint ->
                    if (model.sending) BrailleSpinner(color = tint)
                    else Text("↑", color = tint, style = if (classic) plain(17, FontWeight.Bold) else mono(18, FontWeight.Bold))
                }
            }
        }
    }
}

/** The members the `@name` being typed may become, the newest-seated last, then `all`. */
@Composable
private fun MentionPicker(offers: List<String>, seats: List<RoomSeat>, pick: (String) -> Unit) {
    val classic = LocalLook.current.isClassic
    Column(Modifier.fillMaxWidth().grounded(Theme.panel, 12.dp).framed(if (classic) Theme.line else Theme.ink, 12.dp)) {
        offers.forEachIndexed { i, handle ->
            val seat = seats.firstOrNull { it.handle == handle }
            Row(
                Modifier.fillMaxWidth().clickable(role = Role.Button) { pick(handle) }.padding(horizontal = 10.dp, vertical = 9.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                if (handle == RoomSeat.all) Spacer(Modifier.size(10.dp)) else SeatStateMark(seat?.state, Modifier.width(10.dp))
                Text("@$handle", color = Theme.ink, style = if (classic) plain(14, FontWeight.SemiBold) else mono(14, FontWeight.SemiBold), maxLines = 1)
                Text(
                    if (handle == RoomSeat.all) "全体，只有你能用"
                    else listOfNotNull(seat?.card?.let { RoomArt.agentName(it.agent) }, seat?.state?.word(LocalLook.current)).joinToString(" · "),
                    Modifier.weight(1f), color = Theme.secondaryInk, style = plain(12), maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                seat?.card?.color?.let { ProfileDot(it) }
            }
            if (i != offers.size - 1) HairRule()
        }
    }
}

/** A message's task (2026-11-24, user: 给消息加tag): `T3 登录接口`; a tap shows that task's messages alone. */
@Composable
private fun TaskLabel(n: Int, title: String?, tap: () -> Unit) {
    val classic = LocalLook.current.isClassic
    Text(
        RoomTask.word(n, title),
        Modifier.grounded(if (classic) Theme.panel else androidx.compose.ui.graphics.Color.Transparent, 4.dp).framed(Theme.line, if (classic) 4.dp else 0.dp)
            .clickable(role = Role.Button, onClickLabel = "Only this task") { tap() }.padding(horizontal = 5.dp, vertical = 1.dp),
        color = Theme.secondaryInk, style = mono(11), maxLines = 1,
    )
}

/** The timeline narrowed to one task (its label tapped): said, with the way back. */
@Composable
private fun TaskFilterBar(n: Int, detail: RoomDetail, showAll: () -> Unit) {
    val task = detail.task(n)
    Column(Modifier.fillMaxWidth().background(Theme.panel)) {
        Row(Modifier.fillMaxWidth().padding(horizontal = Theme.Space.l, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("Only " + RoomTask.word(n, task?.title), Modifier.weight(1f, fill = false), color = Theme.ink, style = mono(12), maxLines = 1, overflow = TextOverflow.Ellipsis)
            task?.owner?.let { Text("@$it", color = Theme.inkDim, style = mono(11), maxLines = 1) }
            Spacer(Modifier.weight(1f))
            SquareButton("Show All", showAll, expand = false)
        }
        HairRule()
    }
}

/**
 * Which task the next message is about (2026-11-24): taken from the message answered or the task the timeline shows;
 * a tap drops down the open tasks (and the current one) and No Task.
 */
@Composable
private fun TaskPicker(model: RoomPageModel, detail: RoomDetail, showMenu: (PixelBox) -> Unit) {
    var bounds by remember { mutableStateOf(Rect.Zero) }
    val current = model.draftTask
    Text(
        current?.let { "Task: " + RoomTask.word(it, detail.task(it)?.title) + " ▾" } ?: "Task: — ▾",
        Modifier.onGloballyPositioned { bounds = it.boundsInRoot() }.clickable(role = Role.Button, onClickLabel = "Pick a task") {
            showMenu(PixelBox(anchor = bounds, cancel = null, actions = listOf(PixelBox.Action("No Task") { model.draftTask = null }) +
                detail.tasks.filter { it.state != RoomTaskState.Done || it.n == current }.map { t -> PixelBox.Action(RoomTask.word(t.n, t.title)) { model.draftTask = t.n } }))
        }.padding(vertical = 2.dp),
        color = if (current == null) Theme.inkDim else Theme.secondaryInk, style = mono(11), maxLines = 1, overflow = TextOverflow.Ellipsis,
    )
}

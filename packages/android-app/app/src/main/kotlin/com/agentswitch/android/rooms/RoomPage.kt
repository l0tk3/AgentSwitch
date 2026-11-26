package com.agentswitch.android.rooms

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
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
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.Text
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontStyle
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
import com.agentswitch.android.components.LocalOpenLink
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
import com.agentswitch.android.terminals.LookSymbol
import com.agentswitch.android.terminals.LookSymbolIcon
import com.agentswitch.android.terminals.ProfileDot
import com.agentswitch.kit.api.RoomDetail
import com.agentswitch.kit.api.RoomFilePath
import com.agentswitch.kit.api.RoomMention
import com.agentswitch.kit.api.RoomMessage
import com.agentswitch.kit.api.RoomReaders
import com.agentswitch.kit.api.RoomRow
import com.agentswitch.kit.api.RoomSeat
import androidx.compose.foundation.shape.RoundedCornerShape
import com.agentswitch.kit.api.RoomTask
import com.agentswitch.kit.api.RoomTaskState
import com.agentswitch.kit.api.RoomText
import com.agentswitch.kit.api.updateRoom
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * One room (docs/chatroom-v0.md §10; the second design, 2026-11-24): its timeline and the box the user writes in. The
 * timeline is Discord's: face, name, agent and time in one line, what was said under it in full Markdown, no frames;
 * one head for a speaker's run of messages; a line for each new day; the room's beginning at its top. The title
 * (`T3 登录接口 ▾`) — or a swipe from the left — pulls out the task drawer: `# 全部`, the tasks being done, blocked and
 * to do, the done ones folded, `+ 新任务`; a task picked shows its messages alone, and what is written there is about
 * it. ⌕ searches, the people open the members. The room is read again every few seconds while the page is on screen,
 * and what is in it is then seen. `openTask`, `openSeq`, `openCard`: what 等你处理 opens it on. `desk`: the page is the
 * Dispatch tab's own (the dispatch desk, 调度台) — titled `Dispatch`, no `Back`, nothing to go back to when deleted.
 */
@Composable
fun RoomPage(id: String, openTask: Int? = null, openSeq: Int? = null, openCard: String? = null, desk: Boolean = false) {
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
    val drawer = rememberDrawerState(DrawerValue.Closed)

    WhileStarted(app.connection.endpoint) {
        var had = -1
        while (true) {
            model.refresh(app.api)
            val last = model.detail?.room?.lastSeq ?: 0
            if (model.taskFilter != null && (model.taskMessages == null || last != had)) model.loadTask(app.api)
            had = last
            model.loadCounts(app.api)
            delay(RoomPageModel.pollIntervalMs)
        }
    }
    LaunchedEffect(model.taskFilter) { if (model.taskFilter != null) model.loadTask(app.api) }
    // How large the files the messages come with are is what the shared folder's list says: read when there are such
    // files, and again when a message brings another.
    val shared = remember(detail?.messages, detail?.folder) {
        val folder = detail?.folder ?: ""
        detail?.messages?.flatMap { it.files }?.filter { RoomFilePath.under(folder, it) != null }?.toSet() ?: emptySet()
    }
    LaunchedEffect(shared, app.api) { if (shared.isNotEmpty()) model.loadFiles(app.api) }
    // Deleted, here or from another screen: back to the list.
    LaunchedEffect(model.gone) {
        if (model.gone) { if (!desk) nav.dismiss("room:$id"); app.rooms.refresh(app.api) }
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

    fun tasks(opening: Int? = null, adding: Boolean = false) = nav.present("roomtasks:$id") { RoomTasksSheet(model, opening = opening, adding = adding) }

    fun jump(seq: Int) { scope.launch { model.jump(app.api, seq) } }

    fun search() = nav.present("roomsearch:$id") { RoomSearchSheet(model) { seq -> jump(seq) } }

    // What 等你处理 opens the room on: the task, the message, a member's card — once the room is here.
    var opened by remember { mutableStateOf(false) }
    LaunchedEffect(detail != null) {
        if (detail == null || opened) return@LaunchedEffect
        opened = true
        openTask?.let { if (detail.task(it) != null) model.taskFilter = it }
        openSeq?.let { model.jump(app.api, it) }
        openCard?.let { members(it) }
    }

    // The sample screens that open on one of the room's sheets (`roomtasks`, `roomfiles`, `roommembers`).
    val demoScreen = LocalDemoScreen.current
    LaunchedEffect(demoScreen) {
        when (demoScreen) {
            "roomtasks", "roomtask", "roomtasknew" -> tasks(opening = if (demoScreen == "roomtask") 2 else null, adding = demoScreen == "roomtasknew")
            "roomfiles" -> nav.present("roomfiles:$id") { RoomFilesSheet(model) }
            "roommembers" -> members()
            "roomcard" -> members(model.detail?.sessions?.firstOrNull()?.handle)
            "roomdrawer" -> drawer.open()
            "roomsearch" -> search()
        }
    }

    fun moreMenu() {
        val d = model.detail ?: return
        val task = model.taskFilter
        menu = PixelBox(
            anchor = moreBounds, cancel = null,
            actions = listOfNotNull(
                task?.let { n -> PixelBox.Action("Task Card…") { tasks(opening = n) } },
                if (d.room.paused) PixelBox.Action("Resume") { act { it.updateRoom(id, paused = false) } }
                else PixelBox.Action("Pause") { act { it.updateRoom(id, paused = true) } },
                PixelBox.Action("Add Sessions…") { nav.present("roomadd:$id") { RoomSessionsSheet(RoomSessionsPurpose.Add(id, model.detail?.sessions?.mapNotNull { it.terminal }?.toSet() ?: emptySet()), onDone = { act { } }) } },
                PixelBox.Action("Rename…") { nav.present("roomedit:$id") { RoomEditSheet(model) } },
                PixelBox.Action("Notes…") { nav.present("roomnotes:$id") { RoomNotesSheet(model) } },
                PixelBox.Action("Tasks…") { tasks() },
                PixelBox.Action("Files…") { nav.present("roomfiles:$id") { RoomFilesSheet(model) } },
                // 解散 (user #230); not the 调度台, which goes with the dispatch turned off on the Mac.
                if (d.room.desk) null else PixelBox.Action("Dissolve Room…", PixelBox.Action.Role.Destructive, icon = "trash") { confirmDelete = true },
            ),
        )
    }

    ModalNavigationDrawer(
        drawerState = drawer,
        gesturesEnabled = detail != null,
        scrimColor = Color.Black.copy(alpha = 0.35f),
        drawerContent = {
            if (detail != null) {
                TaskDrawer(
                    model, detail,
                    pick = { n -> model.taskFilter = n; scope.launch { drawer.close() } },
                    card = { n -> scope.launch { drawer.close() }; tasks(opening = n) },
                    add = { scope.launch { drawer.close() }; tasks(adding = true) },
                )
            }
        },
    ) {
        Column(Modifier.fillMaxSize().background(Theme.base).imePadding()) {
            val task = model.taskFilter?.let { detail?.task(it) }
            val title = task?.let { RoomTask.word(it.n, it.title) } ?: if (desk) "Dispatch" else detail?.room?.name ?: "Room"
            NavBar(
                title,
                titleContent = {
                    // The title pulls out the task drawer (2026-11-24 user: 任务栏收进抽屉).
                    Row(
                        Modifier.clickable(detail != null, role = Role.Button, onClickLabel = "任务") { scope.launch { drawer.open() } },
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        Text(title, Modifier.weight(1f, fill = false), color = Theme.ink, style = plain(17, FontWeight.SemiBold), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text("▾", color = Theme.secondaryInk, style = plain(13))
                    }
                },
                subtitle = {
                    if (task != null) {
                        val words = listOfNotNull(task.owner?.let { "@$it" }, task.state.chinese).joinToString(" · ")
                        Text(if (task.state == RoomTaskState.Blocked) "⚠ $words" else words, color = if (task.state == RoomTaskState.Blocked) Theme.waiting else Theme.secondaryInk, style = mono(11), maxLines = 1)
                    } else if (detail != null) {
                        val n = detail.sessions.size
                        Text("$n ${if (n == 1) "Session" else "Sessions"}${if (detail.room.paused) " · Paused" else ""}", color = Theme.secondaryInk, style = mono(11), maxLines = 1)
                    }
                },
                leading = { if (!desk) BarBack({ nav.pop(); scope.launch { app.rooms.refresh(app.api) } }, "Rooms") },
                trailing = {
                    Box(
                        Modifier.heightIn(min = 44.dp).width(34.dp).clickable(detail != null, role = Role.Button, onClickLabel = "搜索") { search() },
                        contentAlignment = Alignment.Center,
                    ) {
                        if (classic) LookSymbolIcon(LookSymbol.Magnifier, side = 18.dp, color = Theme.signal)
                        else Text("⌕", color = Theme.ink, style = plain(20))
                    }
                    Box(
                        Modifier.heightIn(min = 44.dp).width(34.dp).clickable(detail != null, role = Role.Button, onClickLabel = "Members") { members() },
                        contentAlignment = Alignment.Center,
                    ) {
                        if (classic) ClassicIcon(ClassicIconKind.Symbol("person.2"), 22.dp, 20.dp, Theme.signal)
                        else PixelSprite(RoomArt.people, pixel = 2.dp, color = Theme.ink)
                    }
                    Box(
                        Modifier.onGloballyPositioned { moreBounds = it.boundsInRoot() }.heightIn(min = 44.dp).width(34.dp)
                            .clickable(detail != null, role = Role.Button, onClickLabel = "More") { moreMenu() },
                        contentAlignment = Alignment.Center,
                    ) { MoreGlyph(if (classic) Theme.signal else Theme.ink) }
                },
            )
            if (detail != null && detail.room.paused) PausedBanner { act { it.updateRoom(id, paused = false) } }
            // A task that can not go on says what it waits for, where its messages are read.
            if (task != null && task.state == RoomTaskState.Blocked) BlockedNotice(task) { tasks(opening = task.n) }
            ErrorText(model.error, { model.error = null }, Modifier.padding(horizontal = Theme.Space.l, vertical = 6.dp))
            Box(Modifier.weight(1f).fillMaxWidth()) {
                if (!classic) Scanlines(Modifier.fillMaxSize())
                if (detail != null) {
                    // A fresh list for each view: a task picked opens at its newest message.
                    key(model.taskFilter) {
                        Timeline(
                            // The user's own face opens the choice of their avatar (the Mac's, user #495); another's, its card.
                            detail, model, openCard = { if (it == RoomSeat.you) nav.present("roomavatar:$id:you") { RoomAvatarSheet(model, RoomSeat.you) } else members(it) }, reply = { model.replyTo = it; runCatching { focus.requestFocus() } },
                            mention = ::mention, showMenu = { menu = it }, jump = ::jump, older = { scope.launch { model.loadOlder(app.api) } },
                        )
                    }
                }
            }
            if (detail != null) RoomWriter(model, detail, focus) { scope.launch { model.send(app.api) } }
        }
    }
    PixelBoxEffect(menu, { menu = null }) { it }
    PixelBoxEffect(confirmDelete, { confirmDelete = false }) {
        PixelBox(
            head = "Dissolve Room", tone = PixelBox.Tone.Red,
            message = "解散“${detail?.room?.name ?: ""}”？房间、消息和共享文件夹一并删除。为这个房间新开的会话一起结束，对话记录留着可以恢复；原本就在跑的会话不受影响。",
            actions = listOf(PixelBox.Action("Dissolve", PixelBox.Action.Role.Destructive) { scope.launch { model.delete(app.api) } }),
        )
    }
    // 删除消息 (user #278): asks first; to members, it may also tell those who had it to leave it aside.
    val doomed = model.deleting
    PixelBoxEffect(doomed != null, { model.deleting = null }) {
        val m = doomed!!
        val toMembers = m.to.any { it != RoomSeat.you }
        PixelBox(
            head = "删除 #${m.seq}", tone = PixelBox.Tone.Red, cancel = "取消",
            message = "文字和附件链接会删掉，原位置留「这条消息已删除」。还没送到的成员不会再收到；已经收到的成员看过了，删不掉它记得的内容" +
                if (toMembers) "——选「删除并告诉成员」会发一句让它们忽略这条。" else "。",
            actions = listOfNotNull(
                PixelBox.Action("删除", PixelBox.Action.Role.Destructive) { scope.launch { model.deleteMessage(app.api, m.seq, tell = false) } },
                if (toMembers) PixelBox.Action("删除并告诉成员", PixelBox.Action.Role.Destructive) { scope.launch { model.deleteMessage(app.api, m.seq, tell = true) } } else null,
            ),
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

/** The task shown is blocked (卡住): what it waits for, from its note; a tap opens its card. */
@Composable
private fun BlockedNotice(task: RoomTask, open: () -> Unit) {
    Column(Modifier.fillMaxWidth().background(Theme.waiting.copy(alpha = 0.14f)).clickable(role = Role.Button, onClickLabel = "任务卡片", onClick = open)) {
        Row(Modifier.fillMaxWidth().padding(horizontal = Theme.Space.l, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("⚠", color = Theme.waiting, style = plain(14))
            Text("卡住：${task.note ?: "没有写原因"}", Modifier.weight(1f), color = Theme.ink, style = plain(13), maxLines = 3, overflow = TextOverflow.Ellipsis)
        }
        HairRule()
    }
}

/**
 * The task drawer (2026-11-24 design, 已定 1): `# 全部` on top; the tasks being done, blocked and to do — number,
 * title, owner's face, ⚠ for one blocked, how many of its messages the user has not seen; the ones done folded under
 * 已完成; `+ 新任务` at the bottom. A tap shows the task's messages; a long press its card.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun TaskDrawer(model: RoomPageModel, detail: RoomDetail, pick: (Int?) -> Unit, card: (Int) -> Unit, add: () -> Unit) {
    val classic = LocalLook.current.isClassic
    var doneOpen by remember { mutableStateOf(false) }
    val open = detail.openTasks
    val done = detail.tasks(RoomTaskState.Done)
    Column(
        Modifier.fillMaxHeight().width(300.dp).background(Theme.base)
            .windowInsetsPadding(WindowInsets.navigationBars)
            .windowInsetsPadding(WindowInsets.statusBars),
    ) {
        Column(Modifier.fillMaxWidth().padding(horizontal = Theme.Space.l).padding(top = 14.dp, bottom = 10.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(detail.room.name, color = Theme.ink, style = plain(17, FontWeight.SemiBold), maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (detail.room.topic.isNotEmpty()) Text(detail.room.topic, color = Theme.secondaryInk, style = plain(12), maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        HairRule()
        LazyColumn(Modifier.weight(1f).fillMaxWidth()) {
            item("all") {
                DrawerRow(selected = model.taskFilter == null, onClick = { pick(null) }) {
                    Text("#", color = Theme.inkDim, style = mono(15, FontWeight.Bold))
                    Text("全部", Modifier.weight(1f), color = Theme.ink, style = plain(15, FontWeight.Medium), maxLines = 1)
                    Text("${detail.room.lastSeq}", color = Theme.inkDim, style = mono(11), maxLines = 1)
                }
                HairRule(Modifier.padding(vertical = 4.dp))
            }
            if (detail.tasks.isEmpty()) {
                item("none") { Text("还没有任务。", Modifier.padding(horizontal = Theme.Space.l, vertical = 10.dp), color = Theme.secondaryInk, style = plain(13)) }
            }
            itemsIndexed(open, key = { _, t -> "t${t.n}" }) { _, t -> DrawerTaskRow(t, detail, model, pick, card) }
            if (done.isNotEmpty()) {
                item("done") {
                    Row(
                        Modifier.fillMaxWidth().clickable(role = Role.Button) { doneOpen = !doneOpen }.padding(horizontal = Theme.Space.l, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Text(if (doneOpen) "▾" else "▸", color = Theme.inkDim, style = mono(12))
                        Text("已完成 · ${done.size}", color = Theme.secondaryInk, style = mono(12, FontWeight.Medium))
                    }
                }
                if (doneOpen) itemsIndexed(done, key = { _, t -> "d${t.n}" }) { _, t -> DrawerTaskRow(t, detail, model, pick, card) }
            }
        }
        HairRule()
        Row(
            Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = add).padding(horizontal = Theme.Space.l, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text("+", color = if (classic) Theme.signal else Theme.ink, style = plain(18, FontWeight.Medium))
            Text("新任务", color = if (classic) Theme.signal else Theme.ink, style = plain(15))
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun DrawerRow(selected: Boolean, onClick: () -> Unit, onLongClick: (() -> Unit)? = null, content: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit) {
    val classic = LocalLook.current.isClassic
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 8.dp)
            .then(if (selected) Modifier.grounded(if (classic) Theme.signal.copy(alpha = 0.12f) else Theme.panel, 8.dp) else Modifier)
            .then(if (selected && !classic) Modifier.framed(Theme.line, 0.dp) else Modifier)
            .combinedClickable(remember { MutableInteractionSource() }, null, role = Role.Button, onLongClick = onLongClick, onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp), content = content,
    )
}

@Composable
private fun DrawerTaskRow(t: RoomTask, detail: RoomDetail, model: RoomPageModel, pick: (Int?) -> Unit, card: (Int) -> Unit) {
    val classic = LocalLook.current.isClassic
    val done = t.state == RoomTaskState.Done
    val blocked = t.state == RoomTaskState.Blocked
    DrawerRow(selected = model.taskFilter == t.n, onClick = { pick(t.n) }, onLongClick = { card(t.n) }) {
        Text(t.label, Modifier.width(30.dp), color = Theme.inkDim, style = mono(12), maxLines = 1)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text(t.title, color = if (done) Theme.secondaryInk else Theme.ink, style = plain(14, if (done) FontWeight.Normal else FontWeight.Medium), maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (blocked) Text("卡住：${t.note ?: ""}", color = Theme.waiting, style = plain(11), maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        t.owner?.let { RoomAvatarView(detail.seat(it), handle = it, you = it == RoomSeat.you, side = 16.dp) }
        if (blocked) Text("⚠", color = Theme.waiting, style = plain(13))
        if (done) Text("✓", color = Theme.done, style = mono(12))
        val unread = model.unread(t.n)
        if (unread > 0 && model.taskFilter != t.n) {
            if (classic) {
                Box(Modifier.size(18.dp).background(Theme.signal, CircleShape), contentAlignment = Alignment.Center) {
                    Text(if (unread > 99) "99" else unread.toString(), color = Color.White, style = plain(11, FontWeight.Bold), maxLines = 1)
                }
            } else Text("● $unread", color = Theme.ink, style = mono(11), maxLines = 1)
        }
    }
}

@Composable
private fun Timeline(
    detail: RoomDetail, model: RoomPageModel, openCard: (String) -> Unit, reply: (Int) -> Unit, mention: (String) -> Unit,
    showMenu: (PixelBox) -> Unit, jump: (Int) -> Unit, older: () -> Unit,
) {
    val shown = model.shown
    val inTask = model.taskFilter
    val rows = remember(shown, model.allMessages) {
        RoomRow.rows(shown).map { r -> if (r.quoted == null && r.message.replyTo != null) r.copy(quoted = model.message(r.message.replyTo!!)) else r }
    }
    val handles = remember(detail.seats) { RoomText.handles(detail.seats) }
    val state = rememberLazyListState()
    val last = shown.lastOrNull()?.seq
    val scope = rememberCoroutineScope()
    // The reader is at the end (2026-11-24, user: 应该加一个回到底部的按钮): `↓ Latest` is away. `unseen`: a message
    // came while they read further up, and they were left where they were. As on a terminal's record.
    var atEnd by remember { mutableStateOf(true) }
    var unseen by remember { mutableStateOf(false) }
    LaunchedEffect(state) {
        snapshotFlow { state.isScrollInProgress to !state.canScrollForward }.collect { (moving, end) ->
            if (moving || end) { atEnd = end; if (end) unseen = false }
        }
    }
    // The newest is at the bottom, and stays in sight as more come while the reader is there; the user's own always.
    LaunchedEffect(last) {
        if (rows.isEmpty()) return@LaunchedEffect
        if (atEnd || shown.lastOrNull()?.from == RoomSeat.you) state.scrollToItem(rows.size + 1) else unseen = true
    }
    LaunchedEffect(rows.size) { if (atEnd && rows.isNotEmpty() && model.jumpTo == null) state.scrollToItem(rows.size + 1) }
    // A picture that comes after its message was drawn makes it taller: the end stays in sight when it was.
    LaunchedEffect(model.picturesShown) {
        if (model.picturesShown > 0 && rows.isNotEmpty() && (state.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0) >= rows.size) state.scrollToItem(rows.size + 1)
    }
    // A message asked for (a quote, a search hit): brought into sight and lit a moment.
    LaunchedEffect(model.jumpTo, rows) {
        val seq = model.jumpTo ?: return@LaunchedEffect
        val at = rows.indexOfFirst { it.message.seq == seq }
        if (at < 0) return@LaunchedEffect
        model.jumpTo = null
        atEnd = false
        state.scrollToItem(at + 1, -120)
        model.lit = seq
        delay(1800)
        if (model.lit == seq) model.lit = null
    }
    Box(Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize(), state = state) {
            item("begin") {
                when {
                    inTask != null -> TaskBeginning(detail, inTask, model)
                    model.atBeginning -> RoomBeginning(detail)
                    else -> Box(Modifier.fillMaxWidth().padding(vertical = 10.dp), contentAlignment = Alignment.Center) {
                        if (model.loadingOlder) BrailleSpinner(color = Theme.secondaryInk)
                        else SquareButton("更早的消息", older, expand = false)
                    }
                }
            }
            itemsIndexed(rows, key = { _, r -> r.message.seq }) { _, row ->
                MessageRow(
                    row, detail, model, handles, showTask = inTask == null,
                    forMe = RoomSeat.you in row.message.to && row.message.seq > (model.seenAtOpen ?: Int.MAX_VALUE),
                    openCard = openCard, reply = { reply(row.message.seq) }, mention = mention, showMenu = showMenu, jump = jump,
                )
            }
            item("end") { Spacer(Modifier.height(10.dp)) }
        }
        if (!atEnd) {
            // The round ↓ at the bottom right (the design's): the newest; amber-free, the accent when something came.
            Box(
                Modifier.align(Alignment.BottomEnd).padding(end = 14.dp, bottom = 10.dp)
                    .grounded(Theme.panel, 20.dp).framed(if (unseen) Theme.signal else Theme.line, 20.dp)
                    .clickable(remember { MutableInteractionSource() }, null, role = Role.Button, onClickLabel = lookWord("Latest")) {
                        unseen = false
                        scope.launch { state.animateScrollToItem(rows.size + 1) }
                    }
                    .size(40.dp),
                contentAlignment = Alignment.Center,
            ) { Text("↓", color = if (unseen) Theme.signal else Theme.ink, style = mono(16, FontWeight.Bold)) }
        }
    }
}

/** The top of the room (the design's): its name, its topic, and that this is where it begins. */
@Composable
private fun RoomBeginning(detail: RoomDetail) {
    val classic = LocalLook.current.isClassic
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(top = 22.dp, bottom = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(if (classic) detail.room.name else "# ${detail.room.name}", color = Theme.ink, style = plain(22, FontWeight.Bold))
        if (detail.room.topic.isNotEmpty()) Text(detail.room.topic, color = Theme.secondaryInk, style = plain(14))
        Text("这是房间的开始。", color = Theme.inkDim, style = plain(13))
        if (detail.messages.isEmpty()) {
            val first = detail.sessions.firstOrNull()?.handle
            Text(
                if (first != null) "写一句并用 @ 指定收件人，例如：@$first 现在在做什么" else "房间里还没有会话。点右上角 ⋯ 里的 Add Sessions，把正在运行的会话拉进来。",
                Modifier.padding(top = 6.dp), color = Theme.inkDim, style = plain(13),
            )
        }
    }
}

/** The top of one task's messages: what it is, whose, how far, and what it has cost the room. */
@Composable
private fun TaskBeginning(detail: RoomDetail, n: Int, model: RoomPageModel) {
    val task = detail.task(n)
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(top = 18.dp, bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
        Text(RoomTask.word(n, task?.title).let { if (task != null) "T$n ${task.title}" else it }, color = Theme.ink, style = plain(19, FontWeight.Bold))
        task?.detail?.let { Text(it, color = Theme.secondaryInk, style = plain(13)) }
        if (task != null) {
            Text(listOfNotNull(task.owner?.let { "@$it" } ?: "还没有人领", task.state.chinese, task.note?.takeIf { task.state == RoomTaskState.Done }?.let { "结果：$it" }).joinToString(" · "), color = Theme.secondaryInk, style = mono(11))
            detail.taskStats(n)?.let { Text(it.says, color = Theme.inkDim, style = mono(11)) }
        }
        val count = model.shown.size
        Text(if (count >= 200) "只显示这个任务最近的 200 条消息。" else "这是 T$n 的消息。在这里发的消息都属于它。", color = Theme.inkDim, style = plain(12))
    }
}

private val faceSide = 32.dp

/** The line above a new day's first message: `11月24日`. */
private fun dayLine(ms: Long): String {
    val day = Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault()).toLocalDate()
    val today = LocalDate.now()
    val words = if (day.year == today.year) "${day.monthValue}月${day.dayOfMonth}日" else "${day.year}年${day.monthValue}月${day.dayOfMonth}日"
    return when (day) {
        today -> "$words · 今天"
        today.minusDays(1) -> "$words · 昨天"
        else -> words
    }
}

/**
 * One message of the timeline. `forMe`: it names the user and came after what the user had seen — marked amber.
 * `showTask`: in `# 全部`, a message about a task says which (`T3`) after the name.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun MessageRow(
    row: RoomRow, detail: RoomDetail, model: RoomPageModel, handles: Set<String>, showTask: Boolean, forMe: Boolean,
    openCard: (String) -> Unit, reply: () -> Unit, mention: (String) -> Unit, showMenu: (PixelBox) -> Unit, jump: (Int) -> Unit,
) {
    val classic = LocalLook.current.isClassic
    val m = row.message
    val seat = detail.seat(m.from)
    val clipboard = LocalClipboardManager.current
    var bounds by remember { mutableStateOf(Rect.Zero) }
    val lit = model.lit == m.seq
    val api = LocalAppModel.current.api
    val scope = rememberCoroutineScope()
    // A long message folded to 12 lines (user #280), opened whole by the reader.
    val long = remember(m.text) { !m.deleted && RoomText.isLong(m.text) }
    var expanded by remember(m.seq) { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth()) {
        if (row.newDay) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp).padding(top = 12.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                HairRule(Modifier.weight(1f))
                Text(dayLine(m.at), color = Theme.inkDim, style = mono(11), maxLines = 1)
                HairRule(Modifier.weight(1f))
            }
        }
        Box(
            Modifier.fillMaxWidth().onGloballyPositioned { bounds = it.boundsInRoot() }
                .background(
                    when {
                        lit -> Theme.signal.copy(alpha = 0.12f)
                        forMe && classic -> Theme.waiting.copy(alpha = 0.09f)
                        else -> Color.Transparent
                    },
                )
                .combinedClickable(
                    remember { MutableInteractionSource() }, null,
                    onLongClick = {
                        // A long press: answer it, name who said it, take its words, delete it (asks first). A deleted
                        // one has nothing left to do.
                        if (!m.deleted) showMenu(PixelBox(anchor = bounds, cancel = null, actions = listOfNotNull(
                            PixelBox.Action("Reply") { reply() },
                            if (m.from != RoomSeat.you && seat?.here == true) PixelBox.Action("Mention") { mention(m.from) } else null,
                            PixelBox.Action("Copy", icon = "doc.on.clipboard") { clipboard.setText(AnnotatedString(m.text)) },
                            PixelBox.Action("删除消息…", PixelBox.Action.Role.Destructive, icon = "trash") { model.deleting = m },
                        )))
                    },
                    onClick = { },
                ),
        ) {
            // As tall as the message (the row has no height of its own to fill until it is measured).
            if (forMe) Box(Modifier.matchParentSize()) { Box(Modifier.width(3.dp).fillMaxHeight().background(Theme.waiting)) }
            Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp).padding(top = if (row.continues) 1.dp else 10.dp, bottom = 3.dp)) {
                // The message it answers, in one line above the head (Discord's): who said it and how it began; a tap goes there.
                row.quoted?.let { QuoteBar(it, handles) { jump(it.seq) } }
                    ?: m.replyTo?.let { n -> QuoteGone(n) { jump(n) } }
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    if (row.continues) Spacer(Modifier.size(faceSide, 1.dp))
                    else RoomAvatarView(seat, handle = m.from, modifier = Modifier.padding(top = 2.dp).clickable(role = Role.Button) { openCard(m.from) }, you = m.from == RoomSeat.you, side = faceSide)
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        // Who and when, nothing more (2026-11-22, user: 聊天中的信息展示能不能精简一些): the agent is the picture
                        // beside the name; the model, the folder and the mode are on the card.
                        if (!row.continues) {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                                Text(
                                    RoomWords.who(m.from), Modifier.weight(1f, fill = false).clickable(role = Role.Button) { openCard(m.from) },
                                    color = Theme.ink, style = if (classic) plain(15, FontWeight.SemiBold) else mono(14, FontWeight.SemiBold), maxLines = 1, overflow = TextOverflow.Ellipsis,
                                )
                                seat?.card?.agent?.takeIf { it.isNotEmpty() }?.let { RoomAgentMark(it) }
                                if (showTask) m.task?.let { n -> TaskTag(n) { model.taskFilter = n } }
                                Text(RoomWords.time(m.at), color = Theme.inkDim, style = mono(11))
                                if (m.aside) AsideTag()
                            }
                        }
                        // Classic (the Mac's, user #487: 每个人的消息分界区分度太低): what a message says, with its files, on a
                        // round block of its own — the user's own on the accent's light tint (#498).
                        Column(
                            if (classic) Modifier.padding(top = if (row.continues) 0.dp else 2.dp)
                                .background(if (m.from == RoomSeat.you) Theme.signal.copy(alpha = 0.07f) else Theme.panel, RoundedCornerShape(Theme.Radius.card))
                                .padding(horizontal = 11.dp, vertical = 7.dp) else Modifier,
                            verticalArrangement = Arrangement.spacedBy(2.dp),
                        ) {
                        if (m.deleted) {
                            Text("这条消息已删除", color = Theme.inkDim, style = plain(14).copy(fontStyle = FontStyle.Italic))
                        } else {
                            Text(
                                RoomWords.text(m.text, handles, classic, Theme.ink, Theme.base, Theme.signal, Theme.code, LocalOpenLink.current),
                                if (classic) Modifier else Modifier.fillMaxWidth(), color = Theme.ink, style = plain(15).copy(lineHeight = 21.sp),
                                maxLines = if (long && !expanded) RoomText.foldLines else Int.MAX_VALUE, overflow = TextOverflow.Ellipsis,
                            )
                            if (long) Text(
                                if (expanded) "收起" else "展开全文",
                                Modifier.clickable(role = Role.Button) { expanded = !expanded }.padding(vertical = 2.dp),
                                color = Theme.signal, style = plain(13),
                            )
                            // The files it comes with (they are on the Mac): a picture shown, another file as a card; a tap opens one.
                            MessageFiles(model, m.files)
                        }
                        }
                        val readers = detail.readers(m)
                        val poke = if (m.from == RoomSeat.you && model.waitingFor(m.seq).isNotEmpty()) m.seq else null
                        if (readers != null || poke != null) ReadMark(readers, showMenu, poke?.let { seq -> { scope.launch { model.poke(api, seq) } } }, poking = model.poking == m.seq)
                    }
                }
            }
        }
    }
}

/** A reply's quote (the design's): `┌ api：接口改好了，字段见 **T3/api.md**` — the first 60 characters as Markdown. */
@Composable
private fun QuoteBar(quoted: RoomMessage, handles: Set<String>, tap: () -> Unit) {
    val classic = LocalLook.current.isClassic
    Row(
        Modifier.fillMaxWidth().padding(start = faceSide / 2, bottom = 2.dp).height(IntrinsicSize.Min)
            .clickable(role = Role.Button, onClickLabel = "跳到原消息", onClick = tap),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (classic) Box(Modifier.width(2.dp).fillMaxHeight().background(Theme.line)) else Text("┌─", color = Theme.inkDim, style = mono(12))
        Text(RoomWords.who(quoted.from), color = Theme.secondaryInk, style = plain(12, FontWeight.SemiBold), maxLines = 1)
        if (quoted.deleted) Text("已删除", Modifier.weight(1f), color = Theme.inkDim, style = plain(12).copy(fontStyle = FontStyle.Italic), maxLines = 1)
        else Text(
            RoomWords.text(RoomRow.quoteLine(quoted.text), handles, classic, Theme.secondaryInk, Theme.base, Theme.signal, Theme.code),
            Modifier.weight(1f), color = Theme.secondaryInk, style = plain(12), maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
    }
}

/** A reply whose message the page does not have (further up): a tap reads up to it. */
@Composable
private fun QuoteGone(n: Int, tap: () -> Unit) {
    Text(
        "┌ 回复 #$n", Modifier.padding(start = faceSide / 2, bottom = 2.dp).clickable(role = Role.Button, onClickLabel = "跳到原消息", onClick = tap),
        color = Theme.inkDim, style = mono(12), maxLines = 1,
    )
}

/** Who of those the user's message was for has read it (已定 2): `2/3 已读` at its right; a tap or long press says who. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ReadMark(readers: RoomReaders?, showMenu: (PixelBox) -> Unit, poke: (() -> Unit)?, poking: Boolean) {
    var bounds by remember { mutableStateOf(Rect.Zero) }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
        // 戳一下: what still waits for a busy member given to it now.
        if (poke != null) Text(
            if (poking) "戳…" else "戳一下",
            Modifier.clickable(!poking, role = Role.Button, onClickLabel = "戳一下", onClick = poke).padding(horizontal = 4.dp, vertical = 2.dp),
            color = Theme.signal, style = mono(11), maxLines = 1,
        )
        if (readers != null) {
            fun who() = showMenu(PixelBox(head = readers.word, anchor = bounds, cancel = null, actions = readers.lines.map { PixelBox.Action(it) { } }))
            Text(
                readers.word,
                Modifier.onGloballyPositioned { bounds = it.boundsInRoot() }
                    .combinedClickable(remember { MutableInteractionSource() }, null, role = Role.Button, onClickLabel = "谁已读", onLongClick = { who() }, onClick = { who() })
                    .padding(horizontal = 4.dp, vertical = 2.dp),
                color = if (readers.failed) Theme.failed else Theme.inkDim, style = mono(11), maxLines = 1,
            )
        }
    }
}

/**
 * The box the user writes in: a big round box with `+` (photos) at its left and send at its right, its prompt saying
 * where the message goes (`发消息到 T3 登录接口…`). The `@name` being typed offers the members, a reply says what it
 * answers. The photos picked wait above it, and go with the message (RoomFileViews).
 */
@Composable
private fun RoomWriter(model: RoomPageModel, detail: RoomDetail, focus: FocusRequester, send: () -> Unit) {
    val seats = detail.seats
    val classic = LocalLook.current.isClassic
    val offers = RoomMention.query(model.draft)?.let { RoomMention.offers(it, seats) } ?: emptyList()
    var preparing by remember { mutableStateOf(false) }
    val where = model.taskFilter?.let { n -> RoomTask.word(n, detail.task(n)?.title) } ?: detail.room.name
    Column(Modifier.fillMaxWidth().background(Theme.base)) {
        Column(
            Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.navigationBars).padding(horizontal = 10.dp, vertical = Theme.Space.s),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (offers.isNotEmpty()) MentionPicker(offers.takeLast(6), seats) { model.draft = RoomMention.complete(model.draft, it) }
            model.replyTo?.let { n ->
                Row(Modifier.padding(horizontal = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (classic) ClassicIcon(ClassicIconKind.Symbol("arrowshape.turn.up.left"), 14.dp, 13.dp, Theme.secondaryInk)
                    else PixelSprite(RoomArt.reply, pixel = 2.dp, color = Theme.secondaryInk)
                    Text("回复 ${RoomWords.who(model.message(n)?.from ?: "#$n")}", Modifier.weight(1f), color = Theme.secondaryInk, style = mono(12), maxLines = 1)
                    Text("×", Modifier.clickable(role = Role.Button, onClickLabel = "Close") { model.replyTo = null }.padding(horizontal = 6.dp), color = Theme.secondaryInk, style = mono(15))
                }
            }
            // In `# 全部`, a message that begins with `T3` is about that task: said before it goes.
            if (model.taskFilter == null) model.draftTask?.let { n ->
                Text("→ 属于 ${RoomTask.word(n, detail.task(n)?.title)}", Modifier.padding(horizontal = 6.dp), color = Theme.secondaryInk, style = mono(11), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            RoomAttachmentStrip(model, preparing)
            Row(
                Modifier.fillMaxWidth().grounded(if (classic) Theme.panel else Color.Transparent, 22.dp).framed(Theme.line, 22.dp).padding(horizontal = 4.dp, vertical = 4.dp),
                verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                RoomPhotosButton(model) { preparing = it }
                Box(Modifier.weight(1f).padding(vertical = 9.dp)) {
                    PlainField(
                        model.draft, { model.draft = it }, Modifier.fillMaxWidth().heightIn(max = 140.dp).then(rememberRoomPaste(model) { preparing = it }).focusRequester(focus),
                        // The dispatch desk: what the user says is for the dispatch, no `@` needed.
                        placeholder = if (detail.room.desk && model.taskFilter == null) "跟调度说要做什么…" else "发消息到 $where…", singleLine = false,
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
                    )
                }
                SquareIconButton(send, "Send", active = model.canSend || model.sending) { tint ->
                    if (model.sending) BrailleSpinner(color = tint)
                    else Text("→", color = tint, style = if (classic) plain(17, FontWeight.Bold) else mono(18, FontWeight.Bold))
                }
            }
        }
    }
}

/** The members the `@name` being typed may become, the newest-seated last, then `all`; the rule said on top. */
@Composable
private fun MentionPicker(offers: List<String>, seats: List<RoomSeat>, pick: (String) -> Unit) {
    val classic = LocalLook.current.isClassic
    Column(Modifier.fillMaxWidth().grounded(Theme.panel, 12.dp).framed(if (classic) Theme.line else Theme.ink, 12.dp)) {
        Text("只有 @ 到的成员会被唤醒。", Modifier.padding(horizontal = 10.dp, vertical = 6.dp), color = Theme.inkDim, style = plain(11))
        HairRule()
        offers.forEachIndexed { i, handle ->
            val seat = seats.firstOrNull { it.handle == handle }
            Row(
                Modifier.fillMaxWidth().clickable(role = Role.Button) { pick(handle) }.padding(horizontal = 10.dp, vertical = 9.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                if (handle == RoomSeat.all) Spacer(Modifier.size(10.dp)) else SeatStateMark(seat?.state, Modifier.width(10.dp))
                if (handle == RoomSeat.all) Spacer(Modifier.size(18.dp)) else RoomAvatarView(seat, handle = handle, side = 18.dp)
                Text("@$handle", color = Theme.ink, style = if (classic) plain(14, FontWeight.SemiBold) else mono(14, FontWeight.SemiBold), maxLines = 1)
                Text(
                    if (handle == RoomSeat.all) "全体，只有你能用"
                    else listOfNotNull(seat?.card?.let { RoomArt.agentName(it.agent) }, seat?.state?.word(LocalLook.current), if (seat?.muted == true) "已禁言" else null).joinToString(" · "),
                    Modifier.weight(1f), color = Theme.secondaryInk, style = plain(12), maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                seat?.card?.color?.let { ProfileDot(it) }
            }
            if (i != offers.size - 1) HairRule()
        }
    }
}

/** A member's quick answer through its own `/btw` (docs/chatroom-v0.md §13; the Mac's `RoomAsideLabel`): `Aside`, drawn
 *  as a task's tag is. */
@Composable
internal fun AsideTag() {
    val classic = LocalLook.current.isClassic
    Text(
        "Aside",
        Modifier.grounded(if (classic) Theme.panel else Color.Transparent, 4.dp).framed(Theme.line, if (classic) 4.dp else 0.dp)
            .padding(horizontal = 4.dp, vertical = 0.dp),
        color = Theme.secondaryInk, style = mono(11), maxLines = 1, textAlign = TextAlign.Center,
    )
}

/** A message's task in `# 全部` (the design's small tag): `T3`; a tap shows that task's messages. */
@Composable
internal fun TaskTag(n: Int, tap: (() -> Unit)? = null) {
    val classic = LocalLook.current.isClassic
    Text(
        "T$n",
        Modifier.grounded(if (classic) Theme.panel else Color.Transparent, 4.dp).framed(Theme.line, if (classic) 4.dp else 0.dp)
            .then(if (tap != null) Modifier.clickable(role = Role.Button, onClickLabel = "只看这个任务") { tap() } else Modifier)
            .padding(horizontal = 4.dp, vertical = 0.dp),
        color = Theme.secondaryInk, style = mono(11), maxLines = 1, textAlign = TextAlign.Center,
    )
}

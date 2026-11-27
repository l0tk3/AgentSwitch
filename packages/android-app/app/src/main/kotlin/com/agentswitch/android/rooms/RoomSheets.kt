package com.agentswitch.android.rooms

import com.agentswitch.kit.api.createTerminal
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Switch
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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.LocalNav
import com.agentswitch.android.design.BarBack
import com.agentswitch.android.design.BarWord
import com.agentswitch.android.design.FormPage
import com.agentswitch.android.design.FormRow
import com.agentswitch.android.design.FormSection
import com.agentswitch.android.design.HairRule
import com.agentswitch.android.design.LocalLook
import com.agentswitch.android.design.PixelBox
import com.agentswitch.android.design.PixelBoxEffect
import com.agentswitch.android.design.PlainField
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.code
import com.agentswitch.android.design.lookWord
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.android.terminals.LookSymbol
import com.agentswitch.android.terminals.LookSymbolIcon
import com.agentswitch.android.terminals.ProfileDot
import com.agentswitch.android.terminals.TerminalStatusMark
import com.agentswitch.kit.api.RoomClaim
import com.agentswitch.kit.api.RoomSeat
import com.agentswitch.kit.api.RoomSessionSearch
import com.agentswitch.kit.api.SeatState
import com.agentswitch.kit.api.TerminalInfo
import com.agentswitch.kit.api.TerminalStatus
import com.agentswitch.kit.api.createRoom
import com.agentswitch.kit.api.endSeat
import com.agentswitch.kit.api.renameSeat
import com.agentswitch.kit.api.resumeSeat
import com.agentswitch.kit.api.setSeatMuted
import com.agentswitch.kit.api.seat
import com.agentswitch.kit.api.setRoomNotes
import com.agentswitch.kit.api.setSeat
import com.agentswitch.kit.api.unseat
import com.agentswitch.kit.api.updateRoom
import com.agentswitch.kit.feed.ModelName
import com.agentswitch.kit.support.PathDisplay
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

// What comes up over a room (docs/chatroom-v0.md §10): its members and a member's card, the sessions to bring in (and
// a new room's name with them), its name and topic, and its pinned notes (its tasks and files: RoomWorkSheets.kt). The iPhone's `RoomSheets.swift`.

internal val agentInk @Composable get() = if (LocalLook.current.isClassic) Theme.signal else Theme.ink

/**
 * The members, by the node they run on: face with the state at its corner, `@name`, the state's word, the agent's
 * mark, the profile's dot. A tap opens the card. `Add` brings in sessions that run on the Mac. `opening`: a member
 * whose card is shown first (a tap on a face or a name in the timeline).
 */
@Composable
fun RoomMembersSheet(model: RoomPageModel, opening: String?, add: () -> Unit, mention: (String) -> Unit) {
    val app = LocalAppModel.current
    val nav = LocalNav.current
    val classic = LocalLook.current.isClassic
    var card by remember { mutableStateOf(opening) }
    val shown = card
    if (shown != null) {
        BackHandler { card = null }
        SeatCardPage(model, shown, back = { card = null }, mention = { nav.pop(); mention(it) }, close = { nav.pop() })
        return
    }
    val seats = model.detail?.sessions ?: emptyList()
    // The Mac shown first, then the other nodes by name.
    val nodes = seats.groupBy { it.card?.node ?: "" }.toSortedMap()
    FormPage(
        "Members",
        leading = { BarWord("Done", { nav.pop() }, color = agentInk) },
        trailing = {
            if (classic) Text("+", Modifier.clickable(role = Role.Button, onClickLabel = "Add") { nav.pop(); add() }.padding(horizontal = 12.dp, vertical = 6.dp), color = Theme.signal, style = plain(26, FontWeight.Light))
            else BarWord("Add", { nav.pop(); add() })
        },
    ) {
        if (seats.isEmpty()) Text("房间里还没有会话。点 Add 把正在运行的会话拉进来。", Modifier.padding(Theme.Space.l), color = Theme.secondaryInk, style = plain(15))
        for ((node, of) in nodes) {
            FormSection(node.ifEmpty { app.profile?.name ?: "Mac" }) {
                of.forEachIndexed { i, seat -> FormRow(first = i == 0, onClick = { card = seat.handle }) { MemberRow(seat, model.detail?.claim(seat.handle)) } }
            }
        }
    }
}

@Composable
private fun androidx.compose.foundation.layout.RowScope.MemberRow(seat: RoomSeat, claim: RoomClaim?) {
    val classic = LocalLook.current.isClassic
    val look = LocalLook.current
    Box {
        RoomAvatarView(seat, side = 26.dp)
        SeatStateMark(
            seat.state,
            Modifier.align(Alignment.BottomEnd).offset(x = 5.dp, y = 5.dp).size(12.dp).background(Theme.raised, if (classic) RoundedCornerShape(6.dp) else androidx.compose.ui.graphics.RectangleShape),
        )
    }
    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text("@${seat.handle}", color = Theme.ink, style = if (classic) plain(15, FontWeight.SemiBold) else mono(15, FontWeight.SemiBold), maxLines = 1, overflow = TextOverflow.Ellipsis)
        Row {
            Text(seat.state?.word(look) ?: "—", color = seat.state.wordColor(), style = mono(11), maxLines = 1)
            if (seat.canAdd) Text(" · Admin", color = Theme.secondaryInk, style = mono(11), maxLines = 1)
            if (seat.muted) Text(" · 禁言", color = Theme.waiting, style = mono(11), maxLines = 1)
            seat.unread?.takeIf { it > 0 }?.let { Text(" · $it 未读", color = Theme.secondaryInk, style = mono(11), maxLines = 1) }
            // It can neither speak here nor be woken until it is resumed (§6): for the user to do.
            if (seat.noKit) Text(" · No Kit", color = Theme.waiting, style = mono(11), maxLines = 1)
        }
        // What it says it is changing (§9), until when: a word to the others, not a lock.
        claim?.let { Text("▸ ${it.summary()} · until ${RoomWords.time(it.until)}", color = Theme.secondaryInk, style = mono(11), maxLines = 1, overflow = TextOverflow.MiddleEllipsis) }
    }
    seat.card?.agent?.takeIf { it.isNotEmpty() }?.let { RoomAgentMark(it) }
    seat.card?.color?.let { ProfileDot(it) }
}

/**
 * A member's card (§1 名片): its agent, model, profile, node, folder, how it asks, its state and who seated it; the
 * Chatroom Kit's one switch (§6), off for good for a session another session started; and what can be done with it.
 */
@Composable
private fun SeatCardPage(model: RoomPageModel, handle: String, back: () -> Unit, mention: (String) -> Unit, close: () -> Unit) {
    val app = LocalAppModel.current
    val nav = LocalNav.current
    val look = LocalLook.current
    val classic = look.isClassic
    val scope = rememberCoroutineScope()
    val seat = model.detail?.seat(handle)
    var busy by remember { mutableStateOf(false) }
    var confirmRemove by remember { mutableStateOf(false) }
    var confirmEnd by remember { mutableStateOf(false) }
    var renaming by remember { mutableStateOf<String?>(null) }
    fun act(work: suspend (com.agentswitch.kit.api.AgentSwitchAPI) -> Unit) { scope.launch { busy = true; model.run(app.api, work); busy = false } }
    fun end(now: Boolean, delete: Boolean = false) {
        scope.launch {
            busy = true
            var handing = false
            val done = model.run(app.api) { handing = it.endSeat(handle, model.id, now = now, delete = delete).handingOver }
            busy = false
            if (!done) return@launch
            // One with unfinished tasks writes its handover note first, then ends by itself.
            if (handing) app.banner = "@$handle 还有没做完的任务：正在等它写交接，最多两分钟，写完自动结束。" else back()
        }
    }
    FormPage("@$handle", leading = { BarBack(back, "Members") }) {
        if (seat == null) {
            Text("这个成员已不在房间里。", Modifier.padding(Theme.Space.l), color = Theme.secondaryInk, style = plain(15))
            return@FormPage
        }
        FormSection {
            FormRow(first = true) {
                RoomAvatarView(seat, side = 36.dp)
                Text("@${seat.handle}", Modifier.weight(1f), color = Theme.ink, style = if (classic) plain(17, FontWeight.SemiBold) else mono(17, FontWeight.SemiBold), maxLines = 1, overflow = TextOverflow.Ellipsis)
                SeatStateMark(seat.state)
                seat.card?.color?.let { ProfileDot(it) }
            }
            model.error?.let { FormRow { Text(it, Modifier.weight(1f), color = Theme.failed, style = plain(13)) } }
        }
        val gone = seat.left != null
        FormSection(footer = (if (!gone) seat.state?.says else null) ?: if (seat.noKit) "这个会话启动时还没有 Chatroom Kit：恢复一次之后，它才能在房间里说话、被消息叫醒。" else null) {
            var first = true
            @Composable fun line(label: String, value: String, mono: Boolean = false, color: Color = Theme.secondaryInk) {
                FormRow(first = first) {
                    Text(label, color = Theme.ink, style = plain(16), maxLines = 1)
                    Text(value, Modifier.weight(1f), color = color, style = if (mono) code(13) else plain(16), textAlign = TextAlign.End, maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
                }
                first = false
            }
            seat.card?.let { c ->
                line("Agent", RoomArt.agentName(c.agent))
                line("Model", c.model?.let(ModelName::display) ?: "Default")
                line("Profile", c.profile ?: "Default")
                line("Node", c.node ?: app.profile?.name ?: "Mac")
                line("Folder", PathDisplay.short(c.cwd), mono = true)
                c.mode?.let { line("Mode", lookWord(it)) }
            }
            line("State", if (gone) "Left" else seat.state?.word(look) ?: "—", color = if (gone) Theme.secondaryInk else seat.state.wordColor())
            if (seat.noKit) line("Kit", "No Kit", color = Theme.waiting)
            if (seat.canAdd) line("Role", "Admin")
            if (seat.muted) line("Muted", "by @${seat.mutedBy ?: "?"}", color = Theme.waiting)
            line("Seated By", RoomWords.who(seat.addedBy))
            if (!gone) seat.unread?.let { line("Unread", if (it == 0) "全部已读" else "$it 条") }
            seat.asks?.let { line("Asks", it.title, color = Theme.waiting) }
            seat.stats?.let { line("Room Cost", it.says) }
        }
        // What it says it is changing (§9): every path it named, and until when.
        if (!gone) model.detail?.claim(handle)?.let { claim ->
            FormSection("Changing", footer = claim.why?.let { "原因：$it。" }) {
                claim.paths.forEachIndexed { i, path ->
                    FormRow(first = i == 0) { Text(path, Modifier.weight(1f), color = Theme.ink, style = code(13), maxLines = 1, overflow = TextOverflow.MiddleEllipsis) }
                }
                FormRow {
                    Text("Until", color = Theme.ink, style = plain(16), maxLines = 1)
                    Text(RoomWords.time(claim.until), Modifier.weight(1f), color = Theme.secondaryInk, style = plain(16), textAlign = TextAlign.End, maxLines = 1)
                }
            }
        }
        if (!gone) {
            FormSection(footer = if (seat.byAgent) "由别的会话拉起来的会话不能再拉人。" else null) {
                val can = !seat.byAgent && !busy
                fun set(on: Boolean) { scope.launch { busy = true; model.run(app.api) { it.setSeat(handle, model.id, on) }; busy = false } }
                FormRow(Modifier.alpha(if (can) 1f else 0.4f), first = true, onClick = if (can) ({ set(!seat.canAdd) }) else null) {
                    Text("Admin", Modifier.weight(1f), color = Theme.ink, style = plain(16))
                    Switch(checked = seat.canAdd, onCheckedChange = if (can) ({ on: Boolean -> set(on) }) else null, enabled = can)
                }
            }
            // What goes on with it: mention, its terminal, its name here, back from an end, its voice.
            val dim = Modifier.alpha(if (busy) 0.4f else 1f)
            FormSection(footer = if (seat.muted) "已禁言（@${seat.mutedBy ?: "?"}）：还能读、还能干活，但不能发消息、不能写置顶笔记。" else null) {
                FormRow(first = true, onClick = { mention(handle) }) { Text("Mention", color = Theme.ink, style = plain(16)) }
                // Its avatar, one for each look, the same in every room (RoomAvatarSheet).
                if (seat.terminal != null) FormRow(onClick = { nav.present("roomavatar:${model.id}:$handle") { RoomAvatarSheet(model, handle) } }) {
                    Text("Avatar", Modifier.weight(1f), color = Theme.ink, style = plain(16))
                    RoomAvatarView(seat, side = 22.dp)
                    Text("›", color = Theme.inkDim, style = plain(18))
                }
                val terminal = seat.terminal
                if (terminal != null && seat.state != SeatState.Exited && app.terminals.terminals.any { it.id == terminal }) {
                    FormRow(onClick = { close(); nav.popToRoot(); app.openTerminal(terminal) }) { Text("Open Terminal", color = Theme.ink, style = plain(16)) }
                }
                if (seat.state == SeatState.Exited || seat.noKit) {
                    FormRow(dim, onClick = if (busy) null else ({ act { it.resumeSeat(handle, model.id) } })) {
                        Text("恢复", Modifier.weight(1f), color = agentInk, style = plain(16))
                        Text("同一个会话、同一个目录", color = Theme.secondaryInk, style = plain(13), maxLines = 1)
                    }
                }
                FormRow(dim, onClick = if (busy) null else ({ act { it.setSeatMuted(handle, model.id, !seat.muted) } })) {
                    Text(if (seat.muted) "解除禁言" else "禁言", color = Theme.ink, style = plain(16))
                }
                val name = renaming
                if (name == null) {
                    FormRow(dim, onClick = if (busy) null else ({ renaming = handle })) { Text("Rename…", color = Theme.ink, style = plain(16)) }
                } else {
                    FormRow {
                        PlainField(name, { renaming = it }, Modifier.weight(1f), placeholder = "这个房间里的新名字", keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false))
                        BarWord("Save", {
                            val next = name.trim()
                            scope.launch {
                                busy = true
                                var now: String? = null
                                val done = model.run(app.api) { now = it.renameSeat(handle, model.id, next).handle }
                                busy = false
                                if (done) { renaming = null; if (now != null && now != handle) back() }
                            }
                        }, enabled = !busy && name.isNotBlank() && name.trim() != handle, color = agentInk)
                    }
                }
            }
            // What takes it out, in the order of how much they undo.
            FormSection {
                FormRow(dim, first = true, onClick = if (busy) null else ({ confirmRemove = true })) { Text("踢出", color = Theme.failed, style = plain(16)) }
                FormRow(dim, onClick = if (busy) null else ({ confirmEnd = true })) { Text("结束", color = Theme.failed, style = plain(16)) }
            }
        }
    }
    PixelBoxEffect(confirmEnd, { confirmEnd = false }) {
        PixelBox(
            head = "End", tone = PixelBox.Tone.Red,
            message = "结束 @$handle：移出房间并关掉它的终端，对话记录留着，之后还能恢复。它还有没做完的任务时，先在房间里写交接（最多两分钟）再结束；End Now 不等交接。Delete Record 连对话记录一起删，无法恢复。",
            actions = listOf(
                PixelBox.Action("End", PixelBox.Action.Role.Destructive) { end(now = false) },
                PixelBox.Action("End Now", PixelBox.Action.Role.Destructive) { end(now = true) },
                PixelBox.Action("Delete Record", PixelBox.Action.Role.Destructive) { end(now = true, delete = true) },
            ),
        )
    }
    PixelBoxEffect(confirmRemove, { confirmRemove = false }) {
        PixelBox(
            head = "Kick", tone = PixelBox.Tone.Red, message = "把 @$handle 踢出房间？它的会话继续运行；还没交到它手上的消息不再投递。",
            actions = listOf(PixelBox.Action("Kick", PixelBox.Action.Role.Destructive) {
                scope.launch {
                    busy = true
                    val done = model.run(app.api) { it.unseat(handle, model.id) }
                    busy = false
                    if (done) back()
                }
            }),
        )
    }
}

/** What the sessions sheet is for: a new room (a name and a topic first), or more sessions for a room there is. */
sealed class RoomSessionsPurpose {
    data object Create : RoomSessionsPurpose()
    data class Add(val room: String, val seated: Set<String>) : RoomSessionsPurpose()
}

/**
 * The sessions running on the Mac shown, to seat: with a name and a topic first for a new room (`New`), or the ones
 * not seated yet for a room there is (`Add Sessions`). One that has ended can not be seated and is not listed.
 * `onDone`: the room's id, once made or added to.
 */
@Composable
fun RoomSessionsSheet(purpose: RoomSessionsPurpose, onDone: (String) -> Unit = {}) {
    val app = LocalAppModel.current
    val nav = LocalNav.current
    val scope = rememberCoroutineScope()
    val creating = purpose is RoomSessionsPurpose.Create
    var name by remember { mutableStateOf("") }
    var topic by remember { mutableStateOf("") }
    var picked by remember { mutableStateOf(setOf<String>()) }
    // Sessions to start and seat with it (the Mac's, user #504): each an agent in a folder, under a profile.
    var fresh by remember { mutableStateOf(listOf<com.agentswitch.kit.api.NewTerminalRequest>()) }
    // The search over the sessions to pick: by name, agent, model, profile and folder (RoomSessionSearch).
    var query by remember { mutableStateOf("") }
    var working by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val seated = (purpose as? RoomSessionsPurpose.Add)?.seated ?: emptySet()
    val terminals = app.terminals.terminals.filter { it.isRunning && it.id !in seated }.sortedByDescending { maxOf(it.lastOutputAt, it.createdAt) }
    // The ones the search leaves; picked ones the search hides stay picked.
    val shown = RoomSessionSearch.filter(terminals, query)
    val ready = !working && (if (creating) name.isNotBlank() else picked.isNotEmpty() || fresh.isNotEmpty())

    /** The sessions asked for, started and seated in `room`; what went wrong with any of them, in words. */
    suspend fun start(api: com.agentswitch.kit.api.AgentSwitchAPI, room: String): List<String> {
        val problems = ArrayList<String>()
        val asked = fresh.size
        for (one in fresh) {
            try {
                val made = api.createTerminal(one)
                api.seat(made.id, room)
                fresh = fresh - one
            } catch (e: CancellationException) { throw e } catch (e: Exception) { problems += "${one.cwd}：${e.message ?: e.javaClass.simpleName}" }
        }
        if (problems.size < asked) app.refreshTerminals()
        return problems
    }

    LaunchedEffect(Unit) { app.refreshTerminals() }

    fun go() {
        val api = app.api ?: run { error = "未连接 Mac。"; return }
        scope.launch {
            working = true
            try {
                when (purpose) {
                    is RoomSessionsPurpose.Create -> {
                        val made = api.createRoom(name.trim(), topic.trim(), terminals.map { it.id }.filter { it in picked })
                        val problems = made.problems + start(api, made.room.id)
                        app.rooms.refresh(api)
                        // The room is made; a session that could not be started or seated is said, not lost.
                        if (problems.isNotEmpty()) app.banner = problems.joinToString("\n")
                        nav.pop()
                        onDone(made.room.id)
                        app.openRoomRequest = made.room.id
                    }
                    is RoomSessionsPurpose.Add -> {
                        val problems = ArrayList<String>()
                        for (id in terminals.map { it.id }.filter { it in picked }) {
                            try { api.seat(id, purpose.room); picked = picked - id } catch (e: CancellationException) { throw e } catch (e: Exception) { problems += e.message ?: e.javaClass.simpleName }
                        }
                        problems += start(api, purpose.room)
                        onDone(purpose.room)
                        if (problems.isEmpty()) nav.pop() else error = problems.joinToString("\n")
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = e.message ?: e.javaClass.simpleName
            } finally {
                working = false
            }
        }
    }

    FormPage(
        if (creating) "New Room" else "Add Sessions",
        leading = { BarWord("Cancel", { nav.pop() }, color = agentInk) },
        trailing = { BarWord(if (creating) "Create" else if (picked.size + fresh.size > 1) "Add ${picked.size + fresh.size}" else "Add", { go() }, enabled = ready, color = agentInk) },
    ) {
        if (creating) RoomNameFields(name, { name = it }, topic, { topic = it })
        // New sessions, started with it: an agent in a folder each; `New Session` adds one more.
        FormSection("New Sessions") {
            fresh.forEachIndexed { i, one ->
                FormRow(first = i == 0) {
                    RoomAgentMark(one.harness)
                    Text(one.cwd, Modifier.weight(1f), color = Theme.ink, style = mono(14), maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
                    Text("×", Modifier.clickable(role = Role.Button, onClickLabel = "Remove") { fresh = fresh - one }.padding(horizontal = 6.dp), color = Theme.secondaryInk, style = mono(17))
                }
            }
            FormRow(first = fresh.isEmpty(), onClick = { nav.present("roomnewsession") { com.agentswitch.android.terminals.NewTerminalSheet(started = {}, forRoom = { fresh = fresh + it }) } }) {
                Text("New Session", Modifier.weight(1f), color = agentInk, style = plain(16))
                Text("›", color = Theme.inkDim, style = plain(18))
            }
        }
        FormSection("Running Sessions") {
            if (terminals.isNotEmpty()) {
                FormRow(first = true) {
                    if (LocalLook.current.isClassic) LookSymbolIcon(LookSymbol.Magnifier, side = 16.dp, color = Theme.inkDim)
                    else Text("/", color = Theme.signal, style = mono(15, FontWeight.Bold))
                    PlainField(query, { query = it }, Modifier.weight(1f), placeholder = "Search", keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false))
                }
            }
            if (shown.isEmpty()) {
                FormRow(first = terminals.isEmpty()) {
                    Text(if (terminals.isNotEmpty()) "没有找到匹配的会话。" else if (creating) "没有开着的终端。可以先建房间，之后再拉会话。" else "没有可以拉进来的会话：开着的终端都已在房间里。", Modifier.weight(1f), color = Theme.secondaryInk, style = plain(15))
                }
            }
            shown.forEach { t ->
                FormRow(first = false, onClick = { picked = if (t.id in picked) picked - t.id else picked + t.id }) { SessionRow(t, t.id in picked) }
            }
        }
        error?.let { Text(it, Modifier.padding(horizontal = Theme.Space.l, vertical = Theme.Space.m), color = Theme.failed, style = plain(13)) }
    }
}

@Composable
private fun androidx.compose.foundation.layout.RowScope.SessionRow(t: TerminalInfo, on: Boolean) {
    if (LocalLook.current.isClassic) LookSymbolIcon(if (on) LookSymbol.CheckCircleFill else LookSymbol.Circle, side = 20.dp, color = if (on) Theme.signal else Theme.inkDim)
    else Text(if (on) "[x]" else "[ ]", color = if (on) Theme.ink else Theme.inkDim, style = mono(14))
    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(t.name, color = Theme.ink, style = plain(15, FontWeight.SemiBold), maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(PathDisplay.short(t.workdir), color = Theme.secondaryInk, style = code(11), maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
    }
    RoomAgentMark(t.harness)
    t.profile?.color?.let { ProfileDot(it) }
    TerminalStatusMark(if (t.permissions.isEmpty()) t.status else TerminalStatus.Waiting)
}

/** A room's name and its topic, as two rows of one group. */
@Composable
private fun RoomNameFields(name: String, onName: (String) -> Unit, topic: String, onTopic: (String) -> Unit) {
    FormSection("Room") {
        FormRow(first = true) {
            PlainField(name, onName, Modifier.weight(1f), placeholder = "Name", keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false))
        }
        FormRow {
            PlainField(topic, onTopic, Modifier.weight(1f).heightIn(max = 80.dp), placeholder = "一句话，进来的成员先读到", singleLine = false)
        }
    }
}

/** A room's name and its topic. */
@Composable
fun RoomEditSheet(model: RoomPageModel) {
    val app = LocalAppModel.current
    val nav = LocalNav.current
    val scope = rememberCoroutineScope()
    var name by remember { mutableStateOf(model.detail?.room?.name ?: "") }
    var topic by remember { mutableStateOf(model.detail?.room?.topic ?: "") }
    var working by remember { mutableStateOf(false) }
    FormPage(
        "Rename Room",
        leading = { BarWord("Cancel", { nav.pop() }, color = agentInk) },
        trailing = {
            BarWord("Save", {
                scope.launch {
                    working = true
                    val done = model.run(app.api) { it.updateRoom(model.id, name = name.trim(), topic = topic.trim()) }
                    working = false
                    if (done) nav.pop()
                }
            }, enabled = !working && name.isNotBlank(), color = agentInk)
        },
    ) {
        RoomNameFields(name, { name = it }, topic, { topic = it })
        model.error?.let { Text(it, Modifier.padding(horizontal = Theme.Space.l, vertical = Theme.Space.m), color = Theme.failed, style = plain(13)) }
    }
}

/**
 * The room's pinned notes (§9): one text every member reads and writes — what was agreed. Read here, and written whole
 * with `Save`; a session writes them with its own tool, so what is shown is what the Mac had when the sheet opened.
 */
@Composable
fun RoomNotesSheet(model: RoomPageModel) {
    val app = LocalAppModel.current
    val nav = LocalNav.current
    val scope = rememberCoroutineScope()
    val had = remember { model.detail?.notes }
    var text by remember { mutableStateOf(had?.text ?: "") }
    var working by remember { mutableStateOf(false) }
    val changed = text.trimEnd() != (had?.text ?: "")
    FormPage(
        "Notes",
        leading = { BarWord(if (changed) "Cancel" else "Done", { nav.pop() }, color = agentInk) },
        trailing = {
            BarWord("Save", {
                scope.launch {
                    working = true
                    val done = model.run(app.api) { it.setRoomNotes(model.id, text) }
                    working = false
                    if (done) nav.pop()
                }
            }, enabled = changed && !working, color = agentInk)
        },
    ) {
        FormSection(
            "Pinned Notes",
            footer = (had?.let { "上次由 ${if (it.by == RoomSeat.you) "你" else "@${it.by}"} 写于 ${RoomWords.day(it.at)} ${RoomWords.time(it.at)}。" } ?: "还没有置顶笔记。") +
                "所有成员都能读、能改：约定、接口、待办写在这里。保存会整份替换。",
        ) {
            FormRow(first = true) {
                PlainField(text, { text = it }, Modifier.weight(1f).heightIn(min = 160.dp), placeholder = "约定、接口、待办…", style = plain(15), singleLine = false)
            }
        }
        model.error?.let { Text(it, Modifier.padding(horizontal = Theme.Space.l, vertical = Theme.Space.m), color = Theme.failed, style = plain(13)) }
    }
}

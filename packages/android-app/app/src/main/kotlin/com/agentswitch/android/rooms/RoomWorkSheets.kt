package com.agentswitch.android.rooms

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
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
import com.agentswitch.android.design.LocalLook
import com.agentswitch.android.design.PixelBox
import com.agentswitch.android.design.PixelBoxEffect
import com.agentswitch.android.design.PlainField
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.code
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.android.files.FileGlyph
import com.agentswitch.android.files.FileKinds
import com.agentswitch.android.terminals.LookSymbol
import com.agentswitch.android.terminals.LookSymbolIcon
import com.agentswitch.android.terminals.relativeTime
import com.agentswitch.kit.api.FileSize
import com.agentswitch.kit.api.RoomDetail
import com.agentswitch.kit.api.RoomSeat
import com.agentswitch.kit.api.RoomTask
import com.agentswitch.kit.api.RoomTaskState
import com.agentswitch.kit.api.addRoomTask
import com.agentswitch.kit.api.deleteRoomTask
import com.agentswitch.kit.api.setRoomTask
import kotlinx.coroutines.launch

// A room's work, from the page's ⋯ beside Notes (docs/chatroom-v0.md §9): its task list — who does what, and how far
// it is — and what is in its shared folder. Who is changing which files is said where a member is shown
// (RoomSheets.kt). Written as the notes' sheet is.

/** The three groups, in the order they are read: what is being done, what is left, what is finished. */
private val taskGroups = listOf(RoomTaskState.Blocked, RoomTaskState.Doing, RoomTaskState.Todo, RoomTaskState.Done)

/**
 * The room's task list (§9): `Doing`, `To Do`, `Done`; each task with its number, whose it is, what it waits for and
 * how it ended. A tap opens the task: done or to do again, whose it is, off the list. `Add` writes a new one. The
 * sessions change the list with their own tool, and the page reads the room again every few seconds, so what is shown
 * follows. `opening`, `adding`: the task, or the new one's form, shown first.
 */
@Composable
fun RoomTasksSheet(model: RoomPageModel, opening: Int? = null, adding: Boolean = false) {
    val nav = LocalNav.current
    val classic = LocalLook.current.isClassic
    var open by remember { mutableStateOf(opening) }
    var writing by remember { mutableStateOf(adding) }
    val detail = model.detail
    val shown = open
    if (writing) {
        BackHandler { writing = false }
        NewTaskPage(model, back = { writing = false })
        return
    }
    if (shown != null) {
        BackHandler { open = null }
        TaskPage(model, shown, back = { open = null })
        return
    }
    FormPage(
        "Tasks",
        leading = { BarWord("Done", { nav.pop() }, color = agentInk) },
        trailing = {
            if (classic) Text("+", Modifier.clickable(detail != null, role = Role.Button, onClickLabel = "Add") { model.error = null; writing = true }.padding(horizontal = 12.dp, vertical = 6.dp), color = Theme.signal, style = plain(26, FontWeight.Light))
            else BarWord("Add", { model.error = null; writing = true }, enabled = detail != null)
        },
    ) {
        if (detail == null) return@FormPage
        if (detail.tasks.isEmpty()) Text("还没有任务。点 Add 写一个；房间里的会话也能自己添加、领取和完成任务。", Modifier.padding(Theme.Space.l), color = Theme.secondaryInk, style = plain(15))
        for (state in taskGroups) {
            val of = detail.tasks(state)
            if (of.isEmpty()) continue
            FormSection("${state.chinese} · ${of.size}") {
                of.forEachIndexed { i, task -> FormRow(first = i == 0, onClick = { model.error = null; open = task.n }) { TaskRow(task, detail) } }
            }
        }
    }
}

/** `T3`, the title; under it whose it is, what it waits for; and how it ended. */
@Composable
private fun RowScope.TaskRow(task: RoomTask, detail: RoomDetail) {
    val classic = LocalLook.current.isClassic
    val done = task.state == RoomTaskState.Done
    val waits = detail.waitsFor(task)
    Text(task.label, Modifier.align(Alignment.Top).padding(top = 2.dp), color = Theme.inkDim, style = mono(13), maxLines = 1)
    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(task.title, color = if (done) Theme.secondaryInk else Theme.ink, style = plain(15, if (done) FontWeight.Normal else FontWeight.Medium), maxLines = 3, overflow = TextOverflow.Ellipsis)
        if (task.owner != null || waits.isNotEmpty()) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                task.owner?.let { owner ->
                    RoomAvatarView(detail.seat(owner), handle = owner, you = owner == RoomSeat.you, side = 14.dp)
                    Text("@$owner", color = Theme.secondaryInk, style = if (classic) plain(12, FontWeight.Medium) else mono(12, FontWeight.Medium), maxLines = 1)
                }
                // It can not go on until those are done: amber, for someone to look.
                if (waits.isNotEmpty()) Text("waits for ${waits.joinToString(", ") { "T$it" }}", color = Theme.waiting, style = mono(11), maxLines = 1)
            }
        }
        val blocked = task.state == RoomTaskState.Blocked
        task.note?.let { Text(if (blocked) "⚠ 卡住：$it" else it, color = if (blocked) Theme.waiting else Theme.secondaryInk, style = plain(12), maxLines = 2, overflow = TextOverflow.Ellipsis) }
        detail.taskStats(task.n)?.let { Text(it.says, color = Theme.inkDim, style = mono(11), maxLines = 1, overflow = TextOverflow.Ellipsis) }
    }
}

/** A row that is one of several to choose from: its mark, as the sessions to seat have it. */
@Composable
private fun PickMark(on: Boolean) {
    if (LocalLook.current.isClassic) LookSymbolIcon(if (on) LookSymbol.CheckCircleFill else LookSymbol.Circle, side = 20.dp, color = if (on) Theme.signal else Theme.inkDim)
    else Text(if (on) "[x]" else "[ ]", color = if (on) Theme.ink else Theme.inkDim, style = mono(14))
}

/** The sessions sitting, one of them (or none) chosen as a task's owner. */
@Composable
private fun OwnerRows(detail: RoomDetail?, owner: String?, enabled: Boolean, pick: (String?) -> Unit) {
    val seats = detail?.sessions ?: emptyList()
    if (seats.isEmpty()) {
        FormRow(first = true) { Text("房间里还没有会话。", Modifier.weight(1f), color = Theme.secondaryInk, style = plain(15)) }
        return
    }
    seats.forEachIndexed { i, seat ->
        val on = seat.handle == owner
        // A tap on whose it is gives it up.
        FormRow(Modifier.alpha(if (enabled) 1f else 0.4f), first = i == 0, onClick = if (enabled) ({ pick(if (on) null else seat.handle) }) else null) {
            PickMark(on)
            RoomAvatarView(seat, side = 22.dp)
            Text("@${seat.handle}", Modifier.weight(1f), color = Theme.ink, style = plain(16), maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(seat.state?.word(LocalLook.current) ?: "—", color = seat.state.wordColor(), style = mono(11), maxLines = 1)
        }
    }
}

/** One task: what it is, how far, whose; done or to do again, another owner, off the list. */
@Composable
private fun TaskPage(model: RoomPageModel, n: Int, back: () -> Unit) {
    val app = LocalAppModel.current
    val scope = rememberCoroutineScope()
    val detail = model.detail
    val task = detail?.task(n)
    var busy by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    fun act(work: suspend (com.agentswitch.kit.api.AgentSwitchAPI) -> Unit) { scope.launch { busy = true; model.run(app.api, work); busy = false } }
    FormPage("T$n", leading = { BarBack(back, "Tasks") }) {
        if (detail == null || task == null) {
            Text("这个任务已不在任务表里。", Modifier.padding(Theme.Space.l), color = Theme.secondaryInk, style = plain(15))
            return@FormPage
        }
        FormSection {
            FormRow(first = true) { Text(task.title, Modifier.weight(1f), color = Theme.ink, style = plain(17, FontWeight.SemiBold)) }
            task.detail?.let { FormRow { Text(it, Modifier.weight(1f), color = Theme.ink, style = plain(15)) } }
            model.error?.let { FormRow { Text(it, Modifier.weight(1f), color = Theme.failed, style = plain(13)) } }
        }
        FormSection {
            var first = true
            @Composable fun line(label: String, value: String, color: Color = Theme.secondaryInk) {
                FormRow(first = first) {
                    Text(label, color = Theme.ink, style = plain(16), maxLines = 1)
                    Text(value, Modifier.weight(1f), color = color, style = plain(16), textAlign = TextAlign.End, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                first = false
            }
            line("State", task.state.chinese, color = if (task.state == RoomTaskState.Blocked) Theme.waiting else Theme.secondaryInk)
            line("Owner", task.owner?.let { "@$it" } ?: "—")
            val waits = detail.waitsFor(task)
            if (task.after.isNotEmpty()) line(if (waits.isEmpty()) "After" else "Waits For", (waits.ifEmpty { task.after }).joinToString(", ") { "T$it" }, color = if (waits.isEmpty()) Theme.secondaryInk else Theme.waiting)
            line("Added By", RoomWords.who(task.by))
            line("Updated", "${RoomWords.day(task.updatedAt)} ${RoomWords.time(task.updatedAt)}")
        }
        task.note?.let { note ->
            val blocked = task.state == RoomTaskState.Blocked
            FormSection(if (blocked) "卡住：在等" else "Note") { FormRow(first = true) { Text(note, Modifier.weight(1f), color = if (blocked) Theme.waiting else Theme.ink, style = plain(15)) } }
        }
        // What this piece of work has cost the room (2026-11-24): wakes, characters, messages, calls.
        detail.taskStats(n)?.let { stats ->
            FormSection("Room Cost") {
                FormRow(first = true) { Text(stats.says, Modifier.weight(1f), color = Theme.ink, style = plain(15)) }
            }
        }
        FormSection("Owner") {
            OwnerRows(detail, task.owner, enabled = !busy) { handle ->
                act { if (handle == null) it.setRoomTask(model.id, n, clearOwner = true) else it.setRoomTask(model.id, n, owner = handle) }
            }
        }
        FormSection {
            val dim = Modifier.alpha(if (busy) 0.4f else 1f)
            var first = true
            if (task.state != RoomTaskState.Done) {
                FormRow(dim, first = first, onClick = if (busy) null else ({ act { it.setRoomTask(model.id, n, state = RoomTaskState.Done) } })) { Text("Mark Done", color = Theme.ink, style = plain(16)) }
                first = false
            }
            if (task.state != RoomTaskState.Todo) {
                FormRow(dim, first = first, onClick = if (busy) null else ({ act { it.setRoomTask(model.id, n, state = RoomTaskState.Todo) } })) { Text("To Do Again", color = Theme.ink, style = plain(16)) }
                first = false
            }
            FormRow(dim, first = first, onClick = if (busy) null else ({ confirmDelete = true })) { Text("Delete", color = Theme.failed, style = plain(16)) }
        }
    }
    PixelBoxEffect(confirmDelete, { confirmDelete = false }) {
        PixelBox(
            head = "Delete Task", tone = PixelBox.Tone.Red, message = "把 T$n 从任务表里删掉？无法恢复。",
            actions = listOf(PixelBox.Action("Delete", PixelBox.Action.Role.Destructive) {
                scope.launch {
                    busy = true
                    val done = model.run(app.api) { it.deleteRoomTask(model.id, n) }
                    busy = false
                    if (done) back()
                }
            }),
        )
    }
}

/** A new task: its title, what there is to say about it, and whose it is from the start (nobody's: whoever takes it). */
@Composable
private fun NewTaskPage(model: RoomPageModel, back: () -> Unit) {
    val app = LocalAppModel.current
    val scope = rememberCoroutineScope()
    var title by remember { mutableStateOf("") }
    var detail by remember { mutableStateOf("") }
    var owner by remember { mutableStateOf<String?>(null) }
    var working by remember { mutableStateOf(false) }
    FormPage(
        "New Task",
        leading = { BarWord("Cancel", back, color = agentInk) },
        trailing = {
            BarWord("Add", {
                scope.launch {
                    working = true
                    val done = model.run(app.api) { it.addRoomTask(model.id, title.trim(), detail.trim(), owner) }
                    working = false
                    if (done) back()
                }
            }, enabled = !working && title.isNotBlank(), color = agentInk)
        },
    ) {
        FormSection("Task") {
            FormRow(first = true) { PlainField(title, { title = it }, Modifier.weight(1f), placeholder = "Title") }
            FormRow { PlainField(detail, { detail = it }, Modifier.weight(1f).heightIn(min = 80.dp, max = 200.dp), placeholder = "细节：要做成什么样、相关文件…（可不填）", style = plain(15), singleLine = false) }
        }
        FormSection("Owner") {
            OwnerRows(model.detail, owner, enabled = !working) { owner = it }
        }
        model.error?.let { Text(it, Modifier.padding(horizontal = Theme.Space.l, vertical = Theme.Space.m), color = Theme.failed, style = plain(13)) }
    }
}

/**
 * The room's shared folder (§9): where it is on the Mac, and what the members have put in it, the newest first — its
 * path under the folder, its size, when it was last changed. Listed when the sheet opens. A tap opens a file as a
 * message's file is opened (RoomFileViews).
 */
@Composable
fun RoomFilesSheet(model: RoomPageModel) {
    val app = LocalAppModel.current
    val nav = LocalNav.current
    LaunchedEffect(Unit) { model.loadFiles(app.api) }
    val listed = model.files
    val folder = listed?.folder?.ifEmpty { null } ?: model.detail?.folder?.ifEmpty { null }
    FormPage("Files", leading = { BarWord("Done", { nav.pop() }, color = agentInk) }) {
        FormSection("Shared Folder") {
            FormRow(first = true) { Text(folder ?: "—", Modifier.weight(1f), color = Theme.ink, style = code(13)) }
        }
        model.filesError?.let { Text(it, Modifier.padding(horizontal = Theme.Space.l, vertical = Theme.Space.m), color = Theme.failed, style = plain(13)) }
        if (listed == null) return@FormPage
        if (listed.files.isEmpty()) {
            Text("共享文件夹里还没有文件。", Modifier.padding(Theme.Space.l), color = Theme.secondaryInk, style = plain(15))
            return@FormPage
        }
        FormSection("${listed.files.size} ${if (listed.files.size == 1) "File" else "Files"}", footer = if (listed.more) "还有更多文件没有列出。" else null) {
            listed.files.forEachIndexed { i, file ->
                FormRow(first = i == 0, onClick = { nav.openRoomFile(model, listed.whole(file)) }) {
                    FileGlyph(FileKinds.of(file.path.substringAfterLast('/')), Theme.secondaryInk)
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(file.path, color = Theme.ink, style = code(13), maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
                        Text("${FileSize.short(file.size)} · ${relativeTime(file.modifiedAt)}", color = Theme.secondaryInk, style = mono(11), maxLines = 1)
                    }
                }
            }
        }
    }
}

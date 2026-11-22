package com.agentswitch.android.dispatch

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.LocalNav
import com.agentswitch.android.demo.LocalDemoScreen
import com.agentswitch.android.design.BarBack
import com.agentswitch.android.design.BarWord
import com.agentswitch.android.design.BrailleSpinner
import com.agentswitch.android.design.NavBar
import com.agentswitch.android.design.PixelBox
import com.agentswitch.android.design.PixelBoxEffect
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.kit.api.APIError
import com.agentswitch.kit.files.KeptFiles
import com.agentswitch.kit.files.KeptWords
import com.agentswitch.kit.files.TaskFile
import com.agentswitch.kit.files.deleteKeptFiles
import com.agentswitch.kit.files.keptFiles
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

/**
 * Every task's kept files together (docs/dispatch-v0.md “任务的文件”, 2026-11-11, user: dispatch里加一个入口显示所有历史
 * 附件…集中查看和清理): how many there are and the room they take on the Mac, then each task's — what was asked, when,
 * its files as a task page lists them (a tap downloads one and opens the phone's viewer) — with `Delete` for a task's
 * and `Delete All` for everyone's. The tasks stay. A page: push it with `LocalNav`.
 */
@Composable
fun KeptFilesView() {
    val model = LocalAppModel.current
    val nav = LocalNav.current
    val scope = rememberCoroutineScope()
    val demo = LocalDemoScreen.current == "keptfiles"
    val opener = remember { TaskFileOpener() }
    var kept by remember { mutableStateOf<KeptFiles?>(null) }
    var problem by remember { mutableStateOf<String?>(null) }
    var said by remember { mutableStateOf<String?>(null) }
    var deleting by remember { mutableStateOf<Removal?>(null) }

    suspend fun load() {
        // The sample screens have no Mac to ask.
        if (demo) { kept = sampleKept(); return }
        val api = model.api ?: return
        try {
            kept = api.keptFiles()
            problem = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: APIError.Http) {
            if (e.status == 404) problem = KeptWords.unsupported else { if (kept == null) problem = e.message; model.handle(e) }
        } catch (e: Exception) {
            if (kept == null) problem = e.message ?: e.javaClass.simpleName
            model.handle(e)
        }
    }

    suspend fun remove(taskId: String?) {
        val api = model.api ?: return
        try {
            val removal = api.deleteKeptFiles(taskId)
            said = if (taskId == null) KeptWords.left(removal.busy) else null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            said = e.message ?: e.javaClass.simpleName
            model.handle(e)
        }
        load()
    }

    LaunchedEffect(Unit) { load() }
    TaskFilePreview(opener)
    PixelBoxEffect(deleting, { deleting = null }) { pending ->
        PixelBox(
            head = if (pending.taskId == null) "Delete All" else "Delete", tone = PixelBox.Tone.Red, message = pending.message,
            actions = listOf(PixelBox.Action("Delete", PixelBox.Action.Role.Destructive) { scope.launch { remove(pending.taskId) } }),
        )
    }

    Column(Modifier.fillMaxSize().background(Theme.base)) {
        NavBar(
            "Files",
            leading = { BarBack({ nav.pop() }) },
            trailing = {
                BarWord("Delete All", { kept?.let { deleting = Removal(null, KeptWords.deleteAll(it.count)) } }, enabled = kept?.isEmpty == false, color = Theme.failed)
            },
        )
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom))
                .padding(horizontal = Theme.Space.l, vertical = Theme.Space.m),
            verticalArrangement = Arrangement.spacedBy(Theme.Space.l),
        ) {
            said?.let { Text(it, color = Theme.waiting, style = plain(13)) }
            val list = kept
            if (list != null) {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(list.summary, color = Theme.secondaryInk, style = mono(12))
                    Text(KeptWords.kept(list.keptDays), color = Theme.secondaryInk, style = plain(13))
                }
                if (list.isEmpty) Text(KeptWords.none, Modifier.padding(top = 24.dp), color = Theme.secondaryInk, style = plain(13))
                for (task in list.tasks) {
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                task.heading,
                                Modifier.weight(1f).clickable(enabled = task.known, role = Role.Button) { nav.push("task:${task.id}") { TaskDetailView(task.id) } },
                                color = Theme.ink, style = plain(15, FontWeight.Medium), maxLines = 1, overflow = TextOverflow.Ellipsis,
                            )
                            Text(whenText(task.createdAt), color = Theme.secondaryInk, style = mono(11), maxLines = 1)
                            Text(
                                "Delete",
                                Modifier.clickable(role = Role.Button) { deleting = Removal(task.id, KeptWords.deleteTask(task.heading)) }.padding(vertical = 6.dp),
                                color = Theme.failed, style = mono(12),
                            )
                        }
                        TaskFilesSection(task.id, task.files, opener, titled = false)
                    }
                }
            } else if (problem != null) {
                Text(problem!!, Modifier.padding(top = 40.dp), color = Theme.secondaryInk, style = plain(13))
            } else {
                Box(Modifier.fillMaxWidth().padding(top = 40.dp), contentAlignment = Alignment.Center) { BrailleSpinner(color = Theme.secondaryInk) }
            }
        }
    }
}

/** What is asked about before it goes: one task's files, or with no id everyone's. */
private data class Removal(val taskId: String?, val message: String)

/** `11/09 14:32`, this year's; the year before it otherwise. */
private fun whenText(ms: Long): String {
    val date = Date(ms)
    val thisYear = Calendar.getInstance().get(Calendar.YEAR)
    val year = Calendar.getInstance().apply { time = date }.get(Calendar.YEAR)
    return SimpleDateFormat(if (year == thisYear) "MM/dd HH:mm" else "yyyy/MM/dd HH:mm", Locale.US).format(date)
}

/** The sample screen's two tasks (the iPhone's `AgentSwitchApp`, case `keptfiles`). */
private fun sampleKept(): KeptFiles {
    val now = System.currentTimeMillis()
    return KeptFiles(
        listOf(
            KeptFiles.TaskFiles("t3", "整理下载目录里的重复文件", now - 3_600_000, files = listOf(TaskFile("out/report.md", 4_096, true), TaskFile("out/dupes.txt", 1_024, true))),
            KeptFiles.TaskFiles("t1", "把这张截图里的表格转成 Excel", now - 2 * 86_400_000L, files = listOf(TaskFile("out/table.xlsx", 58_000, true), TaskFile("in/shot.png", 401_000, false))),
        ),
    )
}

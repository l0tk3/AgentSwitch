package com.agentswitch.android.terminals

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.design.BarWord
import com.agentswitch.android.design.NavBar
import com.agentswitch.android.design.SectionLabel
import com.agentswitch.android.design.SquareButton
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.code
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.android.rememberBack
import com.agentswitch.kit.api.SessionSummary
import com.agentswitch.kit.support.PathDisplay

/**
 * A session whose folder is gone — moved, renamed or deleted — goes on in a folder picked here (docs/terminal-v0.md §5,
 * 2026-10-03, user: 如果会话没了选择新目录继续): the folder line as in New (a prompt with a block caret), then the
 * folders the Mac offers (the same name elsewhere, the first put in the line; the nearest folder above the old one,
 * only offered: confirmed by mistake it would move the session into a folder too wide) and those used before. Paths go
 * back whole; `~` is only how they are shown. A picked folder that is missing too is said, and kept in the line to mend.
 * A sheet: present it with `LocalNav`.
 */
@Composable
fun MovedFolderSheet(gone: MovedFolder, resume: (String) -> Unit) {
    val model = LocalAppModel.current
    val back = rememberBack()
    var folder by remember { mutableStateOf("") }
    val seen = hashSetOf(gone.cwd)
    val choices = (gone.alike + listOfNotNull(gone.near) + model.terminals.recentFolders).filter { seen.add(it) }
    LaunchedEffect(Unit) { if (folder.isEmpty()) folder = gone.missing ?: gone.alike.firstOrNull() ?: "" }
    Column(Modifier.fillMaxSize().background(Theme.base).windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars))) {
        NavBar("Folder Gone", leading = { BarWord("Cancel", back) })
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(Theme.Space.l),
            verticalArrangement = Arrangement.spacedBy(Theme.Space.xl),
        ) {
            val missing = gone.missing?.let { "所选的 ${PathDisplay.short(it)} 也不存在。" } ?: ""
            Text(
                "「${gone.session.displayTitle}」原来在 ${PathDisplay.short(gone.cwd)}，该文件夹可能已被移动、改名或删除。${missing}请选择一个文件夹，会话将在那里继续。",
                color = Theme.secondaryInk, style = plain(15),
            )
            Column(verticalArrangement = Arrangement.spacedBy(Theme.Space.s)) {
                SectionLabel("Folder")
                FolderPrompt(folder, { folder = it }, mono(14), classic = false)
                for (f in choices) {
                    Text(
                        PathDisplay.short(f), Modifier.fillMaxWidth().clickable { folder = f },
                        color = if (folder == f) Theme.ink else Theme.secondaryInk, style = mono(12), maxLines = 1, overflow = TextOverflow.MiddleEllipsis,
                    )
                }
            }
            SquareButton("Resume", onClick = { back(); resume(folder.trim()) }, prominent = true, enabled = folder.trim().isNotEmpty())
        }
    }
}

/** A session to continue whose folder is gone, and what the Mac offers in its place. */
data class MovedFolder(
    val session: SessionSummary,
    /** The folder it ran in. */
    val cwd: String,
    /** Folders of the same name the Mac knows; the nearest folder above `cwd` still there. */
    val alike: List<String>,
    val near: String?,
    val fork: Boolean,
    val mode: String?,
    /** A folder picked before that is missing too. */
    val missing: String? = null,
) {
    val id: String get() = session.id

    /** The same, after `folder` was picked and is missing too. */
    fun picked(folder: String): MovedFolder = copy(missing = folder)
}

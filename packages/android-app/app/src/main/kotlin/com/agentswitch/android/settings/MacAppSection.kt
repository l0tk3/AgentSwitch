package com.agentswitch.android.settings

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.design.FormRow
import com.agentswitch.android.design.FormSection
import com.agentswitch.android.design.PixelBox
import com.agentswitch.android.design.PixelBoxEffect
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.kit.api.AppUpdateInfo
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * The Mac app, seen from the phone (assistant-v0 §5): a newer AgentSwitch.app waiting to be installed (installed only
 * on the user's go-ahead; the previous version comes back by itself if the new one does not start).
 */
@Composable
fun MacAppSection() {
    val model = LocalAppModel.current
    val scope = rememberCoroutineScope()
    var update by remember { mutableStateOf<AppUpdateInfo?>(null) }
    var confirming by remember { mutableStateOf(false) }
    var requested by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(model.api) {
        val api = model.api ?: return@LaunchedEffect
        update = try { api.appUpdate() } catch (e: CancellationException) { throw e } catch (_: Exception) { null }
    }
    PixelBoxEffect(confirming, { confirming = false }) {
        PixelBox(
            head = "安装新版本？", tone = PixelBox.Tone.Amber, message = "正在进行的任务将中断。",
            actions = listOf(PixelBox.Action("Install and Restart", PixelBox.Action.Role.Primary) {
                scope.launch {
                    val api = model.api ?: return@launch
                    try { api.installUpdate(); requested = true; error = null }
                    catch (e: CancellationException) { throw e }
                    catch (e: Exception) { error = e.message ?: e.javaClass.simpleName }
                }
            }),
        )
    }
    FormSection("Mac App", footer = "安装时正在进行的任务将中断；新版本无法启动时将自动恢复至上一版本。") {
        val staged = update?.staged
        if (staged != null && !requested) {
            FormRow(first = true, onClick = { confirming = true }) {
                Text("Install New Version", Modifier.weight(1f), color = Theme.ink, style = plain(16))
                Text(staged, color = Theme.secondaryInk, style = mono(13))
            }
        } else if (requested) {
            NoteRow("正在安装。Mac 上的 AgentSwitch 将重启，结果将显示在对话中。", first = true)
        } else {
            FormRow(first = true) {
                Text("Version", Modifier.weight(1f), color = Theme.ink, style = plain(16))
                Text(update?.running ?: "—", color = Theme.secondaryInk, style = mono(13))
            }
        }
        update?.last?.takeIf { !it.ok }?.let {
            NoteRow(if (it.reverted) "上次更新失败，已恢复至上一版本：${it.reason}" else "上次更新未安装：${it.reason}", color = Theme.waiting)
        }
        error?.let { NoteRow(it, color = Theme.failed) }
    }
}

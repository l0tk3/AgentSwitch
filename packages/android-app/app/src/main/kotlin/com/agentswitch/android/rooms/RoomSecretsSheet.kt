package com.agentswitch.android.rooms

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.LocalNav
import com.agentswitch.android.design.BarWord
import com.agentswitch.android.design.FormPage
import com.agentswitch.android.design.FormRow
import com.agentswitch.android.design.FormSection
import com.agentswitch.android.design.PixelBox
import com.agentswitch.android.design.PixelBoxEffect
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.code
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.kit.api.RoomSecret
import com.agentswitch.kit.api.deleteRoomSecret
import com.agentswitch.kit.api.roomSecrets
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * A room's secrets (the service's `rooms/secrets.ts`): ciphertexts the Mac's gate sealed — each one's name, its kind,
 * where and as whom, and its token cut short (a long press copies it whole). Here they are only seen and removed;
 * adding one needs the gate, on the Mac.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun RoomSecretsSheet(model: RoomPageModel) {
    val app = LocalAppModel.current
    val nav = LocalNav.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var secrets by remember { mutableStateOf(app.rooms.demoSecrets[model.id]) }
    var problem by remember { mutableStateOf<String?>(null) }
    var removing by remember { mutableStateOf<RoomSecret?>(null) }
    var busy by remember { mutableStateOf(false) }

    suspend fun load() {
        val api = app.api ?: return
        try {
            secrets = api.roomSecrets(model.id)
            problem = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            problem = e.message ?: e.javaClass.simpleName
        }
    }
    LaunchedEffect(app.api) { load() }

    FormPage("Secrets", leading = { BarWord("Done", { nav.pop() }, color = agentInk) }) {
        problem?.let { Text(it, Modifier.padding(horizontal = Theme.Space.l, vertical = Theme.Space.m), color = Theme.failed, style = plain(13)) }
        val list = secrets
        FormSection(footer = "在 Mac 上添加：密码由 Mac 的网关当场封成密文，明文不进房间。") {
            when {
                list == null -> FormRow(first = true) { Text(if (app.api == null) "未连接 Mac。" else "正在读取…", Modifier.weight(1f), color = Theme.secondaryInk, style = plain(15)) }
                list.isEmpty() -> FormRow(first = true) { Text("这个房间还没有密文。", Modifier.weight(1f), color = Theme.secondaryInk, style = plain(15)) }
                else -> list.forEachIndexed { i, s ->
                    FormRow(
                        Modifier.combinedClickable(
                            role = Role.Button,
                            onLongClickLabel = "Copy Token",
                            onLongClick = {
                                (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("token", s.token))
                                app.banner = "已复制 ${s.name} 的密文。"
                            },
                            onClick = {},
                        ),
                        first = i == 0,
                    ) {
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(s.name, color = Theme.ink, style = plain(16, FontWeight.Medium), maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(listOf(s.kindWord, s.details).filter { it.isNotEmpty() }.joinToString(" · "), color = Theme.secondaryInk, style = plain(13), maxLines = 2, overflow = TextOverflow.Ellipsis)
                            Text(s.shortToken(), color = Theme.inkDim, style = code(12), maxLines = 1)
                        }
                        Text(
                            "Delete",
                            Modifier.combinedClickable(enabled = !busy, role = Role.Button, onClick = { removing = s }).padding(start = 8.dp, top = 6.dp, bottom = 6.dp),
                            color = Theme.failed, style = mono(13),
                        )
                    }
                }
            }
        }
    }
    val doomed = removing
    PixelBoxEffect(doomed != null, { removing = null }) {
        PixelBox(
            head = "Delete", tone = PixelBox.Tone.Red,
            message = "从房间里删除「${doomed?.name ?: ""}」？成员之后不能再用这份密文；要再用得在 Mac 上重新添加。",
            actions = listOf(PixelBox.Action("Delete", PixelBox.Action.Role.Destructive) {
                val s = doomed ?: return@Action
                scope.launch {
                    busy = true
                    val done = model.run(app.api) { it.deleteRoomSecret(model.id, s.id) }
                    busy = false
                    if (done) { secrets = secrets?.filter { it.id != s.id }; load() } else problem = model.error
                }
            }),
        )
    }
}

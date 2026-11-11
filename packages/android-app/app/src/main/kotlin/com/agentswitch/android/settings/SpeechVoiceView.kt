package com.agentswitch.android.settings

import android.content.Intent
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.design.BarBack
import com.agentswitch.android.design.FormRow
import com.agentswitch.android.design.FormSection
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.android.platform.Speaker
import com.agentswitch.android.rememberBack
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.RowScope

/** Settings › Voice: the installed Mandarin voices with their quality, a sample of each, and where to get better ones. */
@Composable
fun SpeechVoiceView() {
    val model = LocalAppModel.current
    val speaker = model.dispatch.speaker
    val context = LocalContext.current
    // A voice downloaded meanwhile shows up.
    LaunchedEffect(Unit) { speaker.refreshVoices() }
    DisposableEffect(Unit) { onDispose { speaker.stop() } }
    val chosen = speaker.chosenVoice()?.name
    SettingsPage("Voice", leading = { BarBack(rememberBack(), "Settings") }) {
        FormSection(footer = "轻点声音以选择并试听。") {
            for ((i, voice) in speaker.installedVoices.withIndex()) {
                FormRow(first = i == 0, onClick = { speaker.chooseVoice(voice); speaker.sample(voice) }) {
                    Text(if (chosen == voice.name) "<x>" else "< >", color = if (chosen == voice.name) Theme.signal else Theme.inkDim, style = mono(14))
                    Text(voice.name, color = Theme.ink, style = plain(16), maxLines = 1, modifier = Modifier.weight(1f, fill = false))
                    Text(
                        Speaker.qualityLabel(voice), Modifier.border(1.dp, Theme.line, com.agentswitch.android.design.lookShape(4.dp)).padding(horizontal = 5.dp, vertical = 1.dp),
                        color = Theme.secondaryInk, style = mono(11),
                    )
                    Spacer(Modifier.weight(1f))
                    Text(
                        "Play", Modifier.clickable(role = Role.Button) { speaker.sample(voice) }.padding(6.dp).semantics { contentDescription = "试听 ${voice.name}" },
                        color = Theme.signal, style = mono(12),
                    )
                }
            }
        }
        FormSection("More Voices") {
            var first = true
            if (speaker.onlyCompact) { NoteRow("当前仅安装了基础声音，朗读效果较为生硬。", first = true, color = Theme.waiting); first = false }
            NoteRow("前往 系统设置 › 无障碍 › 文字转语音，或在所用语音引擎的语音数据中，下载标有「增强」或「高音质」的中文（中国大陆）声音。", first = first, color = Theme.ink)
            ActionRow("Open Text-to-Speech Settings") {
                try { context.startActivity(Intent("com.android.settings.TTS_SETTINGS").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (_: Exception) { }
            }
        }
    }
}

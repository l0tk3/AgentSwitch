package com.agentswitch.android.settings

import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.LocalSettings
import com.agentswitch.android.demo.DemoData
import com.agentswitch.android.demo.DemoSettingsRoute
import com.agentswitch.android.demo.LocalDemo
import com.agentswitch.android.demo.LocalDemoScreen
import com.agentswitch.android.design.FormRow
import com.agentswitch.android.design.FormSection
import com.agentswitch.android.design.PixelBox
import com.agentswitch.android.design.PixelBoxEffect
import com.agentswitch.android.design.PixelMarkView
import com.agentswitch.android.design.PixelSprite
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.android.dispatch.DeleteConfirmation
import com.agentswitch.android.dispatch.DeleteRequest
import com.agentswitch.android.platform.AppLock
import com.agentswitch.android.platform.rememberActivity
import com.agentswitch.android.terminals.LookSymbol
import com.agentswitch.android.terminals.LookSymbolIcon
import com.agentswitch.android.terminals.RecordTextSize
import com.agentswitch.kit.api.ApprovalPolicyInfo
import com.agentswitch.kit.api.approvalPolicy
import com.agentswitch.kit.connection.ConnectionPhase
import com.agentswitch.kit.connection.ConnectionState
import com.agentswitch.kit.design.InterfaceLook
import com.agentswitch.kit.design.PixelArt
import kotlinx.coroutines.CancellationException

/**
 * Everything behind the gear (app-v0 §5, docs/ui-v0.md): the Mac and its connection on top, then the executors' usage
 * (§4.2); the look (Appearance, docs/ui-v0.md §8); what every task reads (CONTEXT.md, ciphertexts); sounds and reading;
 * the proxies (Clash, the browser's, each profile's; docs/clash-v0.md §9); the Mac app's new version; the history (every
 * task; clear history deletes it all) and the models; the permission mode (changed on the Mac); the app lock; re-pairing.
 * Rows carry no icons (the usage rows' tiles are content, not row icons); footers are one sentence. Pull to refresh
 * re-reads the usage.
 */
@Composable
fun SettingsTab() {
    val model = LocalAppModel.current
    val settings = LocalSettings.current
    val dispatch = model.dispatch
    val open = rememberOpen()
    val lock = remember { AppLock.of(settings) }
    val activity = rememberActivity()
    val connected = model.connection is ConnectionState.Connected
    var policy by remember { mutableStateOf<ApprovalPolicyInfo?>(null) }
    var confirmForget by remember { mutableStateOf(false) }
    var clearing by remember { mutableStateOf<DeleteRequest?>(null) }
    var clearError by remember { mutableStateOf<String?>(null) }
    var cleared by remember { mutableStateOf(false) }
    val demo = LocalDemo.current
    val screen = LocalDemoScreen.current

    /** The permission mode, read-only here (control-v0 §1); a Mac without the route shows no row. */
    suspend fun loadPolicy() {
        val api = model.api
        if (api == null) { if (demo) policy = DemoData.policy; return }
        if (!connected) return
        policy = try { api.approvalPolicy() } catch (e: CancellationException) { throw e } catch (_: Exception) { null }
    }
    LaunchedEffect(connected, model.api) { dispatch.refreshQuota(); loadPolicy() }
    val proxyNav = com.agentswitch.android.LocalNav.current
    // The demo screens open straight onto the pages they are about.
    LaunchedEffect(Unit) {
        if (!demo) return@LaunchedEffect
        for (r in DemoData.settingsPath(screen)) when (r) {
            DemoSettingsRoute.Mac -> open(SettingsRoute.Mac)
            DemoSettingsRoute.Tasks -> open(SettingsRoute.Tasks)
            DemoSettingsRoute.Sessions -> open(SettingsRoute.Sessions)
            is DemoSettingsRoute.Session -> open(SettingsRoute.Session(r.summary))
            // The proxies' pages are opened the way their rows open them (ProxiesSection.kt).
            DemoSettingsRoute.Clash -> proxyNav.openClash()
            DemoSettingsRoute.ProxyBrowser -> proxyNav.openProxy(ProxyTarget.Browser)
            is DemoSettingsRoute.ProxyProfile -> proxyNav.openProxy(ProxyTarget.Profile(r.agent, r.profile))
            else -> Unit // the proxies' pages are theirs
        }
    }

    PixelBoxEffect(confirmForget, { confirmForget = false }) {
        PixelBox(
            head = "移除「${model.profile?.name ?: "Mac"}」？", tone = PixelBox.Tone.Red,
            message = if (model.macs.servers.size > 1) "将切换到其他已配对的 Mac。" else "之后需要重新扫码配对。",
            actions = listOf(PixelBox.Action("Remove", PixelBox.Action.Role.Destructive) { model.forget() }),
        )
    }
    DeleteConfirmation(clearing, { clearing = null }, { clearError = it }, { cleared = true })

    // The `proxies` sample screen is about a section far down the page: it opens scrolled to it (SettingsView.swift).
    val scroll = rememberScrollState()
    var proxiesTop by remember { mutableStateOf(0) }
    LaunchedEffect(proxiesTop) { if (demo && screen == "proxies" && proxiesTop > 0) scroll.scrollTo((proxiesTop - 600).coerceAtLeast(0)) }
    SettingsPage("Settings", tab = true, onRefresh = { dispatch.refreshQuota(force = true); loadPolicy() }, scroll = scroll) {
        val current = model.profile
        if (current != null) {
            val others = model.macs.servers.filter { it.fingerprint != current.fingerprint }
            FormSection(footer = if (model.macs.servers.size > 1) "同一时间只连接一台 Mac。" else null) {
                FormRow(first = true, onClick = { open(SettingsRoute.Mac) }) {
                    MacHeader(Modifier.weight(1f))
                    LookSymbolIcon(LookSymbol.ChevronRight, side = 13.dp, color = Theme.inkDim, bold = true)
                }
                for (mac in others) FormRow(onClick = { model.switchTo(mac.fingerprint) }) {
                    Text(mac.name, Modifier.weight(1f), color = Theme.ink, style = plain(16), maxLines = 1)
                    Text("Switch", color = Theme.secondaryInk, style = mono(13))
                }
                ActionRow("Add Mac") { model.addingMac = true }
            }
            dispatch.quota?.let { UsageSection(it) }
        }
        AppearanceSection()
        FormSection("Dispatch", footer = "环境说明记录站点、账号和偏好，供每个任务参考。") {
            NavRow("Context", first = true, enabled = connected) { open(SettingsRoute.Context) }
            NavRow("Ciphertexts", enabled = connected) { open(SettingsRoute.Ciphertexts) }
        }
        if (connected) Column(Modifier.onGloballyPositioned { proxiesTop = it.positionInParent().y.toInt() }) { ProxiesSection() }
        FeedbackSection(open)
        if (connected) MacAppSection()
        FormSection("Manage", footer = "Mac 上 Claude Code、Codex 和 OpenCode 的会话在 Terminals 中，可查看和继续。") {
            NavRow("History", first = true, enabled = connected) { open(SettingsRoute.Tasks) }
            NavRow("Models", enabled = connected) { open(SettingsRoute.Models) }
            ActionRow("Clear History", enabled = connected, color = Theme.failed) { cleared = false; clearing = DeleteRequest.History }
            clearError?.let { NoteRow(it, color = Theme.failed) }
            if (cleared) NoteRow("记录已清空。")
        }
        policy?.let { p ->
            FormSection(footer = p.policy.mode.explanation + "。在 Mac 上修改。") {
                FormRow(first = true) {
                    Text("Permissions", Modifier.weight(1f), color = Theme.ink, style = plain(16))
                    Text(p.policy.mode.label, color = Theme.secondaryInk, style = mono(13))
                }
            }
        }
        FormSection("Security", footer = "设备丢失时，可在 Mac 上移除此设备。") {
            ToggleRow("Unlock with ${lock.biometryName}", lock.enabled, first = true) { lock.setEnabled(it, activity) }
            lock.lastError?.let { NoteRow(it, color = Theme.failed) }
        }
        if (current != null) {
            FormSection(footer = "删除此手机与这台 Mac 的配对，已保存的密文不受影响。") {
                ActionRow("Remove This Mac", first = true, color = Theme.failed) { confirmForget = true }
            }
        }
        model.banner?.let { FormSection { FormRow(first = true, onClick = { model.banner = null }) { Text(it, color = Theme.failed, style = plain(14)) } } }
    }
}

/**
 * Appearance (docs/ui-v0.md §8, 2026-10-04): `Pixel`, the look of §7 and the default, or `Classic`, a standard app's.
 * Kept on this phone (the Mac keeps its own; the user: 设置各记各的) and in force at once: the root draws everything again
 * in the look chosen, this page staying open.
 */
@Composable
private fun AppearanceSection() {
    val settings = LocalSettings.current
    val looks = InterfaceLook.entries
    // The conversation's text (2026-10-08, user: 手机上没有调整字体大小的地方). Kept as the terminal page reads it.
    var step by remember { mutableIntStateOf(settings.float(RecordTextSize.key, 0f).toInt().coerceIn(RecordTextSize.steps)) }
    fun set(next: Int) { step = next.coerceIn(RecordTextSize.steps); settings.putFloat(RecordTextSize.key, step.toFloat()) }
    FormSection(
        "Appearance",
        footer = "只换外观：图标、字体、按钮和提示的写法。功能、位置和操作不变。Pixel 是像素与字符的样子；Classic 是常见应用的样子。Text Size 调整简略视图里对话文字的大小；终端里的字用两指捏合缩放。",
    ) {
        FormRow(first = true) {
            Segmented(looks.map { it.label }, looks.indexOf(settings.look), { settings.chooseLook(looks[it]) })
        }
        FormRow {
            Text("Text Size", Modifier.weight(1f), color = Theme.ink, style = plain(16))
            Text(if (step == 0) "Default" else if (step > 0) "+$step" else "$step", color = Theme.secondaryInk, style = plain(16))
            Stepper({ set(step - 1) }, { set(step + 1) }, step > RecordTextSize.steps.first, step < RecordTextSize.steps.last)
        }
    }
}

/** The paired Mac on top of Settings: its name and how it is reached right now, in the connection line's words. */
@Composable
private fun MacHeader(modifier: Modifier) {
    val model = LocalAppModel.current
    val phase = model.connectionPhase
    val color = when (phase) {
        is ConnectionPhase.Connected -> Theme.done
        ConnectionPhase.Connecting, ConnectionPhase.Reconnecting -> Theme.secondaryInk
        is ConnectionPhase.Failing, ConnectionPhase.Lost -> Theme.waiting
        ConnectionPhase.Unpaired, ConnectionPhase.CertificateChanged -> Theme.failed
    }
    Row(modifier.padding(vertical = Theme.Space.xs), horizontalArrangement = Arrangement.spacedBy(Theme.Space.m), verticalAlignment = Alignment.CenterVertically) {
        // The app's mark, with depth: lit while connected, dithered while not.
        PixelMarkView(if (model.connection.endpoint == null) PixelArt.MarkState.Off else PixelArt.MarkState.Idle, pixel = 3.dp)
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(model.profile?.name ?: "Mac", color = Theme.ink, style = plain(17, FontWeight.SemiBold), maxLines = 1)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                PixelSprite(PixelArt.square, pixel = 2.dp, color = color)
                Text(phase.text, color = Theme.secondaryInk, style = mono(12), maxLines = 1)
            }
        }
    }
}

/**
 * Alerts & Voice (assistant-v0 §3, §4): sounds, haptics, sounding with the silent switch on, reading replies aloud and
 * the reading voice. Where the iPhone has its Live Activity row: Follow in Background (FollowService), which is that
 * and what keeps notifications coming after the app left the screen.
 */
@Composable
private fun FeedbackSection(open: (SettingsRoute) -> Unit) {
    val model = LocalAppModel.current
    val feedback = model.dispatch.feedback
    val follower = model.follower
    FormSection("Alerts & Voice", footer = "Read Aloud 开启时自动朗读回复和任务通知；Follow in Background 在有任务或终端工作时让应用在后台保持连接，离开应用后仍能收到通知，这期间通知栏有一条常驻通知。") {
        ToggleRow("Sound", feedback.sound, first = true) { feedback.chooseSound(it) }
        ToggleRow("Haptics", feedback.haptics) { feedback.chooseHaptics(it) }
        ToggleRow("Sound in Silent Mode", feedback.audibleInSilent, enabled = feedback.sound) { feedback.chooseAudibleInSilent(it) }
        ToggleRow("Read Aloud", feedback.voiceMode) { feedback.chooseVoiceMode(it) }
        if (follower != null) ToggleRow("Follow in Background", follower.enabled) { follower.choose(it); model.dispatch.syncLive() }
        NavRow("Voice", monoValue = false) { open(SettingsRoute.Voice) }
    }
}

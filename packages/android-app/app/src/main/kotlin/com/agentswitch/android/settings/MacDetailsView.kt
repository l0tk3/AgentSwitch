package com.agentswitch.android.settings

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.demo.DemoData
import com.agentswitch.android.demo.LocalDemo
import com.agentswitch.android.demo.LocalDemoScroll
import com.agentswitch.android.design.BarBack
import com.agentswitch.android.design.BrailleSpinner
import com.agentswitch.android.design.FormRow
import com.agentswitch.android.design.FormSection
import com.agentswitch.android.design.LabeledRow
import com.agentswitch.android.design.PixelSprite
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.code
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.android.rememberBack
import com.agentswitch.android.terminals.LookSymbol
import com.agentswitch.android.terminals.LookSymbolIcon
import com.agentswitch.kit.api.WorkdirSetting
import com.agentswitch.kit.api.workdir
import com.agentswitch.kit.connection.ConnectionState
import com.agentswitch.kit.connection.ProbeOutcome
import com.agentswitch.kit.connection.ProbeReport
import com.agentswitch.kit.connection.Troubleshooting
import com.agentswitch.kit.design.PixelArt
import com.agentswitch.kit.pairing.ServerProfile
import com.agentswitch.kit.support.PathDisplay
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import java.text.DateFormat
import java.util.Date
import java.util.Locale

/**
 * Settings › Mac: the connection in use and how the last route choice went, what to check when it fails (排障, control-v0
 * §5), then the details a person rarely needs (fingerprint, addresses, key pair, the default work folder).
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun MacDetailsView(profile: ServerProfile) {
    val model = LocalAppModel.current
    val demo = LocalDemo.current
    val scrollTo = LocalDemoScroll.current == "route"
    var workdir by remember { mutableStateOf<WorkdirSetting?>(null) }
    val scroll = rememberScrollState()
    val lastCause = remember { BringIntoViewRequester() }

    // Read-only here (control-v0 §2); a Mac without the route shows nothing.
    LaunchedEffect(model.connection.endpoint, model.api) {
        val api = model.api
        if (api == null) { if (demo) workdir = DemoData.workdir; return@LaunchedEffect }
        if (model.connection.endpoint == null) return@LaunchedEffect
        workdir = try { api.workdir() } catch (e: CancellationException) { throw e } catch (_: Exception) { null }
    }
    // Debug builds with `--es uiDemoScroll route`: the page opens scrolled to the end of 常见原因, for screenshots.
    LaunchedEffect(scrollTo) { if (scrollTo) { delay(500); lastCause.bringIntoView() } }

    SettingsPage(profile.name, scroll = scroll, leading = { BarBack(rememberBack(), "Settings") }) {
        FormSection("Connection") {
            when (val c = model.connection) {
                is ConnectionState.Connected -> {
                    LabeledRow("Route", c.value.kind.title, first = true)
                    LabeledRow("Address", c.value.authority, monoValue = true)
                }
                ConnectionState.Idle, ConnectionState.Selecting -> FormRow(first = true) {
                    Text(model.connectionPhase.text, Modifier.weight(1f), color = Theme.ink, style = mono(13))
                    BrailleSpinner(color = Theme.secondaryInk)
                }
                ConnectionState.Unreachable -> NoteRow(model.connectionPhase.text, first = true, color = Theme.waiting)
                ConnectionState.Unauthorized -> NoteRow("配对已失效，请重新配对。", first = true, color = Theme.failed)
                is ConnectionState.PinMismatch -> FormRow(first = true) {
                    Column(verticalArrangement = Arrangement.spacedBy(Theme.Space.xs)) {
                        Text("服务器证书与配对时不一致，已拒绝连接", color = Theme.failed, style = plain(16))
                        c.seen?.let { Text(ServerProfile.grouped(it), color = Theme.secondaryInk, style = code(11)) }
                    }
                }
            }
            ActionRow("Choose Route Again") { model.reconnect() }
        }
        model.routeReport?.let { report ->
            FormSection("Last Route Choice", footer = "${DateFormat.getTimeInstance(DateFormat.MEDIUM).format(Date(report.at))} · 同时探测所有地址，按顺序选用第一个可用地址。") {
                for ((i, probe) in report.reports.withIndex()) FormRow(first = i == 0) { RouteProbeRow(probe, Modifier.weight(1f)) }
            }
        }
        TroubleshootingSection(profile, lastCause)
        FormSection("Mac") {
            LabeledRow("Name", profile.name, first = true)
            LabeledRow("Port", profile.port.toString(), monoValue = true)
            if (profile.lan.isNotEmpty()) LabeledRow("LAN", profile.lan.joinToString(", "), monoValue = true)
            if (profile.tailnet.isNotEmpty()) LabeledRow("Tailscale", profile.tailnet.joinToString(", "))
            LabeledRow("Keypair", profile.gate?.keypair ?: "—", monoValue = true)
            LabeledRow("This Device", model.me?.name ?: profile.deviceId)
            LabeledRow("Paired", DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT, Locale.getDefault()).format(Date(profile.pairedAt)))
        }
        workdir?.let { w ->
            FormSection(footer = "未指定目录的任务在此目录下各自新建子目录。在 Mac 上修改。") {
                FormRow(first = true) {
                    Text("Default Folder", color = Theme.ink, style = plain(16), maxLines = 1)
                    Text(PathDisplay.short(w.path), Modifier.weight(1f), color = Theme.secondaryInk, style = code(13), textAlign = TextAlign.End, maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
                }
                w.problem?.let { NoteRow(it, color = Theme.waiting) }
            }
        }
        FormSection("Certificate Fingerprint", footer = "与 Mac 上「配对」页显示的指纹一致，即为同一台 Mac。") {
            FormRow(first = true) { SelectionContainer { Text(ServerProfile.grouped(profile.fingerprint), color = Theme.ink, style = code(12)) } }
        }
    }
}

/**
 * Troubleshooting: each line of the last route choice as a check, then the usual reasons, most common first (open by
 * default while the Mac cannot be reached).
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun TroubleshootingSection(profile: ServerProfile, lastCause: BringIntoViewRequester) {
    val model = LocalAppModel.current
    /** null until the user opens or closes the reasons: until then they follow the connection. */
    val demoOpen = LocalDemoScroll.current == "route"
    var causesOpen by remember { mutableStateOf<Boolean?>(if (demoOpen) true else null) }
    val open = causesOpen ?: (model.connection.endpoint == null)
    FormSection("Troubleshooting", footer = "连接中断时会自动重试，无需停留在此页面。") {
        val checks = Troubleshooting.checks(model.connection, model.routeReport?.reports, profile)
        for ((i, check) in checks.withIndex()) {
            FormRow(first = i == 0) {
                Row(horizontalArrangement = Arrangement.spacedBy(Theme.Space.s), verticalAlignment = Alignment.Top) {
                    val color = when (check.ok) { true -> Theme.done; false -> Theme.failed; null -> Theme.inkDim }
                    PixelSprite(PixelArt.square, Modifier.padding(top = 6.dp), pixel = 1.5.dp, color = color)
                    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(check.title, color = Theme.ink, style = plain(15))
                        Text(check.detail, color = Theme.secondaryInk, style = plain(12))
                    }
                }
            }
        }
        FormRow(onClick = { causesOpen = !open }) {
            Text("常见原因", Modifier.weight(1f), color = Theme.ink, style = plain(16))
            LookSymbolIcon(if (open) LookSymbol.ChevronUp else LookSymbol.ChevronRight, side = 13.dp, color = Theme.inkDim, bold = true)
        }
        if (open) for ((index, cause) in Troubleshooting.causes.withIndex()) {
            FormRow(if (index == Troubleshooting.causes.lastIndex) Modifier.bringIntoViewRequester(lastCause) else Modifier) {
                Row(horizontalArrangement = Arrangement.spacedBy(Theme.Space.s), verticalAlignment = Alignment.Top) {
                    Text("${index + 1}.", color = Theme.secondaryInk, style = plain(15))
                    Text(cause, color = Theme.ink, style = plain(15))
                }
            }
        }
    }
}

/** One address of the last route choice: which line, where, and what came of it (answered, timed out, refused…). */
@Composable
fun RouteProbeRow(probe: ProbeReport, modifier: Modifier = Modifier) {
    val seconds = "%.1fs".format(probe.seconds)
    val outcome = probe.outcome
    val verdict = when (outcome) {
        ProbeOutcome.Ok -> "OK · $seconds"
        null -> "Unused"
        ProbeOutcome.Unauthorized -> "Unpaired"
        is ProbeOutcome.PinMismatch -> "Certificate Changed"
        is ProbeOutcome.Unreachable -> "No Response · $seconds"
    }
    val detail = when (outcome) {
        is ProbeOutcome.Unreachable -> outcome.reason
        null -> "已通过优先级更高的地址连接"
        else -> null
    }
    val color = when (outcome) { ProbeOutcome.Ok -> Theme.done; null -> Theme.secondaryInk; else -> Theme.failed }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Row {
            Text(probe.endpoint.kind.title, color = Theme.ink, style = plain(15))
            Spacer(Modifier.weight(1f))
            Text(verdict, color = color, style = plain(15))
        }
        Text(probe.endpoint.authority, color = Theme.secondaryInk, style = code(12))
        detail?.let { Text(it, color = Theme.secondaryInk, style = plain(12)) }
    }
}

package com.agentswitch.android.onboarding

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.LocalNav
import com.agentswitch.android.design.BarWord
import com.agentswitch.android.design.BrailleSpinner
import com.agentswitch.android.design.FormPage
import com.agentswitch.android.design.FormRow
import com.agentswitch.android.design.FormSection
import com.agentswitch.android.design.LabeledRow
import com.agentswitch.android.design.NavBar
import com.agentswitch.android.design.PlainField
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.code
import com.agentswitch.android.design.plain
import com.agentswitch.kit.pairing.PairingLink
import com.agentswitch.kit.pairing.PairingPayload
import com.agentswitch.kit.pairing.ServerProfile
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** Shows who the link says it is (Mac name, certificate fingerprint, addresses) before anything is sent, then pairs. */
@Composable
fun PairConfirmView(link: String) {
    val model = LocalAppModel.current
    val nav = LocalNav.current
    val parsed = remember(link) { runCatching { PairingLink.parse(link) } }
    var pairing by remember { mutableStateOf(false) }
    // Closed any way (Cancel, the back gesture): the link is no longer waiting.
    DisposableEffect(link) { onDispose { if (model.incomingPairingLink == link) model.incomingPairingLink = null } }
    val close = { if (!pairing) { nav.dismiss("pair"); nav.dismiss("addmac"); model.addingMac = false } }
    val payload = parsed.getOrNull()
    if (payload == null) {
        Column(Modifier.fillMaxSize()) {
            NavBar("Pair", leading = { BarWord("Cancel", close) })
            Box(Modifier.fillMaxSize().padding(32.dp), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("无法使用此链接", color = Theme.ink, style = plain(20, androidx.compose.ui.text.font.FontWeight.SemiBold))
                    Text(parsed.exceptionOrNull()?.message ?: "", color = Theme.secondaryInk, style = plain(15), textAlign = TextAlign.Center)
                }
            }
        }
        return
    }
    PairForm(payload, pairing, { pairing = it }, close)
}

@Composable
private fun PairForm(payload: PairingPayload, pairing: Boolean, setPairing: (Boolean) -> Unit, close: () -> Unit) {
    val model = LocalAppModel.current
    val scope = rememberCoroutineScope()
    var deviceName by remember { mutableStateOf(model.deviceName) }
    var error by remember { mutableStateOf<String?>(null) }
    FormPage("Pair", leading = { BarWord("Cancel", close, enabled = !pairing) }) {
        FormSection("Mac") {
            LabeledRow("Name", payload.name, first = true)
            FormRow {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("证书指纹（与 Mac 上显示的一致时再继续）", color = Theme.secondaryInk, style = plain(12))
                    SelectionContainer { Text(ServerProfile.grouped(payload.fp), color = Theme.ink, style = code(13)) }
                }
            }
            LabeledRow("Code", payload.code, monoValue = true)
        }
        FormSection("Addresses") {
            var first = true
            for (address in payload.lan) { LabeledRow("LAN", "$address:${payload.port}", first = first, monoValue = true); first = false }
            for (address in payload.tailnet) { LabeledRow("Tailscale", "$address:${payload.port}", first = first, monoValue = true); first = false }
            if (payload.bonjour.isNotEmpty()) LabeledRow("Bonjour", payload.bonjour, first = first)
        }
        FormSection("Gate Key") {
            val gate = payload.gate
            if (gate != null) LabeledRow("Keypair", gate.keypair, first = true, monoValue = true)
            else FormRow(first = true) { Text("二维码中无公钥，将在配对后向 Mac 获取", color = Theme.secondaryInk, style = plain(13)) }
        }
        val known = model.macs.server(payload.fp)
        FormSection(
            "This Device",
            footer = when {
                known != null -> "已与「${known.name}」配对，将更新此配对。"
                !model.macs.isEmpty -> "将添加这台 Mac 并切换到它，其他 Mac 的配对保留。"
                else -> null
            },
        ) {
            FormRow(first = true) { PlainField(deviceName, { deviceName = it }, Modifier.fillMaxWidth(), placeholder = "设备名称", enabled = !pairing) }
        }
        FormSection(footer = error) {
            FormRow(
                first = true,
                onClick = if (pairing) null else {
                    {
                        setPairing(true)
                        error = null
                        scope.launch {
                            try {
                                model.pair(payload, deviceName)
                                setPairing(false)
                                model.incomingPairingLink = null
                                close()
                            } catch (e: CancellationException) {
                                throw e
                            } catch (e: Exception) {
                                error = e.message ?: e.javaClass.simpleName
                                setPairing(false)
                            }
                        }
                    }
                },
            ) {
                Text(if (pairing) "配对中" else "配对", color = if (pairing) Theme.secondaryInk else Theme.signal, style = plain(16))
                if (pairing) { Spacer(Modifier.weight(1f)); BrailleSpinner(color = Theme.secondaryInk) }
            }
        }
    }
}

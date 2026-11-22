package com.agentswitch.android.onboarding

import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.Box
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.LocalNav
import com.agentswitch.android.design.PixelMarkView
import com.agentswitch.android.design.SquareButton
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.plain
import com.agentswitch.kit.design.PixelArt

/** What the clipboard holds as text, trimmed; "" when it holds none. */
fun pastedText(context: Context): String {
    val clipboard = context.getSystemService(ClipboardManager::class.java) ?: return ""
    val clip = try { clipboard.primaryClip } catch (_: Exception) { null } ?: return ""
    if (clip.itemCount == 0) return ""
    return clip.getItemAt(0).coerceToText(context)?.toString()?.trim() ?: ""
}

/** First run: scan the QR code the Mac app shows, or paste its link. One screen, one action (docs/ui-v0.md). */
@Composable
fun OnboardingView() {
    val model = LocalAppModel.current
    val nav = LocalNav.current
    val context = LocalContext.current
    Box(Modifier.fillMaxSize().background(Theme.base).windowInsetsPadding(WindowInsets.safeDrawing), contentAlignment = Alignment.Center) {
        Column(
            Modifier.widthIn(max = 480.dp).fillMaxSize().padding(horizontal = Theme.Space.xl).padding(bottom = Theme.Space.l),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.weight(1f))
            // The app's mark, with depth (an identity mark of 20 pt and up, §7.2.10).
            PixelMarkView(PixelArt.MarkState.Idle, pixel = 5.dp)
            Spacer(Modifier.padding(top = Theme.Space.xl))
            Text("连接你的 Mac", color = Theme.ink, style = plain(22, FontWeight.SemiBold))
            Text(
                "在 Mac 上打开 AgentSwitch，点按「配对」，然后用此手机扫描二维码。",
                Modifier.padding(top = Theme.Space.s), color = Theme.secondaryInk, style = plain(15), textAlign = TextAlign.Center,
            )
            Spacer(Modifier.weight(1f))
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Theme.Space.m), horizontalAlignment = Alignment.CenterHorizontally) {
                model.banner?.let { Text(it, color = Theme.failed, style = plain(13), textAlign = TextAlign.Center) }
                SquareButton("Scan QR Code", { nav.present("scan") { ScannerSheet(onCode = { code -> nav.dismiss("scan"); model.receivePairingLink(code) }) } }, prominent = true)
                Text(
                    "Paste Pairing Link",
                    Modifier.clickable(role = Role.Button) {
                        val text = pastedText(context)
                        if (text.isEmpty()) model.banner = "剪贴板中无配对链接" else model.receivePairingLink(text)
                    }.padding(vertical = 10.dp, horizontal = 16.dp),
                    color = Theme.ink, style = plain(17),
                )
                Text("手机与 Mac 需在同一局域网，或登录同一 Tailscale 网络。", color = Theme.inkDim, style = plain(13), textAlign = TextAlign.Center)
            }
        }
    }
}

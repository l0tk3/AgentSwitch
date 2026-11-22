package com.agentswitch.android.onboarding

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.plain

/**
 * Adding a Mac, or pairing again with one that no longer knows this phone (app-v0 §5 多台 Mac): the scanner, then the
 * same confirmation as the first pairing, in one sheet.
 */
@Composable
fun AddMacSheet() {
    val model = LocalAppModel.current
    val context = LocalContext.current
    var link by remember { mutableStateOf<String?>(null) }
    DisposableEffect(Unit) { onDispose { model.addingMac = false } }
    val current = link
    if (current != null) {
        PairConfirmView(current)
    } else {
        ScannerSheet(onCode = { link = it }) {
            Box(Modifier.fillMaxWidth().padding(bottom = Theme.Space.l), contentAlignment = Alignment.Center) {
                Text(
                    "Paste Pairing Link",
                    Modifier.clickable(role = Role.Button) {
                        val text = pastedText(context)
                        if (text.isEmpty()) model.banner = "剪贴板中无配对链接" else link = text
                    }.padding(vertical = 10.dp, horizontal = 16.dp),
                    color = Theme.ink, style = plain(17),
                )
            }
        }
    }
}

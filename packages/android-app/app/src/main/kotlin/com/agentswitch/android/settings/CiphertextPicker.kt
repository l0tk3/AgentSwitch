package com.agentswitch.android.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.design.BarWord
import com.agentswitch.android.design.FormRow
import com.agentswitch.android.design.FormSection
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.code
import com.agentswitch.android.design.plain
import com.agentswitch.android.rememberBack
import androidx.compose.ui.unit.dp

/**
 * Pick one saved ciphertext (for the input box, a question, or CONTEXT.md; `Fill Ciphertext` on a browser page). A sheet:
 * present it with `LocalNav.current.present(key) { CiphertextPicker { token -> … } }`; it closes itself after a pick.
 */
@Composable
fun CiphertextPicker(title: String = "Insert Ciphertext", onPick: (String) -> Unit) {
    val model = LocalAppModel.current
    val back = rememberBack()
    SettingsPage(title, leading = { BarWord("Cancel", back) }) {
        FormSection {
            for ((i, item) in model.dispatch.ciphertexts.withIndex()) {
                FormRow(first = i == 0, onClick = { onPick(item.token); back() }) {
                    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(item.note, color = Theme.ink, style = plain(16))
                        Text(item.shortToken, color = Theme.secondaryInk, style = code(12))
                    }
                }
            }
        }
    }
}

package com.agentswitch.android.settings

import com.agentswitch.android.design.BarWord
import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.clickable
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.design.BarBack
import com.agentswitch.android.design.FormRow
import com.agentswitch.android.design.FormSection
import com.agentswitch.android.design.LabeledRow
import com.agentswitch.android.design.PlainField
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.code
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.android.rememberBack
import com.agentswitch.android.GateKeyStatus
import com.agentswitch.kit.secrets.SecretDraft
import com.agentswitch.kit.secrets.SecretKind
import com.agentswitch.kit.secrets.SecretUse
import com.agentswitch.kit.storage.SavedCiphertext
import kotlinx.coroutines.launch

/**
 * Mint `enc:v1:` tokens on the phone with the Mac's gate public key (app-v0 §3). The plaintext value is held only in this
 * page's state and cleared as soon as the token exists; it is never logged or kept, and the saved list keeps ciphertext
 * and note only. Pushed from Settings.
 */
@Composable
fun CiphertextsView(sheet: Boolean = false) {
    val model = LocalAppModel.current
    val scope = rememberCoroutineScope()
    var draft by remember { mutableStateOf(SecretDraft()) }
    var minted by remember { mutableStateOf<SavedCiphertext?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    val context = LocalContext.current
    LaunchedEffect(model.api) { if (!model.canMint) model.refreshGateKey() }
    // Plaintext is gone when the page is.
    DisposableEffect(Unit) { onDispose { draft = draft.copy(value = "") } }

    // From Settings it is a page with its way back; from `New Ciphertext` (Dispatch, a browser page) a sheet with `Done`.
    val back = rememberBack()
    SettingsPage("Ciphertexts", leading = { if (sheet) BarWord("Done", back) else BarBack(back, "Settings") }) {
        // The key
        FormSection(footer = "密文在手机上生成，仅此 Mac 可解密，且仅用于所填站点。") {
            val gate = model.profile?.gate
            if (gate != null && model.canMint) {
                FormRow(first = true) { Text("Keypair", Modifier.weight(1f), color = Theme.ink, style = plain(16)); Text(gate.keypair, color = Theme.secondaryInk, style = mono(13)) }
            } else {
                val status = model.gateKeyStatus
                NoteRow(if (status is GateKeyStatus.Unavailable) "Mac 暂时无法读取公钥（${status.reason}），暂不可生成密文。" else "尚未取得公钥，暂不可生成密文。", first = true, color = Theme.ink)
                ActionRow("Fetch Key Again", enabled = model.api != null) { scope.launch { model.refreshGateKey() } }
            }
        }
        if (model.canMint) FormSection("New") {
            val typing = plain(16)
            FormRow(first = true) { PlainField(draft.label, { draft = draft.copy(label = it) }, Modifier.fillMaxWidth(), "名称，例如 corp-vpn/pass", keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false)) }
            FormRow { PlainField(draft.sites, { draft = draft.copy(sites = it) }, Modifier.fillMaxWidth(), "站点，例如 *.example.com；多个用逗号分隔", singleLine = false, keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = KeyboardType.Uri)) }
            FormRow {
                Text("类型", color = Theme.ink, style = typing)
                Segmented(SecretKind.entries.map { it.title }, SecretKind.entries.indexOf(draft.kind), { draft = draft.copy(kind = SecretKind.entries[it]) })
            }
            for (use in SecretUse.entries) ToggleRow(use.title, use in draft.uses) { on -> draft = draft.copy(uses = if (on) draft.uses + use else draft.uses - use) }
            FormRow {
                // A secret field: dotted, no suggestions, no autofill of what it holds.
                BasicTextField(
                    draft.value, { draft = draft.copy(value = it) }, Modifier.fillMaxWidth(), singleLine = true,
                    textStyle = typing.copy(color = Theme.ink), cursorBrush = SolidColor(Theme.signal),
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = KeyboardType.Password),
                    decorationBox = { inner ->
                        androidx.compose.foundation.layout.Box {
                            if (draft.value.isEmpty()) Text(if (draft.kind == SecretKind.Totp) "TOTP 密钥（base32）" else "密码 / token", color = Theme.inkDim, style = typing, maxLines = 1)
                            inner()
                        }
                    },
                )
            }
            FormRow { PlainField(draft.note, { draft = draft.copy(note = it) }, Modifier.fillMaxWidth(), "备注（可选，仅保存在手机上）") }
            val problem = draft.problem
            if (problem != null && (draft.value.isNotEmpty() || draft.label.isNotEmpty())) NoteRow(problem, color = Theme.waiting)
            error?.let { NoteRow(it, color = Theme.failed) }
            ActionRow("Make Ciphertext", enabled = problem == null, color = Theme.signal) {
                try {
                    minted = model.dispatch.mint(draft)
                    error = null
                    // Plaintext is gone the moment the token exists; label, sites and kind stay for the next one.
                    draft = draft.copy(value = "", note = "")
                } catch (e: Exception) {
                    draft = draft.copy(value = "")
                    error = e.message ?: e.javaClass.simpleName
                }
            }
        }
        minted?.let { item ->
            FormSection("Just Made") {
                FormRow(first = true) { SelectionContainer { Text(item.token, color = Theme.ink, style = code(12), maxLines = 3) } }
                Actions(item, context, model.dispatch::insertIntoCompose, null)
            }
        }
        FormSection("Saved") {
            val items = model.dispatch.ciphertexts
            if (items.isEmpty()) NoteRow("无已保存的密文", first = true)
            for ((i, item) in items.withIndex()) {
                FormRow(first = i == 0 && items.isNotEmpty()) {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(item.note, color = Theme.ink, style = plain(16))
                        Text(item.shortToken, color = Theme.secondaryInk, style = code(12))
                        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            WordButton("Copy") { copyToken(context, item.token) }
                            WordButton("Insert") { model.dispatch.insertIntoCompose(item.token) }
                            WordButton("Delete", Theme.failed) { model.dispatch.deleteCiphertexts(setOf(item.id)) }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun Actions(item: SavedCiphertext, context: Context, insert: (String) -> Unit, delete: (() -> Unit)?) {
    FormRow {
        WordButton("Copy") { copyToken(context, item.token) }
        Spacer(Modifier.weight(1f))
        WordButton("Insert") { insert(item.token) }
    }
}

@Composable
private fun WordButton(word: String, color: androidx.compose.ui.graphics.Color = Theme.signal, onClick: () -> Unit) {
    Text(word, Modifier.clickable(role = Role.Button, onClick = onClick).padding(end = 12.dp, top = 6.dp, bottom = 6.dp), color = color, style = mono(13))
}

private val handler = Handler(Looper.getMainLooper())

/**
 * A ciphertext to the clipboard, marked sensitive (Android 13 and later keep it out of the clipboard preview), and taken
 * off again after two minutes if the clipboard still holds it (the iPhone's `Clipboard.copyToken` expires it the same way).
 */
fun copyToken(context: Context, token: String) {
    val manager = context.applicationContext.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    val clip = ClipData.newPlainText("ciphertext", token)
    if (Build.VERSION.SDK_INT >= 33) clip.description.extras = PersistableBundle().apply { putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true) }
    manager.setPrimaryClip(clip)
    handler.postDelayed({
        try {
            val held = manager.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.text?.toString()
            if (held == token) manager.clearPrimaryClip()
        } catch (_: Exception) { /* the clipboard cannot be read from behind: it stays */ }
    }, 120_000)
}

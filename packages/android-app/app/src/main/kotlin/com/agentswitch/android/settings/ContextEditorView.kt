package com.agentswitch.android.settings

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.ui.semantics.Role
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.LocalNav
import com.agentswitch.android.components.ErrorText
import com.agentswitch.android.design.BarBack
import com.agentswitch.android.design.BarWord
import com.agentswitch.android.design.FormRow
import com.agentswitch.android.design.FormSection
import com.agentswitch.android.design.PixelBox
import com.agentswitch.android.design.PixelBoxEffect
import com.agentswitch.android.design.PlainField
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.code
import com.agentswitch.android.design.mono
import com.agentswitch.android.rememberBack
import com.agentswitch.kit.api.ContextSaveResult
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * CONTEXT.md on the Mac (router-v0 §2b): edited here, saved with `PUT /context`. The Mac seals the credentials in it like
 * a task's and lints it; the editor then shows what was actually stored, what was sealed and the warnings. Leaving with
 * unsaved edits asks first (the iPhone keeps the sheet from being swiped away).
 */
@Composable
fun ContextEditorView() {
    val model = LocalAppModel.current
    val nav = LocalNav.current
    val scope = rememberCoroutineScope()
    var text by remember { mutableStateOf("") }
    /** The text as last read from the Mac; null until the first load succeeds (no save before that). */
    var stored by remember { mutableStateOf<String?>(null) }
    var warnings by remember { mutableStateOf<List<String>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    var saved by remember { mutableStateOf<ContextSaveResult?>(null) }
    var menu by remember { mutableStateOf<Rect?>(null) }
    var bounds by remember { mutableStateOf(Rect.Zero) }
    var leaving by remember { mutableStateOf(false) }
    val dirty = stored != null && text != stored
    val back = rememberBack()

    suspend fun load() {
        val api = model.api ?: return
        try {
            val doc = api.context()
            text = doc.text; stored = doc.text; warnings = doc.warnings; error = null
        } catch (e: CancellationException) { throw e } catch (e: Exception) { model.handle(e); error = e.message ?: e.javaClass.simpleName }
    }
    LaunchedEffect(model.api) { if (stored == null) load() }

    val leave = { if (dirty) leaving = true else back() }
    BackHandler(enabled = dirty) { leaving = true }
    PixelBoxEffect(leaving, { leaving = false }) {
        PixelBox(head = "放弃修改？", tone = PixelBox.Tone.Amber, message = "未保存的修改将丢失。", actions = listOf(PixelBox.Action("Discard", PixelBox.Action.Role.Destructive) { back() }))
    }
    PixelBoxEffect(menu, { menu = null }) { at ->
        PixelBox(
            cancel = null, anchor = at, width = 200.dp,
            actions = buildList {
                if (model.dispatch.ciphertexts.isNotEmpty()) add(PixelBox.Action("Insert Ciphertext") {
                    nav.present("settings/context/pick") { CiphertextPicker { token -> text += (if (text.isEmpty() || text.endsWith(" ") || text.endsWith("\n")) "" else " ") + token } }
                })
                if (text.isEmpty()) add(PixelBox.Action("Load Example") {
                    scope.launch {
                        val api = model.api ?: return@launch
                        try { text = api.contextExample() } catch (e: CancellationException) { throw e } catch (e: Exception) { model.handle(e); error = e.message ?: e.javaClass.simpleName }
                    }
                })
                if (dirty) add(PixelBox.Action("Revert") { text = stored ?: "" })
            }.ifEmpty { listOf(PixelBox.Action("Nothing to Do") {}) },
        )
    }

    SettingsPage(
        "Context",
        leading = { BarBack(leave, "Settings") },
        trailing = {
            Text(
                "⋯", Modifier.onGloballyPositioned { bounds = it.boundsInRoot() }.clickable(role = Role.Button, onClickLabel = "More") { menu = bounds }.padding(horizontal = 12.dp, vertical = 4.dp),
                color = Theme.ink, style = mono(22),
            )
            BarWord(if (saving) "保存中" else "保存", {
                scope.launch {
                    val api = model.api ?: return@launch
                    saving = true
                    try {
                        val result = api.saveContext(text)
                        load() // what the Mac kept, after sealing and the lint
                        warnings = result.warnings
                        saved = result
                    } catch (e: CancellationException) { throw e } catch (e: Exception) { model.handle(e); error = e.message ?: e.javaClass.simpleName }
                    saving = false
                }
            }, enabled = !saving && dirty && stored != null)
        },
    ) {
        FormSection(footer = "记录站点、账号、环境和偏好。密码可直接填写，保存时由 Mac 加密。") {
            FormRow(first = true) {
                PlainField(
                    text, { text = it }, Modifier.fillMaxWidth().heightIn(min = 320.dp), style = code(14), singleLine = false,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
                )
            }
        }
        if (warnings.isNotEmpty()) FormSection("Save Notes") {
            for ((i, w) in warnings.withIndex()) NoteRow(w, first = i == 0, color = Theme.waiting)
        }
        error?.let { FormSection { FormRow(first = true) { ErrorText(it, { error = null }) } } }
        saved?.takeIf { !dirty }?.let { FormSection { NoteRow("✓ " + savedLine(it), first = true, color = Theme.done) } }
    }
}

fun savedLine(result: ContextSaveResult): String {
    val parts = mutableListOf("已保存")
    if (result.sealed.isNotEmpty()) parts.add("${result.sealed.size} 个凭据已加密（${result.sealed.joinToString("、") { it.field }}）")
    if (result.warnings.isNotEmpty()) parts.add("部分行已移除")
    return parts.joinToString("，")
}

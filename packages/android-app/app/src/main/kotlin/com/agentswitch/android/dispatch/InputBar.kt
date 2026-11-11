package com.agentswitch.android.dispatch

import com.agentswitch.android.settings.CiphertextsView
import com.agentswitch.android.settings.CiphertextPicker
import com.agentswitch.android.LocalNav
import android.Manifest
import android.content.ClipboardManager
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.components.ErrorText
import com.agentswitch.android.design.BrailleSpinner
import com.agentswitch.android.design.HairRule
import com.agentswitch.android.design.LocalLook
import com.agentswitch.android.design.PixelBox
import com.agentswitch.android.design.PixelBoxEffect
import com.agentswitch.android.design.SquareIconButton
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.code
import com.agentswitch.android.design.framed
import com.agentswitch.android.design.grounded
import com.agentswitch.android.design.mono
import com.agentswitch.android.terminals.LookGlyph
import com.agentswitch.android.terminals.LookSymbol
import com.agentswitch.android.terminals.PendingAttachment
import com.agentswitch.android.terminals.ReplyBox
import com.agentswitch.android.terminals.nameAndSize
import com.agentswitch.android.terminals.readPicture
import com.agentswitch.kit.feed.displayName
import com.agentswitch.kit.feed.ModelName
import com.agentswitch.kit.files.UploadFile
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import androidx.compose.ui.text.style.TextOverflow

private class InputMenu(val head: String?, val anchor: Rect, val actions: List<PixelBox.Action>)

/**
 * The input box, a band across the foot of the page (its own ground, a line above it). The `+` holds the extras:
 * attachments (camera, photos, files, a pasted image), a saved ciphertext, and pinning the next task to an executor
 * (a removable chip; the router chooses by default). The ciphertext rows are a menu of the saved ones; making a new
 * ciphertext waits for its page. The classic look's floating glass has no Android counterpart: the band is used.
 */
@Composable
fun InputBar(modifier: Modifier = Modifier) {
    val model = LocalAppModel.current
    val dispatch = model.dispatch
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val classic = LocalLook.current.isClassic
    val focusManager = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    var error by remember { mutableStateOf<String?>(null) }
    var menu by remember { mutableStateOf<InputMenu?>(null) }
    var plus by remember { mutableStateOf(Rect.Zero) }
    var field by remember { mutableStateOf(TextFieldValue(dispatch.composeText, TextRange(dispatch.composeText.length))) }
    // The box's text lives in the model (the message on its way hands it back, a ciphertext is put into it).
    LaunchedEffect(dispatch.composeText) {
        if (field.text != dispatch.composeText) field = TextFieldValue(dispatch.composeText, TextRange(dispatch.composeText.length))
    }

    fun hideKeyboard() { focusManager.clearFocus(); keyboard?.hide() }
    fun add(files: List<UploadFile>, prepare: Boolean) {
        if (files.isEmpty()) return
        scope.launch { dispatch.addAttachments(files, prepare)?.let { error = it } }
    }

    val takePicture = rememberLauncherForActivityResult(ActivityResultContracts.TakePicturePreview()) { bitmap: Bitmap? ->
        if (bitmap == null) return@rememberLauncherForActivityResult
        val out = java.io.ByteArrayOutputStream()
        if (bitmap.compress(Bitmap.CompressFormat.JPEG, 92, out)) add(listOf(UploadFile("photo.jpg", "image/jpeg", out.toByteArray())), true)
    }
    val askCamera = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) takePicture.launch(null) else error = "没有相机权限，无法拍照。"
    }
    val pickPhotos = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(PendingAttachment.maxCount)) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        scope.launch {
            val files = withContext(Dispatchers.IO) { uris.mapIndexedNotNull { i, uri -> readPicture(context, uri, "photo-${i + 1}") } }
            add(files, true)
        }
    }
    val pickFiles = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        scope.launch {
            val (files, skipped) = withContext(Dispatchers.IO) { readFiles(context, uris) }
            if (skipped.isNotEmpty()) error = "未添加：${skipped.joinToString("、")}（超过 50 MB 或无法读取）"
            add(files, false)
        }
    }

    val nav = LocalNav.current
    fun openMenu() {
        val rows = ArrayList<PixelBox.Action>()
        if (context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)) rows += PixelBox.Action("Camera") {
            hideKeyboard()
            if (context.checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) takePicture.launch(null)
            else askCamera.launch(Manifest.permission.CAMERA)
        }
        rows += PixelBox.Action("Photos") { hideKeyboard(); pickPhotos.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }
        rows += PixelBox.Action("Files") { hideKeyboard(); pickFiles.launch(arrayOf("*/*")) }
        rows += PixelBox.Action("Paste Image") {
            val images = pastedImages(context)
            if (images.isEmpty()) error = "剪贴板中无图片" else add(images, true)
        }
        // (The iPhone shows `Insert Ciphertext` greyed while there is none; a box's row is either there or not.)
        if (dispatch.ciphertexts.isNotEmpty()) rows += PixelBox.Action("Insert Ciphertext") {
            hideKeyboard(); nav.present("pickCiphertext") { CiphertextPicker { token -> dispatch.insertIntoCompose(token) } }
        }
        rows += PixelBox.Action("New Ciphertext") { hideKeyboard(); nav.present("makeCiphertext") { CiphertextsView(sheet = true) } }
        rows += PixelBox.Action("Pin Model") {
            val options = dispatch.targets?.pinOptions ?: emptyList()
            menu = InputMenu("Pin Model", plus, listOf(PixelBox.Action("Auto") { dispatch.pin = null }) + options.map { ref -> PixelBox.Action(ref.displayName) { dispatch.pin = ref } })
        }
        menu = InputMenu(null, plus, rows)
    }
    PixelBoxEffect(menu, { menu = null }) { m -> PixelBox(head = m.head, cancel = null, actions = m.actions, anchor = m.anchor, width = 240.dp) }

    val hasContent = field.text.trim().isNotEmpty() || dispatch.attachments.isNotEmpty()
    val canSend = model.api != null && !dispatch.sending && dispatch.outgoing == null && dispatch.preparingAttachments == 0 && hasContent
    fun send() { scope.launch { error = dispatch.send() } }

    Column(modifier.fillMaxWidth().background(Theme.base)) {
        HairRule()
        Column(Modifier.fillMaxWidth().padding(horizontal = Theme.Space.l).padding(top = Theme.Space.s, bottom = Theme.Space.s), verticalArrangement = Arrangement.spacedBy(Theme.Space.s)) {
            dispatch.pin?.let { pin ->
                Row(
                    Modifier.framed(Theme.signal, Theme.Radius.control).padding(horizontal = 8.dp, vertical = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("Pin → ${ModelName.display(pin.model)}", color = Theme.signal, style = mono(12, FontWeight.Medium), maxLines = 1)
                    Box(Modifier.clickable(role = Role.Button, onClickLabel = "恢复自动选择") { dispatch.pin = null }.padding(horizontal = 2.dp)) {
                        Text("×", color = Theme.signal, style = mono(14))
                    }
                }
            }
            AttachmentStrip()
            ErrorText(error, { error = null })
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(Theme.Space.s)) {
                Box(
                    Modifier.onGloballyPositioned { plus = it.boundsInRoot() }
                        .then(if (classic) Modifier.size(width = 34.dp, height = 38.dp) else Modifier.size(38.dp).border(1.dp, Theme.line, RectangleShape))
                        .clickable(role = Role.Button, onClickLabel = "more") { openMenu() },
                    contentAlignment = Alignment.Center,
                ) {
                    if (classic) PlusCircle(Theme.secondaryInk) else Text("+", color = Theme.secondaryInk, style = code(20))
                }
                // A framed line; a round field on its own ground in the classic look.
                Box(
                    Modifier.weight(1f).grounded(if (classic) Theme.panel else Color.Transparent, Theme.Radius.bubble)
                        .framed(Theme.line, Theme.Radius.bubble).padding(horizontal = if (classic) 14.dp else 12.dp, vertical = 9.dp),
                ) {
                    ReplyBox(
                        value = field, onValueChange = { field = it; dispatch.composeText = it.text }, prompt = "输入任务或问题", maxLines = 6,
                        modifier = Modifier.fillMaxWidth(), onImages = { files -> add(files, true) },
                    )
                }
                // Square; ink once there is something to send (the primary button, §7.2.3), pink while pressed. A disc with an arrow in the classic look.
                SquareIconButton({ if (canSend) send() }, "send", active = canSend || dispatch.sending) { color ->
                    if (dispatch.sending) BrailleSpinner(color = Theme.base)
                    else if (classic) ArrowUp(color) else Text("↑", color = color, style = code(18, FontWeight.Bold))
                }
            }
        }
    }
}

@Composable
private fun PlusCircle(color: Color) {
    Canvas(Modifier.size(26.dp)) {
        val s = size.width
        drawCircle(color, s * 0.48f, style = Stroke(1.5f * density))
        drawLine(color, Offset(s * 0.28f, s * 0.5f), Offset(s * 0.72f, s * 0.5f), 1.5f * density)
        drawLine(color, Offset(s * 0.5f, s * 0.28f), Offset(s * 0.5f, s * 0.72f), 1.5f * density)
    }
}

@Composable
private fun ArrowUp(color: Color) {
    Canvas(Modifier.size(16.dp)) {
        val s = size.width
        val w = 2.2f * density
        drawLine(color, Offset(s * 0.5f, s * 0.9f), Offset(s * 0.5f, s * 0.12f), w)
        drawLine(color, Offset(s * 0.16f, s * 0.46f), Offset(s * 0.5f, s * 0.12f), w)
        drawLine(color, Offset(s * 0.84f, s * 0.46f), Offset(s * 0.5f, s * 0.12f), w)
    }
}

/** Files picked in the system's picker: read whole; one over the limit is not read at all (its name is given back). */
private fun readFiles(context: Context, uris: List<Uri>): Pair<List<UploadFile>, List<String>> {
    val files = ArrayList<UploadFile>()
    val skipped = ArrayList<String>()
    for (uri in uris) {
        val (name, size) = nameAndSize(context, uri)
        val label = name ?: uri.lastPathSegment ?: "file"
        if (size > PendingAttachment.maxFileBytes) { skipped.add(label); continue }
        val data = try { context.contentResolver.openInputStream(uri)?.use { it.readBytes() } } catch (_: Exception) { null }
        if (data == null || data.size > PendingAttachment.maxFileBytes) { skipped.add(label); continue }
        files.add(UploadFile(label, context.contentResolver.getType(uri) ?: "application/octet-stream", data))
    }
    return files to skipped
}

/** Images on the clipboard, as the files they are sent as (the `+` menu's `Paste Image`; a keyboard's own offer goes through `ReplyBox`). */
private fun pastedImages(context: Context): List<UploadFile> {
    val clip = (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).primaryClip ?: return emptyList()
    val uris = (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }.filter { context.contentResolver.getType(it)?.startsWith("image/") == true }
    return uris.mapIndexedNotNull { i, uri -> readPicture(context, uri, if (uris.size == 1) "pasted" else "pasted-${i + 1}") }
}

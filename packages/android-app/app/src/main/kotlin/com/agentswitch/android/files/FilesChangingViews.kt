package com.agentswitch.android.files

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.FileProvider
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.design.ClassicBar
import com.agentswitch.android.design.HairRule
import com.agentswitch.android.design.LocalLook
import com.agentswitch.android.design.PixelBox
import com.agentswitch.android.design.PixelBoxEffect
import com.agentswitch.android.design.SquareButton
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.floatingShadow
import com.agentswitch.android.design.framed
import com.agentswitch.android.design.grounded
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.kit.api.FileSize
import com.agentswitch.kit.api.UploadConflict
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.util.UUID

// The view half of Files/FilesChanging.swift (the logic is FilesChanging.kt and FilesStore): the questions on screen,
// the upload queue's rows, the pickers that bring files in, and the share sheet / `Save` that take them out.
//
// What differs from the iPhone: the iPhone's alerts and confirmation dialogs are pixel boxes here (the look's own
// questions, as the rest of the app asks them); the name alert's text field needs the keyboard, which a box over the
// page cannot take, so that one alone is a small framed box of its own in a `Dialog`. The share sheet is the system's
// (`ACTION_SEND`); `Save` is `ACTION_CREATE_DOCUMENT`.

/** What a fetched copy is for once it is here: shown to the share sheet, or saved where the person picks. */
@Stable
class ShareMode {
    var save by mutableStateOf(false)
}

/** Holds the copies the share sheet reads until the app is started again (the system's share targets read them later). */
object ShareCache {
    private var cleared = false

    /** At the first look in a process: what an earlier run left in `uploads/` (nothing is on its way then) is let go. */
    fun clearOnce(context: Context) {
        if (cleared) return
        cleared = true
        File(context.cacheDir, "uploads").deleteRecursively()
    }
}

fun mimeOf(file: File): String = MimeTypeMap.getSingleton().getMimeTypeFromExtension(file.extension.lowercase()) ?: "application/octet-stream"

fun uriOf(context: Context, file: File): Uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)

/** The system's share sheet for files on this phone. */
fun shareIntent(context: Context, files: List<File>): Intent {
    val uris = files.map { uriOf(context, it) }
    val send = if (uris.size == 1) {
        Intent(Intent.ACTION_SEND).apply { type = mimeOf(files[0]); putExtra(Intent.EXTRA_STREAM, uris[0]) }
    } else {
        Intent(Intent.ACTION_SEND_MULTIPLE).apply { type = "*/*"; putParcelableArrayListExtra(Intent.EXTRA_STREAM, ArrayList(uris)) }
    }
    send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    val clip = ClipData.newRawUri("", uris[0])
    for (u in uris.drop(1)) clip.addItem(ClipData.Item(u))
    send.clipData = clip
    return Intent.createChooser(send, null).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
}

/** Opens a file on this phone in whatever app can; false when none can. */
fun viewFile(context: Context, file: File): Boolean {
    val view = Intent(Intent.ACTION_VIEW).setDataAndType(uriOf(context, file), mimeOf(file)).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    return try { context.startActivity(view); true } catch (_: ActivityNotFoundException) { false }
}

// MARK: - the pickers

/** ⋯ › Upload's three sources: the camera, the photo picker, the system's file picker. */
class UploadPickers(val hasCamera: Boolean, val takePhoto: () -> Unit, val pickPhotos: () -> Unit, val pickFiles: () -> Unit)

/**
 * The launchers for what ⋯ › Upload brings in; `onFiles` is given the copies on this phone (a folder of their own each,
 * the name kept). Photos and videos as the files they are, named as the system gives them.
 */
@Composable
fun rememberUploadPickers(onFiles: (List<File>) -> Unit): UploadPickers {
    val context = LocalContext.current
    val model = LocalAppModel.current
    val scope = rememberCoroutineScope()
    val deliver = androidx.compose.runtime.rememberUpdatedState(onFiles)

    fun copies(uris: List<Uri>) {
        if (uris.isEmpty()) return
        scope.launch {
            val files = withContext(Dispatchers.IO) {
                uris.mapNotNull { uri ->
                    val name = displayName(context, uri) ?: "file"
                    model.files.copy(name) { context.contentResolver.openInputStream(uri) }
                }
            }
            if (files.isNotEmpty()) deliver.value(files)
        }
    }

    val takePicture = rememberLauncherForActivityResult(ActivityResultContracts.TakePicturePreview()) { bitmap: Bitmap? ->
        if (bitmap == null) return@rememberLauncherForActivityResult
        scope.launch {
            val file = withContext(Dispatchers.IO) {
                val out = java.io.ByteArrayOutputStream()
                if (bitmap.compress(Bitmap.CompressFormat.JPEG, 92, out)) model.files.cameraFile(out.toByteArray()) else null
            }
            if (file != null) deliver.value(listOf(file))
        }
    }
    val askCamera = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted -> if (granted) takePicture.launch(null) }
    val photos = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(20)) { copies(it) }
    val files = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { copies(it) }
    return UploadPickers(
        hasCamera = context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY),
        takePhoto = {
            if (context.checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) takePicture.launch(null)
            else askCamera.launch(Manifest.permission.CAMERA)
        },
        pickPhotos = { photos.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo)) },
        pickFiles = { files.launch(arrayOf("*/*")) },
    )
}

private fun displayName(context: Context, uri: Uri): String? = try {
    context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
        if (c.moveToFirst()) c.getString(0) else null
    }
} catch (_: Exception) { null } ?: uri.lastPathSegment?.substringAfterLast('/')

// MARK: - an upload's row

/**
 * A file on its way: on top of its folder's list, how far it has gone, `×` to stop it; a failed one says why and has
 * `Retry` (files-v0 §12.8).
 */
@Composable
fun UploadRow(upload: FilesStore.Upload, stop: () -> Unit, retry: () -> Unit) {
    val classic = LocalLook.current.isClassic
    val failed = upload.state is FilesStore.Upload.State.Failed
    val said = when (val s = upload.state) {
        FilesStore.Upload.State.Waiting, FilesStore.Upload.State.Asking -> "Waiting"
        FilesStore.Upload.State.Sending -> "Uploading ${(upload.progress * 100).toInt()}%"
        is FilesStore.Upload.State.Failed -> s.why
    }
    Row(
        Modifier.fillMaxWidth().padding(vertical = if (classic) 9.dp else 6.dp, horizontal = Theme.Space.l),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(if (classic) 12.dp else 0.dp),
    ) {
        if (classic) Box(Modifier.width(30.dp), contentAlignment = Alignment.Center) { FileGlyph(FileKinds.of(upload.name), Theme.secondaryInk) }
        else Text("├─ ", color = Theme.inkDim, style = com.agentswitch.android.design.code(13))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(
                upload.name, color = Theme.ink, maxLines = 1, overflow = TextOverflow.MiddleEllipsis,
                style = if (classic) plain(16) else com.agentswitch.android.design.code(13).copy(fontSize = 13.5.sp),
            )
            if (classic) {
                Text("$said · ${FileSize.short(upload.size)}", color = if (failed) Theme.failed else Theme.secondaryInk, style = plain(12), maxLines = 2)
                if (!failed) ClassicBar(upload.progress, color = Theme.signal, width = 200.dp)
            } else {
                val cells = 10
                val on = (upload.progress * cells).let { Math.round(it).toInt() }.coerceIn(0, cells)
                val line = if (failed) said else "[${"█".repeat(on)}${"░".repeat(cells - on)}] " + (if (upload.state == FilesStore.Upload.State.Sending) "${(upload.progress * 100).toInt()}%" else said)
                Text(line, color = if (failed) Theme.failed else Theme.secondaryInk, style = mono(11), maxLines = 2)
            }
        }
        if (failed) {
            Text("Retry", Modifier.clickable(role = Role.Button, onClick = retry).padding(horizontal = 6.dp, vertical = 8.dp), color = Theme.signal, style = if (classic) plain(15) else mono(12))
            Spacer(Modifier.width(4.dp))
        }
        Box(Modifier.heightIn(min = 30.dp).width(30.dp).clickable(role = Role.Button, onClickLabel = "Stop", onClick = stop), contentAlignment = Alignment.Center) {
            Text("×", color = Theme.secondaryInk, style = if (classic) plain(20) else mono(16))
        }
    }
    HairRule(Modifier.padding(start = if (classic) 58.dp else 0.dp))
}

// MARK: - the questions

/**
 * Every question of one session on screen (FilesSession): the name alert (a framed box of its own: its field needs the
 * keyboard), the pixel boxes for the Trash, names taken, a rename of a folder a terminal runs in, what the Mac
 * refused, and the question before a file that may hold a password lands; the download bar over a share, and the
 * system's share sheet / `Save` once what is shared is here.
 */
@Composable
fun FileQuestions(session: FilesSession, mode: ShareMode, modifier: Modifier = Modifier) {
    val model = LocalAppModel.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val q = remember(session, model) { FileChangeQuestions(model, session) }

    // The name.
    val naming = session.naming
    if (naming != null && naming.error == null) NameDialog(naming, q)
    PixelBoxEffect(naming?.takeIf { it.error != null }, { q.clearNamingError() }) {
        PixelBox(head = it.title, tone = PixelBox.Tone.Amber, message = it.error ?: "", cancel = "OK", actions = emptyList())
    }

    // The Trash (what is shown is what the session held as the box opened; the buttons act on that).
    PixelBoxEffect(session.trashing, { q.cancelTrashing() }) { t ->
        PixelBox(
            head = q.trashButton(t), tone = PixelBox.Tone.Red, message = q.trashTitle + "\n" + q.trashMessage(t),
            actions = listOf(PixelBox.Action(q.trashButton(t), PixelBox.Action.Role.Destructive) { scope.launch { q.trash(t) } }),
        )
    }

    // Names taken by an upload: a tap outside or `Stop` lets them go; the answers are given before that is known, so
    // the answer is marked and the let-go waits one turn.
    val answered = remember { HashSet<String>() }
    PixelBoxEffect(session.clashing, {
        val c = session.clashing
        session.clashing = null
        if (c != null) scope.launch { if (answered.remove(c.id).not()) model.files.answer(c.uploads, null) { model.fileSource } }
    }) { c ->
        val title = q.clashTitle
        fun reply(conflict: UploadConflict) { answered.add(c.id); model.files.answer(c.uploads, conflict) { model.fileSource } }
        PixelBox(
            message = title + "\n" + q.clashMessage, cancel = "Stop",
            actions = listOf(PixelBox.Action("Keep Both") { reply(UploadConflict.Keep) }, PixelBox.Action("Replace", PixelBox.Action.Role.Primary) { reply(UploadConflict.Replace) }),
        )
    }

    // A folder a terminal runs in, to be renamed.
    PixelBoxEffect(session.renameAsk, { q.cancelRenameAsk() }) { r ->
        PixelBox(
            head = "Rename", tone = PixelBox.Tone.Red, message = q.renameTitle + "\n" + q.renameMessage,
            actions = listOf(PixelBox.Action("Rename", PixelBox.Action.Role.Destructive) { scope.launch { q.rename(r) } }),
        )
    }

    // What the Mac refused.
    PixelBoxEffect(session.refused, { session.refused = null }) { PixelBox(head = "Error", tone = PixelBox.Tone.Red, message = it, cancel = "OK", actions = emptyList()) }

    // Before a file that may hold a password lands: `Cancel` lets the others land, `Add` all of them.
    PixelBoxEffect(session.asking, { session.asking = null }) { ask ->
        PixelBox(
            head = com.agentswitch.kit.api.SensitiveWarning.title, tone = PixelBox.Tone.Amber, message = com.agentswitch.kit.api.SensitiveWarning.message(ask.names),
            cancel = null,
            actions = listOf(
                PixelBox.Action("Cancel") { val rest = ask.picks.filter { !it.sensitive }; if (rest.isNotEmpty()) ask.then(rest) },
                PixelBox.Action("Add", PixelBox.Action.Role.Primary) { ask.then(ask.picks) },
            ),
        )
    }

    // The download bar, then the share sheet or the save.
    val sharing = session.sharing
    val save = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("*/*")) { uri ->
        val files = session.sharing?.files
        if (uri != null && files != null) scope.launch {
            withContext(Dispatchers.IO) {
                try {
                    context.contentResolver.openOutputStream(uri)?.use { out -> files.first().inputStream().use { it.copyTo(out) } }
                } catch (_: Exception) { }
            }
        }
        mode.save = false
        session.sharing = null
    }
    LaunchedEffect(sharing?.id, sharing?.files) {
        val files = sharing?.files ?: return@LaunchedEffect
        if (files.isEmpty()) { session.sharing = null; return@LaunchedEffect }
        if (mode.save) {
            save.launch(files.first().name)
        } else {
            // The copies stay in the cache for the app that reads them; they are let go when the app starts next.
            try { context.startActivity(shareIntent(context, files)) } catch (_: ActivityNotFoundException) { session.refused = "手机上没有可用于分享的应用。" }
            session.sharing = null
        }
    }
    if (sharing != null && sharing.files == null) {
        Box(modifier.fillMaxWidth(), contentAlignment = Alignment.BottomCenter) { FetchingBar(sharing, onOk = { session.sharing = null; mode.save = false }) }
    }
}

/** The bar over the page while what is to be shared comes from the Mac (`fetching`). */
@Composable
private fun FetchingBar(s: FilesSession.Sharing, onOk: () -> Unit) {
    val classic = LocalLook.current.isClassic
    Column(
        Modifier.padding(Theme.Space.l).padding(bottom = 60.dp).fillMaxWidth()
            .grounded(Theme.raised, 12.dp).framed(if (classic) Theme.raised else Theme.line, 12.dp).padding(Theme.Space.m),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (s.failed != null) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(s.failed, Modifier.weight(1f), color = Theme.failed, style = plain(13))
                Text("OK", Modifier.clickable(role = Role.Button, onClick = onOk).padding(8.dp), color = Theme.signal, style = plain(13))
            }
        } else {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Downloading ${(s.progress * 100).toInt()}%", Modifier.weight(1f), color = Theme.secondaryInk, style = mono(11))
                Text("Cancel", Modifier.clickable(role = Role.Button, onClick = onOk).padding(8.dp), color = Theme.signal, style = plain(13))
            }
            if (classic) ClassicBar(s.progress, color = Theme.signal, width = 280.dp) else com.agentswitch.android.design.CharMeter(s.progress, cells = 20)
        }
    }
}

/**
 * The name alert: a title, one field, `Cancel` and `Create` / `Rename` (disabled while the field is empty). A `Dialog`,
 * since its field needs the keyboard; framed in the look. The whole of a name being changed is selected, as the alert's
 * field has it.
 */
@Composable
private fun NameDialog(naming: FilesSession.Naming, q: FileChangeQuestions) {
    val classic = LocalLook.current.isClassic
    val shape = if (classic) RoundedCornerShape(16.dp) else RectangleShape
    var field by remember(naming.id) { mutableStateOf(TextFieldValue(naming.value, TextRange(0, naming.value.length))) }
    val focus = remember { FocusRequester() }
    LaunchedEffect(naming.id) { focus.requestFocus() }
    val scope = rememberCoroutineScope()
    Dialog(onDismissRequest = { q.cancelNaming() }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Column(
            Modifier.padding(horizontal = 28.dp).fillMaxWidth()
                .then(if (classic) Modifier.floatingShadow(shape) else Modifier)
                .background(if (classic) Theme.panel else Theme.base, shape)
                .then(if (classic) Modifier else Modifier.border(1.dp, Theme.ink, shape)),
        ) {
            if (classic) {
                Text(naming.title, Modifier.padding(start = 18.dp, end = 18.dp, top = 18.dp), color = Theme.ink, style = plain(17, FontWeight.SemiBold))
            } else {
                Text(naming.title, Modifier.fillMaxWidth().background(Theme.raised).padding(horizontal = 10.dp, vertical = 6.dp), color = Theme.ink, style = mono(12))
            }
            Box(
                Modifier.padding(horizontal = if (classic) 18.dp else 12.dp, vertical = 14.dp).fillMaxWidth()
                    .framed(Theme.line, 8.dp).padding(horizontal = 10.dp, vertical = 9.dp),
            ) {
                if (field.text.isEmpty()) Text("名称", color = Theme.inkDim, style = plain(16), maxLines = 1)
                BasicTextField(
                    value = field,
                    onValueChange = { field = it; q.setNamingValue(it.text) },
                    modifier = Modifier.fillMaxWidth().focusRequester(focus),
                    singleLine = true,
                    textStyle = plain(16).copy(color = Theme.ink),
                    cursorBrush = SolidColor(Theme.signal),
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { if (!q.namingEmpty) scope.launch { q.commitName() } }),
                )
            }
            Row(
                Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, bottom = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.End),
            ) {
                SquareButton("Cancel", { q.cancelNaming() }, expand = false)
                SquareButton(if (naming.renaming) "Rename" else "Create", { scope.launch { q.commitName() } }, prominent = true, expand = false, enabled = field.text.trim { it == ' ' || it == '\t' }.isNotEmpty())
            }
        }
    }
}

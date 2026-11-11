package com.agentswitch.android.dispatch

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.webkit.MimeTypeMap
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import com.agentswitch.android.AppModel
import com.agentswitch.android.LocalNav
import com.agentswitch.android.components.ErrorText
import com.agentswitch.android.design.BarWord
import com.agentswitch.android.design.BrailleSpinner
import com.agentswitch.android.design.HairRule
import com.agentswitch.android.design.NavBar
import com.agentswitch.android.design.PixelSprite
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.card
import com.agentswitch.android.design.code
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.kit.design.PixelArt
import com.agentswitch.kit.files.ByteCountFormatter
import com.agentswitch.kit.files.TaskFile
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

/**
 * Opening a task's files, on the task page and the kept-files page alike (app-v0 §5): a tap downloads into the app's
 * cache and opens the phone's own viewer (`ACTION_VIEW` through the `FileProvider`, which can share or save it); HTML,
 * SVG and XML are shown as source, since a local viewer could fetch their remote resources. Knows which files are on
 * the phone already (this launch: the cache is emptied at start, see [FileCache]).
 */
@Stable
class TaskFileOpener {
    enum class State { Remote, Downloading, Local }

    /** A web-type file to show as text. */
    var source: SourceFile? by mutableStateOf(null)
    var error: String? by mutableStateOf(null)
    var downloading: String? by mutableStateOf(null)
        private set

    /** The files no app on the phone could open: their row says so and offers `Share`. */
    private val unopenable: SnapshotStateList<String> = mutableStateListOf()
    private val local: SnapshotStateList<String> = mutableStateListOf()

    private fun key(taskId: String, file: TaskFile) = "$taskId/${file.path}"

    fun state(file: TaskFile, taskId: String): State {
        val key = key(taskId, file)
        return if (downloading == key) State.Downloading else if (key in local) State.Local else State.Remote
    }

    fun cannotOpen(file: TaskFile, taskId: String): Boolean = key(taskId, file) in unopenable

    suspend fun open(file: TaskFile, taskId: String, model: AppModel, context: Context) {
        val api = model.api ?: return
        if (downloading != null) return
        val key = key(taskId, file)
        downloading = key
        try {
            val target = FileCache.file(context, taskId, file.path)
            val data: ByteArray = withContext(Dispatchers.IO) {
                if (key in local && target.exists()) target.readBytes()
                else api.download(taskId, file.path).also { target.parentFile?.mkdirs(); target.writeBytes(it) }
            }
            if (key !in local) local.add(key)
            error = null
            if (file.opensInPreview) {
                if (view(context, target)) unopenable.remove(key) else if (key !in unopenable) unopenable.add(key)
            } else {
                source = SourceFile(target, String(data, 0, minOf(data.size, SourceFile.maxBytes), Charsets.UTF_8))
            }
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            model.handle(e)
            error = e.message ?: e.javaClass.simpleName
        } finally {
            downloading = null
        }
    }

    companion object {
        fun mime(file: File): String =
            MimeTypeMap.getSingleton().getMimeTypeFromExtension(file.extension.lowercase()) ?: "application/octet-stream"

        fun uri(context: Context, file: File) = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)

        /** The phone's viewer for it; false when no app can open this kind of file. */
        fun view(context: Context, file: File): Boolean {
            val intent = Intent(Intent.ACTION_VIEW).setDataAndType(uri(context, file), mime(file)).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            return try { context.startActivity(intent); true } catch (_: ActivityNotFoundException) { false }
        }

        /** The system's share sheet for a downloaded file (where it can also be saved). */
        fun share(context: Context, file: File) {
            val send = Intent(Intent.ACTION_SEND).setType(mime(file)).putExtra(Intent.EXTRA_STREAM, uri(context, file))
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            try { context.startActivity(Intent.createChooser(send, null).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)) } catch (_: ActivityNotFoundException) {}
        }
    }
}

/**
 * Downloads live in `cacheDir/agentswitch-files/<task>/<path>` (the only folder the `FileProvider` exposes), emptied
 * the first time anything asks for it in a process — which is when the app starts, before any file was downloaded.
 */
object FileCache {
    private var cleared = false

    fun root(context: Context): File {
        val root = File(context.cacheDir, "agentswitch-files")
        if (!cleared) { cleared = true; root.deleteRecursively() }
        return root
    }

    fun file(context: Context, taskId: String, path: String): File {
        var file = root(context)
        for (segment in TaskFile.cacheSegments(taskId, path)) file = File(file, segment)
        return file
    }
}

/** A web-type deliverable shown as text (never rendered), with the file to share. */
class SourceFile(val file: File, val text: String) {
    companion object { const val maxBytes = 512 * 1024 }
}

/** Shows what the opener hands over as source: a sheet over the page. Put once on a page that has an opener. */
@Composable
fun TaskFilePreview(opener: TaskFileOpener) {
    val nav = LocalNav.current
    val source = opener.source
    LaunchedEffect(source) {
        if (source != null) {
            opener.source = null
            nav.present("source:${source.file.path}") { SourceFileView(source) { nav.dismiss("source:${source.file.path}") } }
        }
    }
}

@Composable
fun SourceFileView(file: SourceFile, onDone: () -> Unit) {
    val context = LocalContext.current
    Column(Modifier.fillMaxSize()) {
        NavBar(file.file.name, leading = { BarWord("Done", onDone) }, trailing = { BarWord("Share", { TaskFileOpener.share(context, file.file) }) })
        SelectionContainer {
            Text(
                file.text,
                Modifier.fillMaxSize().verticalScroll(rememberScrollState()).horizontalScroll(rememberScrollState()).padding(16.dp),
                color = Theme.ink, style = code(12), softWrap = false,
            )
        }
    }
}

/**
 * 文件 on a task page: what the executor handed back (`out/`, or the kept artifacts) and what you sent (`in/`). The
 * list is loaded by the task page. `titled`: under the word `Files` (a task page); without it where the page itself is
 * the files' (KeptFilesView).
 */
@Composable
fun TaskFilesSection(taskId: String, files: List<TaskFile>, opener: TaskFileOpener, titled: Boolean = true) {
    if (files.isEmpty()) return
    if (titled) Block("Files") { FileList(taskId, files, opener) }
    else Column(verticalArrangement = Arrangement.spacedBy(Theme.Space.s)) { FileList(taskId, files, opener) }
}

@Composable
private fun FileList(taskId: String, files: List<TaskFile>, opener: TaskFileOpener) {
    val context = LocalContext.current
    val model = com.agentswitch.android.LocalAppModel.current
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    Column(Modifier.fillMaxWidth().card().padding(horizontal = 14.dp)) {
        files.forEachIndexed { index, file ->
            if (index > 0) HairRule(Modifier.padding(start = 34.dp))
            Column(
                Modifier.fillMaxWidth().clickable(enabled = opener.downloading == null, role = Role.Button) {
                    scope.launch { opener.open(file, taskId, model, context) }
                },
            ) {
                FileRow(file, opener.state(file, taskId))
                if (opener.cannotOpen(file, taskId)) {
                    Row(Modifier.padding(start = 34.dp, bottom = 10.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text("无法打开此类文件", color = Theme.failed, style = plain(12))
                        Text(
                            "Share",
                            Modifier.clickable(role = Role.Button) { TaskFileOpener.share(context, FileCache.file(context, taskId, file.path)) }.padding(vertical = 4.dp),
                            color = Theme.signal, style = mono(12),
                        )
                    }
                }
            }
        }
    }
    ErrorText(opener.error, onClose = { opener.error = null })
}

@Composable
private fun FileRow(file: TaskFile, state: TaskFileOpener.State) {
    Row(Modifier.fillMaxWidth().padding(vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
        FileIcon(file.name, Modifier.width(24.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(file.name, color = Theme.ink, style = plain(15), maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(
                "${if (file.isDeliverable) "返回的文件" else "发送的附件"} · ${ByteCountFormatter.file(file.size)}",
                color = Theme.secondaryInk, style = plain(12),
            )
        }
        FileStateMark(state)
    }
}

/** Where a file is: `↓` still on the Mac, the spinner while it comes, a square once it is on the phone. */
@Composable
fun FileStateMark(state: TaskFileOpener.State) {
    when (state) {
        TaskFileOpener.State.Remote -> Text("↓", color = Theme.secondaryInk, style = mono(13))
        TaskFileOpener.State.Downloading -> BrailleSpinner(color = Theme.secondaryInk)
        TaskFileOpener.State.Local -> PixelSprite(PixelArt.square, pixel = 2.dp, color = Theme.done)
    }
}

/** A small drawing for a kind of file (the iPhone's SF Symbols: photo, richtext, table, zipper, text, plain). */
@Composable
private fun FileIcon(name: String, modifier: Modifier = Modifier) {
    val kind = when (name.substringAfterLast('.', "").lowercase()) {
        "png", "jpg", "jpeg", "heic", "gif", "webp" -> 0
        "pdf" -> 1
        "csv", "xlsx", "xls", "numbers" -> 2
        "zip", "tar", "gz" -> 3
        "md", "txt", "json", "log" -> 4
        else -> 5
    }
    val color = Theme.secondaryInk
    Box(modifier, contentAlignment = Alignment.Center) {
        Canvas(Modifier.size(22.dp)) { drawFileKind(kind, color) }
    }
}

private fun DrawScope.drawFileKind(kind: Int, color: Color) {
    val w = size.width
    val stroke = Stroke(w * 0.075f)
    fun at(x: Float, y: Float) = Offset(x * w, y * w)
    if (kind == 0 || kind == 2) {
        drawRoundRect(color, at(0.06f, 0.16f), Size(w * 0.88f, w * 0.68f), CornerRadius(w * 0.08f), style = stroke)
        if (kind == 2) {
            drawLine(color, at(0.06f, 0.5f), at(0.94f, 0.5f), stroke.width)
            drawLine(color, at(0.4f, 0.16f), at(0.4f, 0.84f), stroke.width)
            drawLine(color, at(0.68f, 0.16f), at(0.68f, 0.84f), stroke.width)
        } else {
            drawCircle(color, w * 0.07f, at(0.7f, 0.36f))
            drawPath(Path().apply { moveTo(w * 0.1f, w * 0.8f); lineTo(w * 0.38f, w * 0.52f); lineTo(w * 0.56f, w * 0.7f); lineTo(w * 0.72f, w * 0.56f); lineTo(w * 0.9f, w * 0.8f) }, color, style = stroke)
        }
        return
    }
    val body = Path().apply {
        moveTo(w * 0.2f, w * 0.06f); lineTo(w * 0.62f, w * 0.06f); lineTo(w * 0.84f, w * 0.28f)
        lineTo(w * 0.84f, w * 0.94f); lineTo(w * 0.2f, w * 0.94f); close()
    }
    drawPath(body, color, style = stroke)
    drawPath(Path().apply { moveTo(w * 0.62f, w * 0.06f); lineTo(w * 0.62f, w * 0.28f); lineTo(w * 0.84f, w * 0.28f) }, color, style = stroke)
    when (kind) {
        1, 4 -> for (y in listOf(0.5f, 0.64f, 0.78f)) drawLine(color, at(0.32f, y), at(0.72f, y), stroke.width)
        3 -> for (y in listOf(0.4f, 0.54f, 0.68f, 0.82f)) drawLine(color, at(0.46f, y), at(0.58f, y), stroke.width)
    }
}

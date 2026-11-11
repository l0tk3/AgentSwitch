package com.agentswitch.android.files

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.design.BarBack
import com.agentswitch.android.design.BrailleSpinner
import com.agentswitch.android.design.CharMeter
import com.agentswitch.android.design.ClassicBar
import com.agentswitch.android.design.HairRule
import com.agentswitch.android.design.LocalLook
import com.agentswitch.android.design.NavBar
import com.agentswitch.android.design.PixelBox
import com.agentswitch.android.design.PixelBoxEffect
import com.agentswitch.android.design.SquareButton
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.code
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.android.dispatch.FileCache
import com.agentswitch.kit.api.FileRefusal
import com.agentswitch.kit.api.FileSize
import com.agentswitch.kit.api.MacFileDetails
import com.agentswitch.kit.api.MacFilePreview
import com.agentswitch.kit.api.MacFileType
import com.agentswitch.kit.api.MacPath
import com.agentswitch.kit.api.MacPick
import com.agentswitch.kit.api.maxFileDownload
import com.agentswitch.kit.api.AgentSwitchAPI
import com.agentswitch.kit.design.PixelArt
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.File
import java.security.MessageDigest

// A file of the Mac's, opened from the browser (docs/files-v0.md §5 预览): a text file's first 64 KB shown here
// (monospaced, long lines wrapped, numbered in the pixel look); a picture's small copy, then `Open Preview` fetches the
// whole of it for the phone's own viewer, as for a PDF and the rest; a file over 25 MB is not fetched. Under it
// `Add to Reply` (`Add to Reply…` on the Files tab) and `Copy Path`; in the bar `Share` (fetched, then the system's
// share sheet) and `⋯` with `Rename…`, `Move to Trash` (files-v0 §12.3) and `Save` (to a place the person picks).
//
// What differs from the iPhone: the iPhone's Quick Look is `ACTION_VIEW` on the fetched copy through the `FileProvider`
// (`cacheDir/agentswitch-files/mac/<digest>/<name>`: inside the folder `res/xml/file_paths.xml` already exposes; the
// cache is emptied at the first look in a process, `FileCache`); when no app can open it, the page says so and offers
// `Share`. Save to Files / Photos is `Save` here, and the share sheet.

/** What kind, how big, how many lines. */
fun filePreviewFacts(d: MacFileDetails): String {
    val kind = when (d.type) {
        MacFileType.Text -> "Text"
        MacFileType.Image -> "Image"
        MacFileType.Pdf -> "PDF"
        MacFileType.Audio -> "Audio"
        MacFileType.Video -> "Video"
        MacFileType.Archive -> "Archive"
        MacFileType.Binary, null -> "Document"
    }
    return listOfNotNull(kind, FileSize.short(d.size), d.lines?.let { "$it Lines" }).joinToString(" · ")
}

private fun cacheFile(context: android.content.Context, path: String): File {
    val digest = MessageDigest.getInstance("SHA-256").digest(path.toByteArray()).take(8).joinToString("") { "%02x".format(it) }
    val dir = File(File(FileCache.root(context), "mac"), digest).also { it.mkdirs() }
    return File(dir, MacPath.name(path))
}

@Composable
fun FilePreviewPage(path: String, session: FilesSession, onPick: (List<MacPick>) -> Unit, shareMode: ShareMode) {
    val model = LocalAppModel.current
    val context = LocalContext.current
    val classic = LocalLook.current.isClassic
    val scope = rememberCoroutineScope()
    val mac = model.profile?.name ?: "Mac"
    var details by remember { mutableStateOf<MacFileDetails?>(null) }
    var preview by remember { mutableStateOf<MacFilePreview?>(null) }
    var thumbnail by remember { mutableStateOf<ImageBitmap?>(null) }
    var refusal by remember { mutableStateOf<FileRefusal?>(null) }
    var failure by remember { mutableStateOf<String?>(null) }
    /** How far the whole file has come for the viewer. */
    var downloading by remember { mutableStateOf<Double?>(null) }
    /** The fetched copy no app on the phone could open. */
    var unopenable by remember { mutableStateOf<File?>(null) }
    var copied by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf<List<PixelBox.Action>?>(null) }
    var menuAnchor by remember { mutableStateOf(Rect.Zero) }
    var moreBounds by remember { mutableStateOf(Rect.Zero) }
    val tooLarge = (details?.size ?: 0) > AgentSwitchAPI.maxFileDownload

    LaunchedEffect(path, model.api) {
        val source = model.fileSource ?: return@LaunchedEffect
        try {
            val d = source.fileDetails(path)
            details = d
            when (d.type) {
                MacFileType.Text -> preview = source.filePreview(path)
                MacFileType.Image -> thumbnail = try {
                    source.fileThumbnail(path).let { b -> BitmapFactory.decodeByteArray(b, 0, b.size)?.asImageBitmap() }
                } catch (e: CancellationException) { throw e } catch (_: Exception) { null }
                else -> Unit
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            val r = FileRefusal.of(e)
            if (r != null && r != FileRefusal.NotText) refusal = r else failure = e.message ?: e.javaClass.simpleName
        }
    }
    LaunchedEffect(copied) { if (copied) { delay(1500); copied = false } }
    PixelBoxEffect(menu, { menu = null }) { PixelBox(cancel = null, actions = it, anchor = menuAnchor) }

    suspend fun openPreview() {
        val source = model.fileSource ?: return
        if (tooLarge) return
        val file = cacheFile(context, path)
        downloading = 0.0
        try {
            source.downloadFile(path, file) { p -> downloading = p }
            failure = null
            if (!viewFile(context, file)) unopenable = file
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            failure = FileRefusal.of(e)?.sentence(mac) ?: (e.message ?: e.javaClass.simpleName)
        } finally {
            downloading = null
        }
    }

    fun give() {
        val pick = MacPick(path, isFolder = false, sensitive = details?.sensitive != null)
        if (session.asksTerminal) { session.choosing = listOf(pick); return }
        session.land(listOf(pick)) { landed -> onPick(landed) }
    }

    Column(Modifier.fillMaxSize().background(Theme.base)) {
        NavBar(
            title = MacPath.name(path),
            subtitle = { details?.let { Text(filePreviewFacts(it), color = Theme.secondaryInk, style = mono(11), maxLines = 1, overflow = TextOverflow.Ellipsis) } },
            leading = { BarBack({ session.stack = session.stack.dropLast(1) }) },
            trailing = {
                BarIcon(PixelArt.share, "Share", details != null && (details?.size ?: 0) <= FilesStore.MAX_FILE_SHARE) {
                    shareMode.save = false
                    session.share(listOf(path), model.fileSource, model.files, scope)
                }
                val d = details
                if (d != null && !d.fixed) {
                    Box(
                        Modifier.onGloballyPositioned { moreBounds = it.boundsInRoot() }.heightIn(min = 44.dp).width(44.dp)
                            .clickable(role = Role.Button, onClickLabel = "More") {
                                menuAnchor = moreBounds
                                menu = listOf(
                                    PixelBox.Action("Rename…") { session.naming = FilesSession.Naming(FilesSession.Naming.Kind.Rename(path), emptySet(), d.name) },
                                    PixelBox.Action("Save") { shareMode.save = true; session.share(listOf(path), model.fileSource, model.files, scope) },
                                    PixelBox.Action("Move to Trash", PixelBox.Action.Role.Destructive) { session.trashing = FilesSession.Trashing(listOf(path)) },
                                )
                            },
                        contentAlignment = Alignment.Center,
                    ) { MoreGlyph(Theme.ink) }
                }
            },
        )
        Box(Modifier.weight(1f).fillMaxWidth()) {
            val r = refusal
            val p = preview
            val d = details
            when {
                r != null -> Note(r.sentence(mac))
                failure != null && d == null -> Note(failure ?: "")
                p != null -> TextView(p)
                d != null -> Other(d, thumbnail, tooLarge, downloading, failure, mac, unopenable, { scope.launch { openPreview() } }) {
                    unopenable?.let { f -> shareMode.save = false; try { context.startActivity(shareIntent(context, listOf(f))) } catch (_: Exception) { } }
                }
                else -> Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                    BrailleSpinner(color = Theme.secondaryInk)
                    Spacer(Modifier.width(8.dp))
                    Text("Loading", color = Theme.secondaryInk, style = mono(12))
                }
            }
        }
        Column(Modifier.fillMaxWidth().background(Theme.base).then(if (session.inTab) Modifier else Modifier.windowInsetsPadding(WindowInsets.navigationBars))) {
            HairRule()
            Row(Modifier.padding(horizontal = Theme.Space.l, vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(Theme.Space.m)) {
                SquareButton(if (session.asksTerminal) "Add to Reply…" else "Add to Reply", { give() }, prominent = true, expand = false, enabled = details != null && !session.checking)
                SquareButton(if (copied) "Copied" else "Copy Path", {
                    (context.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager)
                        .setPrimaryClip(android.content.ClipData.newPlainText("path", path))
                    copied = true
                }, expand = false)
            }
        }
    }
}

@Composable
private fun Note(words: String) {
    Text(words, Modifier.fillMaxSize().padding(Theme.Space.l), color = Theme.secondaryInk, style = plain(15))
}

/**
 * The text a line to a row, long lines wrapped to the page's width (a minified file is one line); in the pixel look
 * each row's number beside its first row, in a column as wide as the largest number.
 */
@Composable
private fun TextView(p: MacFilePreview) {
    val classic = LocalLook.current.isClassic
    val body = p.text.removeSuffix("\n")
    val lines = remember(p) { body.split("\n") }
    val digits = lines.size.toString().length
    val style = code(12).copy(fontSize = 11.5.sp)
    SelectionContainer {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(Theme.Space.m)) {
            itemsIndexed(lines) { i, line ->
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    if (!classic) Text((i + 1).toString().padStart(digits, ' '), color = Theme.inkDim, style = style, softWrap = false)
                    Text(line.ifEmpty { " " }, Modifier.weight(1f), color = Theme.ink, style = style)
                }
            }
            if (p.truncated) item { Text("仅显示前 64 KB（共 ${FileSize.short(p.size)}）。", Modifier.padding(top = Theme.Space.m), color = Theme.secondaryInk, style = plain(13)) }
        }
    }
}

@Composable
private fun Other(
    d: MacFileDetails, thumbnail: ImageBitmap?, tooLarge: Boolean, downloading: Double?, failure: String?, mac: String,
    unopenable: File?, open: () -> Unit, share: () -> Unit,
) {
    val classic = LocalLook.current.isClassic
    Column(Modifier.fillMaxSize().padding(Theme.Space.l), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Theme.Space.l, Alignment.CenterVertically)) {
        if (thumbnail != null) {
            // The frame on the picture itself, not on the room it is given.
            val shape = if (classic) RoundedCornerShape(10.dp) else RectangleShape
            Image(
                thumbnail, null, Modifier.heightIn(max = 360.dp).clip(shape).then(if (classic) Modifier else Modifier.border(1.dp, Theme.line, shape)),
                contentScale = ContentScale.Fit,
            )
        } else {
            Box(Modifier.heightIn(min = 54.dp), contentAlignment = Alignment.Center) { FileGlyph(FileKinds.of(d.name), Theme.secondaryInk, side = 54.dp) }
        }
        Text(filePreviewFacts(d), color = Theme.secondaryInk, style = mono(12))
        if (tooLarge) {
            Text(FileRefusal.TooLarge.sentence(mac), color = Theme.secondaryInk, style = plain(13))
        } else if (downloading != null) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (classic) ClassicBar(downloading, color = Theme.signal, width = 220.dp) else CharMeter(downloading, cells = 20)
                Text("Downloading ${(downloading * 100).toInt()}%", color = Theme.secondaryInk, style = mono(11))
            }
        } else {
            SquareButton("Open Preview", open, expand = false)
        }
        if (unopenable != null) {
            Text("手机上没有能打开此文件的应用。", color = Theme.secondaryInk, style = plain(13))
            SquareButton("Share", share, expand = false)
        }
        if (failure != null) Text(failure, color = Theme.failed, style = plain(13))
    }
}

package com.agentswitch.android.rooms

import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import android.util.LruCache
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentswitch.android.AppModel
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.LocalNav
import com.agentswitch.android.Nav
import com.agentswitch.android.design.BarWord
import com.agentswitch.android.design.BrailleSpinner
import com.agentswitch.android.design.CharMeter
import com.agentswitch.android.design.ClassicBar
import com.agentswitch.android.design.ClassicIcon
import com.agentswitch.android.design.ClassicIconKind
import com.agentswitch.android.design.LocalLook
import com.agentswitch.android.design.NavBar
import com.agentswitch.android.design.PixelSprite
import com.agentswitch.android.design.SquareButton
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.code
import com.agentswitch.android.design.framed
import com.agentswitch.android.design.grounded
import com.agentswitch.android.design.lookShape
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.android.files.BarIcon
import com.agentswitch.android.files.FileGlyph
import com.agentswitch.android.files.FileKind
import com.agentswitch.android.files.FileKinds
import com.agentswitch.android.files.shareIntent
import com.agentswitch.android.files.viewFile
import com.agentswitch.android.platform.ImagePrep
import com.agentswitch.android.terminals.ZoomableImage
import com.agentswitch.android.terminals.readPicture
import com.agentswitch.kit.api.APIError
import com.agentswitch.kit.api.AgentSwitchAPI
import com.agentswitch.kit.api.FileRefusal
import com.agentswitch.kit.api.FileSize
import com.agentswitch.kit.api.RoomFilePath
import com.agentswitch.kit.api.maxFileDownload
import com.agentswitch.kit.api.roomFileContent
import com.agentswitch.kit.design.PixelArt
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.security.MessageDigest
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import com.agentswitch.android.files.FileCache

// A room message's files as a chat draws them (2026-11-23, user: 会话发的图片、我发的图片要能在聊天页直接预览；文件要有
// 文件图标，点了能预览): a picture is shown in the timeline, any other file is a card with its kind's icon, its name
// and its size; a tap opens it — a picture whole, a text file as text, the rest handed to whatever app on the phone
// opens it. And the pictures picked on this phone for the next message, above the box.
//
// Where a file is read from: one in the room's shared folder through the room's own route (`/rooms/:id/files/content`,
// whatever the phone may see of the Mac's other files); one anywhere else on the Mac as the Files pages read it
// (`/files/thumbnail`, `/files/preview`, `/files/content`), which the Mac may refuse this phone.

/**
 * The timeline's pictures as they are drawn, small (the long side at most [side]), by room and by where the file is on
 * the Mac: read once, kept while there is room, so going up and down the timeline asks the Mac for nothing again.
 */
object RoomPictures {
    const val side = 960

    private val held = object : LruCache<String, Bitmap>(32 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap): Int = value.byteCount
    }

    fun get(room: String, path: String): Bitmap? = held.get("$room\n$path")

    fun keep(room: String, path: String, bitmap: Bitmap) { held.put("$room\n$path", bitmap) }
}

/**
 * A message's picture, small: from what is kept, else read from the Mac. Null when it can not be had; one the Mac
 * would not give (refused, gone, not a picture after all) is remembered in `noPicture` and not asked for again, one
 * that only failed on the way is asked for the next time it is drawn.
 */
suspend fun RoomPageModel.picture(app: AppModel, path: String): Bitmap? {
    RoomPictures.get(id, path)?.let { return it }
    try {
        val data = demoBytes[path] ?: run {
            val api = app.api
            val under = RoomFilePath.under(folder, path)
            if (api != null && under != null) {
                try {
                    api.roomFileContent(id, under)
                } catch (e: APIError.Http) {
                    // Too large is too large; a Mac from before the room's route may still give it as one of its files.
                    if (e.status == 413) throw e
                    (app.fileSource ?: throw e).fileThumbnail(path)
                }
            } else {
                (app.fileSource ?: return null).fileThumbnail(path)
            }
        }
        val bitmap = withContext(Dispatchers.Default) { ImagePrep.decode(data, RoomPictures.side) }
        if (bitmap == null) { noPicture[path] = true; return null }
        RoomPictures.keep(id, path, bitmap)
        return bitmap
    } catch (e: CancellationException) {
        throw e
    } catch (e: APIError.Http) {
        noPicture[path] = true
        return null
    } catch (_: Exception) {
        return null
    }
}

/** Opens one of a room's files in a sheet over the page. */
fun Nav.openRoomFile(model: RoomPageModel, path: String) = present("roomfile:${model.id}:$path") { RoomFilePage(model, path) }

/** What a file is, in a word and a size: `PNG · 284 KB`. */
private fun facts(path: String, size: Long?): String {
    val name = RoomFilePath.name(path)
    val dot = name.lastIndexOf('.')
    val kind = if (dot > 0 && dot < name.length - 1 && name.length - dot <= 9) name.substring(dot + 1).uppercase() else "File"
    return listOfNotNull(kind, size?.let { FileSize.short(it) }).joinToString(" · ")
}

/** The files a message comes with, under its words: pictures shown, the rest as cards. */
@Composable
fun MessageFiles(model: RoomPageModel, files: List<String>) {
    if (files.isEmpty()) return
    val nav = LocalNav.current
    Column(Modifier.padding(top = 3.dp, bottom = 2.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        for (path in files) key(path) {
            if (RoomFilePath.isPicture(path)) MessagePicture(model, path) { nav.openRoomFile(model, path) }
            else RoomFileCard(path, model.listed(path)?.size) { nav.openRoomFile(model, path) }
        }
    }
}

private val pictureWidth = 220.dp
private val pictureHeight = 240.dp

/** A picture in the timeline: its proportions kept, no larger than a chat's picture is; its place held while it is read. */
@Composable
private fun MessagePicture(model: RoomPageModel, path: String, open: () -> Unit) {
    val app = LocalAppModel.current
    val classic = LocalLook.current.isClassic
    var bitmap by remember(path) { mutableStateOf(RoomPictures.get(model.id, path)) }
    /** It did not come this time. */
    var missed by remember(path) { mutableStateOf(false) }
    val size = model.listed(path)?.size
    val never = model.noPicture[path] == true || (size ?: 0) > AgentSwitchAPI.maxFileDownload
    LaunchedEffect(path, app.api, never) {
        if (bitmap != null || never) return@LaunchedEffect
        missed = false
        val got = model.picture(app, path)
        if (got == null) missed = true else { bitmap = got; model.picturesShown += 1 }
    }
    val shown = bitmap
    if (shown == null && (never || missed)) { RoomFileCard(path, size, open); return }
    val shape = lookShape(12.dp)
    val name = RoomFilePath.name(path)
    if (shown == null) {
        Box(Modifier.size(160.dp, 120.dp).grounded(Theme.raised, 12.dp).framed(Theme.line, 12.dp), contentAlignment = Alignment.Center) {
            BrailleSpinner(color = Theme.secondaryInk)
        }
        return
    }
    // As large as it is, within a chat picture's bounds; a very small one is not left a speck.
    val density = LocalDensity.current.density
    val w = shown.width / density
    val h = shown.height / density
    var scale = minOf(pictureWidth.value / w, pictureHeight.value / h, 1f)
    if (maxOf(w, h) * scale < 96f) scale = minOf(96f / maxOf(w, h), pictureWidth.value / w, pictureHeight.value / h)
    Image(
        shown.asImageBitmap(), contentDescription = name,
        Modifier.size((w * scale).coerceAtLeast(24f).dp, (h * scale).coerceAtLeast(24f).dp).clip(shape)
            .then(if (classic) Modifier else Modifier.border(1.dp, Theme.line, shape))
            .clickable(role = Role.Image, onClickLabel = "Open", onClick = open),
        contentScale = ContentScale.Crop,
    )
}

/** A file as a card: its kind's icon, its name, what it is and how large. */
@Composable
fun RoomFileCard(path: String, size: Long?, open: () -> Unit) {
    val classic = LocalLook.current.isClassic
    val name = RoomFilePath.name(path)
    Row(
        Modifier.widthIn(max = 280.dp).clip(lookShape(12.dp)).grounded(if (classic) Theme.raised else Color.Transparent, 12.dp).framed(Theme.line, 12.dp)
            .clickable(role = Role.Button, onClickLabel = "Open", onClick = open).padding(horizontal = 10.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        FileGlyph(FileKinds.of(name), if (classic) Theme.signal else Theme.ink, side = 30.dp)
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(name, color = Theme.ink, style = if (classic) plain(14, FontWeight.Medium) else mono(13, FontWeight.Medium), maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
            Text(facts(path, size), color = Theme.secondaryInk, style = mono(11), maxLines = 1)
        }
    }
}

// MARK: - a file opened

/** The most of a text file shown as text. */
private const val maxText = 256 * 1024

private fun localCopy(context: Context, room: String, path: String): File {
    val digest = MessageDigest.getInstance("SHA-256").digest("$room\n$path".toByteArray()).take(8).joinToString("") { "%02x".format(it) }
    val dir = File(File(FileCache.root(context), "room"), digest).also { it.mkdirs() }
    return File(dir, RoomFilePath.name(path))
}

/** The first of a file as text, or null when it is not text (a zero byte in it). */
private fun textOf(file: File): String? {
    val bytes = file.inputStream().use { input -> ByteArray(minOf(file.length(), maxText.toLong()).toInt()).also { var at = 0; while (at < it.size) { val n = input.read(it, at, it.size - at); if (n < 0) break; at += n } } }
    if (bytes.any { it == 0.toByte() }) return null
    return String(bytes, Charsets.UTF_8)
}

/**
 * One of a room's files, whole, in a sheet over the page: a picture fills it (pinch to zoom, double tap); a text file
 * is read as text; anything else is fetched with `Open Preview` and handed to the app on the phone that opens it — and
 * when none does, to `Share`. `Share` in the bar gives the fetched copy to the system's share sheet. A file over 25 MB
 * is not fetched.
 */
@Composable
fun RoomFilePage(model: RoomPageModel, path: String) {
    val app = LocalAppModel.current
    val nav = LocalNav.current
    val context = LocalContext.current
    val classic = LocalLook.current.isClassic
    val scope = rememberCoroutineScope()
    val mac = app.profile?.name ?: "Mac"
    val name = RoomFilePath.name(path)
    val kind = FileKinds.of(name)
    val under = RoomFilePath.under(model.folder, path)
    val demo = model.demoBytes[path]

    var size by remember { mutableStateOf(model.listed(path)?.size ?: demo?.size?.toLong()) }
    var copy by remember { mutableStateOf<File?>(null) }
    var picture by remember { mutableStateOf<Bitmap?>(null) }
    var text by remember { mutableStateOf<String?>(null) }
    var truncated by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(true) }
    var downloading by remember { mutableStateOf<Double?>(null) }
    var failure by remember { mutableStateOf<String?>(null) }
    var unopenable by remember { mutableStateOf(false) }
    val tooLarge = (size ?: 0) > AgentSwitchAPI.maxFileDownload

    fun words(e: Exception): String = when {
        e is APIError.Http && (e.status == 413 || e.detail == FileRefusal.TooLarge.rawValue) -> FileRefusal.TooLarge.sentence(mac)
        // The room's route says why in its own words; the Files routes answer with a code.
        under != null && app.api != null -> e.message ?: e.javaClass.simpleName
        else -> FileRefusal.of(e)?.sentence(mac) ?: (e.message ?: e.javaClass.simpleName)
    }

    /** The whole file on this phone, fetched once while the sheet is open; null and why when it can not be. */
    suspend fun whole(): File? {
        copy?.let { return it }
        if (tooLarge) return null
        val file = localCopy(context, model.id, path)
        downloading = 0.0
        try {
            val api = app.api
            when {
                demo != null -> withContext(Dispatchers.IO) { file.writeBytes(demo) }
                api != null && under != null -> {
                    val bytes = api.roomFileContent(model.id, under)
                    withContext(Dispatchers.IO) { file.writeBytes(bytes) }
                }
                else -> (app.fileSource ?: return null).downloadFile(path, file) { p -> downloading = p }
            }
            size = file.length()
            failure = null
            copy = file
            return file
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            failure = words(e)
            return null
        } finally {
            downloading = null
        }
    }

    LaunchedEffect(path) {
        // How large it is, where the room's folder says: a large one is not fetched just to be looked at.
        if (under != null && model.files == null) model.loadFiles(app.api)
        if (size == null) size = model.listed(path)?.size
        try {
            if (RoomFilePath.isPicture(path)) {
                val file = whole()
                if (file != null) picture = withContext(Dispatchers.IO) { ImagePrep.decode(file.readBytes(), 2048) }
            } else if (kind == FileKind.Code || kind == FileKind.Text) {
                if (demo != null || (under != null && app.api != null)) {
                    if ((size ?: 0) <= 4L * 1024 * 1024) {
                        val file = whole()
                        if (file != null) {
                            text = withContext(Dispatchers.IO) { textOf(file) }
                            truncated = file.length() > maxText
                        }
                    }
                } else {
                    // Elsewhere on the Mac: its first part as the Files pages read it; what is not text is left to `Open Preview`.
                    val source = app.fileSource
                    if (source != null) {
                        try {
                            val preview = source.filePreview(path)
                            text = preview.text
                            truncated = preview.truncated
                            size = preview.size
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            if (FileRefusal.of(e) != FileRefusal.NotText) failure = words(e)
                        }
                    }
                }
            }
        } finally {
            loading = false
        }
    }

    fun open() {
        scope.launch {
            val file = whole() ?: return@launch
            unopenable = !viewFile(context, file)
        }
    }
    fun share() {
        scope.launch {
            val file = whole() ?: return@launch
            try { context.startActivity(shareIntent(context, listOf(file))) } catch (_: Exception) { }
        }
    }

    Column(Modifier.fillMaxSize().background(Theme.base)) {
        NavBar(
            title = name,
            subtitle = { Text(facts(path, size), color = Theme.secondaryInk, style = mono(11), maxLines = 1, overflow = TextOverflow.Ellipsis) },
            leading = { BarWord("Done", { nav.pop() }, color = agentInk) },
            trailing = { BarIcon(PixelArt.share, "Share", !tooLarge && downloading == null) { share() } },
        )
        Box(Modifier.weight(1f).fillMaxWidth()) {
            val shown = picture
            val body = text
            when {
                shown != null -> ZoomableImage(shown)
                body != null -> TextBody(body, truncated)
                loading -> Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                    BrailleSpinner(color = Theme.secondaryInk)
                    Spacer(Modifier.width(8.dp))
                    Text("Loading", color = Theme.secondaryInk, style = mono(12))
                }
                else -> Column(
                    Modifier.fillMaxSize().padding(Theme.Space.l), horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(Theme.Space.l, Alignment.CenterVertically),
                ) {
                    Box(Modifier.heightIn(min = 54.dp), contentAlignment = Alignment.Center) { FileGlyph(kind, Theme.secondaryInk, side = 54.dp) }
                    Text(facts(path, size), color = Theme.secondaryInk, style = mono(12))
                    val progress = downloading
                    if (tooLarge) {
                        Text(FileRefusal.TooLarge.sentence(mac), color = Theme.secondaryInk, style = plain(13))
                    } else if (progress != null) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            if (classic) ClassicBar(progress, color = Theme.signal, width = 220.dp) else CharMeter(progress, cells = 20)
                            Text("Downloading ${(progress * 100).toInt()}%", color = Theme.secondaryInk, style = mono(11))
                        }
                    } else {
                        SquareButton("Open Preview", { open() }, expand = false)
                    }
                    if (unopenable) {
                        Text("手机上没有能打开此文件的应用。", color = Theme.secondaryInk, style = plain(13))
                        SquareButton("Share", { share() }, expand = false)
                    }
                    failure?.let { Text(it, color = Theme.failed, style = plain(13)) }
                }
            }
        }
        Spacer(Modifier.windowInsetsPadding(WindowInsets.navigationBars))
    }
}

/** A text file a line to a row, long lines wrapped; numbered in the pixel look (as the Files pages show one). */
@Composable
private fun TextBody(text: String, truncated: Boolean) {
    val classic = LocalLook.current.isClassic
    val lines = remember(text) { text.removeSuffix("\n").split("\n") }
    val digits = lines.size.toString().length
    val style = code(12).copy(fontSize = 11.5.sp)
    SelectionContainer {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(Theme.Space.m)) {
            itemsIndexed(lines) { i, line ->
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    if (!classic) Text((i + 1).toString().padStart(digits, ' '), color = Theme.inkDim, style = style, softWrap = false)
                    Text(line.ifEmpty { " " }, Modifier.weight(1f), color = Theme.ink, style = style)
                }
            }
            if (truncated) item { Text("仅显示文件的开头。", Modifier.padding(top = Theme.Space.m), color = Theme.secondaryInk, style = plain(13)) }
        }
    }
}

// MARK: - pictures for the next message

/** The picture on the button that picks photos, in the pixel look: a frame, a sun, hills. */
private val pictureArt = listOf("#########", "#.......#", "#.##....#", "#.....#.#", "#..#.####", "#.#######", "#########")

/** A picked picture made ready to go (ImagePrep: no larger than the app sends, upright, without its metadata), under a name of its own. */
private fun pickedPicture(context: Context, uri: Uri, stem: String): Pair<String, ByteArray>? {
    val read = readPicture(context, uri, stem) ?: return null
    val ready = ImagePrep.prepare(read) ?: return null
    return ready.name to ready.data
}

/**
 * The button beside a room's box that opens the system's photo picker (no permission asked), and what it picks made
 * ready and put above the box. `preparing`: told while the picked pictures are read.
 */
@Composable
fun RoomPhotosButton(model: RoomPageModel, preparing: (Boolean) -> Unit) {
    val context = LocalContext.current
    val classic = LocalLook.current.isClassic
    val scope = rememberCoroutineScope()
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(RoomFilePath.maxPerMessage)) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        scope.launch {
            preparing(true)
            try {
                val stamp = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss"))
                val read = withContext(Dispatchers.IO) {
                    uris.mapIndexedNotNull { i, uri -> pickedPicture(context, uri, if (uris.size == 1) "photo-$stamp" else "photo-$stamp-${i + 1}") }
                }
                model.error = null
                model.attach(read) { data -> ImagePrep.decode(data, 168) }
                if (read.size < uris.size) model.error = "有 ${uris.size - read.size} 张图片无法读取，没有添加。"
            } finally {
                preparing(false)
            }
        }
    }
    val enabled = !model.sending && model.attachmentRoom > 0
    Box(
        Modifier.size(38.dp).alpha(if (enabled) 1f else 0.4f)
            .clickable(enabled, role = Role.Button, onClickLabel = "Photos") { pick.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }
            .semantics { contentDescription = "Photos" },
        contentAlignment = Alignment.Center,
    ) {
        if (classic) ClassicIcon(ClassicIconKind.Symbol("photo"), 25.dp, 23.dp, Theme.signal)
        else PixelSprite(pictureArt, pixel = 2.dp, color = Theme.ink)
    }
}

/** The pictures waiting to go with the next message, above the box: each small, with its `×`; and how far they have gone. */
@Composable
fun RoomAttachmentStrip(model: RoomPageModel, preparing: Boolean) {
    val items = model.attachments
    if (items.isEmpty() && !preparing) return
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (items.isNotEmpty()) {
            Row(Modifier.horizontalScroll(rememberScrollState()).padding(end = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (item in items) key(item.id) { AttachmentTile(item, removable = !model.sending) { model.detach(item.id) } }
            }
        }
        val word = when {
            model.uploading != null -> "Uploading ${model.uploading}"
            preparing -> "Preparing"
            else -> null
        }
        if (word != null) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                BrailleSpinner(color = Theme.secondaryInk)
                Text(word, color = Theme.secondaryInk, style = mono(11))
            }
        }
    }
}

private val tileSide: Dp = 56.dp

@Composable
private fun AttachmentTile(item: RoomAttachment, removable: Boolean, remove: () -> Unit) {
    val shape = lookShape(8.dp)
    Box(Modifier.padding(top = 6.dp)) {
        Box(Modifier.size(tileSide).clip(shape).background(Theme.raised).border(1.dp, Theme.line, shape), contentAlignment = Alignment.Center) {
            val thumbnail = item.thumbnail
            if (thumbnail != null) Image(thumbnail.asImageBitmap(), null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
            else FileGlyph(FileKind.Photo, Theme.secondaryInk, side = 26.dp)
        }
        if (removable) {
            Box(
                Modifier.align(Alignment.TopEnd).offset(x = 6.dp, y = (-6).dp).size(20.dp).background(Color.Black.copy(alpha = 0.7f), lookShape(10.dp))
                    .clickable(role = Role.Button, onClickLabel = "移除 ${item.name}", onClick = remove)
                    .semantics { contentDescription = "移除 ${item.name}" },
                contentAlignment = Alignment.Center,
            ) { Text("×", color = Color.White, style = plain(15, FontWeight.Bold)) }
        }
    }
}

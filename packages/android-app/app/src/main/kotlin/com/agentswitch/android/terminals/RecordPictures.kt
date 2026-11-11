package com.agentswitch.android.terminals

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import com.agentswitch.android.AgentSwitchApp
import com.agentswitch.android.BuildConfig
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.LocalNav
import com.agentswitch.android.demo.DemoData
import com.agentswitch.android.design.BarWord
import com.agentswitch.android.design.BrailleSpinner
import com.agentswitch.android.design.LocalLook
import com.agentswitch.android.design.NavBar
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.lookWord
import com.agentswitch.android.design.mono
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

// The pictures you sent with a message, in a session's record (docs/simple-view-v0.md §4, §5.1): small under the message,
// one opened whole in a page of its own over the record (the iPhone handed it to Quick Look; Android has no such
// viewer to hand to, so the page zooms with pinch and double tap itself — sharing and saving are left out).

/** A thumbnail's height in a message; a step's pictures are larger (their caller says). */
val RecordPictureHeight: Dp = 96.dp

/** A message with many pictures shows the first few (a record is for reading, not a gallery). */
private const val shownPictures = 4

/** The pictures of a message (`step` null) or of one step of a run of work, side by side. */
@Composable
fun RecordPictures(source: RecordPictureSource, item: String, count: Int, modifier: Modifier = Modifier, step: Int? = null, height: Dp = RecordPictureHeight) {
    val model = LocalAppModel.current
    val store = rememberPictureStore()
    val nav = LocalNav.current
    val scope = rememberCoroutineScope()
    var opening by remember { mutableStateOf<Int?>(null) }

    fun open(n: Int) {
        if (opening != null) return
        opening = n
        scope.launch {
            val file = try { store.file(model.api, source, item, step, n) } finally { opening = null }
            if (file != null) nav.present("picture/${source.key(item, step, n)}") { PicturePage(file, n) }
        }
    }

    Row(modifier, horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.Top) {
        for (n in 0 until minOf(count, shownPictures)) {
            RecordPicture(source, item, n, step = step, height = height, opening = opening == n) { open(n) }
        }
        if (count > shownPictures) {
            Box(Modifier.height(height), contentAlignment = Alignment.Center) {
                Text("+${count - shownPictures}", color = Theme.secondaryInk, style = mono(11))
            }
        }
    }
}

/** One thumbnail: read once from the Mac, a tap opens it whole (`open`). */
@Composable
fun RecordPicture(source: RecordPictureSource, item: String, n: Int, modifier: Modifier = Modifier, step: Int? = null, height: Dp = RecordPictureHeight, opening: Boolean = false, open: () -> Unit) {
    val model = LocalAppModel.current
    val store = rememberPictureStore()
    val key = source.key(item, step, n)
    var image by remember(key) { mutableStateOf<Bitmap?>(store.held(key)) }
    var failed by remember(key) { mutableStateOf(false) }
    LaunchedEffect(key, model.api) {
        if (image == null) {
            image = store.thumbnail(model.api, source, item, step, n)
            failed = image == null
        }
    }
    val shape = if (LocalLook.current.isClassic) RoundedCornerShape(9.dp) else RectangleShape
    val bitmap = image
    if (bitmap != null) {
        val width = if (bitmap.height > 0) (height * bitmap.width / bitmap.height).coerceIn(54.dp, height * 1.75f) else height
        Box(
            modifier.size(width, height).clip(shape).border(1.dp, Theme.line, shape)
                .clickable(remember { MutableInteractionSource() }, null, role = Role.Button, onClickLabel = "Image ${n + 1}") { open() },
        ) {
            Image(bitmap.asImageBitmap(), contentDescription = "Image ${n + 1}", Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
            if (opening) {
                Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.35f)), contentAlignment = Alignment.Center) { BrailleSpinner(color = Color.White) }
            }
        }
    } else {
        // Not read yet, or not there to read (an older Mac, its file moved): its place is kept.
        Box(modifier.size(height).border(1.dp, Theme.line, shape), contentAlignment = Alignment.Center) {
            if (failed) Text(lookWord("Image"), color = Theme.inkDim, style = mono(11)) else BrailleSpinner(color = Theme.secondaryInk)
        }
    }
}

@Composable
private fun rememberPictureStore(): RecordPictureStore {
    val app = LocalContext.current.applicationContext as AgentSwitchApp
    val model = LocalAppModel.current
    // The sample screens read the made-up pictures.
    if (BuildConfig.DEBUG && model.api == null && app.pictures.demo == null) app.pictures.demo = { DemoData.picture(it) }
    return app.pictures
}

/**
 * One picture whole, as a page over the record (Nav.present): pinch to zoom, drag to move it, double tap to zoom in and
 * back; `Done` closes it.
 */
@Composable
private fun PicturePage(file: File, n: Int) {
    val nav = LocalNav.current
    val bitmap by produceState<Bitmap?>(null, file) {
        value = withContext(Dispatchers.IO) { RecordPictureStore.image(file.readBytes(), side = 2048) }
    }
    Column(Modifier.fillMaxSize().background(Theme.base)) {
        NavBar("Image ${n + 1}", trailing = { BarWord("Done", { nav.pop() }, color = Theme.signal) })
        Box(Modifier.weight(1f).fillMaxSize(), contentAlignment = Alignment.Center) {
            val shown = bitmap
            if (shown == null) BrailleSpinner(color = Theme.secondaryInk) else ZoomableImage(shown)
        }
    }
}

@Composable
private fun ZoomableImage(bitmap: Bitmap) {
    var scale by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    var box by remember { mutableStateOf(IntSize.Zero) }
    fun clamp(o: Offset, s: Float): Offset {
        val x = box.width * (s - 1f) / 2f
        val y = box.height * (s - 1f) / 2f
        return Offset(o.x.coerceIn(-x, x), o.y.coerceIn(-y, y))
    }
    Box(
        Modifier.fillMaxSize().clipToBounds().onSizeChanged { box = it }
            .pointerInput(Unit) {
                detectTapGestures(onDoubleTap = {
                    if (scale > 1.01f) { scale = 1f; offset = Offset.Zero } else scale = 2.5f
                })
            }
            .pointerInput(Unit) {
                detectTransformGestures { _, pan, zoom, _ ->
                    val s = (scale * zoom).coerceIn(1f, 6f)
                    scale = s
                    offset = clamp(offset + pan, s)
                }
            },
    ) {
        Image(
            bitmap.asImageBitmap(), contentDescription = null,
            Modifier.fillMaxSize().graphicsLayer(scaleX = scale, scaleY = scale, translationX = offset.x, translationY = offset.y),
            contentScale = ContentScale.Fit,
        )
    }
}

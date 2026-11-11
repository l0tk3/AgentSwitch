package com.agentswitch.android.dispatch

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.design.BrailleSpinner
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.android.terminals.LookGlyph
import com.agentswitch.android.terminals.LookSymbol
import com.agentswitch.android.terminals.PendingAttachment

/**
 * The files waiting to go with the next task, above the input box: thumbnails or file names, each removable, and the one
 * reminder that attachments are not sealed (router-v0 §9).
 */
@Composable
fun AttachmentStrip(modifier: Modifier = Modifier) {
    val dispatch = LocalAppModel.current.dispatch
    Column(modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (dispatch.preparingAttachments > 0) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                BrailleSpinner(color = Theme.secondaryInk)
                Text("Preparing", color = Theme.secondaryInk, style = mono(11))
            }
        }
        if (dispatch.attachments.isNotEmpty()) {
            Row(Modifier.horizontalScroll(rememberScrollState()).padding(end = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (item in dispatch.attachments) androidx.compose.runtime.key(item.id) { Tile(item) { dispatch.removeAttachment(item.id) } }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("⚠", color = Theme.waiting, style = plain(11))
                Text("附件不经过自动加密，其中的密码将原样提供给模型。", color = Theme.waiting, style = plain(11))
            }
        }
    }
}

@Composable
private fun Tile(item: PendingAttachment, remove: () -> Unit) {
    Box(Modifier.padding(top = 6.dp)) {
        Box(Modifier.size(60.dp).clip(RectangleShape).background(Theme.raised), contentAlignment = Alignment.Center) {
            val thumbnail = item.thumbnail
            if (thumbnail != null) {
                Image(thumbnail.asImageBitmap(), null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
            } else {
                Column(Modifier.padding(4.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    val ink = Theme.secondaryInk
                    Canvas(Modifier.size(width = 16.dp, height = 20.dp)) {
                        drawRect(ink, Offset(1f, 1f), Size(size.width - 2f, size.height - 2f), style = Stroke(2f))
                    }
                    Text(item.file.name, color = Theme.ink, style = plain(10), maxLines = 2, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
                }
            }
        }
        Box(
            Modifier.align(Alignment.TopEnd).offset(x = 6.dp, y = (-6).dp).size(20.dp).background(Color.Black.copy(alpha = 0.7f))
                .clickable(role = Role.Button, onClickLabel = "移除 ${item.file.name}", onClick = remove)
                .semantics { contentDescription = "移除 ${item.file.name}" },
            contentAlignment = Alignment.Center,
        ) { Text("×", color = Color.White, style = plain(15, FontWeight.Bold)) }
    }
}

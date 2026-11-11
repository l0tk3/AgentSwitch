package com.agentswitch.android.terminals

import android.content.ClipData
import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.content.MediaType
import androidx.compose.foundation.content.ReceiveContentListener
import androidx.compose.foundation.content.TransferableContent
import androidx.compose.foundation.content.consume
import androidx.compose.foundation.content.contentReceiver
import androidx.compose.foundation.content.hasMediaType
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.TextFieldValue
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.code
import com.agentswitch.android.design.plain
import com.agentswitch.kit.feed.TerminalDraft
import com.agentswitch.kit.files.UploadFile

// The reply box's text (docs/simple-view-v0.md §5.1, docs/terminal-v0.md §4). The iPhone put UIKit's text view under
// it for one thing SwiftUI's field cannot do: take a picture from the system's Paste (2026-10-07, user: 手机上要可以直接用
// ios的粘贴来粘贴图片). Here the field tells the page its text and its selection (a `TextFieldValue`: a placeholder goes in
// where the caret is), grows from `minLines` to `maxLines` and then scrolls, and takes a picture that the keyboard offers
// through rich content (Gboard's clipboard and stickers, a screenshot's suggestion) — `Modifier.contentReceiver`; the
// picture becomes one of the reply's files, never its text. The `+` menu's `Paste Image` (the page's) reads the clipboard
// itself, for a keyboard that offers none.

/**
 * The reply's text field. `value` carries the caret (`TextFieldValue.selection`); `onImages` is given the pictures the
 * keyboard offered (null: pictures are not taken here, a sealed reply is text); `onFocus` says when it gains or loses
 * the keyboard.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun ReplyBox(
    value: TextFieldValue,
    onValueChange: (TextFieldValue) -> Unit,
    prompt: String,
    modifier: Modifier = Modifier,
    monospaced: Boolean = false,
    minLines: Int = 1,
    maxLines: Int = 5,
    focus: FocusRequester = FocusRequester(),
    onFocus: (Boolean) -> Unit = {},
    onImages: ((List<UploadFile>) -> Unit)? = null,
) {
    val context = LocalContext.current
    val style = (if (monospaced) code(14) else plain(17)).copy(color = Theme.ink)
    val images by rememberUpdatedState(onImages)
    val receiver = if (onImages == null) Modifier else Modifier.contentReceiver(object : ReceiveContentListener {
        override fun onReceive(transferableContent: TransferableContent): TransferableContent? {
            if (!transferableContent.hasMediaType(MediaType.Image)) return transferableContent
            val uris = ArrayList<Uri>()
            val rest = transferableContent.consume { item: ClipData.Item ->
                val uri = item.uri
                if (uri != null) uris.add(uri)
                uri != null
            }
            val files = uris.mapIndexedNotNull { i, uri -> readPicture(context, uri, if (uris.size == 1) "pasted" else "pasted-${i + 1}") }
            if (files.isNotEmpty()) images?.invoke(files)
            return rest
        }
    })
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = modifier.then(receiver).focusRequester(focus).onFocusChanged { onFocus(it.isFocused) },
        textStyle = style,
        cursorBrush = SolidColor(Theme.signal),
        minLines = minLines,
        maxLines = maxLines,
        // No correcting, no capital letters: a reply to an agent is often a command (the iPhone's text view says the same).
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
        decorationBox = { inner ->
            Box {
                if (value.text.isEmpty()) Text(prompt, color = Theme.inkDim, style = style, maxLines = 1)
                inner()
            }
        },
    )
}

/** `tokens` put into the reply where the caret is (at the end when the box has no focus), the caret after them. */
fun TextFieldValue.withTokens(tokens: List<String>, focused: Boolean): TextFieldValue {
    val result = TerminalDraft.insert(tokens, text, if (focused) selection.end else null)
    return TextFieldValue(result.text, TextRange(result.caret))
}

/** A picture the keyboard (or the clipboard) offers by address, as the file it is sent as; null when it cannot be read. */
internal fun readPicture(context: Context, uri: Uri, stem: String): UploadFile? {
    val resolver = context.contentResolver
    val type = resolver.getType(uri)?.takeIf { it.startsWith("image/") } ?: "image/jpeg"
    val ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(type) ?: "jpg"
    val data = try { resolver.openInputStream(uri)?.use { it.readBytes() } } catch (_: Exception) { null } ?: return null
    if (data.isEmpty()) return null
    return UploadFile(name = "$stem.$ext", type = type, data = data)
}

/** What a file picked from the system's pickers is named and how large it is (`OpenableColumns`). */
internal fun nameAndSize(context: Context, uri: Uri): Pair<String?, Long> {
    var name: String? = null
    var size = -1L
    try {
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                val n = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                val s = c.getColumnIndex(OpenableColumns.SIZE)
                if (n >= 0 && !c.isNull(n)) name = c.getString(n)
                if (s >= 0 && !c.isNull(s)) size = c.getLong(s)
            }
        }
    } catch (_: Exception) {
    }
    return name to size
}

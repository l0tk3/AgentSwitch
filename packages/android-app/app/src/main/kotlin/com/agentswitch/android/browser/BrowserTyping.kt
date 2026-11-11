package com.agentswitch.android.browser

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import com.agentswitch.kit.api.BrowserKey

/**
 * Typing into the page (browser-v0 §1: the system keyboard, text inserted as typed; the iPhone's `BrowserTypingField`):
 * a field nobody sees holds the keyboard. What the keyboard commits goes to the page and the field is emptied; while an
 * input method composes (pinyin, kana, a Chinese keyboard's pre-edit) nothing is sent until a candidate is chosen, and
 * the pre-edit text is shown on the key bar through `onComposing`. Backspace on the empty field and return become keys.
 * Nothing is corrected, predicted or capitalised: the page gets exactly what was typed.
 *
 * What differs from the iPhone: Android's input methods do not send a backspace to an empty field (they send
 * `deleteSurroundingText`, which an empty field cannot show), so the field always holds one invisible mark and a
 * deletion that takes it away is the page's `Backspace`. `typing` follows the keyboard: it goes false when the field
 * loses focus or the keyboard is put away (the system's back gesture), as the iPhone's `textFieldDidEndEditing`.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun BrowserTypingField(
    typing: Boolean,
    onTyping: (Boolean) -> Unit,
    onComposing: (String) -> Unit,
    onText: (String) -> Unit,
    onKey: (BrowserKey) -> Unit,
    modifier: Modifier = Modifier,
) {
    val mark = "\u200B"
    var field by remember { mutableStateOf(TextFieldValue(mark, TextRange(mark.length))) }
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    val typingNow by rememberUpdatedState(typing)
    val setTyping by rememberUpdatedState(onTyping)
    val sendText by rememberUpdatedState(onText)
    val sendKey by rememberUpdatedState(onKey)
    val composing by rememberUpdatedState(onComposing)
    var hadFocus by remember { mutableStateOf(false) }

    fun reset() { field = TextFieldValue(mark, TextRange(mark.length)) }

    LaunchedEffect(typing) {
        if (typing) {
            focus.requestFocus()
            keyboard?.show()
        } else {
            if (hadFocus) focus.freeFocus()
            keyboard?.hide()
            composing("")
            reset()
        }
    }
    // The keyboard put away by the system (its back gesture) is the end of typing.
    val imeUp = WindowInsets.isImeVisible
    var imeWasUp by remember { mutableStateOf(false) }
    LaunchedEffect(imeUp) {
        if (imeUp) imeWasUp = true
        else if (imeWasUp) { imeWasUp = false; if (typingNow) setTyping(false) }
    }

    BasicTextField(
        value = field,
        onValueChange = { v ->
            if (v.composition != null) {
                // Still being composed: it waits, and is shown.
                composing(v.text.removePrefix(mark))
                field = v
                return@BasicTextField
            }
            composing("")
            when {
                v.text == mark -> field = v
                !v.text.startsWith(mark) -> { reset(); sendKey(BrowserKey.Backspace) }
                else -> {
                    reset()
                    // Committed text goes; a line break in it is the return key.
                    val parts = v.text.removePrefix(mark).split('\n')
                    parts.forEachIndexed { i, part ->
                        if (part.isNotEmpty()) sendText(part)
                        if (i < parts.lastIndex) sendKey(BrowserKey.Enter)
                    }
                }
            }
        },
        modifier = modifier.size(1.dp).alpha(0.02f)
            .focusRequester(focus)
            .onFocusChanged {
                if (it.isFocused) hadFocus = true
                else if (hadFocus) { hadFocus = false; composing(""); if (typingNow) setTyping(false) }
            }
            .onPreviewKeyEvent { e ->
                if (e.type == KeyEventType.KeyDown && e.key == Key.Backspace && field.text == mark && field.composition == null) { sendKey(BrowserKey.Backspace); true }
                else if (e.type == KeyEventType.KeyDown && (e.key == Key.Enter || e.key == Key.NumPadEnter) && field.composition == null) { sendKey(BrowserKey.Enter); true }
                else false
            }
            .semantics { contentDescription = "向页面输入" },
        singleLine = true,
        textStyle = TextStyle(),
        cursorBrush = SolidColor(androidx.compose.ui.graphics.Color.Transparent),
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, imeAction = ImeAction.Default),
        keyboardActions = KeyboardActions(onAny = { sendKey(BrowserKey.Enter) }),
    )
}

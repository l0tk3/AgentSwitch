package com.agentswitch.android.settings

import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.agentswitch.android.design.BarBack
import com.agentswitch.android.design.FormRow
import com.agentswitch.android.design.LocalLook
import com.agentswitch.android.design.NavBar
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.android.rememberBack
import com.agentswitch.android.terminals.LookGlyph
import com.agentswitch.android.terminals.LookSymbol

// The small parts the proxies' pages share: a page under a bar, and the rows the system's forms have (a button, a
// value, a switch, a field at the right, a link to another page).

/**
 * A page of grouped rows under a bar with `‹ back` at its left, scrolling, clear of the system's bars and the
 * keyboard. `FormPage`'s, with its scroll state handed in (the Clash page scrolls itself to a place in a demo).
 */
@Composable
internal fun ProxyPage(
    title: String,
    back: String,
    modifier: Modifier = Modifier,
    scroll: ScrollState = rememberScrollState(),
    leading: (@Composable androidx.compose.foundation.layout.RowScope.() -> Unit)? = null,
    trailing: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit = {},
    content: @Composable ColumnScope.() -> Unit,
) {
    val goBack = rememberBack()
    Column(modifier.fillMaxSize().background(Theme.base)) {
        NavBar(title, leading = leading ?: { BarBack(goBack, back) }, trailing = trailing)
        Column(
            Modifier.fillMaxSize().verticalScroll(scroll).windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom))
                .padding(horizontal = 16.dp, vertical = 8.dp),
            content = content,
        )
    }
}

/** A row that is a button of the form (`Update Now`, `Apply`): the ink; dim when it cannot act; red when it destroys. */
@Composable
internal fun FormButton(word: String, onClick: () -> Unit, first: Boolean = false, enabled: Boolean = true, destructive: Boolean = false) {
    FormRow(first = first, onClick = if (enabled) onClick else null) {
        Text(word, color = if (!enabled) Theme.inkDim else if (destructive) Theme.failed else Theme.ink, style = plain(16), maxLines = 1)
    }
}

/** A row that says something under the group's rows, in a footnote's size. */
@Composable
internal fun FormNote(text: String, color: Color = Theme.secondaryInk, first: Boolean = false) {
    FormRow(first = first) { Text(text, color = color, style = plain(13)) }
}

/** The iPhone's `LabeledContent`: its name at the left, the value (short words, so monospaced in the pixel look) at the right. */
@Composable
internal fun ValueRow(label: String, value: String, first: Boolean = false, color: Color = Theme.secondaryInk, size: Int = 13, maxLines: Int = 1) {
    FormRow(first = first) {
        Text(label, color = Theme.ink, style = plain(16), maxLines = 1)
        Spacer(Modifier.width(4.dp))
        Text(value, Modifier.weight(1f), color = color, style = mono(size), textAlign = TextAlign.End, maxLines = maxLines, overflow = TextOverflow.Ellipsis)
    }
}

/** A row that opens another page: its content, then a chevron. */
@Composable
internal fun NavRow(onClick: () -> Unit, first: Boolean = false, content: @Composable RowScope.() -> Unit) {
    FormRow(first = first, onClick = onClick) {
        content()
        LookGlyph("›", LookSymbol.ChevronRight, color = Theme.inkDim, size = 13)
    }
}

/** A row with a switch at the right (Material's, which is what the system draws). */
@Composable
internal fun SwitchRow(title: String, checked: Boolean, onChange: (Boolean) -> Unit, first: Boolean = false, enabled: Boolean = true) {
    FormRow(first = first) {
        Text(title, Modifier.weight(1f), color = if (enabled) Theme.ink else Theme.secondaryInk, style = plain(16), maxLines = 2)
        Switch(
            checked, onChange, enabled = enabled,
            colors = androidx.compose.material3.SwitchDefaults.colors(checkedThumbColor = Color.White, checkedTrackColor = Theme.signal, checkedBorderColor = Theme.signal),
        )
    }
}

/** A line to type into, ending at the row's right (the iPhone's `TextField` in a `LabeledContent`): `placeholder` while empty. */
@Composable
internal fun RightField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    style: TextStyle = plain(16),
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    keyboardActions: KeyboardActions = KeyboardActions.Default,
    visualTransformation: VisualTransformation = VisualTransformation.None,
) {
    val ink = style.copy(color = Theme.ink, textAlign = TextAlign.End)
    BasicTextField(
        value, onValueChange, modifier, singleLine = true, textStyle = ink, cursorBrush = SolidColor(Theme.signal),
        keyboardOptions = keyboardOptions, keyboardActions = keyboardActions, visualTransformation = visualTransformation,
        decorationBox = { inner ->
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
                if (value.isEmpty()) Text(placeholder, Modifier.fillMaxWidth(), color = Theme.inkDim, style = ink, maxLines = 1)
                inner()
            }
        },
    )
}

/** The mark of a choice among several or of one among many, as the look draws it: `<x>` / `< >` and `[x]` / `[ ]`, or a ring / a box. */
@Composable
internal fun ChoiceMark(on: Boolean, box: Boolean) {
    if (LocalLook.current.isClassic) {
        if (box) {
            Box(
                Modifier.size(18.dp).clip(RoundedCornerShape(4.dp)).then(if (on) Modifier.background(Theme.signal) else Modifier.border(1.5.dp, Theme.secondaryInk, RoundedCornerShape(4.dp))),
                contentAlignment = Alignment.Center,
            ) { if (on) Text("✓", color = Theme.onFill, style = plain(12, androidx.compose.ui.text.font.FontWeight.Bold)) }
        } else {
            LookGlyph("", if (on) LookSymbol.CheckCircleFill else LookSymbol.Circle, color = if (on) Theme.signal else Theme.secondaryInk, size = 20, scale = 0.9f)
        }
    } else {
        val word = if (box) (if (on) "[x]" else "[ ]") else (if (on) "<x>" else "< >")
        Text(word, color = if (on) Theme.ink else Theme.secondaryInk, style = mono(13))
    }
}

/**
 * A row taken away by swiping it to the left (the iPhone's `onDelete`): a red `Delete` shows under it as it goes. The
 * row itself stays until the list that holds it changes.
 */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
internal fun SwipeRow(onDelete: () -> Unit, content: @Composable () -> Unit) {
    val state = androidx.compose.material3.rememberSwipeToDismissBoxState(
        confirmValueChange = {
            if (it == androidx.compose.material3.SwipeToDismissBoxValue.EndToStart) onDelete()
            false
        },
    )
    androidx.compose.material3.SwipeToDismissBox(
        state,
        enableDismissFromStartToEnd = false,
        backgroundContent = {
            Box(Modifier.fillMaxSize().background(Theme.failed).padding(end = 18.dp), contentAlignment = Alignment.CenterEnd) {
                Text("Delete", color = Color.White, style = plain(15), maxLines = 1)
            }
        },
    ) { Box(Modifier.fillMaxWidth().background(Theme.raised)) { content() } }
}

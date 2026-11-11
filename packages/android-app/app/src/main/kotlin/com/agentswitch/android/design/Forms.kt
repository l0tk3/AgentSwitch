package com.agentswitch.android.design

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

// The pages a standard app would build from the system's own lists (the iPhone's `Form`, `NavigationStack`): a bar
// with a title, grouped rows. docs/ui-v0.md §7.4: the system's forms keep their round groups in the pixel look too —
// only their labels (`// Label`) and their values (monospaced) are the look's.

/**
 * The bar at the top of a page: the title in the middle, what leads back at the left, the page's actions at the right.
 * It keeps clear of the status bar; a hair rule under it.
 */
@Composable
fun NavBar(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: (@Composable () -> Unit)? = null,
    /** Drawn before the title (the Dispatch tab's mark). */
    mark: (@Composable () -> Unit)? = null,
    /** Replaces the title's text (the Mac switcher); `title` stays its words for the bar's semantics. */
    titleContent: (@Composable () -> Unit)? = null,
    ground: Color = Theme.base,
    leading: @Composable RowScope.() -> Unit = {},
    trailing: @Composable RowScope.() -> Unit = {},
) {
    Column(modifier.fillMaxWidth().background(ground).windowInsetsPadding(WindowInsets.statusBars)) {
        Box(Modifier.fillMaxWidth().height(48.dp)) {
            Row(Modifier.align(Alignment.CenterStart).padding(start = 8.dp), verticalAlignment = Alignment.CenterVertically, content = leading)
            Column(Modifier.align(Alignment.Center).padding(horizontal = 96.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    mark?.invoke()
                    if (titleContent != null) titleContent() else Text(title, color = Theme.ink, style = plain(17, FontWeight.SemiBold), maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                subtitle?.invoke()
            }
            Row(Modifier.align(Alignment.CenterEnd).padding(end = 8.dp), verticalAlignment = Alignment.CenterVertically, content = trailing)
        }
        HairRule()
    }
}

/** A word in a bar that acts (`Cancel`, `Done`, `New`): the look's short-word font, the ink; dim when it cannot act. */
@Composable
fun BarWord(word: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, color: Color = Theme.ink) {
    Text(
        word,
        modifier.clip(RoundedCornerShape(6.dp)).clickable(enabled, role = Role.Button, onClick = onClick).padding(horizontal = 10.dp, vertical = 10.dp),
        color = if (enabled) color else Theme.inkDim,
        style = mono(16),
        maxLines = 1,
    )
}

/** `‹ Back`: what leads back from a page. */
@Composable
fun BarBack(onClick: () -> Unit, word: String = "Back") {
    Row(
        Modifier.clip(RoundedCornerShape(6.dp)).clickable(role = Role.Button, onClickLabel = word, onClick = onClick).padding(horizontal = 8.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("‹", color = Theme.ink, style = plain(24), modifier = Modifier.padding(end = 4.dp, bottom = 3.dp))
        Text(word, color = Theme.ink, style = plain(17), maxLines = 1)
    }
}

/** A page of grouped rows under a bar, scrolling, clear of the system's bars and the keyboard. */
@Composable
fun FormPage(
    title: String,
    modifier: Modifier = Modifier,
    leading: @Composable RowScope.() -> Unit = {},
    trailing: @Composable RowScope.() -> Unit = {},
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(modifier.fillMaxSize().background(Theme.base)) {
        NavBar(title, leading = leading, trailing = trailing)
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState())
                .windowInsetsPadding(WindowInsets.safeDrawing.excludeTop())
                .padding(horizontal = 16.dp, vertical = 8.dp),
            content = content,
        )
    }
}

/** The safe area without its top (a bar above has taken that). */
@Composable
private fun WindowInsets.excludeTop(): WindowInsets = object : WindowInsets {
    override fun getTop(density: androidx.compose.ui.unit.Density) = 0
    override fun getBottom(density: androidx.compose.ui.unit.Density) = this@excludeTop.getBottom(density)
    override fun getLeft(density: androidx.compose.ui.unit.Density, layoutDirection: androidx.compose.ui.unit.LayoutDirection) = this@excludeTop.getLeft(density, layoutDirection)
    override fun getRight(density: androidx.compose.ui.unit.Density, layoutDirection: androidx.compose.ui.unit.LayoutDirection) = this@excludeTop.getRight(density, layoutDirection)
}

/** A group of rows: its label above (`// Label`), a sentence under it when it needs saying. */
@Composable
fun FormSection(label: String? = null, footer: String? = null, modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(modifier.fillMaxWidth().padding(top = 14.dp)) {
        if (label != null) SectionLabel(label, Modifier.padding(start = 16.dp, bottom = 7.dp))
        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Theme.raised), content = content)
        if (footer != null) Text(footer, Modifier.padding(start = 16.dp, end = 16.dp, top = 7.dp), color = Theme.secondaryInk, style = plain(13))
    }
}

/** One row of a group: any content, at the row's height and margins; a hair rule above every row but the first. */
@Composable
fun FormRow(modifier: Modifier = Modifier, first: Boolean = false, onClick: (() -> Unit)? = null, content: @Composable RowScope.() -> Unit) {
    Column(Modifier.fillMaxWidth()) {
        if (!first) HairRule(Modifier.padding(start = 16.dp))
        Row(
            modifier.fillMaxWidth().then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
                .defaultMinSize(minHeight = 46.dp).padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            content = content,
        )
    }
}

/** A row that says one thing about the page's subject: its name at the left, the value at the right. */
@Composable
fun LabeledRow(label: String, value: String, first: Boolean = false, monoValue: Boolean = false) {
    FormRow(first = first) {
        Text(label, color = Theme.ink, style = plain(16), maxLines = 1)
        Spacer(Modifier.width(4.dp))
        Text(
            value, Modifier.weight(1f), color = Theme.secondaryInk, style = if (monoValue) mono(13) else plain(16),
            textAlign = TextAlign.End, maxLines = 2, overflow = TextOverflow.Ellipsis,
        )
    }
}

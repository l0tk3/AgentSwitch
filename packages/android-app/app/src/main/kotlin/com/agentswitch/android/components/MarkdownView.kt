package com.agentswitch.android.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.IntrinsicSize.Max
import androidx.compose.foundation.layout.IntrinsicSize.Min
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.agentswitch.android.design.Fonts
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.plain
import com.agentswitch.kit.feed.InlineText
import com.agentswitch.kit.feed.Markdown
import com.agentswitch.kit.feed.MarkdownBlock

// Model output rendered by blocks (AgentSwitchKit `Markdown`): headings, lists, quotes, code (CodeBlock) and tables,
// with inline Markdown inside each (its code on the code wash). A link tapped is handed to `LocalOpenLink` (the iPhone:
// RootView's `openURL`, which opens it in the Mac's shared browser on the Browser tab, Safari when the Mac has none);
// images are never loaded, only their alt text shows. (ios-app App/Sources/Components/MarkdownView.swift)

/** Where a tapped link goes; the root provides it. Nothing happens by default. */
val LocalOpenLink = compositionLocalOf<(String) -> Unit> { { } }

/**
 * Inline runs as an `AnnotatedString`: bold, italic, strikethrough, code (mono, on the `wash`) and links (clickable,
 * in `linkColor`, calling `onLink`).
 */
fun inlineAnnotated(text: InlineText, onLink: (String) -> Unit, linkColor: Color, wash: Color): AnnotatedString = buildAnnotatedString {
    for (run in text.runs) {
        val style = SpanStyle(
            fontWeight = if (run.bold) FontWeight.Bold else null,
            fontStyle = if (run.italic) FontStyle.Italic else null,
            fontFamily = if (run.code) Fonts.mono else null,
            background = if (run.code) wash else Color.Unspecified,
            textDecoration = if (run.strikethrough) TextDecoration.LineThrough else null,
        )
        val url = run.link
        if (url != null) {
            val link = LinkAnnotation.Url(
                url,
                TextLinkStyles(SpanStyle(color = linkColor, textDecoration = TextDecoration.Underline)),
            ) { onLink(url) }
            withLink(link) { withStyle(style) { append(run.text) } }
        } else {
            withStyle(style) { append(run.text) }
        }
    }
}

@Composable
private fun inline(text: String): AnnotatedString {
    val onLink = LocalOpenLink.current
    val signal = Theme.signal
    val wash = Theme.code
    return remember(text, onLink, signal, wash) { inlineAnnotated(Markdown.inline(text), onLink, signal, wash) }
}

@Composable
fun MarkdownView(text: String, modifier: Modifier = Modifier) {
    val blocks = remember(text) { Markdown.readableBlocks(text) }
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (block in blocks) BlockView(block)
    }
}

@Composable
private fun BlockView(block: MarkdownBlock) {
    when (block) {
        is MarkdownBlock.Heading -> {
            val style = when (block.level) {
                1 -> plain(20, FontWeight.Bold)
                2 -> plain(17, FontWeight.SemiBold)
                else -> plain(15, FontWeight.Bold)
            }
            Text(inline(block.text), Modifier.padding(top = 2.dp), color = Theme.ink, style = style)
        }
        is MarkdownBlock.Paragraph -> Text(inline(block.text), color = Theme.ink, style = plain(17))
        is MarkdownBlock.ListItem -> Row(Modifier.padding(start = (block.depth * 16).dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(
                block.ordinal?.let { "$it." } ?: "•",
                Modifier.alignByBaseline(), color = Theme.secondaryInk, style = plain(17).copy(fontFeatureSettings = "tnum"),
            )
            Text(inline(block.text), Modifier.alignByBaseline(), color = Theme.ink, style = plain(17))
        }
        is MarkdownBlock.Quote -> Row(Modifier.height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.width(3.dp).fillMaxHeight().background(Theme.inkDim))
            Text(inline(block.text), color = Theme.secondaryInk, style = plain(17))
        }
        is MarkdownBlock.Code -> CodeBlock(block.text, language = block.language)
        is MarkdownBlock.Table -> TableView(block)
        MarkdownBlock.Rule -> Box(Modifier.fillMaxWidth().height(1.dp).background(Theme.line))
    }
}

/** A table: columns as wide as their widest cell, the header bold over a rule, scrolling sideways when wider than the page. */
@Composable
private fun TableView(table: MarkdownBlock.Table) {
    val columns = table.header.size
    Row(
        Modifier.fillMaxWidth().background(Theme.raised).border(1.dp, Theme.line, RectangleShape)
            .horizontalScroll(rememberScrollState()).padding(10.dp),
    ) {
        for (c in 0 until columns) {
            val last = c == columns - 1
            Column(Modifier.width(Max)) {
                val pad = Modifier.padding(end = if (last) 0.dp else 14.dp)
                Text(inline(table.header[c]), pad.padding(vertical = 3.dp), color = Theme.ink, style = plain(16, FontWeight.Bold), softWrap = false)
                Box(Modifier.fillMaxWidth().padding(vertical = 3.dp).height(1.dp).background(Theme.line))
                for (row in table.rows) {
                    Text(inline(row.getOrElse(c) { "" }), pad.padding(vertical = 3.dp), color = Theme.ink, style = plain(16), softWrap = false)
                }
            }
        }
    }
}

package com.agentswitch.android.components

import android.content.ClipData
import androidx.compose.foundation.border
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentswitch.android.design.LocalLook
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.code
import com.agentswitch.android.design.lookShape
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.kit.feed.Markdown
import com.agentswitch.kit.feed.MarkdownBlock
import com.agentswitch.kit.feed.ShellHighlight
import com.agentswitch.kit.feed.codeSpans
import com.agentswitch.kit.feed.typedBlocks
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// Code in Dispatch (docs/dispatch-v0.md §2, demo `app.html` `.cb`, 2026-10-03, user: dispatch里加上代码块支持吧 …… 手机上也
// 是): a fenced block in the mono font on the code wash, square, framed; one line per line — a long one scrolls sideways
// rather than wrapping, since on a phone a command wrapped over two lines reads as two — its language and `Copy` above
// it. Inline code sits on the same wash. What a person typed is read for code only (TypedText); model output is Markdown.
// (ios-app App/Sources/Components/CodeBlock.swift)

private val shellLanguages = setOf("sh", "bash", "zsh", "shell", "console", "shell-session")

/** A shell command in colour, as the terminal record draws a command (ShellHighlight): commands in the signal colour, strings green, comments faint. */
@Composable
fun shellColoured(command: String): AnnotatedString {
    val signal = Theme.signal
    val string = Theme.done
    val comment = Theme.ink.copy(alpha = 0.4f)
    val plain = Theme.ink
    return buildAnnotatedString {
        for (run in ShellHighlight.runs(command)) {
            val color = when (run.kind) {
                ShellHighlight.Kind.Command -> signal
                ShellHighlight.Kind.String -> string
                ShellHighlight.Kind.Comment -> comment
                ShellHighlight.Kind.Plain -> plain
            }
            withStyle(SpanStyle(color = color)) { append(run.text) }
        }
    }
}

/**
 * A fenced block; `Copy` puts its text on the clipboard (`Copied` for a moment). A shell block (`language` sh, bash,
 * zsh …) is coloured as a command; any other is plain ink.
 */
@Composable
fun CodeBlock(code: String, modifier: Modifier = Modifier, language: String? = null) {
    var copied by remember { mutableStateOf(false) }
    val clipboard = LocalClipboard.current
    val haptic = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    val shape = lookShape(6.dp)
    val body: AnnotatedString = if (language?.lowercase() in shellLanguages) shellColoured(code) else AnnotatedString(code)
    Column(modifier.fillMaxWidth().background(Theme.code, shape).border(1.dp, Theme.line, shape)) {
        Row(Modifier.fillMaxWidth().padding(start = 10.dp, end = 10.dp, top = 2.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (language != null) Text(language, Modifier.weight(1f), color = Theme.inkDim, style = mono(11), maxLines = 1)
            else androidx.compose.foundation.layout.Spacer(Modifier.weight(1f))
            Text(
                if (copied) "Copied" else "Copy",
                Modifier.clickable(remember { MutableInteractionSource() }, null, role = Role.Button) {
                    scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("code", code))) }
                    haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                    copied = true
                }.padding(top = 4.dp, bottom = 4.dp, start = 16.dp).semantics { contentDescription = "拷贝代码" },
                color = if (copied) Theme.signal else Theme.secondaryInk, style = mono(11),
            )
        }
        SelectionContainer {
            Text(
                body,
                Modifier.horizontalScroll(rememberScrollState()).padding(start = 10.dp, end = 10.dp, top = 2.dp, bottom = 9.dp),
                color = Theme.ink, style = code(13), softWrap = false,
            )
        }
    }
    LaunchedEffect(copied) { if (copied) { delay(1200); copied = false } }
}

/**
 * What a person typed, as typed (Markdown.typedBlocks): fenced blocks drawn as code, backtick spans on the code wash,
 * and nothing else read — a `*` or `#` they typed stays.
 */
@Composable
fun TypedText(text: String, modifier: Modifier = Modifier, fontSize: Int = 17, weight: FontWeight = FontWeight.Normal) {
    val blocks = remember(text) { Markdown.typedBlocks(text) }
    val wash = Theme.code
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (block in blocks) {
            when (block) {
                is MarkdownBlock.Code -> CodeBlock(block.text, language = block.language)
                is MarkdownBlock.Paragraph -> Text(inlineAnnotated(Markdown.codeSpans(block.text), {}, Color.Unspecified, wash), color = Theme.ink, style = plain(fontSize, weight))
                else -> Unit
            }
        }
    }
}

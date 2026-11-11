package com.agentswitch.android.design

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentswitch.android.R
import com.agentswitch.kit.design.ClassicWords

// The interface's look on the phone (docs/ui-v0.md §8): `pixel`, the visual language of §7, or `classic`, a standard
// app's. The look is handed down from the root (AgentSwitchTheme); the shared parts each draw by it, so the pages are
// written once.

/** The interface's monospace: JetBrains Mono (its licence is in the package's `licenses/`), one file for every weight. */
object Fonts {
    @OptIn(ExperimentalTextApi::class)
    private fun weight(w: FontWeight) = Font(R.font.jetbrains_mono, weight = w, variationSettings = FontVariation.Settings(FontVariation.weight(w.weight)))

    val mono: FontFamily = FontFamily(weight(FontWeight.Normal), weight(FontWeight.Medium), weight(FontWeight.SemiBold), weight(FontWeight.Bold))
}

/** The sizes the iPhone's text styles have, so a page reads the same on both phones (points there, sp here). */
object Type {
    val largeTitle = 34.sp
    val title2 = 22.sp
    val title3 = 20.sp
    val headline = 17.sp
    val body = 17.sp
    val callout = 16.sp
    val subheadline = 15.sp
    val footnote = 13.sp
    val caption = 12.sp
    val caption2 = 11.sp
}

/** Short words (states, labels, values): monospaced in the pixel look (§7.2.7), the system font in the classic one. */
@Composable
@ReadOnlyComposable
fun mono(size: Int = 12, weight: FontWeight = FontWeight.Normal): TextStyle =
    TextStyle(fontSize = size.sp, fontWeight = weight, fontFamily = if (LocalLook.current.isClassic) FontFamily.Default else Fonts.mono)

/** Code, commands and paths: monospaced in both looks. */
fun code(size: Int = 12, weight: FontWeight = FontWeight.Normal): TextStyle =
    TextStyle(fontSize = size.sp, fontWeight = weight, fontFamily = Fonts.mono)

/** Text people read: the system's font. */
fun plain(size: Int = 17, weight: FontWeight = FontWeight.Normal): TextStyle = TextStyle(fontSize = size.sp, fontWeight = weight)

/** The shape of a frame or a ground: square in the pixel look, round by `radius` in the classic one. */
@Composable
@ReadOnlyComposable
fun lookShape(radius: Dp = 10.dp): Shape = if (LocalLook.current.isClassic) RoundedCornerShape(radius) else RectangleShape

/** A 1 dp frame: square in the pixel look, round in the classic one. */
fun Modifier.framed(color: Color, radius: Dp = 10.dp): Modifier = composed { border(1.dp, color, lookShape(radius)) }

/** A ground: square in the pixel look, round in the classic one. */
fun Modifier.grounded(color: Color, radius: Dp = 10.dp): Modifier = composed { background(color, lookShape(radius)) }

/** A short word as the look writes it (`Waiting` → `Needs You`; ClassicWords). */
@Composable
@ReadOnlyComposable
fun lookWord(text: String): String = ClassicWords.word(text, LocalLook.current)

/** A line of short words joined by ` · `, each as the look writes it. */
@Composable
@ReadOnlyComposable
fun lookPhrase(text: String): String = ClassicWords.phrase(text, LocalLook.current)

/** A button's word: `[ Allow ]`, or the word alone in the classic look. */
@Composable
@ReadOnlyComposable
fun buttonWord(word: String): String = ClassicWords.button(word, LocalLook.current)

/** A group's label: `// Status`, or `Status` in the classic look. */
@Composable
@ReadOnlyComposable
fun labelWord(text: String): String = ClassicWords.label(text, LocalLook.current)

/** One level of container: a 1 dp frame, square (§7.2.1). In the classic look a round card on its own ground. */
fun Modifier.card(): Modifier = composed {
    if (LocalLook.current.isClassic) background(Theme.panel, RoundedCornerShape(Theme.Radius.card)) else border(1.dp, Theme.line, RectangleShape)
}

/** `text` in a style, in the ink unless told otherwise: the one-line way most labels are written. */
@Composable
fun Label(text: String, style: TextStyle, color: Color = Theme.ink, modifier: Modifier = Modifier, maxLines: Int = Int.MAX_VALUE) {
    Text(text, modifier = modifier, color = color, style = style, maxLines = maxLines, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
}

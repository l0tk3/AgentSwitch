package com.agentswitch.android.design

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ProvideTextStyle
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentswitch.kit.design.InterfaceLook

// The shared look (docs/ui-v0.md §7, visual language v1): pixel / character / signal, restrained. One signal colour
// (pink #E0106E / #FF2E88) for selection, the brand mark and the primary button; status colours only for status,
// always with a shape or a word; square corners and 1 px lines outside the system's own controls.
// In the classic look (§8) the same names give a standard app's values: blue for the signal, the usual status
// colours, grouped grounds, round corners.
//
// The values are the iPhone app's (ios-app App/Sources/Design/Theme.swift), one for one: the two phones are one design.

/** Every colour of the interface in one look and one of light or dark. */
@Immutable
class Palette(
    val dark: Boolean,
    val signal: Color,
    /** At work: cyan; the accent in the classic look (one colour for what is yours to see moving). */
    val busy: Color,
    val waiting: Color,
    val done: Color,
    val failed: Color,
    /** The page under the conversation and a task: black, or paper in light mode. */
    val base: Color,
    val ink: Color,
    val inkDim: Color,
    /** §7.3's 次 (second ink): what is read second; the lower edge of a solid key cap, and the cap while pressed. */
    val secondaryInk: Color,
    /** 1 px lines: card frames, rules. */
    val line: Color,
    /** What you said: a raised box, not a coloured bubble (the signal colour is not for text backgrounds). */
    val raised: Color,
    /** A card's or a floating layer's own ground in the classic look (the pixel look frames them on the page's). */
    val panel: Color,
    val pixelShadow: Color,
    /** The highest thinking level's own colour (docs/terminal-v0.md §1 “滑块”): violet, and the deeper blue its line begins in. */
    val top: Color,
    val topDeep: Color,
    /** The primary button's fill: ink, with the page's colour on it; the signal colour only while pressed (§7.2.3). */
    val fill: Color,
    /** What is written on the primary button's fill. */
    val onFill: Color,
) {
    /** Code's ground: a wash of ink, so a block or a span stands out on the page and in your raised box alike. */
    val code: Color get() = ink.copy(alpha = 0.07f)

    companion object {
        private fun rgb(value: Long) = Color(0xFF000000 or value)

        // §7.3, dark / light; then the classic look's (§8).
        val pixelDark = Palette(
            dark = true, signal = rgb(0xFF2E88), busy = rgb(0x2EE6FF), waiting = rgb(0xFFB000), done = rgb(0x9BE22D), failed = rgb(0xFF4A3D),
            base = rgb(0x000000), ink = rgb(0xE9E6DF), inkDim = rgb(0x4D4B48), secondaryInk = rgb(0x8D8A84), line = rgb(0x262524),
            raised = rgb(0x161514), panel = rgb(0x000000), pixelShadow = rgb(0x2C2A28), top = rgb(0xA98BFF), topDeep = rgb(0x4B4FE0),
            fill = rgb(0xE9E6DF), onFill = rgb(0x000000),
        )
        val pixelLight = Palette(
            dark = false, signal = rgb(0xE0106E), busy = rgb(0x0086A8), waiting = rgb(0xC27400), done = rgb(0x3F8F00), failed = rgb(0xD7261B),
            base = rgb(0xF3F1EA), ink = rgb(0x151413), inkDim = rgb(0xA29D93), secondaryInk = rgb(0x5F5B54), line = rgb(0xD3CEC3),
            raised = rgb(0xE6E2D8), panel = rgb(0xF3F1EA), pixelShadow = rgb(0xCFC9BC), top = rgb(0x7A3CF0), topDeep = rgb(0x3B3FD8),
            fill = rgb(0x151413), onFill = rgb(0xF3F1EA),
        )
        val classicDark = Palette(
            dark = true, signal = rgb(0x0A84FF), busy = rgb(0x0A84FF), waiting = rgb(0xFF9F0A), done = rgb(0x30D158), failed = rgb(0xFF453A),
            base = rgb(0x000000), ink = rgb(0xF2F2F7), inkDim = rgb(0x6C6C72), secondaryInk = rgb(0xA2A2A8), line = rgb(0x38383A),
            raised = rgb(0x2C2C2E), panel = rgb(0x1C1C1E), pixelShadow = rgb(0x2C2A28), top = rgb(0xA58BFF), topDeep = rgb(0x3D4BE0),
            fill = rgb(0x0A84FF), onFill = rgb(0xFFFFFF),
        )
        val classicLight = Palette(
            dark = false, signal = rgb(0x007AFF), busy = rgb(0x007AFF), waiting = rgb(0xFF9500), done = rgb(0x34C759), failed = rgb(0xFF3B30),
            base = rgb(0xF2F2F7), ink = rgb(0x1D1D1F), inkDim = rgb(0xA6A6AB), secondaryInk = rgb(0x6E6E73), line = rgb(0xDCDCE0),
            raised = rgb(0xE9E9EB), panel = rgb(0xFFFFFF), pixelShadow = rgb(0xCFC9BC), top = rgb(0x8E5CF7), topDeep = rgb(0x2F3DC8),
            fill = rgb(0x007AFF), onFill = rgb(0xFFFFFF),
        )

        fun of(look: InterfaceLook, dark: Boolean): Palette =
            if (look.isClassic) (if (dark) classicDark else classicLight) else (if (dark) pixelDark else pixelLight)
    }
}

val LocalPalette = staticCompositionLocalOf { Palette.pixelDark }

/** The look the views under this draw in (docs/ui-v0.md §8). */
val LocalLook = staticCompositionLocalOf { InterfaceLook.Pixel }

object Theme {
    object Space {
        val xs = 4.dp
        val s = 8.dp
        val m = 12.dp
        val l = 16.dp
        val xl = 24.dp

        /** Between items of the conversation. */
        val item = 20.dp
    }

    /** Square everywhere outside the system's own controls (§7.2.1); round in the classic look (§8). */
    object Radius {
        val card: Dp @Composable @ReadOnlyComposable get() = if (LocalLook.current.isClassic) 12.dp else 0.dp
        val bubble: Dp @Composable @ReadOnlyComposable get() = if (LocalLook.current.isClassic) 17.dp else 0.dp
        val control: Dp @Composable @ReadOnlyComposable get() = if (LocalLook.current.isClassic) 8.dp else 0.dp
    }

    val palette: Palette @Composable @ReadOnlyComposable get() = LocalPalette.current
    val signal: Color @Composable @ReadOnlyComposable get() = LocalPalette.current.signal
    val busy: Color @Composable @ReadOnlyComposable get() = LocalPalette.current.busy
    val waiting: Color @Composable @ReadOnlyComposable get() = LocalPalette.current.waiting
    val done: Color @Composable @ReadOnlyComposable get() = LocalPalette.current.done
    val failed: Color @Composable @ReadOnlyComposable get() = LocalPalette.current.failed
    val base: Color @Composable @ReadOnlyComposable get() = LocalPalette.current.base
    val ink: Color @Composable @ReadOnlyComposable get() = LocalPalette.current.ink
    val inkDim: Color @Composable @ReadOnlyComposable get() = LocalPalette.current.inkDim
    val secondaryInk: Color @Composable @ReadOnlyComposable get() = LocalPalette.current.secondaryInk
    val line: Color @Composable @ReadOnlyComposable get() = LocalPalette.current.line
    val raised: Color @Composable @ReadOnlyComposable get() = LocalPalette.current.raised
    val panel: Color @Composable @ReadOnlyComposable get() = LocalPalette.current.panel
    val code: Color @Composable @ReadOnlyComposable get() = LocalPalette.current.code
    val pixelShadow: Color @Composable @ReadOnlyComposable get() = LocalPalette.current.pixelShadow
    val top: Color @Composable @ReadOnlyComposable get() = LocalPalette.current.top
    val topDeep: Color @Composable @ReadOnlyComposable get() = LocalPalette.current.topDeep
    val fill: Color @Composable @ReadOnlyComposable get() = LocalPalette.current.fill
    val onFill: Color @Composable @ReadOnlyComposable get() = LocalPalette.current.onFill

    /** Whether the page is drawn dark. */
    val isDark: Boolean @Composable @ReadOnlyComposable get() = LocalPalette.current.dark
}

/** A colour by its 24-bit value, as the kit's pictures give theirs. */
fun colorOf(rgb: Int): Color = Color(0xFF000000 or (rgb.toLong() and 0xFFFFFF))
fun colorOf(rgb: Long): Color = Color(0xFF000000 or (rgb and 0xFFFFFF))

/**
 * The root of a screen: the look's colours handed down, and the system's own controls (switches, dialogs, text
 * fields' cursors) tinted to match — the signal colour is theirs to select with, nothing else of Material shows through.
 * `dark`: the system's choice unless a page fixes it (a terminal's screen is always dark, docs/ui-v0.md §3b).
 */
@Composable
fun AgentSwitchTheme(look: InterfaceLook, dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val palette = Palette.of(look, dark)
    val scheme = if (dark) {
        darkColorScheme(
            primary = palette.signal, onPrimary = Color.Black, secondary = palette.ink, onSecondary = palette.base,
            background = palette.base, onBackground = palette.ink, surface = palette.base, onSurface = palette.ink,
            surfaceVariant = palette.raised, onSurfaceVariant = palette.secondaryInk, outline = palette.line, outlineVariant = palette.line,
            error = palette.failed, surfaceContainer = palette.raised, surfaceContainerHigh = palette.raised, surfaceContainerHighest = palette.raised,
            surfaceContainerLow = palette.panel, surfaceContainerLowest = palette.base, primaryContainer = palette.raised, onPrimaryContainer = palette.ink,
            secondaryContainer = palette.raised, onSecondaryContainer = palette.ink,
        )
    } else {
        lightColorScheme(
            primary = palette.signal, onPrimary = Color.White, secondary = palette.ink, onSecondary = palette.base,
            background = palette.base, onBackground = palette.ink, surface = palette.base, onSurface = palette.ink,
            surfaceVariant = palette.raised, onSurfaceVariant = palette.secondaryInk, outline = palette.line, outlineVariant = palette.line,
            error = palette.failed, surfaceContainer = palette.raised, surfaceContainerHigh = palette.raised, surfaceContainerHighest = palette.raised,
            surfaceContainerLow = palette.panel, surfaceContainerLowest = palette.base, primaryContainer = palette.raised, onPrimaryContainer = palette.ink,
            secondaryContainer = palette.raised, onSecondaryContainer = palette.ink,
        )
    }
    CompositionLocalProvider(LocalPalette provides palette, LocalLook provides look) {
        MaterialTheme(colorScheme = scheme) {
            CompositionLocalProvider(LocalContentColor provides palette.ink) {
                ProvideTextStyle(TextStyle(fontSize = 17.sp, color = palette.ink), content)
            }
        }
    }
}

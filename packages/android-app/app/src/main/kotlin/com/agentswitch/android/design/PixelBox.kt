package com.agentswitch.android.design

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role as SemanticsRole
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.max

/**
 * A floating box on the cell grid, as the desktop's confirm boxes and menus (docs/design/implemented/phone.html;
 * ios-app App/Sources/Design/PixelBox.swift): a 1 dp ink frame, square, a dithered hard shadow, a head bar in a status
 * colour, the words in formal Chinese and the buttons as short English words in brackets; it glitches as it opens. A
 * confirm box dims what is under it; a menu sits by the row it belongs to. A tap outside (or the system back gesture)
 * is cancel.
 * In the classic look (docs/ui-v0.md §8) the same box is a round card with a soft shadow: its head a bold title with
 * the tone as a dot, its buttons standard ones, its menu rows plain; nothing glitches.
 */
data class PixelBox(
    val head: String? = null,
    val tone: Tone = Tone.Plain,
    val message: String = "",
    /** The way out first (`[ Cancel ]`); null for a box that only informs, or where a tap outside is the way out. */
    val cancel: String? = "Cancel",
    val actions: List<Action>,
    /**
     * A menu: its actions as rows, placed under (or over) this rectangle, in the host's coordinates (pixels, as
     * `boundsInRoot()` gives them). With a `head`, that is its first line: what the menu is about (a link's whole
     * address, 2026-10-03).
     */
    val anchor: Rect? = null,
    /** A menu wider than the usual (an address reads better whole). */
    val width: Dp = menuWidth,
) {
    enum class Tone { Plain, Amber, Red, Signal }

    data class Action(val label: String, val role: Role = Role.Normal, val run: () -> Unit) {
        enum class Role { Normal, Primary, Destructive }
    }

    companion object {
        val menuWidth: Dp = 180.dp
    }
}

/** What a page hands a box to: [PixelBoxHost] draws it. */
@Stable
class PixelBoxState {
    internal class Shown(val box: PixelBox, val owner: Any, val close: () -> Unit)

    internal var shown by mutableStateOf<Shown?>(null)
        private set

    /** Open `box` for `owner`; `close` is what a tap outside, the back gesture or a button calls to say it is done. A box shown over another closes that one first. */
    fun show(box: PixelBox, owner: Any, close: () -> Unit) {
        shown?.let { if (it.owner !== owner) it.close() }
        shown = Shown(box, owner, close)
    }

    /** Close the box `owner` opened, if it is still the one showing. */
    fun hide(owner: Any) {
        if (shown?.owner === owner) shown = null
    }
}

val LocalPixelBox = staticCompositionLocalOf<PixelBoxState> { error("PixelBoxHost is missing above this page") }

/**
 * The root of the boxes. On the iPhone a window of its own above everything holds the box open, so the page under it
 * keeps its keyboard and its text field's focus. Here the veil and the box are drawn over the page in the same
 * composition, by this host at the root (not a `Dialog` or a focusable `Popup`: those take the keyboard's focus);
 * the page is drawn first, the box over it. The system back gesture closes the box.
 */
@Composable
fun PixelBoxHost(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val state = remember { PixelBoxState() }
    val shown = state.shown
    Box(modifier.fillMaxSize()) {
        CompositionLocalProvider(LocalPixelBox provides state) { content() }
        if (shown != null) PixelBoxLayer(shown.box, shown.close)
    }
    BackHandler(enabled = shown != null) { shown?.close?.invoke() }
}

/**
 * Shows a box while `item` is non-null (and for as long as it stays so); a button, a tap outside or the back gesture
 * calls `onDismiss`, which is to clear the item (state is hoisted: the page owns it). `make` is asked once as the item
 * is set. The Swift's `pixelBox(item:)`.
 */
@Composable
fun <Item : Any> PixelBoxEffect(item: Item?, onDismiss: () -> Unit, make: (Item) -> PixelBox) {
    val state = LocalPixelBox.current
    val owner = remember { Any() }
    val makeNow by rememberUpdatedState(make)
    val dismissNow by rememberUpdatedState(onDismiss)
    LaunchedEffect(item) {
        if (item != null) state.show(makeNow(item), owner) { dismissNow() } else state.hide(owner)
    }
    DisposableEffect(owner) { onDispose { state.hide(owner) } }
}

/** Shows a box while `isPresented`. The Swift's `pixelBox(isPresented:)`. */
@Composable
fun PixelBoxEffect(isPresented: Boolean, onDismiss: () -> Unit, make: () -> PixelBox) {
    PixelBoxEffect(if (isPresented) true else null, onDismiss) { make() }
}

private const val menuRow = 36
/**
 * A menu's first line: up to three lines of small mono text and its padding (about what it comes to: it only decides
 * whether the menu goes under or over its anchor).
 */
private const val menuHead = 58

/** The veil and the box, over the whole screen. */
@Composable
private fun PixelBoxLayer(box: PixelBox, close: () -> Unit) {
    val density = LocalDensity.current.density
    BoxWithConstraints(Modifier.fillMaxSize().semantics { isTraversalGroup = true }) {
        // A menu leaves the screen as it is; a confirm box dims it.
        Box(
            Modifier.fillMaxSize()
                .background(Color.Black.copy(alpha = if (box.anchor == null) 0.45f else 0.001f))
                .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClickLabel = box.cancel ?: "close", role = SemanticsRole.Button, onClick = close),
        )
        val anchor = box.anchor
        if (anchor != null) {
            val origin = menuOrigin(box, anchor, maxWidth.value, maxHeight.value, density)
            Box(Modifier.offset(origin.first.dp, origin.second.dp)) { Menu(box, close) }
        } else {
            Box(Modifier.fillMaxSize().padding(start = 22.dp, end = 28.dp), contentAlignment = Alignment.Center) { Confirm(box, close) }
        }
    }
}

/** Under the row, at the right (as the desktop's); over it when there is no room below. In dp. */
private fun menuOrigin(box: PixelBox, anchor: Rect, width: Float, height: Float, density: Float): Pair<Float, Float> {
    val rowsHeight = box.actions.size * menuRow + 2 + (if (box.head == null) 0 else menuHead)
    val x = max(12f, width - 28 - box.width.value)
    val minY = anchor.top / density
    val below = anchor.bottom / density + 4
    val y = if (below + rowsHeight + 40 < height) below else max(60f, minY - 4 - rowsHeight)
    return x to y
}

@Composable
private fun toneColor(tone: PixelBox.Tone): Color = when (tone) {
    PixelBox.Tone.Plain -> Theme.raised
    PixelBox.Tone.Amber -> Theme.waiting
    PixelBox.Tone.Red -> Theme.failed
    PixelBox.Tone.Signal -> Theme.signal
}

// MARK: confirm

@Composable
private fun Confirm(box: PixelBox, close: () -> Unit) {
    if (LocalLook.current.isClassic) ClassicConfirm(box, close) else PixelConfirm(box, close)
}

/** The classic look's box: a title (the tone as a dot before it), the sentence, standard buttons. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ClassicConfirm(box: PixelBox, close: () -> Unit) {
    val shape = RoundedCornerShape(16.dp)
    Column(Modifier.fillMaxWidth().floatingShadow(shape).background(Theme.panel, shape)) {
        if (box.head != null) {
            Row(Modifier.fillMaxWidth().padding(start = 18.dp, end = 18.dp, top = 18.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                if (box.tone != PixelBox.Tone.Plain) Box(Modifier.size(8.dp).background(toneColor(box.tone), CircleShape))
                Text(box.head, color = Theme.ink, style = plain(16, FontWeight.SemiBold), maxLines = 3, overflow = TextOverflow.Ellipsis)
            }
        }
        if (box.message.isNotEmpty()) {
            Text(box.message, Modifier.padding(start = 18.dp, end = 18.dp, top = if (box.head == null) 18.dp else 8.dp), color = Theme.secondaryInk, style = plain(14).copy(lineHeight = 20.sp))
        }
        FlowRow(
            Modifier.fillMaxWidth().padding(start = 18.dp, end = 18.dp, top = 16.dp, bottom = 16.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.End), verticalArrangement = Arrangement.spacedBy(8.dp),
        ) { Buttons(box, close) }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PixelConfirm(box: PixelBox, close: () -> Unit) {
    Box(Modifier.fillMaxWidth().glitch(0, onAppear = true)) {
        DitherShadow(Modifier.matchParentSize().offset(6.dp, 6.dp))
        Column(Modifier.fillMaxWidth().background(Theme.base).border(1.dp, Theme.ink, RectangleShape)) {
            if (box.head != null) {
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 24.dp).background(toneColor(box.tone)).padding(horizontal = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(box.head, color = if (box.tone == PixelBox.Tone.Plain) Theme.ink else Color.Black, style = mono(12), maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            }
            if (box.message.isNotEmpty()) {
                Text(box.message, Modifier.padding(start = 12.dp, end = 12.dp, top = 10.dp, bottom = 4.dp), color = Theme.secondaryInk, style = plain(13).copy(lineHeight = 19.sp))
            }
            FlowRow(
                Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, top = 8.dp, bottom = 10.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.End), verticalArrangement = Arrangement.spacedBy(6.dp),
            ) { Buttons(box, close) }
        }
    }
}

@Composable
private fun Buttons(box: PixelBox, close: () -> Unit) {
    if (box.cancel != null) BoxButton(box.cancel, PixelBox.Action.Role.Normal, close)
    for (a in box.actions) BoxButton(a.label, a.role) { close(); a.run() }
}

/**
 * A box's button (the web page's .btn): mono words in brackets; the primary one filled with ink, the signal colour
 * while pressed; a destructive one in red. In the classic look a standard button: the primary one filled with the
 * accent, a destructive one with red, the rest on a quiet ground.
 */
@Composable
private fun BoxButton(label: String, role: PixelBox.Action.Role, onClick: () -> Unit) {
    val source = remember { MutableInteractionSource() }
    val pressed = source.collectIsPressedAsState().value
    val click = Modifier.clickable(source, null, role = SemanticsRole.Button, onClick = onClick)
    if (LocalLook.current.isClassic) {
        val fill = when (role) { PixelBox.Action.Role.Primary -> Theme.fill; PixelBox.Action.Role.Destructive -> Theme.failed; else -> Theme.raised }
        Text(
            buttonWord(label),
            Modifier.alpha(if (pressed) 0.7f else 1f).background(fill, RoundedCornerShape(10.dp)).then(click).padding(horizontal = 16.dp, vertical = 8.dp),
            color = if (role == PixelBox.Action.Role.Normal) Theme.ink else Color.White, style = plain(15, FontWeight.SemiBold), maxLines = 1,
        )
    } else {
        val ink = when (role) {
            PixelBox.Action.Role.Primary -> if (pressed) Color.Black else Theme.base
            PixelBox.Action.Role.Destructive -> Theme.failed
            else -> Theme.ink
        }
        val fill = if (role == PixelBox.Action.Role.Primary) (if (pressed) Theme.signal else Theme.ink) else (if (pressed) Theme.line else Color.Transparent)
        Text(buttonWord(label), Modifier.background(fill).then(click).padding(horizontal = 6.dp, vertical = 4.dp), color = ink, style = mono(13), maxLines = 1)
    }
}

// MARK: menu

@Composable
private fun Menu(box: PixelBox, close: () -> Unit) {
    if (LocalLook.current.isClassic) {
        val shape = RoundedCornerShape(12.dp)
        Box(Modifier.floatingShadow(shape).clip(shape).background(Theme.panel)) { MenuRows(box, close) }
    } else {
        Box(Modifier.glitch(0, onAppear = true)) {
            DitherShadow(Modifier.matchParentSize().offset(6.dp, 6.dp))
            Box(Modifier.background(Theme.base).border(1.dp, Theme.ink, RectangleShape)) { MenuRows(box, close) }
        }
    }
}

@Composable
private fun MenuRows(box: PixelBox, close: () -> Unit) {
    Column(Modifier.width(box.width)) {
        if (box.head != null) {
            // What the menu is about (a link's whole address): code, in both looks.
            Text(
                box.head, Modifier.fillMaxWidth().background(Theme.raised).padding(horizontal = 12.dp, vertical = 7.dp),
                color = Theme.secondaryInk, style = code(11), maxLines = 3, overflow = TextOverflow.MiddleEllipsis,
            )
        }
        for (a in box.actions) MenuRow(a, close)
    }
}

@Composable
private fun MenuRow(a: PixelBox.Action, close: () -> Unit) {
    val source = remember { MutableInteractionSource() }
    val pressed = source.collectIsPressedAsState().value
    val destructive = a.role == PixelBox.Action.Role.Destructive
    val classic = LocalLook.current.isClassic
    val ink = if (classic) (if (destructive) Theme.failed else Theme.ink) else (if (pressed) Theme.base else if (destructive) Theme.failed else Theme.ink)
    val fill = if (!pressed) Color.Transparent else if (classic) Theme.raised else Theme.ink
    Row(
        Modifier.fillMaxWidth().height(menuRow.dp).background(fill).clickable(source, null, role = SemanticsRole.Button) { close(); a.run() }.padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(a.label, color = ink, style = mono(14), maxLines = 1)
    }
}

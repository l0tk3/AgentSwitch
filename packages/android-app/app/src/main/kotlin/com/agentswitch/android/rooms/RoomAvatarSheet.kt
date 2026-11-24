package com.agentswitch.android.rooms

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.LocalNav
import com.agentswitch.android.design.BarWord
import com.agentswitch.android.design.FormPage
import com.agentswitch.android.design.FormRow
import com.agentswitch.android.design.FormSection
import com.agentswitch.android.design.LocalLook
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.colorOf
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.android.settings.Segmented
import com.agentswitch.kit.api.AvatarChoice
import com.agentswitch.kit.api.PixelAvatar
import com.agentswitch.kit.api.RoomFace
import com.agentswitch.kit.api.setSeatAvatar
import kotlinx.coroutines.launch

/**
 * A member's avatar, picked by the user (2026-11-24): two tabs, one for each look — Pixel (the system's faces, then the
 * pixel characters) and Classic (an emoji, and the colour of its ground). `Save` sets what was picked, for the session
 * in every room it sits in; `Reset` puts the tab's look back to the seat's own (its face; its initials).
 */
@Composable
fun RoomAvatarSheet(model: RoomPageModel, handle: String) {
    val app = LocalAppModel.current
    val nav = LocalNav.current
    val scope = rememberCoroutineScope()
    val seat = model.detail?.seat(handle)
    val current = seat?.avatar
    val classicLook = LocalLook.current.isClassic
    var tab by remember { mutableIntStateOf(if (classicLook) 1 else 0) }
    var pixel by remember { mutableStateOf(current?.pixel) }
    var emoji by remember { mutableStateOf(current?.classic?.let { it.id to it.emoji }) }
    val faceColor = seat?.face?.color ?: RoomAvatarArt.faceColor(handle)
    var bg by remember { mutableIntStateOf(current?.classic?.bg ?: faceColor) }
    var busy by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(app.api) { app.rooms.loadAvatars(app.api)?.let { problem = it } }
    val library = app.rooms.avatars

    val pixelChanged = pixel?.id != current?.pixel?.id || (pixel == null) != (current?.pixel == null)
    val classicChanged = emoji?.second != current?.classic?.emoji || (emoji != null && bg != current?.classic?.bg)

    fun save(pixelChoice: AvatarChoice?, classicChoice: AvatarChoice?) {
        if (pixelChoice == null && classicChoice == null) { nav.pop(); return }
        scope.launch {
            busy = true
            val done = model.run(app.api) { it.setSeatAvatar(model.id, handle, pixelChoice, classicChoice) }
            busy = false
            if (done) nav.pop() else problem = model.error
        }
    }

    fun pixelChoice(): AvatarChoice? {
        if (!pixelChanged) return null
        val p = pixel ?: return AvatarChoice.Reset
        return p.id?.let { AvatarChoice.Library(it) } ?: AvatarChoice.Drawn(p.rows, p.color)
    }

    fun classicChoice(): AvatarChoice? {
        if (!classicChanged) return null
        val (id, e) = emoji ?: return AvatarChoice.Reset
        return if (id != null) AvatarChoice.Library(id, bg) else AvatarChoice.Emoji(e, bg)
    }

    FormPage(
        "Avatar",
        leading = { BarWord("Cancel", { nav.pop() }, color = agentInk) },
        trailing = { BarWord("Save", { save(pixelChoice(), classicChoice()) }, enabled = !busy && seat != null && (pixelChanged || classicChanged), color = agentInk) },
    ) {
        if (seat == null) {
            Text("这个成员已不在房间里。", Modifier.padding(Theme.Space.l), color = Theme.secondaryInk, style = plain(15))
            return@FormPage
        }
        // What it will look like in each look.
        FormSection(footer = "头像跟着会话走：它在每个房间里都一样。像素风格显示像素头像，Classic 风格显示普通头像。") {
            FormRow(first = true) {
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    val p = pixel
                    if (p?.isGrid == true) PixelGridView(p, side = 44.dp) else RoomFaceView(p?.face ?: seat.face, side = 44.dp)
                    Text("Pixel", color = Theme.secondaryInk, style = mono(11))
                }
                Spacer(Modifier.size(18.dp))
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    ClassicAvatarView(emoji?.second, if (emoji != null) bg else faceColor, handle, side = 44.dp)
                    Text("Classic", color = Theme.secondaryInk, style = mono(11))
                }
                Spacer(Modifier.weight(1f))
                Text("@$handle", color = Theme.ink, style = mono(15, FontWeight.SemiBold), maxLines = 1)
            }
            problem?.let { FormRow { Text(it, Modifier.weight(1f), color = Theme.failed, style = plain(13)) } }
        }
        Segmented(listOf("Pixel", "Classic"), tab, { tab = it }, Modifier.padding(top = 14.dp))
        if (library == null) {
            Text(if (problem == null) "正在读取头像库…" else "头像库没有读到。", Modifier.padding(Theme.Space.l), color = Theme.secondaryInk, style = plain(14))
        } else if (tab == 0) {
            FormSection("Faces") {
                Grid(library.faces, columns = 6) { f ->
                    Cell(pixel?.id == f.id, { pixel = f.avatar }) { RoomFaceView(RoomFace(f.rows, f.color), side = 36.dp) }
                }
            }
            FormSection("Characters", footer = "像素角色：DiceBear Pixel Art（CC0）。") {
                Grid(library.art, columns = 6) { a ->
                    Cell(pixel?.id == a.id, { pixel = a.avatar }) { PixelGridView(a.avatar, side = 36.dp) }
                }
            }
        } else {
            FormSection("Emoji") {
                Grid(library.emoji, columns = 6) { e ->
                    Cell(emoji?.second == e.emoji, { emoji = e.id to e.emoji }) { ClassicAvatarView(e.emoji, bg, handle, side = 36.dp) }
                }
            }
            FormSection("Colour") {
                Grid((0..9).toList(), columns = 10, padding = 4.dp) { c ->
                    val color = colorOf(RoomFace(color = c).rgb(Theme.isDark))
                    Box(
                        Modifier.fillMaxWidth().aspectRatio(1f).padding(2.dp)
                            .border(if (bg == c) 2.dp else 0.dp, if (bg == c) Theme.ink else Color.Transparent, CircleShape)
                            .padding(3.dp)
                            .clickable(role = Role.RadioButton) { bg = c },
                    ) { Box(Modifier.fillMaxWidth().aspectRatio(1f).background(color, CircleShape)) }
                }
            }
        }
        val shown = if (tab == 0) current?.pixel != null || pixel != null else current?.classic != null || emoji != null
        FormSection(footer = if (tab == 0) "Reset：像素头像回到这个座位自己的脸。" else "Reset：普通头像回到名字的首字母。") {
            FormRow(Modifier.alpha(if (shown && !busy) 1f else 0.4f), first = true, onClick = if (shown && !busy) ({
                if (tab == 0) save(AvatarChoice.Reset, null) else save(null, AvatarChoice.Reset)
            }) else null) { Text("Reset", color = Theme.failed, style = plain(16)) }
        }
    }
}

/** Items in rows of `columns`, each cell a square share of the width. */
@Composable
private fun <T> Grid(items: List<T>, columns: Int, padding: Dp = 8.dp, cell: @Composable (T) -> Unit) {
    Column(Modifier.fillMaxWidth().padding(padding)) {
        for (row in items.chunked(columns)) {
            Row(Modifier.fillMaxWidth()) {
                for (item in row) Box(Modifier.weight(1f), contentAlignment = Alignment.Center) { cell(item) }
                repeat(columns - row.size) { Spacer(Modifier.weight(1f)) }
            }
        }
    }
}

/** One choice: lit with a frame when it is the one picked. */
@Composable
private fun Cell(on: Boolean, pick: () -> Unit, content: @Composable () -> Unit) {
    val classic = LocalLook.current.isClassic
    val shape = if (classic) RoundedCornerShape(10.dp) else RectangleShape
    Box(
        Modifier.padding(3.dp).border(2.dp, if (on) Theme.signal else Color.Transparent, shape).clickable(role = Role.RadioButton, onClick = pick).padding(5.dp),
        contentAlignment = Alignment.Center,
    ) { content() }
}

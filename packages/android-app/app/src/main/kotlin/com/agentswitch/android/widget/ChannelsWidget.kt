package com.agentswitch.android.widget

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.Action
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.color.ColorProvider
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.width
import androidx.glance.text.FontFamily
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider as Paint
import com.agentswitch.android.MainActivity
import com.agentswitch.kit.widget.ChannelsSnapshot
import com.agentswitch.kit.widget.ChannelsSnapshot.Channel

/**
 * The home screen's Channels widget (docs/app-v0.md §6; user #763): the Mac's rooms as the app last read them
 * ([ChannelsFeed]). A row opens its room; anywhere else, the rooms list. Drawn in the app's look; light or dark as
 * the phone is. Any size: a narrow one shows one channel with room for what was said, a wider one as many rows as
 * fit (at most 8). The iPhone's `ChannelsWidget`.
 */
class ChannelsWidget : GlanceAppWidget() {
    override val sizeMode: SizeMode = SizeMode.Exact

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val widget = try { GlanceAppWidgetManager(context).getAppWidgetId(id) } catch (_: Exception) { -1 }
        val drawing = ChannelsDrawing(
            snapshot = ChannelsFeed.read(context),
            choice = ChannelsFeed.choice(context, widget),
            chosen = ChannelsFeed.chosen(context, widget),
            classic = ChannelsFeed.classic(context),
            now = System.currentTimeMillis(),
        )
        provideContent { ChannelsContent(drawing) }
    }
}

/** What one widget draws: the copy, which of its channels it was set up to show, the look, and when. */
data class ChannelsDrawing(
    val snapshot: ChannelsSnapshot?,
    val choice: ChannelsSnapshot.Choice,
    val chosen: List<String>,
    val classic: Boolean,
    val now: Long,
)

/** The widget's colours: the app's (design/Theme.kt), each a pair the launcher picks from as the phone is light or dark. */
class ChannelsPalette(private val classic: Boolean) {
    private fun pick(light: Long, dark: Long, classicLight: Long, classicDark: Long): Paint =
        if (classic) ColorProvider(day = Color(0xFF000000 or classicLight), night = Color(0xFF000000 or classicDark))
        else ColorProvider(day = Color(0xFF000000 or light), night = Color(0xFF000000 or dark))

    val ground = pick(0xF3F1EC, 0x121212, 0xFFFFFF, 0x1C1C1E)
    val raised = pick(0xEAE7E0, 0x1F1F1F, 0xF2F2F7, 0x2C2C2E)
    val ink = pick(0x151413, 0xE9E6DF, 0x1D1D1F, 0xF2F2F7)
    val secondary = pick(0x5F5B54, 0x8D8A84, 0x6E6E73, 0xA2A2A8)
    val dim = pick(0xA29D93, 0x4D4B48, 0xA6A6AB, 0x6C6C72)
    val line = pick(0xDCD8CF, 0x262524, 0xDCDCE0, 0x38383A)
    val signal = pick(0xE0106E, 0xFF2E88, 0x007AFF, 0x0A84FF)
    val waiting = pick(0xC27400, 0xFFB000, 0xFF9500, 0xFF9F0A)
    val onCount: Paint = ColorProvider(day = Color.White, night = Color.White)
}

/** How many rows fit, by the widget's size: a narrow widget shows one channel big (0 here). */
fun channelsRows(size: DpSize): Int {
    if (size.width < 180.dp) return 0
    return ((size.height.value - 40f) / 52f).toInt().coerceIn(1, 8)
}

private fun open(context: Context, link: String): Action =
    actionStartActivity(Intent(Intent.ACTION_VIEW, Uri.parse(link)).setClass(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))

private const val ROOMS = "agentswitch://rooms"
private fun roomLink(id: String) = "agentswitch://room/${Uri.encode(id)}"

@Composable
fun ChannelsContent(d: ChannelsDrawing) {
    val context = LocalContext.current
    val p = ChannelsPalette(d.classic)
    val rows = channelsRows(LocalSize.current)
    val picked = d.snapshot?.pick(d.choice, d.chosen, limit = if (rows == 0) 1 else rows) ?: emptyList()
    Column(
        GlanceModifier.fillMaxSize().background(p.ground).cornerRadius(if (d.classic) 22.dp else 0.dp)
            .padding(start = 14.dp, end = 14.dp, top = 12.dp, bottom = if (rows == 0) 12.dp else 6.dp)
            .clickable(open(context, ROOMS)),
    ) {
        Head(d, p, small = rows == 0)
        when {
            d.snapshot == null -> Notice("Open AgentSwitch", d, p)
            picked.isEmpty() -> Notice(if (d.choice == ChannelsSnapshot.Choice.Mentions) "Nothing for you" else "No channels", d, p)
            rows == 0 -> Big(picked.first(), d, p)
            else -> picked.forEachIndexed { i, ch ->
                if (i > 0) Spacer(GlanceModifier.fillMaxWidth().height(1.dp).background(p.line))
                ChannelRow(ch, d, p)
            }
        }
    }
}

private fun style(d: ChannelsDrawing, color: Paint, size: TextUnit, weight: FontWeight = FontWeight.Normal, mono: Boolean = !d.classic) =
    TextStyle(color = color, fontSize = size, fontWeight = weight, fontFamily = if (mono) FontFamily.Monospace else null)

@Composable
private fun Head(d: ChannelsDrawing, p: ChannelsPalette, small: Boolean) {
    Row(GlanceModifier.fillMaxWidth().padding(bottom = if (small) 8.dp else 4.dp), verticalAlignment = Alignment.CenterVertically) {
        if (d.classic) Text("Channels", style = style(d, p.secondary, 13.sp, FontWeight.Medium))
        else Text("// CHANNELS", style = style(d, p.signal, 11.5.sp, FontWeight.Bold))
        Spacer(GlanceModifier.defaultWeight())
        val waiting = d.snapshot?.waiting ?: 0
        if (waiting > 0) Count(waiting, warm = true, mark = true, d, p)
    }
}

@Composable
private fun Notice(words: String, d: ChannelsDrawing, p: ChannelsPalette) {
    Box(GlanceModifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text(words, style = style(d, p.secondary, if (d.classic) 14.sp else 13.sp, if (d.classic) FontWeight.Medium else FontWeight.Normal))
    }
}

@Composable
private fun Name(ch: Channel, d: ChannelsDrawing, p: ChannelsPalette, size: TextUnit, modifier: GlanceModifier = GlanceModifier) {
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        if (ch.desk) Text("◆ ", style = style(d, p.signal, (size.value - 3).sp, FontWeight.Bold, mono = false))
        else if (!d.classic) Text("# ", style = style(d, p.dim, (size.value - 1).sp, FontWeight.Bold))
        Text(ch.name, style = style(d, p.ink, size, FontWeight.Medium, mono = false), maxLines = 1)
        if (ch.paused) Text(" ‖", style = style(d, p.secondary, (size.value - 2).sp, FontWeight.Bold, mono = false))
    }
}

/** `who: what` — the speaker in ink, what was said in the secondary colour. */
@Composable
private fun Said(ch: Channel, d: ChannelsDrawing, p: ChannelsPalette, size: TextUnit, lines: Int, modifier: GlanceModifier = GlanceModifier) {
    if (ch.from != null && lines == 1) {
        Row(modifier, verticalAlignment = Alignment.CenterVertically) {
            Text("${ch.from}: ", style = style(d, p.ink, size, FontWeight.Medium, mono = false), maxLines = 1)
            Text(ch.text, style = style(d, p.secondary, size, mono = false), maxLines = 1, modifier = GlanceModifier.defaultWeight())
        }
    } else {
        Text(if (ch.from != null) "${ch.from}: ${ch.text}" else ch.text, style = style(d, p.secondary, size, mono = false), maxLines = lines, modifier = modifier)
    }
}

@Composable
private fun ChannelRow(ch: Channel, d: ChannelsDrawing, p: ChannelsPalette) {
    val context = LocalContext.current
    Column(GlanceModifier.fillMaxWidth().padding(vertical = 5.dp).clickable(open(context, roomLink(ch.id)))) {
        Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Name(ch, d, p, 14.sp, GlanceModifier.defaultWeight())
            ch.at?.let { Text(ChannelsSnapshot.ago(it, d.now), style = style(d, if (ch.unread > 0) p.ink else p.secondary, if (d.classic) 12.sp else 11.sp)) }
        }
        Row(GlanceModifier.fillMaxWidth().padding(top = 1.dp), verticalAlignment = Alignment.CenterVertically) {
            Said(ch, d, p, 12.5.sp, lines = 1, modifier = GlanceModifier.defaultWeight())
            if (ch.attention > 0) { Spacer(GlanceModifier.width(4.dp)); Count(ch.attention, warm = true, mark = true, d, p) }
            if (ch.unread > 0) { Spacer(GlanceModifier.width(4.dp)); Count(ch.unread, warm = ch.forYou, mark = false, d, p) }
        }
    }
}

/** The narrow widget's one channel, given room for what was said. */
@Composable
private fun Big(ch: Channel, d: ChannelsDrawing, p: ChannelsPalette) {
    val context = LocalContext.current
    Column(GlanceModifier.fillMaxSize().clickable(open(context, roomLink(ch.id)))) {
        Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Name(ch, d, p, 15.sp, GlanceModifier.defaultWeight())
            if (ch.unread > 0) Count(ch.unread, warm = ch.forYou, mark = false, d, p)
        }
        Said(ch, d, p, 13.sp, lines = 3, modifier = GlanceModifier.padding(top = 4.dp).defaultWeight())
        ch.at?.let { Text(ChannelsSnapshot.ago(it, d.now), style = style(d, p.secondary, if (d.classic) 12.sp else 11.sp)) }
    }
}

/** A count: amber where it waits for the user; a capsule in the classic look, `[n]` in the pixel one. `mark`: things
 *  that wait on the user's hand rather than messages not seen. */
@Composable
private fun Count(n: Int, warm: Boolean, mark: Boolean, d: ChannelsDrawing, p: ChannelsPalette) {
    val colour = if (warm) p.waiting else if (d.classic) p.dim else p.secondary
    if (d.classic) {
        Box(GlanceModifier.background(colour).cornerRadius(9.dp).padding(horizontal = 6.dp, vertical = 1.dp), contentAlignment = Alignment.Center) {
            Text(if (mark) "! $n" else "$n", style = TextStyle(color = p.onCount, fontSize = 11.sp, fontWeight = FontWeight.Bold))
        }
    } else {
        Text(if (mark) "⚠ $n" else "[$n]", style = style(d, colour, 11.5.sp, FontWeight.Bold))
    }
}

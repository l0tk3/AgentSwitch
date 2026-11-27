package com.agentswitch.android.widget

import android.content.Context
import com.agentswitch.kit.api.RoomList
import com.agentswitch.kit.design.InterfaceLook
import com.agentswitch.kit.widget.ChannelsSnapshot
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import androidx.glance.appwidget.updateAll

/**
 * The home screen's Channels widget's copy of the rooms (docs/app-v0.md §6; user #763): written to a file of the app's
 * own whenever the list read from the Mac changes, and the widgets told to draw again. The widget runs in the app's
 * own process, so nothing is shared with anyone: the file holds the channels' names, counts, the last line and its
 * time — no address, no token. Unchanged, nothing is written. The iPhone's `ChannelsWidgetFeed`.
 */
object ChannelsFeed {
    private const val FILE = "channels-widget.json"
    private const val PREFS = "channels-widget"
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    @Volatile private var last: List<ChannelsSnapshot.Channel>? = null

    private fun file(context: Context) = File(context.applicationContext.filesDir, FILE)

    fun read(context: Context): ChannelsSnapshot? = try {
        file(context).takeIf { it.exists() }?.readText()?.let(ChannelsSnapshot::decode)
    } catch (_: Exception) { null }

    /** The list as just read from the Mac; the widgets draw again when its channels changed. */
    fun save(context: Context, list: RoomList, now: Long = System.currentTimeMillis()) {
        val snapshot = ChannelsSnapshot.of(list, now)
        if (snapshot.channels == (last ?: read(context)?.channels)) { last = snapshot.channels; return }
        if (!write(context, snapshot)) return
        last = snapshot.channels
        redraw(context)
    }

    /** Another Mac, or none, or one without Chat Room: the widget shows nothing of the one before. */
    fun forget(context: Context) {
        last = null
        file(context).delete()
        redraw(context)
    }

    /** Written whole: a widget never reads half of one. */
    fun write(context: Context, snapshot: ChannelsSnapshot): Boolean = try {
        val target = file(context)
        val temp = File(target.parentFile, "$FILE.tmp")
        temp.writeText(snapshot.encode())
        temp.renameTo(target)
    } catch (_: Exception) { false }

    /** Every Channels widget drawn again: a new copy, the look changed, or the rows' times moved on. */
    fun redraw(context: Context) {
        val app = context.applicationContext
        scope.launch { try { ChannelsWidget().updateAll(app) } catch (_: Exception) { } }
    }

    /** The app's look (Settings › Appearance) the widgets draw in. */
    fun classic(context: Context): Boolean =
        InterfaceLook.load(context.applicationContext.getSharedPreferences("settings", Context.MODE_PRIVATE).getString(InterfaceLook.key, null)).isClassic

    // MARK: each widget's set-up (ChannelsSetupActivity)

    private fun prefs(context: Context) = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun choice(context: Context, widget: Int): ChannelsSnapshot.Choice = ChannelsSnapshot.Choice.load(prefs(context).getString("$widget.show", null))

    fun chosen(context: Context, widget: Int): List<String> =
        prefs(context).getString("$widget.chosen", null)?.split('\n')?.filter { it.isNotEmpty() } ?: emptyList()

    fun setUp(context: Context, widget: Int, choice: ChannelsSnapshot.Choice, chosen: List<String>) {
        prefs(context).edit().putString("$widget.show", choice.rawValue).putString("$widget.chosen", chosen.joinToString("\n")).apply()
    }

    fun drop(context: Context, widget: Int) {
        prefs(context).edit().remove("$widget.show").remove("$widget.chosen").apply()
    }
}

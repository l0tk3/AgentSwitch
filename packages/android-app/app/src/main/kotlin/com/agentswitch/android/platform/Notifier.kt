package com.agentswitch.android.platform

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import com.agentswitch.android.MainActivity
import com.agentswitch.android.R

/**
 * Notifications the phone posts itself (docs/app-v0.md §5 “通知”, 2026-11-11): a terminal that newly waits for you, a
 * terminal whose turn ended, something in a room that waits on you (等你处理).
 *
 * Local ones: the app posts them when it learns of the change, which it does while it runs — in front, and behind
 * for as long as something is in progress (FollowService keeps it running then). With the app frozen or closed
 * nothing is learnt and nothing is posted.
 * A later one about the same terminal takes the place of the one before; tapping one opens its terminal
 * (`agentswitch://terminal/<id>`).
 */
class Notifier(context: Context) {
    private val context = context.applicationContext
    private val manager: NotificationManager? = context.getSystemService(NotificationManager::class.java)

    /** How the system's question is put (Android 13 and later ask): the activity in front sets this. */
    var ask: (() -> Unit)? = null
    private var asked = false

    init {
        manager?.createNotificationChannel(
            NotificationChannel(CHANNEL, "Terminals", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "终端等你处理，或这一轮已结束。"
            },
        )
        manager?.createNotificationChannel(
            NotificationChannel(ROOMS_CHANNEL, "Rooms", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "房间里有事等你处理。"
            },
        )
        // The old tasks' channel, on a phone that had it: nothing posts there any more.
        manager?.deleteNotificationChannel("tasks")
    }

    /** Whether a notification would be shown now: leave was given (Android 13 and later ask) and not taken back. */
    val allowed: Boolean
        get() = (Build.VERSION.SDK_INT < 33 || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) &&
            manager?.areNotificationsEnabled() == true

    /** The system's question is put now, not at the first thing to say (a terminal's page was opened). Once. */
    fun prepare() {
        if (asked || Build.VERSION.SDK_INT < 33) return
        if (context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        val ask = ask ?: return
        asked = true
        ask()
    }

    /** One notification about terminal `id`; a later one about the same terminal takes its place. */
    fun post(terminal: String, title: String, body: String) {
        val manager = manager ?: return
        if (!allowed) { prepare(); return }
        val open = Intent(Intent.ACTION_VIEW, Uri.parse("agentswitch://terminal/$terminal"), context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val pending = PendingIntent.getActivity(context, terminal.hashCode(), open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = Notification.Builder(context, CHANNEL)
            .setSmallIcon(StatusIcon.of(context))
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(Notification.BigTextStyle().bigText(body))
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_STATUS)
            .setGroup(terminal)
            .build()
        manager.notify("terminal:$terminal", 0, notification)
    }

    /**
     * One thing in a room that newly waits on the user (等你处理): `等你处理：@ios 等你确认权限`. Tapping it opens the room
     * there — `agentswitch://room/<id>?task=&seq=&card=`.
     */
    fun postRoom(room: String, identity: String, title: String, body: String, task: Int?, seq: Int?, card: String?) {
        val manager = manager ?: return
        if (!allowed) { prepare(); return }
        val link = Uri.Builder().scheme("agentswitch").authority("room").appendPath(room).apply {
            task?.let { appendQueryParameter("task", it.toString()) }
            seq?.let { appendQueryParameter("seq", it.toString()) }
            card?.let { appendQueryParameter("card", it) }
        }.build()
        val open = Intent(Intent.ACTION_VIEW, link, context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val pending = PendingIntent.getActivity(context, ("room:$identity").hashCode(), open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = Notification.Builder(context, ROOMS_CHANNEL)
            .setSmallIcon(StatusIcon.of(context))
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(Notification.BigTextStyle().bigText(body))
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_STATUS)
            .setGroup("room:$room")
            .build()
        manager.notify("room:$identity", 0, notification)
    }

    /** What was said about terminal `id` is taken back (it is on screen now). */
    fun clear(terminal: String) {
        manager?.cancel("terminal:$terminal", 0)
    }

    companion object {
        const val CHANNEL = "terminals"
        const val ROOMS_CHANNEL = "rooms"
    }
}

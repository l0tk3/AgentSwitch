package com.agentswitch.android.platform

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.agentswitch.android.AgentSwitchApp
import com.agentswitch.android.AppSettings
import com.agentswitch.android.MainActivity
import com.agentswitch.android.R
import com.agentswitch.kit.live.LiveState
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

// Following the Mac from behind (docs/app-v0.md §5b “后台跟随”, 2026-11-12): the Live Activity's counterpart on
// Android, and what the iPhone cannot do.
//
// Android freezes an app within seconds of its leaving the screen. Frozen, it asks the Mac nothing, so it learns of
// nothing and notifies of nothing: a terminal that comes to need you, a turn that ends. While something is in
// progress — a task, a terminal at work — a foreground service keeps the app running and asking, and the service's
// ongoing notification says what is in progress (the summary the iPhone's Live Activity shows, `LiveSummary`). With
// nothing in progress there is no service and no notification, and the phone is left alone.
//
// Three parts: `FollowRule` (when), `Follower` (what is shown; starts the service), `FollowService` (keeps asking).

/**
 * When the Mac is followed, given what is in progress: while anything runs; and for [lingerMs] after the last of it
 * stopped to wait for you — you may answer on the Mac, and work goes on — but not for as long as you leave it waiting:
 * a question left overnight must not keep the phone awake until morning (the notification about it stays).
 */
class FollowRule(private val lingerMs: Long = defaultLingerMs) {
    private var waitingSince: Long? = null

    fun follows(state: LiveState?, now: Long): Boolean {
        if (state == null) {
            waitingSince = null
            return false
        }
        if (state.running > 0) {
            waitingSince = null
            return true
        }
        val since = waitingSince ?: now.also { waitingSince = it }
        // (A clock set back does not keep it following for longer than the linger.)
        return now - since in 0 until lingerMs
    }

    companion object {
        const val defaultLingerMs = 10 * 60_000L
    }
}

/** What is in progress as the ongoing notification says it, and whether the service that owns it should be running. */
class Follower(context: Context, private val settings: AppSettings, private val notifier: Notifier) {
    private val context = context.applicationContext
    private val manager: NotificationManager? = context.getSystemService(NotificationManager::class.java)
    private val rule = FollowRule()

    /** What the notification shows: the summary and the Mac's name. */
    data class Shown(val state: LiveState, val mac: String)

    /** What the service shows now; null: nothing is followed, and a running service ends itself. */
    val shown = MutableStateFlow<Shown?>(null)

    /** Set as the service is asked for and cleared as it ends: it is asked for once. */
    internal var running = false
    private var last: Pair<LiveState?, String> = null to "Mac"

    /** Settings › Alerts & Voice › Follow in Background. */
    var enabled: Boolean by mutableStateOf(settings.bool(KEY, true))
        private set

    fun choose(on: Boolean) {
        enabled = on
        settings.putBool(KEY, on)
        sync(last.first, last.second)
    }

    init {
        manager?.createNotificationChannel(
            NotificationChannel(CHANNEL, "In Progress", NotificationManager.IMPORTANCE_LOW).apply {
                description = "有任务或终端在工作时显示；这期间应用在后台保持连接。"
                setShowBadge(false)
            },
        )
    }

    /**
     * What is in progress now (`LiveSummary.state`; null: nothing). Called at every change and at every asking, so
     * the linger runs out by itself. Without leave to notify nothing is followed: there would be nothing to show and
     * nothing to tell.
     */
    fun sync(state: LiveState?, mac: String) {
        last = state to mac
        val follows = enabled && notifier.allowed && rule.follows(state, System.currentTimeMillis())
        shown.value = if (follows && state != null) Shown(state, mac) else null
        if (shown.value != null && !running) start()
    }

    private fun start() {
        running = true
        try {
            context.startForegroundService(Intent(context, FollowService::class.java))
        } catch (_: Exception) {
            // Asked for from behind, later than Android allows: the next change seen in front starts it.
            running = false
        }
    }

    /** The ongoing notification for `shown` (null: the moment before the service ends). */
    internal fun notification(shown: Shown?): Notification {
        val state = shown?.state
        val lead = state?.lead
        val single = state?.rows?.singleOrNull()
        val open = if (single != null) Intent(Intent.ACTION_VIEW, Uri.parse(single.link), context, MainActivity::class.java)
        else Intent(context, MainActivity::class.java)
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val builder = Notification.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_terminal)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setCategory(Notification.CATEGORY_PROGRESS)
            .setContentIntent(PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
        // Shown at once: by default Android holds a service's notification back for ten seconds.
        if (Build.VERSION.SDK_INT >= 31) builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
        if (state == null || lead == null) return builder.setContentTitle("AgentSwitch").build()
        builder.setSubText(shown.mac)
        if (single != null) {
            builder.setContentTitle("${single.title} · ${word(single)}").setContentText(single.step)
            // The running clock of the one thing in progress, as the Live Activity has it.
            if (!single.needsYou) builder.setShowWhen(true).setWhen(single.startedAt).setUsesChronometer(true)
        } else {
            val lines = state.rows.map { "${it.title} · ${it.step}" }
            builder.setContentTitle(counts(state)).setContentText(lines.first())
            builder.setStyle(Notification.InboxStyle().also { style -> lines.forEach { style.addLine(it) } })
        }
        return builder.build()
    }

    companion object {
        const val CHANNEL = "following"
        const val ID = 1
        const val KEY = "followInBackground"

        /** How often the Mac is asked from behind. In front the pages ask (every 4 seconds); behind, less often. */
        const val pollMs = 5_000L

        private fun word(row: LiveState.Row): String = if (row.needsYou) "Needs You" else "Busy"

        /** "1 Needs You · 2 Busy": the ones waiting for you first, as the rows are ordered. */
        internal fun counts(state: LiveState): String =
            listOfNotNull(
                if (state.waiting > 0) "${state.waiting} Needs You" else null,
                if (state.running > 0) "${state.running} Busy" else null,
            ).joinToString(" · ")
    }
}

/**
 * The service behind [Follower]: for as long as it runs the app is not frozen, and while the app is not in front it
 * asks the Mac every [Follower.pollMs] what the terminals and the tasks in progress are doing — which is what posts
 * the notifications (`AppModel.refreshTerminals`, `DispatchStore.refreshApprovals`). It ends itself when [Follower]
 * shows nothing.
 *
 * Its kind is `connectedDevice` (a paired Mac, reached over the network): no limit of hours a day, as `dataSync` has.
 * The processor is kept awake from one asking to the next, by a lock that lets go by itself if the asking ever stops;
 * with the screen off a timer does not run otherwise.
 */
class FollowService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var wake: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_NOT_STICKY

    override fun onCreate() {
        super.onCreate()
        val app = application as AgentSwitchApp
        val follower = app.follower
        try {
            startForeground(Follower.ID, follower.notification(follower.shown.value), ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        } catch (_: Exception) {
            stopSelf()
            return
        }
        follower.running = true
        wake = getSystemService(PowerManager::class.java)?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "AgentSwitch:follow")?.apply { setReferenceCounted(false) }
        val manager = getSystemService(NotificationManager::class.java)
        scope.launch {
            follower.shown.collect { shown ->
                if (shown == null) {
                    stopForeground(STOP_FOREGROUND_REMOVE)
                    stopSelf()
                } else manager?.notify(Follower.ID, follower.notification(shown))
            }
        }
        scope.launch {
            val model = app.model
            while (true) {
                if (!model.inFront) {
                    wake?.acquire(Follower.pollMs * 6)
                    try {
                        model.refreshTerminals()
                        model.dispatch.refreshFollowed()
                    } catch (e: CancellationException) {
                        throw e
                    } catch (_: Exception) {
                    }
                }
                delay(Follower.pollMs)
            }
        }
    }

    override fun onDestroy() {
        scope.cancel()
        wake?.let { if (it.isHeld) it.release() }
        (application as AgentSwitchApp).follower.running = false
        super.onDestroy()
    }
}

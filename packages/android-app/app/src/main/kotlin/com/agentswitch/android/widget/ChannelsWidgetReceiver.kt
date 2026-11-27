package com.agentswitch.android.widget

import android.content.Context
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.agentswitch.android.AgentSwitchApp
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/** The launcher's way in to the Channels widget: the first one placed starts the refresh, the last one removed stops it. */
class ChannelsWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = ChannelsWidget()

    override fun onEnabled(context: Context) {
        super.onEnabled(context)
        ChannelsRefresh.schedule(context)
    }

    override fun onDisabled(context: Context) {
        super.onDisabled(context)
        ChannelsRefresh.cancel(context)
    }

    override fun onDeleted(context: Context, appWidgetIds: IntArray) {
        super.onDeleted(context, appWidgetIds)
        for (id in appWidgetIds) ChannelsFeed.drop(context, id)
    }
}

/**
 * While the app is away the widget's copy is read again every 15 minutes, the least the system allows (WorkManager;
 * it may wait longer on a phone that saves power): the app's own connection to the Mac is made, the rooms read, and the
 * copy written if they changed. A read that fails leaves the last copy; the rows' times move on all the same.
 */
object ChannelsRefresh {
    private const val NAME = "channels-widget"

    fun schedule(context: Context) {
        val work = PeriodicWorkRequestBuilder<ChannelsRefreshWorker>(15, TimeUnit.MINUTES).build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(NAME, ExistingPeriodicWorkPolicy.KEEP, work)
    }

    fun cancel(context: Context) {
        WorkManager.getInstance(context).cancelUniqueWork(NAME)
    }
}

class ChannelsRefreshWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val app = applicationContext as AgentSwitchApp
        withContext(Dispatchers.Main) {
            val model = app.model
            val api = withTimeoutOrNull(20_000) { while (model.api == null) delay(500); model.api }
            if (api != null) model.rooms.refresh(api)
        }
        ChannelsFeed.redraw(applicationContext)
        return Result.success()
    }
}

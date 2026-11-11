package com.agentswitch.android

import com.agentswitch.kit.connection.DirectRoute
import com.agentswitch.android.platform.AndroidDirectRoute
import com.agentswitch.android.platform.Follower
import android.app.Application
import android.os.Build
import android.provider.Settings
import com.agentswitch.android.dispatch.DispatchServices
import com.agentswitch.android.platform.AndroidPathMonitor
import com.agentswitch.android.platform.Feedback
import com.agentswitch.android.platform.SodiumSealer
import com.agentswitch.android.platform.Speaker
import com.agentswitch.android.platform.KeystoreTokenVault
import com.agentswitch.android.platform.Notifier
import com.agentswitch.android.platform.NsdDiscovery
import com.agentswitch.android.terminals.RecordPictureStore
import com.agentswitch.kit.connection.PathMonitoring
import com.agentswitch.kit.connection.ServiceDiscovery
import com.agentswitch.kit.storage.LocalStore
import java.io.File

/** The process: the one [AppModel] and the settings kept on this phone live as long as it does. */
class AgentSwitchApp : Application() {
    val settings: AppSettings by lazy { AppSettings(this) }
    val notifier: Notifier by lazy { Notifier(this) }

    /** What is in progress, as an ongoing notification, and the service that follows the Mac from behind meanwhile. */
    val follower: Follower by lazy { Follower(this, settings, notifier) }

    /** The pictures of sessions' records read so far (small in memory, whole in the cache directory). */
    val pictures: RecordPictureStore by lazy { RecordPictureStore(cacheDir) }

    val model: AppModel by lazy {
        val store = try { LocalStore(File(filesDir, "agentswitch").apply { mkdirs() }) } catch (_: Exception) { null }
        AppModel(store, KeystoreTokenVault(this), Services(), dispatchServices = DispatchServices(SodiumSealer, Feedback(this, settings), Speaker(this, settings)), settings = settings, tempDir = cacheDir).also {
            if (store == null) it.banner = "无法打开本地存储，配对信息将无法保存。"
            it.notifier = notifier
            it.follower = follower
            it.start()
        }
    }

    /** One for the process: it keeps the socket factory of the network under a VPN. */
    private val direct by lazy { AndroidDirectRoute(this) }

    private inner class Services : PlatformServices {
        override fun discovery(): ServiceDiscovery = NsdDiscovery(this@AgentSwitchApp)
        override fun paths(): PathMonitoring = AndroidPathMonitor(this@AgentSwitchApp)
        override fun directRoute(): DirectRoute = direct

        /** What the user called this phone (Settings › About phone), else its model. */
        override val deviceName: String
            get() = Settings.Global.getString(contentResolver, Settings.Global.DEVICE_NAME)?.trim()?.takeIf { it.isNotEmpty() }
                ?: Build.MODEL?.trim()?.takeIf { it.isNotEmpty() } ?: "Android"
    }
}

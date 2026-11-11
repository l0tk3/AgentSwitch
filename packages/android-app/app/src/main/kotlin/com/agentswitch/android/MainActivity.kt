package com.agentswitch.android

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.CompositionLocalProvider
import com.agentswitch.android.demo.Demo
import com.agentswitch.android.demo.DesignGallery
import com.agentswitch.android.demo.KitSelfCheckScreen
import com.agentswitch.android.demo.LocalDemo
import com.agentswitch.android.demo.LocalDemoOpenTools
import com.agentswitch.android.demo.LocalDemoScreen
import com.agentswitch.android.demo.LocalDemoScroll
import com.agentswitch.android.demo.TerminalScreenDemo
import com.agentswitch.android.design.AgentSwitchTheme
import com.agentswitch.android.platform.PhoneScreen
import com.agentswitch.kit.design.InterfaceLook
import com.agentswitch.kit.pairing.PairingLink

class MainActivity : ComponentActivity() {
    private val app: AgentSwitchApp get() = application as AgentSwitchApp

    /** A sample screen is shown (debug builds): the real Mac is left alone.  */
    private val demo: Boolean get() = BuildConfig.DEBUG && (intent.getBooleanExtra("uiDemo", false) || intent.getStringExtra("uiDemo") == "YES")

    /** The system's question about notifications (Android 13 and later), put when the app first has reason to. */
    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(SystemBarStyle.auto(0, 0), SystemBarStyle.auto(0, 0))
        // Debug screens with nothing behind them (the iPhone's `-uiDemoScreen`): the shared parts, a terminal's screen.
        val screen = if (BuildConfig.DEBUG) intent.getStringExtra("uiDemoScreen") else null
        if (screen == "design" || screen == "terminalscreen" || screen == "selfcheck") {
            val look = InterfaceLook.load(intent.getStringExtra(InterfaceLook.key))
            setContent {
                AgentSwitchTheme(look) {
                    when (screen) {
                        "terminalscreen" -> TerminalScreenDemo()
                        "selfcheck" -> KitSelfCheckScreen()
                        else -> DesignGallery(open = intent.getStringExtra("uiDemoOpen"))
                    }
                }
            }
            return
        }
        if (BuildConfig.DEBUG) intent.getStringExtra(InterfaceLook.key)?.let { app.settings.chooseLook(InterfaceLook.load(it)) }
        // Screens with sample data and no Mac (the iPhone's `-uiDemo YES -uiDemoScreen <name>`), debug builds only:
        // `--ez uiDemo true [--es uiDemoScreen <name>]`.
        if (BuildConfig.DEBUG && (intent.getBooleanExtra("uiDemo", false) || intent.getStringExtra("uiDemo") == "YES")) {
            val model = Demo.model(screen, offline = screen == "offline" || screen == "offlinemac", phoneScreen = PhoneScreen.id(app.settings))
            setContent {
                CompositionLocalProvider(
                    LocalDemo provides true, LocalDemoScreen provides screen,
                    LocalDemoOpenTools provides intent.getBooleanExtra("uiDemoOpenTools", false),
                    LocalDemoScroll provides intent.getStringExtra("uiDemoScroll"),
                ) { RootView(model, app.settings) }
            }
            return
        }
        take(intent)
        setContent { RootView(app.model, app.settings) }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        take(intent)
    }

    override fun onResume() {
        super.onResume()
        app.notifier.ask = { if (Build.VERSION.SDK_INT >= 33) askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS) }
        if (!demo) { app.model.inFront = true; app.model.resume() }
    }

    override fun onPause() {
        super.onPause()
        app.notifier.ask = null
        if (!demo) app.model.inFront = false
    }

    override fun onStop() {
        super.onStop()
        if (!demo && !isChangingConfigurations) app.model.leaving()
    }

    /**
     * A link the app was opened with: the Mac's pairing link (`agentswitch://pair?p=…`), shown for confirmation before
     * anything is sent. Debug builds also take it as the extra `pairLink` (no prompt from the system on the way).
     */
    private fun take(intent: Intent?) {
        val link = intent?.data?.takeIf { it.scheme.equals(PairingLink.scheme, ignoreCase = true) && it.host.equals(PairingLink.host, ignoreCase = true) }?.toString()
            ?: (if (BuildConfig.DEBUG) intent?.getStringExtra("pairLink") else null)
        if (link != null) app.model.receivePairingLink(link)
        // A notification's link: agentswitch://terminal/<id>.
        intent?.data?.takeIf { it.scheme.equals(PairingLink.scheme, ignoreCase = true) && it.host == "terminal" }
            ?.pathSegments?.firstOrNull()?.takeIf { it.isNotEmpty() }?.let { app.model.openTerminal(it) }
        // A task notification's link: agentswitch://task/<id>.
        intent?.data?.takeIf { it.scheme.equals(PairingLink.scheme, ignoreCase = true) && it.host == "task" }
            ?.pathSegments?.firstOrNull()?.takeIf { it.isNotEmpty() }?.let { app.model.dispatch.openTask(it) }
    }
}

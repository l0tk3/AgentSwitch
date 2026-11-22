package com.agentswitch.android.platform

import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import com.agentswitch.kit.design.InterfaceLook

/**
 * The Home Screen icon follows the look (docs/ui-v0.md §10), as the iPhone's does (HomeIcon.swift). Android has no
 * alternate icon: the launcher shows the app by one of two names for `MainActivity` (the manifest's `LauncherPixel`
 * and `LauncherClassic`), each with its icon, and exactly one is switched on.
 *
 * Asked for as the app leaves the screen, not at the tap: a launcher that sees the name it opened the app by switched
 * off may close the app under the user's finger. Nothing is changed when the right one is already on.
 */
/** The status bar's mark follows the look too (2026-11-23, user: 切换成 classic 之后状态栏图标还是 pixel 的): asked
 *  each time a notification is made, from what the settings keep — a notification is made with no page on screen. */
object StatusIcon {
    fun of(context: Context): Int {
        val kept = context.applicationContext.getSharedPreferences("settings", Context.MODE_PRIVATE).getString(InterfaceLook.key, null)
        return if (InterfaceLook.load(kept).isClassic) com.agentswitch.android.R.drawable.ic_stat_terminal_classic else com.agentswitch.android.R.drawable.ic_stat_terminal
    }
}

object HomeIcon {
    private const val PIXEL = "com.agentswitch.android.LauncherPixel"
    private const val CLASSIC = "com.agentswitch.android.LauncherClassic"

    fun follow(context: Context, look: InterfaceLook) {
        val packages = context.packageManager
        val wanted = if (look.isClassic) CLASSIC else PIXEL
        try {
            // The one wanted first: at no moment is the app without a name on the Home Screen.
            for ((name, on) in listOf(wanted to true, (if (look.isClassic) PIXEL else CLASSIC) to false)) {
                val component = ComponentName(context.packageName, name)
                val state = if (on) PackageManager.COMPONENT_ENABLED_STATE_ENABLED else PackageManager.COMPONENT_ENABLED_STATE_DISABLED
                val now = packages.getComponentEnabledSetting(component)
                // `DEFAULT` is what the manifest says: the pixel name on, the classic one off.
                val isOn = now == PackageManager.COMPONENT_ENABLED_STATE_ENABLED || (now == PackageManager.COMPONENT_ENABLED_STATE_DEFAULT && name == PIXEL)
                if (isOn != on) packages.setComponentEnabledSetting(component, state, PackageManager.DONT_KILL_APP)
            }
        } catch (_: Exception) {
            // A launcher or a system that refuses: the icon stays as it is, the next time the app leaves the screen tries again.
        }
    }
}

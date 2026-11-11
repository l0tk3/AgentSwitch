package com.agentswitch.android

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.agentswitch.kit.design.InterfaceLook

/**
 * What this phone keeps of how the app is set (the iPhone's `UserDefaults`): each device keeps its own
 * (docs/ui-v0.md §8: 设置各记各的). Read by the interface as state, written through at once.
 */
class AppSettings(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("settings", Context.MODE_PRIVATE)

    /** The interface's look (docs/ui-v0.md §8): `Pixel`, the default, or `Classic`. In force at once. */
    var look: InterfaceLook by mutableStateOf(InterfaceLook.load(prefs.getString(InterfaceLook.key, null)))
        private set

    fun chooseLook(next: InterfaceLook) {
        look = next
        prefs.edit().putString(InterfaceLook.key, next.rawValue).apply()
    }

    fun string(key: String): String? = prefs.getString(key, null)
    fun putString(key: String, value: String?) = prefs.edit().apply { if (value == null) remove(key) else putString(key, value) }.apply()
    fun float(key: String, fallback: Float): Float = prefs.getFloat(key, fallback)
    fun putFloat(key: String, value: Float) = prefs.edit().putFloat(key, value).apply()
    fun bool(key: String, fallback: Boolean): Boolean = prefs.getBoolean(key, fallback)
    fun putBool(key: String, value: Boolean) = prefs.edit().putBoolean(key, value).apply()
}

package com.agentswitch.android.platform

import com.agentswitch.android.AppSettings
import java.util.UUID

/**
 * This phone as a screen of the Mac's terminals and browser tabs: one id, kept across pages and launches (2026-09-30,
 * user: 返回重新进入提示我另一个 iPhone 在使用 — a new id per page made the page just left, still holding the size for a few
 * seconds, "another iPhone"). What it holds and the sizes it sets are its own (terminal-v0 §1 尺寸有主, browser-v0 §1).
 *
 * Kept in [AppSettings] (the iPhone's `UserDefaults`) under the same key; read once per process.
 */
object PhoneScreen {
    private const val key = "terminal.screenId"
    private var made: String? = null

    /** `phone-` and eight lower-case hex digits. Main thread. */
    fun id(settings: AppSettings): String {
        made?.let { return it }
        val saved = settings.string(key)
        val id = if (saved != null && saved.startsWith("phone-")) saved else {
            "phone-" + UUID.randomUUID().toString().take(8).lowercase()
        }
        if (id != saved) settings.putString(key, id)
        made = id
        return id
    }
}

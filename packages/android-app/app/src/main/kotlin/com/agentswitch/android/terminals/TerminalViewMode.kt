package com.agentswitch.android.terminals

import com.agentswitch.android.AppSettings

/**
 * How a terminal's page shows it (docs/simple-view-v0.md §1): the session's record with a reply box, or the program's
 * own screen. Each terminal remembers the one last used on this phone; the phone opens one it has not seen in the
 * simple view (the Mac opens it as a terminal).
 */
enum class TerminalViewMode(val rawValue: String) {
    Simple("simple"), Terminal("terminal");

    fun save(settings: AppSettings, id: String) = settings.putString(key(id), rawValue)

    companion object {
        private fun key(id: String) = "terminalView.$id"

        /** `demoScreen`: a sample screen's name decides (`simple…` is the simple view, any other the terminal). */
        fun saved(settings: AppSettings, id: String, demoScreen: String? = null): TerminalViewMode {
            if (demoScreen != null) return if (demoScreen.startsWith("simple")) Simple else Terminal
            return entries.firstOrNull { it.rawValue == settings.string(key(id)) } ?: Simple
        }

        /** A terminal that is gone leaves nothing behind. */
        fun forget(settings: AppSettings, id: String) = settings.putString(key(id), null)
    }
}

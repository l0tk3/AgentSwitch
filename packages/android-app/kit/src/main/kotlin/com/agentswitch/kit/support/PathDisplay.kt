package com.agentswitch.kit.support

/** Paths as people read them (docs/ui-v0.md §1.5): the Mac user's home folder as `~`. */
object PathDisplay {
    /** `/Users/me/Projects/AgentSwitch` → `~/Projects/AgentSwitch`; `/Users/me` → `~`; anything else unchanged. */
    fun short(path: String): String {
        val parts = path.split("/")
        // "", "Users", "<name>", rest…
        if (parts.size < 3 || parts[0].isNotEmpty() || parts[1] != "Users" || parts[2].isEmpty() || parts[2] == "Shared") return path
        val rest = parts.drop(3).joinToString("/")
        return if (rest.isEmpty()) "~" else "~/$rest"
    }

    /** The last folder name, for a compact label. */
    fun name(path: String): String {
        val short = short(path)
        return short.split("/").lastOrNull { it.isNotEmpty() } ?: short
    }
}

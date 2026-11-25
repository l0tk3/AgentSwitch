package com.agentswitch.kit.api

/** What a command an agent ran reads as (the terminals' activity line). */
object EventDescriber {
    /** `/bin/zsh -lc 'ps -A | head'` → `ps -A | head`: Codex wraps every command in a login shell. */
    fun unwrapShell(command: String): String {
        val match = shellWrapper.find(command) ?: return command
        val inner = match.groupValues[2]
        return if (inner.isEmpty()) command else inner
    }

    private val shellWrapper = Regex("""^(?:/bin/|/usr/bin/)?(?:zsh|bash|sh) -l?c (['"])([\s\S]*)\1$""")
}

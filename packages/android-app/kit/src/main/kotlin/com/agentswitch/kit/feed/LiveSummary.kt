package com.agentswitch.kit.feed

import com.agentswitch.kit.api.TerminalInfo
import com.agentswitch.kit.api.TerminalStatus
import com.agentswitch.kit.api.ToolDisplay
import com.agentswitch.kit.api.graphemeCount
import com.agentswitch.kit.api.graphemePrefix
import com.agentswitch.kit.api.isHorizontalSpace
import com.agentswitch.kit.live.LiveState

/**
 * The terminals at work and the ones waiting for you, as the Live Activity's state (assistant-v0 §4); on Android, of
 * the ongoing notification.
 */
object LiveSummary {
    const val maxRows = 3
    internal const val titleChars = 28
    internal const val stepChars = 60

    /**
     * The terminals at work or waiting for you (terminal-v0 §1), the ones waiting first, then the newest; null when
     * there are none. An idle or ended one is not in it.
     */
    fun state(terminals: List<TerminalInfo>): LiveState? {
        val rows = terminals.filter { it.waitsForYou || it.status == TerminalStatus.Working }.map { row(it) }
        if (rows.isEmpty()) return null
        val ordered = rows.sortedWith(compareBy<LiveState.Row> { if (it.needsYou) 0 else 1 }.thenByDescending { it.startedAt })
        val waiting = rows.count { it.needsYou }
        return LiveState(ordered.take(maxRows), rows.size - waiting, waiting)
    }

    /**
     * A terminal waiting for you: its name, what it asks to run ("Bash: npm test"), its agent, since when it asks. At
     * work: what it is using ("运行 npm test", else 进行中), since this turn began.
     */
    internal fun row(terminal: TerminalInfo): LiveState.Row {
        val agent = ModelName.harness(terminal.harness)
        if (!terminal.waitsForYou) {
            return LiveState.Row(
                id = terminal.id, title = clip(terminal.name.ifEmpty { agent }, titleChars),
                step = clip(terminal.activity?.let { MessageDisplay.readable(it.phrase) } ?: "进行中", stepChars), model = agent,
                startedAt = terminal.statusSince ?: terminal.lastOutputAt, needsYou = false,
                doing = terminal.activity?.let { ToolDisplay.word(it.tool) } ?: "Think",
            )
        }
        val ask = terminal.permissions.firstOrNull()
        val since = ask?.at?.takeIf { it > 0 } ?: terminal.statusSince ?: terminal.lastOutputAt
        return LiveState.Row(
            id = terminal.id, title = clip(terminal.name.ifEmpty { agent }, titleChars),
            step = clip(ask?.let { MessageDisplay.readable(it.summary) } ?: "等你处理", stepChars), model = agent,
            startedAt = since, needsYou = true,
            doing = if (ask?.tool == "AskUserQuestion") "Answer" else "Allow?",
        )
    }

    internal fun clip(text: String, limit: Int): String {
        val one = text.replace("\n", " ").trim { it.isHorizontalSpace() }
        return if (one.graphemeCount() > limit) one.graphemePrefix(limit - 1) + "…" else one
    }
}

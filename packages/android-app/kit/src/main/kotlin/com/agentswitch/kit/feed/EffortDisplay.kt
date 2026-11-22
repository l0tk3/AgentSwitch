package com.agentswitch.kit.feed

import com.agentswitch.kit.api.TerminalList
import com.agentswitch.kit.api.graphemePrefix

/**
 * How hard an agent thinks, as the screens offer and say it (docs/terminal-v0.md §1 思考强度, 2026-10-07; user:
 * 新建终端和当前的模型选择页面都没有思考强度的选择，能不能根据各个 agent 客户端和模型适配一下). Each agent has its own word for it
 * and its own levels, which differ by model; the Mac lists them (what the agent itself says), and the screens offer
 * only those.
 */
object EffortDisplay {
    /**
     * The agent's own word for it, as the control's label: Claude Code's effort, Codex's reasoning, OpenCode's variant
     * of a model, pi's thinking.
     */
    fun word(harness: String): String = when (harness) {
        "codex" -> "Reasoning"
        "opencode" -> "Variant"
        "pi" -> "Thinking"
        else -> "Effort"
    }

    /** A level as people read it: `xhigh` → `XHigh`, `low` → `Low`. */
    fun name(level: String): String = when (level) {
        "xhigh" -> "XHigh"
        "" -> ""
        else -> level.split('-', '_').filter { it.isNotEmpty() }.joinToString(" ") { word ->
            val head = word.graphemePrefix(1)
            head.uppercase(java.util.Locale.ROOT) + word.substring(head.length)
        }
    }

    /**
     * The levels a terminal of this agent may be started at with this model chosen (null or empty: none chosen, the
     * agent's default model). Empty: nothing to choose — the model takes no level, the Mac does not list any, or
     * (OpenCode) a variant needs its model chosen first.
     */
    fun levels(list: TerminalList?, harness: String, model: String?): List<String> {
        if (list == null) return emptyList()
        if (model == null || model.isEmpty()) return list.efforts[harness] ?: emptyList()
        return list.models[harness]?.firstOrNull { it.id == model }?.efforts ?: emptyList()
    }

    /**
     * The levels of the model a running terminal is on: the listed model that is it (by id, or by the name people
     * read), else the agent's default model's. (Swift's `levels(_:harness:current:)`: Kotlin cannot tell it from
     * [levels] by its label, so it has its own name.)
     */
    fun levelsCurrent(list: TerminalList?, harness: String, current: String?): List<String> {
        if (list == null) return emptyList()
        val own = list.models[harness]?.firstOrNull { RecordDisplay.isCurrent(it, current) }?.efforts
        if (own != null) return own
        return list.efforts[harness] ?: emptyList()
    }

    /** What "default" is, when the agent says: the chosen model's own, else (none chosen) the agent's default model's. */
    fun defaultLevel(list: TerminalList?, harness: String, model: String?): String? {
        if (list == null) return null
        if (model == null || model.isEmpty()) return list.effortDefaults[harness]
        return list.models[harness]?.firstOrNull { it.id == model }?.defaultEffort
    }

    /** The level kept when the model changes: the one chosen if the new model takes it, else none (its default). */
    fun kept(level: String, levels: List<String>): String = if (level in levels) level else ""

    /** The level a terminal is at, as far as anything says: one just asked for, the last turn's in its record, the one it was started at. */
    fun level(asked: String?, record: String?, started: String?): String? = asked ?: record ?: started

    /** Claude Code's command for another level, typed as a reply: `/effort high`. Letters only. */
    fun command(level: String): String = "/effort " + level.filter { it in 'a'..'z' }

    /** The command that opens an agent's own picker for it, when it has one apart from its model picker. */
    fun picker(harness: String): String? = if (harness == "opencode") "/variants" else null
}

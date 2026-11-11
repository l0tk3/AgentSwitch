package com.agentswitch.kit.feed

import com.agentswitch.kit.api.TargetRef
import java.util.Locale

/**
 * Model and executor ids as people say them (docs/ui-v0.md §1.5): `claude-opus-5-5` → Opus 5.5,
 * `deepseek/deepseek-flash` → DeepSeek Flash, `gpt-6-luna` → GPT-6 Luna, `claude-code` → Claude Code.
 */
object ModelName {
    private val brands: Map<String, String> = mapOf(
        "deepseek" to "DeepSeek", "gpt" to "GPT", "qwen" to "Qwen", "glm" to "GLM", "kimi" to "Kimi", "gemini" to "Gemini",
        "llama" to "Llama", "mistral" to "Mistral", "grok" to "Grok", "o3" to "o3", "o4" to "o4",
    )

    fun display(id: String): String {
        var name = id.split("/").lastOrNull { it.isNotEmpty() } ?: id
        var suffix = ""
        if (name.endsWith("[1m]")) {
            name = name.dropLast(4)
            suffix = " 1M"
        }
        val parts = name.split("-").filter { it.isNotEmpty() }
        // claude-<family>-<major>-<minor>[-<date>]
        if (parts.firstOrNull() == "claude" && parts.size >= 3) {
            val family = capitalized(parts[1])
            val numbers = parts.drop(2).filter { it.codePointCount(0, it.length) <= 2 && it.toIntOrNull() != null }
            return listOf(family, numbers.joinToString(".")).filter { it.isNotEmpty() }.joinToString(" ") + suffix
        }
        // gpt-6-luna → GPT-6 Luna; gpt-5.5 → GPT-5.5
        if (parts.firstOrNull() == "gpt" && parts.size >= 2) {
            val rest = parts.drop(2).map(::capitalized)
            return (listOf("GPT-${parts[1]}") + rest).joinToString(" ") + suffix
        }
        return parts.joinToString(" ") { brands[it.lowercase(Locale.ROOT)] ?: capitalized(it) } + suffix
    }

    fun harness(id: String): String = when (id) {
        "claude-code" -> "Claude Code"
        "codex" -> "Codex"
        "opencode" -> "OpenCode"
        "pi" -> "pi"
        "grok" -> "Grok"
        "echo" -> "Echo"
        else -> capitalized(id)
    }

    private fun capitalized(word: String): String {
        if (word.isEmpty()) return word
        val first = word.offsetByCodePoints(0, 1)
        return word.substring(0, first).uppercase(Locale.ROOT) + word.substring(first)
    }
}

/** "Opus 5.5 · Claude Code": a choice of model in a menu. */
val TargetRef.displayName: String get() = "${ModelName.display(model)} · ${ModelName.harness(harness)}"

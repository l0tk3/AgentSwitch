package com.agentswitch.kit.feed

import com.agentswitch.kit.api.QuotaReading
import com.agentswitch.kit.api.cFixed
import com.agentswitch.kit.api.graphemePrefix
import com.agentswitch.kit.api.isHorizontalSpace
import com.agentswitch.kit.support.JSONValue

/**
 * 设置 › 用量 (docs/ui-v0.md §4.2): `GET /quota` as one row per executor. Claude Code and Codex always show the same two
 * windows, 5h and 7d, from `detail.windows`; OpenCode shows its DeepSeek balance from `detail.balances`. A window
 * without a reading, or one whose reset time has passed, has no percent (the row draws an empty bar and "—").
 * Times are milliseconds since 1970; `now` is passed in.
 */
object Usage {
    /** The executors in the order the rows are shown; readings for anything else are left out. */
    val harnesses = listOf("claude-code", "codex", "opencode")

    /** The two windows of every Claude Code and Codex row, in this order; others (Claude's "7d opus") are not shown. */
    val windowLabels = listOf("5h", "7d")

    /** From this much used the bar turns red. */
    const val alertPercent = 90
    internal const val missing = "—"

    data class Slot(
        val label: String,
        /** Used, 0...100; null without a reading, or once the window has reset. */
        val percent: Int?,
        /** When the window resets, milliseconds since 1970; null when unknown or already past. */
        val resetsAt: Long?,
    ) {
        val id: String get() = label
        val percentText: String get() = percent?.let { "$it%" } ?: missing
        val isHigh: Boolean get() = (percent ?: 0) >= alertPercent

        /** "5 小时" / "7 天", for VoiceOver. */
        val spokenLabel: String
            get() {
                if (label.isEmpty()) return label
                val unit = label.last()
                val n = label.dropLast(1).toIntOrNull() ?: return label
                return when (unit) {
                    'h' -> "$n 小时"
                    'd' -> "$n 天"
                    'm' -> "$n 分钟"
                    else -> label
                }
            }
    }

    data class Row(
        val harness: String,
        /** "Claude Code", "Codex · Pro", "OpenCode". */
        val title: String,
        /** Claude Code and Codex: 5h and 7d. OpenCode: none (a balance instead). */
        val slots: List<Slot>,
        /** OpenCode: "¥96.23"; null for the others, or when the balance is unknown. */
        val balance: String?,
    ) {
        val id: String get() = harness
        val showsBalance: Boolean get() = slots.isEmpty()
        val balanceText: String get() = "Balance " + (balance ?: missing)
    }

    fun rows(readings: List<QuotaReading>, now: Long = System.currentTimeMillis()): List<Row> =
        harnesses.mapNotNull { harness -> readings.firstOrNull { it.harness == harness }?.let { row(it, now) } }

    /** When the numbers shown were read (milliseconds since 1970): the oldest of the rows' readings. */
    fun readAt(readings: List<QuotaReading>): Long? =
        readings.filter { it.harness in harnesses }.map { it.fetched }.minOrNull()

    internal fun row(reading: QuotaReading, now: Long): Row {
        val name = ModelName.harness(reading.harness)
        if (reading.harness == "opencode") {
            return Row(reading.harness, name, emptyList(), balance(reading.detail))
        }
        val plan = if (reading.harness == "codex") reading.detail?.get("planType")?.string?.let { planName(it) } else null
        return Row(reading.harness, plan?.let { "$name · $it" } ?: name, windowLabels.map { slot(it, reading.detail, now) }, null)
    }

    internal fun slot(label: String, detail: JSONValue?, now: Long): Slot {
        val window = detail?.get("windows")?.array?.firstOrNull { it["label"]?.string == label }
        // `resetsAt` is in seconds on the wire.
        val resetsAtSeconds = window?.get("resetsAt")?.number
        if (resetsAtSeconds != null && resetsAtSeconds * 1000 <= now) return Slot(label, null, null)
        val percent = window?.get("usedPercent")?.number?.let { Math.round(minOf(maxOf(it, 0.0), 100.0)).toInt() }
        return Slot(label, percent, if (percent == null) null else resetsAtSeconds?.let { (it * 1000).toLong() })
    }

    /** "pro" → "Pro". */
    internal fun planName(plan: String): String? {
        val trimmed = plan.trim { it.isHorizontalSpace() }
        if (trimmed.isEmpty()) return null
        val first = trimmed.graphemePrefix(1)
        return first.uppercase() + trimmed.substring(first.length)
    }

    /** Every balance, "¥96.23 · $5.00"; null when there is none. */
    internal fun balance(detail: JSONValue?): String? {
        val amounts = (detail?.get("balances")?.array ?: emptyList()).mapNotNull { item ->
            val total = item["total"]?.string ?: item["total"]?.number?.let { it.toString() } ?: return@mapNotNull null
            money(total, item["currency"]?.string ?: "")
        }
        return if (amounts.isEmpty()) null else amounts.joinToString(" · ")
    }

    internal fun money(amount: String, currency: String): String {
        val value = amount.toDoubleOrNull()?.cFixed(2) ?: amount
        return when (currency.uppercase()) {
            "CNY", "RMB" -> "¥$value"
            "USD" -> "$$value"
            "" -> value
            else -> "$value $currency"
        }
    }
}

package com.agentswitch.kit.api

import kotlinx.serialization.Serializable

// Several sessions deleted at once (docs/terminal-v0.md §5 批量删除; the Mac's SessionsRemoval.swift, in this package:
// packages share nothing): what the Mac said of each, and the tab's words about it.

/**
 * `POST /sessions/delete`'s answer: each session's outcome — `deleted`, `busy` (in use: left), `gone` (not there any
 * more), `failed`.
 */
@Serializable
data class SessionsRemoval(val results: List<One>) {
    enum class Outcome(val rawValue: String) {
        Deleted("deleted"), Busy("busy"), Gone("gone"), Failed("failed"),
    }

    @Serializable
    data class One(
        val harness: String,
        val id: String,
        val outcome: String,
        val error: String? = null,
    ) {
        constructor(harness: String, id: String, outcome: Outcome, error: String? = null) : this(harness, id, outcome.rawValue, error)
    }

    fun count(outcome: Outcome): Int = results.count { it.outcome == outcome.rawValue }

    /** The sessions still on the Mac — in use, or not deleted for another reason — as `SessionSummary.id` names them. */
    val kept: Set<String>
        get() = results.filter { it.outcome == Outcome.Busy.rawValue || it.outcome == Outcome.Failed.rawValue }
            .map { "${it.harness}/${it.id}" }.toSet()

    companion object {
        /** What one `DELETE /sessions/:harness/:id` came to, for a Mac whose service has no batch route yet. */
        fun outcome(of: Throwable?): Outcome {
            val error = of ?: return Outcome.Deleted
            if (error is APIError.Http) return if (error.status == 409) Outcome.Busy else if (error.status == 404) Outcome.Gone else Outcome.Failed
            return Outcome.Failed
        }
    }
}

object SessionDeleteWords {
    fun all(count: Int): String = if (count == 1) "Delete Session…" else "Delete All $count Sessions…"

    /** The first few by name, then how many in all: what is about to go is read before it goes. */
    fun question(titles: List<String>, named: Int = 3): String {
        val names = titles.take(named).joinToString("、") { "「$it」" }
        val which = if (titles.size > named) "${names}等 ${titles.size} 个会话" else names
        return "删除${which}的记录？Mac 上这些会话的记录将被删除，无法恢复，也无法再继续。正在使用的会话不会删除。"
    }

    /** What was left and why, after the rest went; null when all of them went. */
    fun left(removal: SessionsRemoval): String? {
        val parts = mutableListOf<String>()
        val busy = removal.count(SessionsRemoval.Outcome.Busy)
        val failed = removal.count(SessionsRemoval.Outcome.Failed)
        if (busy > 0) parts.add("$busy 个正在使用，未删除")
        if (failed > 0) parts.add("$failed 个未能删除")
        if (parts.isEmpty()) return null
        val deleted = removal.count(SessionsRemoval.Outcome.Deleted)
        return ((if (deleted > 0) listOf("已删除 $deleted 个会话") else emptyList()) + parts).joinToString("；") + "。"
    }
}

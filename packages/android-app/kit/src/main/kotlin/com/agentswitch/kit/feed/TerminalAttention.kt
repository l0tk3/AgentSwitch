package com.agentswitch.kit.feed

import com.agentswitch.kit.api.TerminalInfo
import com.agentswitch.kit.api.TerminalStatus

/** Waiting for an answer: a permission request, or a prompt on its screen the agent reported (the tab's badge). */
val TerminalInfo.waitsForYou: Boolean
    get() = status != TerminalStatus.Exited && (status == TerminalStatus.Waiting || permissions.isNotEmpty())

/**
 * What voice mode reads when it starts to wait: 终端「修复登录」等你批准：Bash; a question is said as one
 * (终端「修复登录」问你：会话存在哪里？, 2026-10-01), not as a tool to approve.
 */
val TerminalInfo.spokenWait: String
    get() {
        val name = name.ifEmpty { ModelName.harness(harness) }
        val ask = permissions.firstOrNull()
        val question = ask?.questions?.firstOrNull()
        if (ask != null && question != null) return "终端「$name」问你：${question.question}"
        if (ask != null && ask.tool.isNotEmpty()) return "终端「$name」等你批准：${ask.tool}"
        return "终端「$name」等你处理"
    }

/**
 * Terminals that newly need you (terminal-v0 §1), for the same cue as a task's question: one with a permission request
 * not seen before, or one that turned to waiting without one. The first look only sets the baseline, as for approvals.
 * (A Swift struct with a `mutating` function: a class whose function changes its own state.)
 */
class TerminalCueTracker {
    /** "terminal/permission" (a permission id is the terminal's own). */
    private var seenAsks: Set<String>? = null
    private var waiting: Set<String> = emptySet()

    fun newlyWaiting(terminals: List<TerminalInfo>): List<TerminalInfo> {
        val now = terminals.filter { it.waitsForYou }
        val asks = now.flatMap { t -> t.permissions.map { "${t.id}/${it.id}" } }.toSet()
        val before = waiting
        val seen = seenAsks
        seenAsks = (seen ?: emptySet()) + asks
        waiting = now.map { it.id }.toSet()
        if (seen == null) return emptyList()
        return now.filter { t -> t.id !in before || t.permissions.any { "${t.id}/${it.id}" !in seen } }
    }
}

/**
 * Terminals whose turn newly ended (docs/app-v0.md §5 “通知”): at work at the last look, at rest now. The first look
 * only sets the baseline; one that waits for you is the other tracker's. (A class, as [TerminalCueTracker].)
 */
class TerminalDoneTracker {
    private var working: Set<String>? = null

    fun newlyDone(terminals: List<TerminalInfo>): List<TerminalInfo> {
        val now = terminals.filter { it.status == TerminalStatus.Working }.map { it.id }.toSet()
        val before = working
        working = now
        if (before == null) return emptyList()
        return terminals.filter { it.id in before && it.status == TerminalStatus.Idle && !it.waitsForYou }
    }
}

/** What a notification calls it: its name, else its agent's. */
val TerminalInfo.noticeName: String
    get() = name.ifEmpty { ModelName.harness(harness) }

/** What a notification says it waits for: the question, the tool to approve, or nothing more. */
val TerminalInfo.noticeWait: String
    get() {
        val ask = permissions.firstOrNull()
        val question = ask?.questions?.firstOrNull()
        if (question != null) return question.question
        if (ask != null && ask.summary.isNotEmpty()) return ask.summary
        return "等你处理。"
    }

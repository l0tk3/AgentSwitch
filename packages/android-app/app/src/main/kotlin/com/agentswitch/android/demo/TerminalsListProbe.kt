package com.agentswitch.android.demo

import com.agentswitch.kit.api.SessionSummary
import com.agentswitch.kit.api.TerminalInfo
import com.agentswitch.kit.api.TerminalList
import com.agentswitch.kit.api.TerminalStatus
import com.agentswitch.kit.api.TerminalSubagent

/**
 * `terminalsmany`: the terminals tab on a long made-up tree — one home folder holding everything, as a Mac's real list
 * nests (docs/terminal-v0.md §1) — read again every 4 s as the tab reads the Mac (a terminal's sub-agents come and go,
 * a session is written to). Only the data is here; the iPhone's scripted walk (scrolling, tab switches, folding, the
 * failed-read line, written to a probe file) is a timing probe and is not ported.
 */
object TerminalsListProbe {
    const val home = "/Users/me"

    val folders: List<String> by lazy {
        val paths = mutableListOf("", "/Desktop", "/Desktop/WorkSpace/Worktop", "/Desktop/WorkSpace/Worktop/培训", "/Desktop/WorkSpace/Worktop/培训/靶场")
        for (p in listOf(
            "harbor", "harbor/deploy", "lumen", "lumen/packages/api", "lumen/packages/web", "notes", "relay", "relay/cli",
            "atlas", "atlas/ios", "atlas/server", "kiln", "quarry", "quarry/tools", "tidewater", "beacon", "beacon/docs", "ember",
        )) {
            paths.add("/Desktop/WorkSpace/Projects/$p")
        }
        paths += listOf("/Work/api", "/Work/api/scripts", "/Blog", "/Downloads/scratch")
        paths.map { home + it }
    }

    val words = listOf(
        "连接池", "错误码统一", "发布流程", "回滚脚本", "缓存命中率", "构建报错", "登录页", "日志轮转", "测试修复", "依赖升级",
        "接口文档", "重试策略", "权限检查", "迁移脚本", "性能分析",
    )

    /** The sessions: two to seven a folder, newest first; one written to just now while [tick] goes on. */
    fun sessions(tick: Int): List<SessionSummary> {
        val all = mutableListOf<SessionSummary>()
        val agents = listOf("claude-code", "codex", "opencode", "pi", "grok")
        for ((f, cwd) in folders.withIndex()) {
            for (k in 0 until (2 + (f * 5) % 6)) {
                val n = f * 10 + k
                val fresh = if (n == 31) DemoData.ago(5) + tick.toLong() * 4000 else DemoData.ago(600 + n * 3700L)
                all.add(
                    SessionSummary(
                        harness = agents[n % agents.size], sessionId = "m$n", cwd = cwd, title = "${words[n % words.size]} $n",
                        lastText = "…", updatedAt = fresh, startedAt = DemoData.ago(900 + n * 3700L), active = n == 31,
                    ),
                )
            }
        }
        return all
    }

    /** Six terminals across the tree; those that work have sub-agents that come and go from one read to the next. */
    fun list(tick: Int): TerminalList {
        val at = listOf(
            5 to TerminalStatus.Working, 5 to TerminalStatus.Idle, 8 to TerminalStatus.Waiting,
            13 to TerminalStatus.Working, 20 to TerminalStatus.Working, 24 to TerminalStatus.Idle,
        )
        val terminals = at.mapIndexed { i, t ->
            TerminalInfo(
                id = "mt$i", harness = if (i % 2 == 0) "claude-code" else "codex", cwd = folders[t.first], name = "终端 $i", status = t.second,
                createdAt = DemoData.ago(3600), lastOutputAt = DemoData.ago(2),
                subagents = if (t.second == TerminalStatus.Working && (tick + i) % 3 != 0)
                    (0 until (1 + (tick + i) % 3)).map { TerminalSubagent(id = "s$i$it", type = "Explore", name = "子任务 $it", doing = "读取 src/$tick.ts") }
                else emptyList(),
            )
        }
        return TerminalList(terminals = terminals, agents = listOf("claude-code", "codex", "opencode", "pi", "grok"))
    }
}

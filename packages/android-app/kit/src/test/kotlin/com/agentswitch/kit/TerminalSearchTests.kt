package com.agentswitch.kit

import com.agentswitch.kit.api.GitSummary
import com.agentswitch.kit.api.SessionSummary
import com.agentswitch.kit.api.TerminalInfo
import com.agentswitch.kit.api.TerminalStatus
import com.agentswitch.kit.feed.TerminalSearch
import com.agentswitch.kit.feed.TerminalTree
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class TerminalSearchTests {
    private fun session(id: String, cwd: String, title: String) =
        SessionSummary(harness = "claude-code", sessionId = id, cwd = cwd, title = title, updatedAt = 1, startedAt = 1)

    private val nodes: List<TerminalTree.Folder>
        get() {
            val terminal = TerminalInfo(id = "t1", harness = "claude-code", cwd = "/Users/u/Work/api", name = "修复登录超时", status = TerminalStatus.Working,
                createdAt = 1, lastOutputAt = 1, agentSessionId = "c9")
            return TerminalTree.build(listOf(terminal), listOf(
                session("s1", "/Users/u/Work/api", "给健康检查加缓存"), session("s2", "/Users/u/Work/web", "表单校验"),
                session("s3", "/Users/u/AgentSwitch", "未读标记"),
            ), git = mapOf("/Users/u/AgentSwitch" to GitSummary(branch = "main")))
        }

    @Test
    fun testFoldersByNameWithAllTheyHold() {
        val result = TerminalSearch.run(nodes, "agentsw")
        assertEquals(listOf("AgentSwitch"), result.folders.map { it.name })
        assertEquals(listOf("s:claude-code/s3@1-1"), result.folders[0].rows.map { it.id })
        assertEquals("main", result.folders[0].git?.branch)
        assertEquals("// 1 folder", result.summary)
    }

    @Test
    fun testTitlesAndWordsKeepTheTreeOrder() {
        val said = mapOf("claude-code:c9" to "…连接池太小，改成 64。", "claude-code:s2" to "校验放在失焦时")
        val result = TerminalSearch.run(nodes, "缓存", said)
        assertEquals(listOf("Work/api", "Work/web"), result.folders.map { it.name })
        // The terminal by the words of the session it writes; a title that matched carries no line of words.
        assertEquals(listOf("t:t1", "s:claude-code/s1@1-1"), result.folders[0].rows.map { it.id })
        assertEquals(listOf<String?>("…连接池太小，改成 64。", null), result.folders[0].rows.map { it.said })
        assertEquals(listOf(false, true), result.folders[0].rows.map { it.titleHit })
        assertEquals("// 1 title · 2 in text", result.summary)
        assertTrue(TerminalSearch.run(nodes, "没有这个").folders.isEmpty())
        assertTrue(TerminalSearch.run(nodes, "  ").folders.isEmpty())
    }

    /** A folder in another goes by the names of the folders it sits in, and a match on those keeps it. */
    @Test
    fun testNestedFoldersAreNamedByTheFoldersTheySitIn() {
        val tree = TerminalTree.build(emptyList(), listOf(
            session("w", "/Users/u/Worktop", "整理"), session("r", "/Users/u/Worktop/培训/靶场", "靶机"), session("c", "/Users/u/Worktop/Codex", "其他"),
        ))
        val result = TerminalSearch.run(tree, "worktop")
        assertEquals(listOf("Worktop", "Worktop/Codex", "Worktop/培训/靶场"), result.folders.map { it.name })
        assertEquals(listOf(1), TerminalSearch.run(tree, "靶场").folders.map { it.rows.size })
    }

    @Test
    fun testTheMatchShowsInANarrowRow() {
        assertEquals("…置文件，发现连接池太小", TerminalSearch.near("连接池", "…先看了一下配置文件，发现连接池太小"))
        assertEquals("连接池太小", TerminalSearch.near("池", "连接池太小"))
        assertNotNull(TerminalSearch.match("KEY", "a key here"))
    }
}

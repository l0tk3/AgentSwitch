package com.agentswitch.kit

import com.agentswitch.kit.api.APIError
import com.agentswitch.kit.api.SessionDeleteWords
import com.agentswitch.kit.api.SessionsRemoval
import com.agentswitch.kit.support.KitJson
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** Several sessions deleted at once (docs/terminal-v0.md §5 批量删除). */
class SessionsRemovalTests {
    @Test
    fun testTheMacsAnswer() {
        val json = """{"results":[{"harness":"claude-code","id":"c1","outcome":"deleted"},{"harness":"codex","id":"x1","outcome":"busy","error":"会话正在终端中打开，请先关闭终端。"},{"harness":"pi","id":"p1","outcome":"failed"},{"harness":"codex","id":"x2","outcome":"gone"}],"deleted":1,"busy":1,"gone":1,"failed":1}"""
        val removal = KitJson.decodeFromString(SessionsRemoval.serializer(), json)
        assertEquals(1, removal.count(SessionsRemoval.Outcome.Deleted))
        assertEquals(1, removal.count(SessionsRemoval.Outcome.Busy))
        // What stays on the Mac comes back to the list, named as the list names a session.
        assertEquals(setOf("codex/x1", "pi/p1"), removal.kept)
        assertEquals("已删除 1 个会话；1 个正在使用，未删除；1 个未能删除。", SessionDeleteWords.left(removal))
    }

    @Test
    fun testOneByOneForAMacWithoutTheRoute() {
        assertEquals(SessionsRemoval.Outcome.Deleted, SessionsRemoval.outcome(null))
        assertEquals(SessionsRemoval.Outcome.Busy, SessionsRemoval.outcome(APIError.Http(409, "会话正在使用中")))
        assertEquals(SessionsRemoval.Outcome.Gone, SessionsRemoval.outcome(APIError.Http(404, "no such session")))
        assertEquals(SessionsRemoval.Outcome.Failed, SessionsRemoval.outcome(APIError.Http(500, "")))
        assertEquals(SessionsRemoval.Outcome.Failed, SessionsRemoval.outcome(APIError.Unreachable))
    }

    @Test
    fun testTheWords() {
        assertEquals("Delete All 4 Sessions…", SessionDeleteWords.all(4))
        assertEquals("删除「a」、「b」的记录？Mac 上这些会话的记录将被删除，无法恢复，也无法再继续。正在使用的会话不会删除。", SessionDeleteWords.question(listOf("a", "b")))
        assertEquals("删除「a」、「b」、「c」等 4 个会话的记录？Mac 上这些会话的记录将被删除，无法恢复，也无法再继续。正在使用的会话不会删除。", SessionDeleteWords.question(listOf("a", "b", "c", "d")))
        assertNull(SessionDeleteWords.left(SessionsRemoval(listOf(SessionsRemoval.One("codex", "x", SessionsRemoval.Outcome.Deleted), SessionsRemoval.One("codex", "y", SessionsRemoval.Outcome.Gone)))))
        assertEquals("1 个正在使用，未删除。", SessionDeleteWords.left(SessionsRemoval(listOf(SessionsRemoval.One("codex", "x", SessionsRemoval.Outcome.Busy)))))
    }
}

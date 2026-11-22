package com.agentswitch.kit

import com.agentswitch.kit.api.AgentTask
import com.agentswitch.kit.api.TerminalActivity
import com.agentswitch.kit.api.TerminalInfo
import com.agentswitch.kit.api.TerminalPermission
import com.agentswitch.kit.api.TerminalQuestion
import com.agentswitch.kit.api.TerminalStatus
import com.agentswitch.kit.feed.LiveSummary
import com.agentswitch.kit.feed.TerminalCueTracker
import com.agentswitch.kit.feed.TerminalDoneTracker
import com.agentswitch.kit.feed.noticeName
import com.agentswitch.kit.feed.noticeWait
import com.agentswitch.kit.feed.spokenWait
import com.agentswitch.kit.feed.waitsForYou
import com.agentswitch.kit.live.LiveLink
import com.agentswitch.kit.live.LiveState
import com.agentswitch.kit.support.KitJson
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * terminal-v0 §1's reminders: a terminal that newly waits for you gets the "needs you" cue once (the first look only
 * sets the baseline), and the terminals waiting are rows of the Live Activity beside the tasks.
 */
class TerminalAttentionTests {
    private fun terminal(id: String, status: TerminalStatus = TerminalStatus.Working, asks: List<String> = emptyList(), name: String = "修复登录",
                         harness: String = "claude-code", at: Long = 1_700_000_000_000) =
        TerminalInfo(id = id, harness = harness, cwd = "/Users/me/p", name = name, status = status, createdAt = 1, lastOutputAt = 1_600_000_000_000,
            permissions = asks.map { TerminalPermission(id = it, tool = "Bash", summary = "Bash: npm test", at = at) })

    private fun ids(list: List<TerminalInfo>) = list.map { it.id }

    @Test
    fun testWaitingIsAPermissionOrTheWaitingStateButNeverOnceExited() {
        assertFalse(terminal("a").waitsForYou)
        assertFalse(terminal("a", TerminalStatus.Idle).waitsForYou)
        assertTrue(terminal("a", TerminalStatus.Waiting).waitsForYou)
        assertTrue(terminal("a", TerminalStatus.Working, asks = listOf("p1")).waitsForYou)
        assertFalse(terminal("a", TerminalStatus.Exited, asks = listOf("p1")).waitsForYou)
    }

    @Test
    fun testNewlyWaitingOnlyOnceAfterTheBaseline() {
        val tracker = TerminalCueTracker()
        assertEquals(emptyList(), ids(tracker.newlyWaiting(listOf(terminal("a", TerminalStatus.Waiting, asks = listOf("p1")), terminal("b")))),
            "already waiting when the phone first looks is not news")
        assertEquals(emptyList(), ids(tracker.newlyWaiting(listOf(terminal("a", TerminalStatus.Waiting, asks = listOf("p1")), terminal("b")))))
        assertEquals(listOf("a"), ids(tracker.newlyWaiting(listOf(terminal("a", TerminalStatus.Waiting, asks = listOf("p1", "p2")), terminal("b")))),
            "a second request while it still waits")
        assertEquals(listOf("b"), ids(tracker.newlyWaiting(listOf(terminal("a"), terminal("b", TerminalStatus.Waiting)))),
            "turned to waiting without a request (a prompt on its screen)")
        assertEquals(emptyList(), ids(tracker.newlyWaiting(listOf(terminal("a"), terminal("b", TerminalStatus.Waiting)))))
        assertEquals(listOf("a"), ids(tracker.newlyWaiting(listOf(terminal("a", asks = listOf("p1")), terminal("b", TerminalStatus.Waiting)))),
            "waiting again after it was answered, even with an id seen before")
        assertEquals(listOf("c"), ids(tracker.newlyWaiting(listOf(terminal("a", TerminalStatus.Exited, asks = listOf("p3")), terminal("c", asks = listOf("p1"))))),
            "an ended one is not waiting; a request id is the terminal's own")
    }

    @Test
    fun testWhatVoiceModeSays() {
        assertEquals("终端「修复登录」等你批准：Bash", terminal("a", asks = listOf("p1")).spokenWait)
        assertEquals("终端「Claude Code」等你处理", terminal("a", TerminalStatus.Waiting, name = "").spokenWait)
        assertEquals("终端「pi」等你处理", terminal("a", TerminalStatus.Waiting, name = "", harness = "pi").spokenWait)
        // A question is said as one, not as AskUserQuestion to approve (2026-10-01).
        val asking = TerminalInfo(id = "q", harness = "claude-code", cwd = "/p", name = "修复登录", status = TerminalStatus.Waiting, createdAt = 1, lastOutputAt = 1,
            permissions = listOf(TerminalPermission(id = "p1", tool = "AskUserQuestion", summary = "会话存在哪里？",
                questions = listOf(TerminalQuestion(question = "会话存在哪里？", options = listOf(TerminalQuestion.Option(label = "Redis")))))))
        assertEquals("终端「修复登录」问你：会话存在哪里？", asking.spokenWait)
    }

    @Test
    fun testAWaitingTerminalIsARowAndStartsTheSummaryOnItsOwn() {
        assertNull(LiveSummary.state(emptyList(), emptyList(), emptyMap(), terminals = listOf(terminal("b", TerminalStatus.Idle), terminal("c", TerminalStatus.Exited))),
            "an idle or ended terminal is not in it")
        val state = assertNotNull(LiveSummary.state(emptyList(), emptyList(), emptyMap(), terminals = listOf(terminal("a", asks = listOf("p1")))))
        assertEquals(LiveState.Phase.NeedsYou, state.phase)
        assertEquals(1, state.waiting)
        assertEquals(0, state.running)
        assertFalse(state.hasTasks, "no conclusion to show once it is answered")
        val row = assertNotNull(state.lead)
        assertEquals(LiveState.Row.Kind.Terminal, row.kind)
        assertEquals("修复登录", row.title)
        assertEquals("Bash: npm test", row.step)
        assertEquals("Claude Code", row.model)
        assertEquals(1_700_000_000_000L, row.startedAt, "the clock counts from the request")
        assertEquals(LiveLink.terminal("a"), row.link)
        val screen = assertNotNull(LiveSummary.state(emptyList(), emptyList(), emptyMap(), terminals = listOf(terminal("a", TerminalStatus.Waiting)))?.lead)
        assertEquals("等你处理", screen.step)
        assertEquals(1_600_000_000_000L, screen.startedAt, "no request: since its last output")
    }

    /** 2026-09-30, user: 实时活动应该包括终端里的活动，不只是路由器调度的. */
    @Test
    fun testATerminalAtWorkIsARowInProgressSayingWhatItUses() {
        val busy = TerminalInfo(id = "k1", harness = "codex", cwd = "/p", name = "api-refactor", status = TerminalStatus.Working, createdAt = 1, lastOutputAt = 9,
            activity = TerminalActivity(tool = "Bash", target = "/bin/zsh -lc 'npm test'"), statusSince = 1_700_000_000_000)
        val state = assertNotNull(LiveSummary.state(emptyList(), emptyList(), emptyMap(), terminals = listOf(busy, terminal("b", TerminalStatus.Idle))))
        assertEquals(LiveState.Phase.Running, state.phase)
        assertEquals(1, state.running)
        assertEquals(0, state.waiting)
        val row = assertNotNull(state.lead)
        assertEquals(LiveState.Row.Kind.Terminal, row.kind)
        assertFalse(row.needsYou)
        assertEquals("api-refactor", row.title)
        assertEquals("运行 npm test", row.step)
        assertEquals("Codex", row.model)
        assertEquals(1_700_000_000_000L, row.startedAt, "since this turn began")
        val quiet = assertNotNull(LiveSummary.state(emptyList(), emptyList(), emptyMap(), terminals = listOf(terminal("a")))?.lead)
        assertEquals("进行中", quiet.step, "no tool reported yet")
    }

    @Test
    fun testTerminalsAndTasksWaitingComeFirstNewestFirst() {
        val running = KitJson.decodeFromString(AgentTask.serializer(), mapToJsonText(mapOf(
            "id" to "t1", "createdAt" to 1_800_000_000_000, "updatedAt" to 1_800_000_000_000, "status" to "running", "task" to "整理下载目录")))
        val state = assertNotNull(LiveSummary.state(listOf(running), emptyList(), emptyMap(),
            terminals = listOf(terminal("old", asks = listOf("p"), at = 1_000), terminal("new", asks = listOf("p"), at = 2_000))))
        assertEquals(listOf("new", "old", "t1"), state.rows.map { it.id })
        assertEquals(2, state.waiting)
        assertEquals(1, state.running)
        assertTrue(state.hasTasks)
        assertEquals(LiveLink.task("t1"), state.rows.lastOrNull()?.link)
    }

    @Test
    fun testTerminalLinksGoBothWaysAndAreNotTaskLinks() {
        val url = LiveLink.terminal("a1b2c3d4")
        assertEquals("agentswitch://terminal/a1b2c3d4", url)
        assertEquals("a1b2c3d4", LiveLink.terminalId(url))
        assertNull(LiveLink.taskId(url))
        assertNull(LiveLink.terminalId(LiveLink.task("a1b2c3d4")))
        assertNull(LiveLink.terminalId("agentswitch://terminal/"))
    }

    @Test
    fun testAStateSavedBeforeRowsHadAKindReadsAsTasks() {
        val old = """{"rows":[{"id":"t1","title":"x","step":"y","startedAt":0,"needsYou":false}],"running":1,"waiting":0}"""
        val state = KitJson.decodeFromString(LiveState.serializer(), old)
        assertEquals(LiveState.Row.Kind.Task, state.rows.firstOrNull()?.kind)
        val again = KitJson.decodeFromString(LiveState.serializer(), KitJson.encodeToString(LiveState.serializer(),
            LiveState(rows = listOf(LiveState.Row(id = "a", title = "x", step = "y", model = null, startedAt = 1, needsYou = true, kind = LiveState.Row.Kind.Terminal)), running = 0, waiting = 1)))
        assertEquals(LiveState.Row.Kind.Terminal, again.rows.firstOrNull()?.kind)
    }

    @Test
    fun testATurnThatEndedIsToldOnceAndNotOnTheFirstLook() {
        val tracker = TerminalDoneTracker()
        assertEquals(emptyList(), ids(tracker.newlyDone(listOf(terminal("a", TerminalStatus.Idle), terminal("b")))), "the first look sets the baseline")
        assertEquals(listOf("b"), ids(tracker.newlyDone(listOf(terminal("a", TerminalStatus.Idle), terminal("b", TerminalStatus.Idle)))))
        assertEquals(emptyList(), ids(tracker.newlyDone(listOf(terminal("a", TerminalStatus.Idle), terminal("b", TerminalStatus.Idle)))))
        assertEquals(emptyList(), ids(tracker.newlyDone(listOf(terminal("a"), terminal("b")))))
        // One that stopped to ask is the other tracker's; one that ended is not a turn that ended.
        assertEquals(emptyList(), ids(tracker.newlyDone(listOf(terminal("a", TerminalStatus.Waiting, asks = listOf("p1")), terminal("b", TerminalStatus.Exited)))))
        assertEquals(listOf("Claude Code", "修复登录"), listOf(terminal("a", name = "").noticeName, terminal("a").noticeName))
        assertEquals(listOf("Bash: npm test", "等你处理。"), listOf(terminal("a", TerminalStatus.Waiting, asks = listOf("p1")).noticeWait, terminal("a", TerminalStatus.Waiting).noticeWait))
    }
}

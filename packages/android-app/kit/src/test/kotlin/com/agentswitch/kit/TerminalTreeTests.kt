package com.agentswitch.kit

import com.agentswitch.kit.api.FolderGitList
import com.agentswitch.kit.api.GitSummary
import com.agentswitch.kit.api.SessionSummary
import com.agentswitch.kit.api.TerminalInfo
import com.agentswitch.kit.api.TerminalStatus
import com.agentswitch.kit.feed.TerminalTree
import com.agentswitch.kit.support.KitJson
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class TerminalTreeTests {
    private fun term(id: String, cwd: String, created: Long, status: TerminalStatus = TerminalStatus.Idle, session: String? = null, resumedFrom: String? = null) =
        TerminalInfo(id = id, harness = "claude-code", cwd = cwd, name = id, status = status, createdAt = created, lastOutputAt = created + 100,
            agentSessionId = session, resumedFrom = resumedFrom)

    private fun session(id: String, cwd: String, at: Long = 1, started: Long? = null) =
        SessionSummary(harness = "claude-code", sessionId = id, cwd = cwd, title = id, updatedAt = at, startedAt = started)

    /** The tree as `name/` lines, two spaces a level, its own terminals and sessions as `· id`. */
    private fun lines(folders: List<TerminalTree.Folder>, depth: Int = 0): List<String> {
        val pad = "  ".repeat(depth)
        return folders.flatMap { f ->
            listOf("$pad${f.name}/") + f.terminals.map { "$pad  · ${it.id}" } + f.sessions.map { "$pad  · ${it.sessionId}" } + lines(f.children, depth + 1)
        }
    }

    private val w = "/Users/u/Desktop/WorkSpace"

    // 2026-09-30, user: 目录树顺序应该是固定的，现在会根据活跃状态顺序乱跳.
    @Test
    fun testTheOrderIsFixedFoldersByPathTerminalsAsOpenedSessionsAsBegun() {
        val terminals = listOf(term("t2", "/Users/u/Work/api", created = 20), term("t1", "/Users/u/Code/AgentSwitch", created = 10),
            term("t3", "/Users/u/Work/api", created = 30))
        val sessions = listOf(session("s1", "/Users/u/Work/web", at = 999, started = 100), session("s2", "/Users/u/Docs/Notes", at = 500, started = 400),
            session("s3", "/Users/u/Code/AgentSwitch", at = 50, started = 40), session("s4", "/Users/u/Code/AgentSwitch", at = 9_999, started = 30))
        val folders = TerminalTree.build(terminals, sessions)
        assertEquals(listOf("AgentSwitch/", "  · t1", "  · s3", "  · s4", "Notes/", "  · s2",
            "Work/", "  api/", "    · t2", "    · t3", "  web/", "    · s1"), lines(folders), "s4 is busy now; it began earlier and stays below")
        assertFalse(folders[2].holdsOwn)
        assertEquals(listOf("t1", "t2", "t3"), TerminalTree.order(folders).map { it.id })
        // Work going on anywhere moves nothing.
        val later = TerminalTree.build(terminals, sessions.map { SessionSummary(harness = it.harness, sessionId = it.sessionId, cwd = it.cwd, title = it.title, updatedAt = it.updatedAt + 50_000, startedAt = it.startedAt) })
        assertEquals(lines(folders), lines(later))
    }

    // 2026-10-03, user: 怎么分别显示了两个worktop.
    @Test
    fun testAFolderWithSessionsOfItsOwnThatHoldsOthersIsOneLine() {
        val folders = TerminalTree.build(emptyList(), listOf(session("own", "$w/Worktop"), session("c1", "$w/Worktop/Codex"), session("c2", "$w/Worktop/Claude")))
        assertEquals(listOf("Worktop/", "  · own", "  Claude/", "    · c2", "  Codex/", "    · c1"), lines(folders))
        assertTrue(folders[0].holdsOwn)
    }

    // 2026-10-03, user: 有共同的祖父节点时并没能正确显示，比如“靶场”就在 /WorkSpace/Worktop/培训/靶场 下，但是显示起来是独立的.
    @Test
    fun testAFolderSitsInTheNearestFolderAboveItThatTheListShows() {
        val sessions = listOf(session("a1", "$w/Projects/AgentSwitch"), session("a2", "$w/Projects/AgentSwitch/packages/secret-gate"),
            session("m1", "$w/Projects/MailLab"), session("w1", "$w/Worktop"), session("c1", "$w/Worktop/Claude"),
            session("v1", "$w/Worktop/Claude/CVP_bypass"), session("x1", "$w/Worktop/Codex"), session("r1", "$w/Worktop/培训/靶场"),
            session("d1", "/Users/u/Documents/工作文章/CBwork"))
        assertEquals(listOf(
            "Projects/", "  AgentSwitch/", "    · a1", "    packages/secret-gate/", "      · a2", "  MailLab/", "    · m1",
            "Worktop/", "  · w1", "  Claude/", "    · c1", "    CVP_bypass/", "      · v1", "  Codex/", "    · x1", "  培训/靶场/", "    · r1",
            "CBwork/", "  · d1",
        ), lines(TerminalTree.build(emptyList(), sessions)))
    }

    @Test
    fun testAFolderThatOnlyGathersOthersHoldsTheDeeperOnesToo() {
        val folders = TerminalTree.build(emptyList(), listOf(session("c1", "$w/Worktop/Codex"), session("c2", "$w/Worktop/Claude"), session("r1", "$w/Worktop/培训/靶场")))
        assertEquals(listOf("Worktop/", "  Claude/", "    · c2", "  Codex/", "    · c1", "  培训/靶场/", "    · r1"), lines(folders))
        assertEquals(listOf("Worktop", "Worktop/Claude", "Worktop/Codex", "Worktop/培训/靶场"), TerminalTree.flatten(folders).map { it.name })
        assertEquals(listOf("c2", "c1", "r1"), folders[0].allSessions.map { it.sessionId })
        // Projects that only share a grandparent get no folder over them.
        val apart = TerminalTree.build(emptyList(), listOf(session("a", "$w/Projects/A"), session("b", "$w/Projects/B"),
            session("c", "$w/Worktop/C"), session("d", "$w/Worktop/D")))
        assertEquals(listOf("Projects", "Worktop"), apart.map { it.name })
    }

    @Test
    fun testYourHomeFolderHoldsOnlyWhatSitsDirectlyInIt() {
        val folders = TerminalTree.build(emptyList(), listOf(session("h", "/Users/u"), session("n", "/Users/u/notes"),
            session("p", "$w/Projects/A"), session("t", "/private/tmp/x/y")))
        assertEquals(listOf("y/", "  · t", "~/", "  · h", "  notes/", "    · n", "A/", "  · p"), lines(folders))
    }

    // 2026-10-03 review: two sessions started in ~/Desktop made it hold every project below it.
    @Test
    fun testThePlacesInYourHomeHoldOnlyWhatSitsDirectlyInThem() {
        val folders = TerminalTree.build(emptyList(), listOf(session("d", "/Users/u/Desktop"), session("a", "$w/Projects/A"),
            session("b", "$w/Projects/B"), session("n", "/Users/u/Desktop/notes")))
        assertEquals(listOf("Desktop/", "  · d", "  notes/", "    · n", "Projects/", "  A/", "    · a", "  B/", "    · b"), lines(folders))
        assertEquals(listOf("/a/b", "/a", "/"), TerminalTree.foldersAbove("/a/b"))
    }

    @Test
    fun testAMalformedFolderEndsAtTheTopAndTheTopOfTheDiskIsASlash() {
        val folders = TerminalTree.build(emptyList(), listOf(session("r", "foo/bar"), session("s", "foo"), session("t", "/")))
        assertEquals(listOf("//", "  · t", "  foo/", "    · s", "    bar/", "      · r"), lines(folders))
        assertEquals("/", TerminalTree.slashed(folders[0].name))
        assertEquals("/Users/Shared/Projects/app", TerminalTree.tilde("/Users/Shared/Projects/app"))
        assertEquals("~/Projects/app", TerminalTree.tilde("/Users/u/Projects/app"))
        // Names repeated at the top, as the web page writes them.
        val repeated = TerminalTree.build(emptyList(), listOf(session("a", "/Users/u/app"), session("b", "/app")))
        assertEquals(listOf("app", "~/app"), repeated.map { it.name })
    }

    /** A new Codex terminal's record, before it says its id, is its own (as the web page reads it). */
    @Test
    fun testANewCodexTerminalsRecordIsNotListedAsAnotherSession() {
        val fresh = TerminalInfo(id = "t3", harness = "codex", cwd = "/p/q", name = "t3", status = TerminalStatus.Idle, createdAt = 1_000, lastOutputAt = 1_000)
        val record = SessionSummary(harness = "codex", sessionId = "019a0000-0000-7000-8000-000000000000", cwd = "/p/q", title = "x", updatedAt = 5, startedAt = 5)
        val other = SessionSummary(harness = "codex", sessionId = "019a0000-0000-7000-8000-000000000001", cwd = "/p/other", title = "y", updatedAt = 5, startedAt = 5)
        val folders = TerminalTree.build(listOf(fresh), listOf(record, other))
        assertEquals(listOf("019a0000-0000-7000-8000-000000000001"), folders.flatMap { it.allSessions }.map { it.sessionId })
    }

    @Test
    fun testASessionARunningTerminalWritesIsNotListedTwice() {
        val open = term("t1", "/p/q", created = 1, session = "s1")
        val ended = term("t2", "/p/q", created = 2, status = TerminalStatus.Exited, session = "s2")
        val folders = TerminalTree.build(listOf(open, ended), listOf(session("s1", "/p/q", at = 5), session("s2", "/p/q", at = 4)))
        assertEquals(listOf("s2"), folders[0].sessions.map { it.sessionId }, "an ended terminal no longer holds its session")
    }

    @Test
    fun testRepeatedNamesAtTheTopLevelCarryTheirParent() {
        val folders = TerminalTree.build(emptyList(), listOf(session("a", "/Users/u/x/app", at = 2), session("b", "/Users/u/y/app", at = 1)))
        assertEquals(listOf("x/app", "y/app"), folders.map { it.name })
    }

    /** Git after a folder's name (2026-09-30): what is 0 is left out; a folder outside a repository says nothing. (The tree half; the git half is in TerminalTests.) */
    @Test
    fun testAFolderCarriesItsGit() {
        val git = mapOf("/Users/u/x/app" to GitSummary(branch = "main", changed = 5, ahead = 2))
        val folders = TerminalTree.build(emptyList(), listOf(session("a", "/Users/u/x/app", at = 2), session("b", "/Users/u/y/app", at = 1)), git = git)
        assertEquals(listOf("main ±5 ↑2", null), folders.map { it.git?.said })
        assertNull(folders[1].git)
        assertEquals(GitSummary(branch = "main", changed = 1, behind = 3),
            KitJson.decodeFromString(FolderGitList.serializer(), """{"folders":{"/w":{"branch":"main","changed":1,"ahead":0,"behind":3}}}""").folders["/w"])
    }
}

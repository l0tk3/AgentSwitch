package com.agentswitch.kit

import com.agentswitch.kit.api.FolderGitList
import com.agentswitch.kit.api.GitSummary
import com.agentswitch.kit.api.ResumeTerminalRequest
import com.agentswitch.kit.api.TerminalEvent
import com.agentswitch.kit.api.TerminalKey
import com.agentswitch.kit.api.TerminalList
import com.agentswitch.kit.api.TerminalPermission
import com.agentswitch.kit.api.TerminalQuestion
import com.agentswitch.kit.api.TerminalStatus
import com.agentswitch.kit.api.TerminalStyle
import com.agentswitch.kit.api.TerminalSubagent
import com.agentswitch.kit.feed.QuestionPicks
import com.agentswitch.kit.support.KitJson
import kotlinx.serialization.builtins.ListSerializer
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The terminals tab's client side (docs/terminal-v0.md §4): the list, the stream, and what the phone may send. Left out
 * (they go through `AgentSwitchAPI` and its fake transport): testAnsweringAQuestionSendsWhatWasPickedByQuestion,
 * testResumeStartedExistingOrOpenElsewhere (only its `continuing(in:)` line is here), testKeysAndInputGoByNameAndThroughTheSealer
 * (only the key names are here), testPicturesAreStagedThenPutInTheTerminal, testStreamResumesAfterTheLastSeqAndEndsWhenRemoved;
 * the classes TerminalTreeTests, TerminalSearchTests (types of a later slice) and the second test of TerminalDraftTests
 * (API client).
 */
class TerminalTests {
    private fun list(json: Any?): TerminalList = KitJson.decodeFromString(TerminalList.serializer(), mapToJsonText(json))

    @Test
    fun testListDecodesLeniently() {
        val list = list(
            mapOf(
                "terminals" to listOf(
                    mapOf(
                        "id" to "a1b2c3d4", "harness" to "claude-code", "cwd" to "/Users/u/p", "name" to "发布前检查", "status" to "waiting",
                        "createdAt" to 1, "lastOutputAt" to 2,
                        "permissions" to listOf(mapOf("id" to "p1", "tool" to "Bash", "summary" to "Bash: rm -rf build", "at" to 3)),
                    ),
                    mapOf("id" to "e5f6", "status" to "something-new"),
                ),
                "agents" to listOf("claude-code", "codex"),
                "models" to mapOf("claude-code" to listOf(mapOf("id" to "claude-opus-5-5", "name" to "Opus 5.5"))),
            ),
        )
        assertEquals(2, list.terminals.size)
        assertEquals(TerminalStatus.Waiting, list.terminals[0].status)
        assertEquals("Waiting", list.terminals[0].status.label)
        assertEquals("rm -rf build", list.terminals[0].permissions.first().detail)
        assertEquals(TerminalStatus.Other("something-new"), list.terminals[1].status)
        assertEquals("Opus 5.5", list.models["claude-code"]?.first()?.name)
        assertEquals("Busy", TerminalStatus.Working.label)
        assertEquals(emptyMap(), list.defaults, "a Mac that predates it")
        assertFalse(list.models["claude-code"]?.first()?.older ?: true)
    }

    /**
     * A question the agent asks (AskUserQuestion, 2026-10-01): its questions come with the request; any other request
     * and a Mac that predates question cards have none (the permission card then).
     */
    @Test
    fun testAQuestionDecodesWithItsOptions() {
        fun permission(json: Any?) = KitJson.decodeFromString(TerminalPermission.serializer(), mapToJsonText(json))
        val p = permission(
            mapOf(
                "id" to "p1", "tool" to "AskUserQuestion", "summary" to "会话存在哪里？", "at" to 3, "input" to mapOf("questions" to listOf<Any>()),
                "questions" to listOf(
                    mapOf(
                        "question" to "会话存在哪里？", "header" to "Store", "multiSelect" to false,
                        "options" to listOf(mapOf("label" to "Redis", "description" to "多台实例共享"), mapOf("label" to "内存")),
                    ),
                    mapOf("question" to "记哪些字段？", "options" to listOf(mapOf("label" to "耗时")), "multiSelect" to true),
                ),
            ),
        )
        assertTrue(p.isQuestion)
        assertEquals(
            TerminalQuestion(question = "会话存在哪里？", header = "Store", options = listOf(TerminalQuestion.Option("Redis", "多台实例共享"), TerminalQuestion.Option("内存"))),
            p.questions[0],
        )
        assertEquals("", p.questions[1].header)
        assertTrue(p.questions[1].multiSelect)
        val plain = permission(mapOf("id" to "p2", "tool" to "Bash", "summary" to "Bash: ls"))
        assertFalse(plain.isQuestion)
        val broken = permission(mapOf("id" to "p3", "tool" to "AskUserQuestion", "questions" to "?"))
        assertFalse(broken.isQuestion, "what it cannot read is a permission card, not a failure")
    }

    /** What is picked on a question card: one replaces one, several toggle, Other's words pick it; Submit once all have one. */
    @Test
    fun testPicksOnAQuestionCard() {
        val picks = QuestionPicks(
            listOf(
                TerminalQuestion(question = "存哪？", options = listOf(TerminalQuestion.Option("Redis"), TerminalQuestion.Option("内存"))),
                TerminalQuestion(question = "记哪些？", multiSelect = true, options = listOf(TerminalQuestion.Option("id"), TerminalQuestion.Option("耗时"), TerminalQuestion.Option("路径"))),
            ),
        )
        assertFalse(picks.isComplete)
        picks.pick("Redis", 0)
        picks.pick("内存", 0)
        assertFalse(picks.isPicked("Redis", 0))
        picks.write("先放文件里", 0)
        assertFalse(picks.isPicked("内存", 0), "writing in Other takes the place of the option (one)")
        assertFalse(picks.isComplete)
        picks.pick("路径", 1)
        picks.pick("id", 1)
        picks.pick("耗时", 1)
        picks.pick("耗时", 1)
        picks.write("  trace id ", 1)
        assertTrue(picks.isPicked("路径", 1), "beside them (several)")
        assertTrue(picks.isComplete)
        assertEquals(
            mapOf("存哪？" to QuestionPicks.Answer(labels = emptyList(), other = "先放文件里"), "记哪些？" to QuestionPicks.Answer(labels = listOf("id", "路径"), other = "trace id")),
            picks.answers,
        )
        picks.pick("Redis", 0)
        assertEquals("", picks.other(0), "an option picked (one) clears Other")
        picks.write("   ", 1)
        assertEquals(QuestionPicks.Answer(labels = listOf("id", "路径"), other = null), picks.answers["记哪些？"])
    }

    /** What a question's answer sends: `other` left out when nil, as Swift's encoder leaves it out. */
    @Test
    fun answersEncodeAsTheMacTakesThem() {
        assertEquals("""{"labels":["Redis"]}""", KitJson.encodeToString(QuestionPicks.Answer.serializer(), QuestionPicks.Answer(listOf("Redis"), null)))
        assertEquals("""{"labels":["id"],"other":"密码 hunter2"}""", KitJson.encodeToString(QuestionPicks.Answer.serializer(), QuestionPicks.Answer(listOf("id"), "密码 hunter2")))
    }

    /** Sub-agents under their terminal (2026-09-30); a Mac that predates them says none. */
    @Test
    fun testATerminalListsItsSubagents() {
        val list = list(
            mapOf(
                "terminals" to listOf(
                    mapOf(
                        "id" to "a1", "status" to "working",
                        "subagents" to listOf(
                            mapOf("id" to "s1", "type" to "code-reviewer", "name" to "审查改动", "doing" to "运行 git diff", "since" to 1),
                            mapOf("id" to "s2", "type" to "Explore"),
                        ),
                    ),
                    mapOf("id" to "a2", "status" to "idle"),
                ),
                "agents" to listOf<Any>(), "models" to mapOf<String, Any>(),
            ),
        )
        assertEquals(
            listOf(TerminalSubagent("s1", "code-reviewer", "审查改动", "运行 git diff"), TerminalSubagent("s2", "Explore", "Explore")),
            list.terminals[0].subagents,
        )
        assertEquals(emptyList(), list.terminals[1].subagents)
    }

    @Test
    fun testModelsAsTheAgentListsThem() {
        val list = list(
            mapOf(
                "terminals" to listOf<Any>(), "agents" to listOf("claude-code"),
                "models" to mapOf(
                    "claude-code" to listOf(
                        mapOf("id" to "opus", "name" to "Opus 5.5", "description" to "For complex work"),
                        mapOf("id" to "claude-opus-4-8", "name" to "Opus 4.8", "older" to true),
                    ),
                ),
                "defaults" to mapOf("claude-code" to "Opus 5.5"),
            ),
        )
        assertEquals("Opus 5.5", list.defaults["claude-code"])
        assertEquals(listOf(false, true), list.models["claude-code"]?.map { it.older })
        assertEquals("For complex work", list.models["claude-code"]?.first()?.description)
    }

    @Test
    fun testEventsParseAndUnknownOnesAreSkipped() {
        assertEquals(
            TerminalEvent.Snapshot(seq = 7, cols = 80, rows = 24, data = "hi"),
            TerminalEvent.parse("snapshot", """{"type":"snapshot","seq":7,"cols":80,"rows":24,"data":"hi"}"""),
        )
        assertEquals(TerminalEvent.Output(seq = 8, data = "\u001b[2J"), TerminalEvent.parse("output", """{"type":"output","seq":8,"data":"\u001b[2J"}"""))
        assertEquals(TerminalEvent.Status(TerminalStatus.Working), TerminalEvent.parse("status", """{"status":"working"}"""))
        assertEquals(
            TerminalEvent.Permission(TerminalPermission(id = "p1", tool = "Write", summary = "Write: a.txt")),
            TerminalEvent.parse("permission", """{"request":{"id":"p1","tool":"Write","summary":"Write: a.txt","input":{}}}"""),
        )
        assertEquals(TerminalEvent.PermissionResolved("p1"), TerminalEvent.parse("permission_resolved", """{"id":"p1","decision":null}"""))
        assertEquals(
            TerminalEvent.Permissions(listOf(TerminalPermission(id = "p2", tool = "Bash", summary = "Bash: ls"))),
            TerminalEvent.parse("permissions", """{"type":"permissions","requests":[{"id":"p2","tool":"Bash","summary":"Bash: ls","input":{}}]}"""),
        )
        assertEquals(TerminalEvent.Permissions(emptyList()), TerminalEvent.parse("permissions", """{"requests":[]}"""))
        assertEquals(TerminalEvent.Resize(cols = 149, rows = 52, by = "mac-3f"), TerminalEvent.parse("resize", """{"type":"resize","cols":149,"rows":52,"by":"mac-3f"}"""))
        assertEquals(TerminalEvent.Resize(cols = 50, rows = 30, by = null), TerminalEvent.parse("resize", """{"cols":50,"rows":30,"by":null}"""))
        assertEquals(TerminalEvent.Exit(code = null), TerminalEvent.parse("exit", """{"code":null}"""))
        assertEquals(TerminalEvent.Removed, TerminalEvent.parse("removed", "{}"))
        assertNull(TerminalEvent.parse("future", "{}"))
        assertNull(TerminalEvent.parse("output", "not json"))
    }

    /** The seq an output event carries is what the stream resumes after; other events carry none. */
    @Test
    fun eventsCarryTheirSeq() {
        assertEquals(7L, TerminalEvent.parse("snapshot", """{"seq":7,"cols":80,"rows":24,"data":""}""")?.seq)
        assertEquals(1_700_000_000_000L, TerminalEvent.parse("output", """{"seq":1700000000000,"data":""}""")?.seq)
        assertNull(TerminalEvent.parse("status", """{"status":"idle"}""")?.seq)
    }

    /** `body.continuing(in:)` of the Swift resume test: the same request in another folder. */
    @Test
    fun resumeContinuesInAnotherFolder() {
        val body = ResumeTerminalRequest(harness = "claude-code", cwd = "/Users/u/p", agentSessionId = "s-1", mode = "auto")
        assertEquals(ResumeTerminalRequest(harness = "claude-code", cwd = "~/Projects/p", agentSessionId = "s-1", mode = "auto"), body.continuing("~/Projects/p"))
    }

    /** The keys go by these names, exactly (the Swift test reads them off the request body). */
    @Test
    fun terminalKeysEncodeByName() {
        assertEquals(
            """["esc","shift-tab","ctrl-c","1"]""",
            KitJson.encodeToString(ListSerializer(TerminalKey.serializer()), listOf(TerminalKey.Esc, TerminalKey.ShiftTab, TerminalKey.CtrlC, TerminalKey.One)),
        )
        assertEquals(
            listOf(
                "esc", "tab", "shift-tab", "enter", "backspace", "up", "down", "left", "right", "pgup", "pgdn", "wheel-up", "wheel-down",
                "ctrl-c", "ctrl-d", "ctrl-l", "ctrl-r", "y", "n", "1", "2", "3", "4", "5", "6", "7", "8", "9",
            ),
            TerminalKey.entries.map { it.rawValue },
        )
        for (key in TerminalKey.entries) {
            assertEquals("\"${key.rawValue}\"", KitJson.encodeToString(TerminalKey.serializer(), key))
            assertEquals(key, KitJson.decodeFromString(TerminalKey.serializer(), "\"${key.rawValue}\""))
        }
    }

    @Test
    fun testStyleColours() {
        val style = KitJson.decodeFromString(
            TerminalStyle.serializer(),
            mapToJsonText(
                mapOf(
                    "theme" to mapOf(
                        "background" to "#0c0c0e", "foreground" to "#e6e6e6", "selectionBackground" to "rgba(1,2,3,0.3)",
                        "black" to "#000000", "red" to "#ff0000", "green" to "#00ff00", "yellow" to "#ffff00", "blue" to "#0000ff", "magenta" to "#ff00ff",
                        "cyan" to "#00ffff", "white" to "#ffffff", "brightBlack" to "#111111", "brightRed" to "#222222", "brightGreen" to "#333333",
                        "brightYellow" to "#444444", "brightBlue" to "#555555", "brightMagenta" to "#666666", "brightCyan" to "#777777", "brightWhite" to "#888888",
                    ),
                ),
            ),
        )
        assertEquals(TerminalStyle.RGB(0x0c, 0x0c, 0x0e), style.background)
        assertEquals(16, style.ansi?.size)
        assertEquals(TerminalStyle.RGB(255, 0, 0), style.ansi?.get(1))
        assertNull(TerminalStyle(mapOf("black" to "#000000")).ansi)
    }

    /** The git half of `testAFolderCarriesItsGit` (the tree half belongs to TerminalTree, a later slice). */
    @Test
    fun testAFolderCarriesItsGit() {
        assertEquals("feat/x ↓4", GitSummary(branch = "feat/x", behind = 4).said)
        assertEquals("main ±5 ↑2", GitSummary(branch = "main", changed = 5, ahead = 2).said)
        val json = """{"folders":{"/w":{"branch":"main","changed":1,"ahead":0,"behind":3}}}"""
        assertEquals(GitSummary(branch = "main", changed = 1, behind = 3), KitJson.decodeFromString(FolderGitList.serializer(), json).folders["/w"])
        assertNotNull(KitJson.decodeFromString(FolderGitList.serializer(), json).folders["/w"])
    }
}

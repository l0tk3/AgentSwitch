package com.agentswitch.kit

import com.agentswitch.kit.api.FileDiffList
import com.agentswitch.kit.api.NewTerminalRequest
import com.agentswitch.kit.api.PlanEntry
import com.agentswitch.kit.api.ProfileChoice
import com.agentswitch.kit.api.ProfileChoices
import com.agentswitch.kit.api.ProfileColor
import com.agentswitch.kit.api.ProxyExit
import com.agentswitch.kit.api.ProxySetting
import com.agentswitch.kit.api.RecordFile
import com.agentswitch.kit.api.RecordItem
import com.agentswitch.kit.api.RecordStep
import com.agentswitch.kit.api.RecordStepDetail
import com.agentswitch.kit.api.RecordUsage
import com.agentswitch.kit.api.ResumeTerminalRequest
import com.agentswitch.kit.api.ScreenChoices
import com.agentswitch.kit.api.ScreenNotice
import com.agentswitch.kit.api.SentReply
import com.agentswitch.kit.api.SessionDetail
import com.agentswitch.kit.api.SessionMessage
import com.agentswitch.kit.api.SessionRecord
import com.agentswitch.kit.api.SessionSummary
import com.agentswitch.kit.api.TerminalActivity
import com.agentswitch.kit.api.sessionStep
import com.agentswitch.kit.api.TerminalDaybreak
import com.agentswitch.kit.api.TerminalEvent
import com.agentswitch.kit.api.TerminalInfo
import com.agentswitch.kit.api.TerminalList
import com.agentswitch.kit.api.TerminalModelMenu
import com.agentswitch.kit.api.TerminalModelOption
import com.agentswitch.kit.api.TerminalProfile
import com.agentswitch.kit.api.ToolDisplay
import com.agentswitch.kit.api.TurnProgress
import com.agentswitch.kit.feed.EffortDisplay
import com.agentswitch.kit.feed.RecordDisplay
import com.agentswitch.kit.support.KitJson
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.JsonElement
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * A session's record on the phone (docs/simple-view-v0.md §2, §4, §5): what the Mac sends decoded, the words the simple
 * view puts on it, and the same record from a Mac that only has the session's messages. Left out: the ShellHighlight
 * lines of testThoughtsNotesAndAStepWhole and `testEffortAsAPlaceOnALine` are in
 * TextLogicTests; `testDecodesARecordFromARunningMac` is opt-in (environment variable AGENTSWITCH_RECORD_JSON).
 */
class RecordTests {
    private val session = """{"harness":"claude-code","id":"c1","cwd":"/Users/u/code/site","title":"删除按钮标红","lastText":"改好了","updatedAt":1791342000000.5,"startedAt":1791341000000,"active":true}"""

    private fun record(rest: String): SessionRecord =
        KitJson.decodeFromString(SessionRecord.serializer(), """{"session":$session,$rest}""")

    @Test
    fun testDecodesTheRecordAsTheMacSendsIt() {
        val r = record(
            """
            "items":[
              {"type":"user","id":"120","ts":1791341000000,"text":"delete 应该标红才对","images":1},
              {"type":"work","id":"455","ts":1791341002000,"secs":70,"steps":[
                {"kind":"think","text":"The delete button uses the system style."},
                {"kind":"read","text":"Sources/AgentsView.swift"},
                {"kind":"run","text":"swift build -c release","out":"Build complete!"},
                {"kind":"edit","text":"Sources/AgentsView.swift","added":2,"removed":1},
                {"kind":"tool","tool":"browser · navigate","text":"http://127.0.0.1:8765/","failed":true,"out":"Error: page crashed"},
                {"kind":"teleport","text":"somewhere"}]},
              {"type":"answer","id":"9000","ts":1791341072000.25,"text":"改好了。","clipped":true},
              {"type":"hologram","id":"9100","ts":1},
              {"type":"user","id":"9200.1","ts":1791341080000,"text":"顺便改版本号","queued":true},
              {"type":"note","id":"9300","ts":1791341090000,"text":"Interrupted"}],
            "more":true,"cursor":120,"rev":"abc-1","plan":[{"text":"找出用到的地方","state":"done"},{"text":"标红","state":"doing"},{"text":"重新构建","state":"todo"},{"text":"以后","state":"someday"}],
            "usage":{"model":"claude-opus-5-5","used":124012},"mode":"acceptEdits"
            """.trimIndent(),
        )
        // An item of a kind a newer Mac added is left out; the rest stands.
        assertEquals(listOf(RecordItem.Kind.User, RecordItem.Kind.Work, RecordItem.Kind.Answer, RecordItem.Kind.User, RecordItem.Kind.Note), r.items.map { it.kind })
        assertEquals(1, r.items[0].images)
        assertEquals(70, r.items[1].seconds)
        assertEquals(
            listOf(RecordStep.Kind.Think, RecordStep.Kind.Read, RecordStep.Kind.Run, RecordStep.Kind.Edit, RecordStep.Kind.Tool, RecordStep.Kind.Tool),
            r.items[1].steps.map { it.kind },
        )
        assertEquals(RecordStep(kind = RecordStep.Kind.Tool, text = "http://127.0.0.1:8765/", tool = "browser · navigate", out = "Error: page crashed", failed = true), r.items[1].steps[4])
        // A step of a kind this app does not know is a tool by that name.
        assertEquals("teleport", r.items[1].steps[5].tool)
        assertTrue(r.items[2].clipped)
        assertEquals(1_791_341_072_000, r.items[2].at)
        assertTrue(r.items[3].queued)
        assertEquals(9200L, r.items[3].offset)
        assertTrue(r.more)
        assertEquals(120L, r.cursor)
        assertEquals(listOf(PlanEntry.State.Done, PlanEntry.State.Doing, PlanEntry.State.Todo, PlanEntry.State.Todo), r.plan.map { it.state })
        assertEquals(RecordUsage(model = "claude-opus-5-5", used = 124_012), r.usage)
        assertEquals("acceptEdits", r.mode)
        assertEquals("c1", r.session.sessionId)
        // A file's mtime may carry a fraction: the session's time is rounded (older Macs).
        assertEquals(1_791_342_000_001L, r.session.updatedAt)
    }

    @Test
    fun testARunOfWorkOnOneLine() {
        val work = RecordItem(
            id = "1", kind = RecordItem.Kind.Work, seconds = 72,
            steps = listOf(
                RecordStep(RecordStep.Kind.Think, "…"), RecordStep(RecordStep.Kind.Read, "a.swift"), RecordStep(RecordStep.Kind.Search, "Delete"),
                RecordStep(RecordStep.Kind.Run, "swift build"), RecordStep(RecordStep.Kind.Todo, "标红"), RecordStep(RecordStep.Kind.Run, "swift test"),
                RecordStep(RecordStep.Kind.Edit, "a.swift", added = 12, removed = 1), RecordStep(RecordStep.Kind.Write, "b.swift", added = 2, removed = 0),
                RecordStep(RecordStep.Kind.Tool, "x", tool = "browser · navigate"), RecordStep(RecordStep.Kind.Tool, "y", tool = "Artifact"),
                RecordStep(RecordStep.Kind.Agent, "找出所有用到的地方"),
            ),
        )
        assertEquals("Worked 1m 12s · Read 1 · Searched 1 · Ran 2 · Edited 2 · Tools 2 · Agent 1", RecordDisplay.summary(work))
        assertEquals("Working 1m 12s · Read 1 · Searched 1 · Ran 2 · Edited 2 · Tools 2 · Agent 1", RecordDisplay.summary(work, running = true))
        assertEquals("Worked · Listed 1", RecordDisplay.summary(RecordItem(id = "2", kind = RecordItem.Kind.Work, steps = listOf(RecordStep(RecordStep.Kind.List, "src")))))
        // What it offers as the next message comes and goes with the terminal's stream.
        assertEquals(TerminalEvent.Suggestion("add both"), TerminalEvent.parse("suggestion", """{"type":"suggestion","text":"add both"}"""))
        assertEquals(TerminalEvent.Suggestion(null), TerminalEvent.parse("suggestion", """{"type":"suggestion","text":null}"""))
        // A step that brought pictures back says how many; one that says nothing has none (an older Mac).
        val steps = KitJson.decodeFromString(ListSerializer(RecordStep.serializer()), """[{"kind":"read","text":"shot.png","images":2},{"kind":"read","text":"a.ts"}]""")
        assertEquals(listOf(2, 0), steps.map { it.images })
        assertEquals("Worked", RecordDisplay.summary(RecordItem(id = "3", kind = RecordItem.Kind.Work, steps = listOf(RecordStep(RecordStep.Kind.Think, "…")))))
        val stat = RecordDisplay.stat(work.steps)
        assertEquals(14, stat?.added)
        assertEquals(1, stat?.removed)
        assertNull(RecordDisplay.stat(listOf(RecordStep(RecordStep.Kind.Run, "ls"))))
        // Opened: its thinking only in the verbose transcript.
        assertEquals(10, RecordDisplay.shown(work.steps, verbose = false).size)
        assertEquals(11, RecordDisplay.shown(work.steps, verbose = true).size)
        assertEquals(
            listOf("Thought", "Read", "Search", "Run", "Tasks", "Run", "Edit", "Write", "browser · navigate", "Artifact", "Agent"),
            work.steps.map { RecordDisplay.label(it) },
        )
    }

    @Test
    fun testTimesContextModeAndTheTaskList() {
        assertEquals(listOf("0s", "8s", "59s", "1m 00s", "1m 12s", "59m 59s", "1h 00m", "1h 02m"), listOf(0, 8, 59, 60, 72, 3599, 3600, 3725).map { RecordDisplay.duration(it) })
        assertEquals(listOf("0:00", "0:41", "12:05", "1:02:25"), listOf(0, 41, 725, 3745).map { RecordDisplay.clock(it) })
        assertEquals("19%", RecordDisplay.context(RecordUsage(used = 51_000, window = 272_000)))
        assertEquals("100%", RecordDisplay.context(RecordUsage(used = 300_000, window = 272_000)))
        assertEquals("124k", RecordDisplay.context(RecordUsage(used = 124_012)))
        assertEquals("1.2M", RecordDisplay.context(RecordUsage(used = 1_240_000)))
        assertNull(RecordDisplay.context(RecordUsage(model = "x")))
        assertNull(RecordDisplay.context(null))
        assertEquals(
            listOf("Ask", "Edits", "Plan", "Auto", "Bypass", "On Request", "Never Ask", "Ask"),
            listOf("default", "acceptEdits", "plan", "auto", "bypassPermissions", "on-request", "never", "untrusted").map { RecordDisplay.mode(it) },
        )
        assertNull(RecordDisplay.mode("something-new"))
        assertNull(RecordDisplay.mode(null))
        val plan = RecordDisplay.plan(listOf(PlanEntry("找", PlanEntry.State.Done), PlanEntry("标红", PlanEntry.State.Doing), PlanEntry("构建", PlanEntry.State.Todo)))
        assertEquals(1, plan?.done)
        assertEquals(3, plan?.total)
        assertEquals("标红", plan?.now)
        assertEquals("b", RecordDisplay.plan(listOf(PlanEntry("a", PlanEntry.State.Done), PlanEntry("b", PlanEntry.State.Todo)))?.now)
        assertEquals("", RecordDisplay.plan(listOf(PlanEntry("a", PlanEntry.State.Done)))?.now)
        assertNull(RecordDisplay.plan(emptyList()))
    }

    @Test
    fun testAMacWithOnlyTheMessagesStillGivesARecord() {
        val summary = KitJson.decodeFromString(SessionSummary.serializer(), session)
        val detail = SessionDetail(
            summary,
            listOf(
                SessionMessage(SessionMessage.Role.User, "跑测试", 1000),
                SessionMessage(SessionMessage.Role.Tool, "npm test\n--watch=false", 2000, "Bash"),
                SessionMessage(SessionMessage.Role.Tool, "src/a.ts", 3000, "Read"),
                SessionMessage(SessionMessage.Role.Tool, "click", 4000, "mcp__browser__browser_click"),
                SessionMessage(SessionMessage.Role.Assistant, "通过了。", 5000),
                SessionMessage(SessionMessage.Role.Tool, "src/a.ts", 6000, "Edit"),
            ),
        )
        val r = SessionRecord.coarse(detail)
        assertEquals(listOf(RecordItem.Kind.User, RecordItem.Kind.Work, RecordItem.Kind.Answer, RecordItem.Kind.Work), r.items.map { it.kind })
        assertEquals(listOf(RecordStep.Kind.Run, RecordStep.Kind.Read, RecordStep.Kind.Tool), r.items[1].steps.map { it.kind })
        assertEquals("npm test", r.items[1].steps[0].text)
        assertEquals(2000L, r.items[1].at)
        assertEquals(4, r.items.map { it.id }.toSet().size)
        assertNull(r.items[0].offset)
        assertFalse(r.more)
    }

    @Test
    fun testALongAnswerFoldsWhereAParagraphEnds() {
        assertNull(RecordDisplay.preview("字".repeat(2000)))
        val paragraphs = (0 until 40).joinToString("\n\n") { "第 $it 段，" + "话".repeat(90) }
        val head = RecordDisplay.preview(paragraphs)!!
        assertTrue(head.codePointCount(0, head.length) <= RecordDisplay.previewChars)
        assertTrue(paragraphs.startsWith(head))
        assertTrue(head.endsWith("话"))
        assertFalse(head.endsWith("\n"))
        // Cut inside a block of code: the block is closed, so what follows on the screen is not drawn as code.
        val code = "说明：\n\n```swift\n" + (0 until 200).joinToString("\n") { "let x$it = $it" } + "\n```\n\n完。"
        val cut = RecordDisplay.preview(code)!!
        assertTrue(cut.endsWith("\n```"))
        assertEquals(2, cut.split("```").size - 1)
    }

    @Test
    fun testChangingTheModel() {
        assertEquals("/model opus", RecordDisplay.modelCommand("opus"))
        assertEquals("/model claude-opus-5-5[1m]", RecordDisplay.modelCommand("claude-opus-5-5[1m]"))
        // Nothing that would read as a second line or a flag's value.
        assertEquals("/model sonnetrm-rf", RecordDisplay.modelCommand("sonnet\nrm -rf ~"))
        assertEquals("/model", RecordDisplay.modelPicker("codex"))
        assertEquals("/models", RecordDisplay.modelPicker("opencode"))
        assertEquals("claude-sonnet-5-5", RecordDisplay.model("claude-sonnet-5-5", "claude-opus-5-5", "opus"))
        assertEquals("claude-opus-5-5", RecordDisplay.model(null, "claude-opus-5-5", "opus"))
        assertEquals("opus", RecordDisplay.model(null, null, "opus"))
        val opus = TerminalModelOption(id = "opus", name = "Opus 5.5")
        val sonnet = TerminalModelOption(id = "sonnet", name = "Sonnet 5.5")
        assertTrue(RecordDisplay.isCurrent(opus, "opus"))
        assertTrue(RecordDisplay.isCurrent(opus, "claude-opus-5-5"))
        assertFalse(RecordDisplay.isCurrent(sonnet, "claude-opus-5-5"))
        assertFalse(RecordDisplay.isCurrent(opus, null))
        assertEquals(TerminalEvent.Model("claude-sonnet-5-5"), TerminalEvent.parse("model", """{"type":"model","model":"claude-sonnet-5-5"}"""))
        val info = KitJson.decodeFromString(TerminalInfo.serializer(), """{"id":"t1","harness":"claude-code","model":"opus","modelNow":"claude-sonnet-5-5","status":"idle"}""")
        assertEquals("claude-sonnet-5-5", info.modelNow)
        assertNull(KitJson.decodeFromString(TerminalInfo.serializer(), """{"id":"t1","harness":"codex"}""").modelNow)
    }

    @Test
    fun testThinkingLevelsByAgentAndModel() {
        val list = KitJson.decodeFromString(
            TerminalList.serializer(),
            """
            {"terminals":[{"id":"t1","harness":"claude-code","model":"opus","effort":"xhigh","status":"idle"}],
             "agents":["claude-code","codex","opencode","pi"],
             "models":{"claude-code":[{"id":"opus","name":"Opus 5.5","efforts":["low","medium","high","xhigh","max"]},{"id":"haiku","name":"Haiku 4.5","efforts":[]},
                                      {"id":"claude-opus-4-6","name":"Opus 4.6","older":true,"efforts":["low","medium","high","max"]}],
                       "codex":[{"id":"gpt-6-luna","name":"GPT-6-Luna","efforts":["low","medium","high","xhigh","max"],"defaultEffort":"medium"}],
                       "opencode":[{"id":"deepseek/deepseek-flash","name":"DeepSeek Flash","efforts":["none","low","high","max"]},{"id":"openai/gpt-6","name":"GPT-6"}],
                       "pi":[]},
             "defaults":{"claude-code":"Opus 5.5"},
             "efforts":{"claude-code":["low","medium","high","xhigh","max"],"codex":["low","medium","high","xhigh","max","ultra"],"pi":["off","minimal","low","medium","high","xhigh","max"]},
             "effortDefaults":{"codex":"low"}}
            """.trimIndent(),
        )
        assertEquals("xhigh", list.terminals[0].effort)
        // A new terminal: the chosen model's levels; none chosen, the agent's default model's.
        assertEquals(listOf("low", "medium", "high", "xhigh", "max"), EffortDisplay.levels(list, "claude-code", null))
        assertEquals(listOf("low", "medium", "high", "max"), EffortDisplay.levels(list, "claude-code", "claude-opus-4-6"))
        assertEquals(emptyList(), EffortDisplay.levels(list, "claude-code", "haiku"))
        assertEquals(listOf("low", "medium", "high", "xhigh", "max", "ultra"), EffortDisplay.levels(list, "codex", ""))
        assertEquals(7, EffortDisplay.levels(list, "pi", null).size)
        // OpenCode's variants belong to a model: nothing without one, nothing for a model whose variants are not listed.
        assertEquals(emptyList(), EffortDisplay.levels(list, "opencode", null))
        assertEquals(listOf("none", "low", "high", "max"), EffortDisplay.levels(list, "opencode", "deepseek/deepseek-flash"))
        assertEquals(emptyList(), EffortDisplay.levels(list, "opencode", "openai/gpt-6"))
        assertEquals(emptyList(), EffortDisplay.levels(null, "claude-code", null))
        assertEquals("low", EffortDisplay.defaultLevel(list, "codex", null))
        assertEquals("medium", EffortDisplay.defaultLevel(list, "codex", "gpt-6-luna"))
        assertNull(EffortDisplay.defaultLevel(list, "claude-code", "opus"))
        // A running terminal: the levels of the model it is on, found by the id it reports as by the alias listed.
        assertEquals(listOf("low", "medium", "high", "max"), EffortDisplay.levelsCurrent(list, "claude-code", "claude-opus-4-6"))
        assertEquals(listOf("low", "medium", "high", "xhigh", "max"), EffortDisplay.levelsCurrent(list, "claude-code", "claude-opus-5-5"))
        assertEquals(emptyList(), EffortDisplay.levelsCurrent(list, "claude-code", "claude-haiku-4-5-20251001"))
        assertEquals(listOf("low", "medium", "high", "xhigh", "max"), EffortDisplay.levelsCurrent(list, "claude-code", null))
        // The model changes: a level it does not take goes back to its default.
        assertEquals("", EffortDisplay.kept("xhigh", listOf("low", "medium", "high", "max")))
        assertEquals("max", EffortDisplay.kept("max", listOf("low", "medium", "high", "max")))
        assertEquals(listOf("Low", "XHigh", "Max", "Minimal", "None", "Off", "Ultra"), listOf("low", "xhigh", "max", "minimal", "none", "off", "ultra").map { EffortDisplay.name(it) })
        assertEquals(listOf("Effort", "Reasoning", "Variant", "Thinking"), listOf("claude-code", "codex", "opencode", "pi").map { EffortDisplay.word(it) })
        assertEquals("medium", EffortDisplay.level(null, "medium", "xhigh"))
        assertEquals("high", EffortDisplay.level("high", "medium", null))
        assertEquals("/effort xhigh", EffortDisplay.command("xhigh"))
        assertEquals("/effort highclear", EffortDisplay.command("high\n/clear"))
        assertEquals("/variants", EffortDisplay.picker("opencode"))
        assertNull(EffortDisplay.picker("codex"))
        val usage = KitJson.decodeFromString(RecordUsage.serializer(), """{"model":"claude-opus-5-5","used":1000,"effort":"xhigh"}""")
        assertEquals("xhigh", usage.effort)
        val body = KitJson.encodeToJsonElementOf(NewTerminalRequest(harness = "codex", cwd = "~/p", model = "gpt-6-luna", effort = "high"))
        assertEquals("high", (body["effort"] as JsonPrimitive).content)
        assertNull(KitJson.encodeToJsonElementOf(NewTerminalRequest(harness = "codex", cwd = "~/p"))["effort"])
    }

    /**
     * A picture sent with a message (2026-10-07): asked of the Mac by the item it came with and its place among that
     * item's pictures; what it is, by its first bytes.
     */
    @Test
    fun testAMessagesPictureIsAskedByItsItemAndPlace() = kotlinx.coroutines.test.runTest {
        fun bytes(vararg b: Int) = ByteArray(b.size) { b[it].toByte() }
        val png = bytes(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3)
        val transport = FakeTransport({ req, _ ->
            if (req.path.endsWith("/images/1024.2/1")) png to httpResponse(req.url, contentType = "image/png")
            else json(mapOf("error" to "no such picture")) to httpResponse(req.url, status = 404)
        })
        val api = com.agentswitch.kit.api.AgentSwitchAPI(
            endpoints = com.agentswitch.kit.api.FixedEndpoint(com.agentswitch.kit.api.APIEndpoint(host = "192.168.1.5", port = 4400, kind = com.agentswitch.kit.api.EndpointKind.Lan)),
            transport = transport, token = "tok")
        val data = api.sessionImage(harness = "claude-code", id = "c7", item = "1024.2", n = 1)
        assertTrue(png.contentEquals(data))
        assertEquals(listOf("/sessions/claude-code/c7/images/1024.2/1"), transport.paths)
        assertEquals("Bearer tok", transport.requests.first().headers["Authorization"])
        // An older Mac, or a picture no longer there: an HTTP error, not a picture.
        val e = kotlin.test.assertFailsWith<com.agentswitch.kit.api.APIError.Http>("a picture that is not there") {
            api.sessionImage(harness = "codex", id = "x1", item = "0", n = 0)
        }
        assertEquals(404, e.status)

        assertEquals("png", RecordDisplay.pictureExtension(png))
        assertEquals("jpg", RecordDisplay.pictureExtension(bytes(0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10)))
        assertEquals("gif", RecordDisplay.pictureExtension("GIF89a....".toByteArray()))
        assertEquals("webp", RecordDisplay.pictureExtension("RIFF$\u0000\u0000\u0000WEBPVP8 ".toByteArray()))
        assertEquals("heic", RecordDisplay.pictureExtension(bytes(0, 0, 0, 0x18) + "ftypheic".toByteArray()))
        assertEquals("png", RecordDisplay.pictureExtension(ByteArray(0)))
        assertEquals("png", RecordDisplay.pictureExtension("RIFF....WAVE".toByteArray()))
    }

    /** 2026-10-07, user: 怎么少了思考细节呢 / 官方的代码执行块里看没有省略而且有高亮显示. (Without the `sessionStep` calls.) */
    @Test
    fun testThoughtsNotesAndAStepWhole() = kotlinx.coroutines.test.runTest {
        val page = """[{"type":"answer","id":"5","ts":1,"text":"先看列表的底色。","thinking":true},{"type":"work","id":"9","ts":2,"secs":3,"steps":[{"kind":"run","text":"git status","note":"Check the tree"},{"kind":"run","text":"ls","note":""}]},{"type":"answer","id":"20","ts":6,"text":"好了"}]"""
        val items = KitJson.decodeFromString(ListSerializer(RecordItem.serializer()), page)
        assertEquals(listOf(true, false, false), items.map { it.thinking })
        assertEquals(listOf("Check the tree", null), items[1].steps.map { it.note })
        val busy = KitJson.decodeFromString(TerminalActivity.serializer(), """{"tool":"Bash","target":"cat > x","note":"Write the patch"}""")
        assertEquals(TerminalActivity(tool = "Bash", target = "cat > x", note = "Write the patch"), busy)
        assertNull(KitJson.decodeFromString(TerminalActivity.serializer(), """{"tool":"Bash","target":"ls"}""").note)
        // The step as the Mac sends it whole.
        val transport = FakeTransport({ req, _ ->
            if (req.path == "/sessions/claude-code/c7/steps/1024/2")
                """{"kind":"run","text":"a\nb","note":"Two lines","out":"x","clipped":true}""".toByteArray() to httpResponse(req.url)
            else json(mapOf("error" to "no such step")) to httpResponse(req.url, status = 404)
        })
        val api = com.agentswitch.kit.api.AgentSwitchAPI(
            endpoints = com.agentswitch.kit.api.FixedEndpoint(com.agentswitch.kit.api.APIEndpoint(host = "192.168.1.5", port = 4400, kind = com.agentswitch.kit.api.EndpointKind.Lan)),
            transport = transport, token = "tok")
        val step = api.sessionStep(harness = "claude-code", id = "c7", work = "1024", n = 2)
        assertEquals(RecordStepDetail(text = "a\nb", note = "Two lines", out = "x", clipped = true), step)
        // An older Mac: no such route, the record's own line stays.
        assertNull(api.sessionStep(harness = "claude-code", id = "c7", work = "1024", n = 9))

        // One small picture for each kind of step, no two alike.
        val kinds = listOf(
            RecordStep.Kind.Read, RecordStep.Kind.Search, RecordStep.Kind.List, RecordStep.Kind.Run, RecordStep.Kind.Edit, RecordStep.Kind.Write,
            RecordStep.Kind.Web, RecordStep.Kind.Agent, RecordStep.Kind.Todo, RecordStep.Kind.Think, RecordStep.Kind.Tool,
        )
        assertEquals(kinds.size, kinds.map { RecordDisplay.symbol(it) }.toSet().size)
        assertEquals("terminal", RecordDisplay.symbol(RecordStep.Kind.Run))
        assertEquals("globe", RecordDisplay.symbol(RecordStep.Kind.Web))
        // What it is doing now has the picture of the step it will be; thinking, the thinking one.
        assertEquals("terminal", RecordDisplay.toolSymbol("Bash"))
        assertEquals("pencil", RecordDisplay.toolSymbol("MultiEdit"))
        assertEquals("globe", RecordDisplay.toolSymbol("WebSearch"))
        assertEquals(RecordDisplay.symbol(RecordStep.Kind.Agent), RecordDisplay.toolSymbol("Agent"))
        assertEquals(RecordDisplay.symbol(RecordStep.Kind.Todo), RecordDisplay.toolSymbol("TodoWrite"))
        // The browser's tools read as the web here (ToolDisplay's word for them); any other tool is a tool.
        assertEquals("globe", RecordDisplay.toolSymbol("mcp__browser__browser_click"))
        assertEquals(RecordDisplay.symbol(RecordStep.Kind.Tool), RecordDisplay.toolSymbol("mcp__github__create_issue"))
        assertNull(RecordDisplay.toolSymbol(null)) // at work with no tool: no picture
        // Compacting its context is no tool: a word and a picture of its own, like no step's.
        assertEquals("Compact", ToolDisplay.word("Compact"))
        assertEquals("压缩上下文", ToolDisplay.label("Compact"))
        assertEquals(RecordDisplay.compactSymbol, RecordDisplay.toolSymbol("Compact"))
        assertFalse(kinds.map { RecordDisplay.symbol(it) }.contains(RecordDisplay.compactSymbol))
    }

    @Test
    fun testChangesDecode() {
        val list = KitJson.decodeFromString(
            FileDiffList.serializer(),
            """
            {"files":[{"path":"src/retry.ts","added":1,"removed":1,"hunks":[{"header":"@@ -3,1 +3,1 @@","lines":["-const RETRIES = 5;","+const RETRIES = 3;"]}]},
                      {"path":"big.txt","added":420,"removed":0,"hunks":[{"header":"","lines":["+l0"]}],"clipped":true}]}
            """.trimIndent(),
        )
        assertEquals(listOf("src/retry.ts", "big.txt"), list.files.map { it.path })
        assertEquals(2, list.files[0].hunks[0].lines.size)
        assertTrue(list.files[1].clipped)
    }

    @Test
    fun testTheRecordStreamsOwnEvents() {
        assertEquals(TerminalEvent.Record(rev = "k3-x9", session = null), TerminalEvent.parse("record", """{"type":"record","rev":"k3-x9"}"""))
        assertEquals(TerminalEvent.Record(rev = "", session = "b2"), TerminalEvent.parse("record", """{"type":"record","rev":"","session":"b2"}"""))
        assertEquals(TerminalEvent.Activity(null, emptyList()), TerminalEvent.parse("activity", """{"type":"activity","activity":null,"subagents":[]}"""))
        val busy = TerminalEvent.parse(
            "activity",
            """{"type":"activity","activity":{"tool":"Bash","target":"npm test"},"subagents":[{"id":"a1","type":"Explore","name":"找出所有用到的地方","activity":{"tool":"Grep","target":"Delete"},"since":1,"doing":"搜索 Delete"}]}""",
        )
        val activity = busy as? TerminalEvent.Activity ?: throw AssertionError("not an activity")
        assertEquals(TerminalActivity(tool = "Bash", target = "npm test"), activity.activity)
        assertEquals(listOf("找出所有用到的地方"), activity.subagents.map { it.name })
        assertEquals("搜索 Delete", activity.subagents.first().doing)
    }

    /** Codex's Daybreak switch (docs/simple-view-v0.md §5.8): the models offered as it stands, the line when the one it is on cannot run, and what the service says of it. */
    @Test
    fun testCodexDaybreakSwitchAndItsModels() {
        val never = TerminalModelOption(id = "gpt-6.1-sol", name = "GPT-6.1-Sol", daybreak = "never")
        val also = TerminalModelOption(id = "gpt-6-sol", name = "GPT-6-Sol", daybreak = "also")
        val only = TerminalModelOption(id = "gpt-daybreak-blue-latest", name = "Daybreak Blue", daybreak = "only")
        val unsaid = TerminalModelOption(id = "gpt-x", name = "GPT-X")
        val all = listOf(never, also, only, unsaid)
        // No switch: every model. On: not the ones with the standard program alone. Off: not the Daybreak-only ones.
        assertEquals(all, TerminalDaybreak.offered(all, on = null))
        assertEquals(listOf(also, only, unsaid), TerminalDaybreak.offered(all, on = true))
        assertEquals(listOf(never, also, unsaid), TerminalDaybreak.offered(all, on = false))
        // The model it is on cannot run as the switch stands: said, named as the control names it.
        assertEquals("Codex 的模型列表里 GPT-6.1-Sol 不支持 Daybreak，开着时它的下一轮会被 Codex 拒绝。换一个模型，或关掉 Daybreak。", TerminalDaybreak.clash(never, on = true))
        assertEquals("Codex 的模型列表里 Blue 只在 Daybreak 开着时可用，下一轮会被 Codex 拒绝。换一个模型，或打开 Daybreak。", TerminalDaybreak.clash(only, on = false, name = "Blue"))
        for ((model, on) in listOf(also to true, also to false, never to false, only to true, unsaid to true)) {
            assertNull(TerminalDaybreak.clash(model, on))
        }
        assertNull(TerminalDaybreak.clash(null, on = true))
        assertNull(TerminalDaybreak.clash(never, on = null))
        assertEquals(listOf("Daybreak On", "Daybreak Off"), listOf(TerminalDaybreak.word(true), TerminalDaybreak.word(false)))
        // As the service sends it: a terminal's switch (none said: no switch), each model's place, how new sessions start.
        val list = KitJson.decodeFromString(
            TerminalList.serializer(),
            """
            {"terminals":[{"id":"t1","harness":"codex","cwd":"/w","name":"a","status":"idle","createdAt":1,"daybreak":true},
                          {"id":"t2","harness":"codex","cwd":"/w","name":"b","status":"idle","createdAt":2,"daybreak":null},
                          {"id":"t3","harness":"claude-code","cwd":"/w","name":"c","status":"idle","createdAt":3}],
             "agents":["codex"],"models":{"codex":[{"id":"gpt-6.1-sol","name":"GPT-6.1-Sol","daybreak":"never"},{"id":"gpt-x","name":"GPT-X"}]},
             "daybreak":{"codex":false}}
            """.trimIndent(),
        )
        assertEquals(listOf(true, null, null), list.terminals.map { it.daybreak })
        assertEquals(listOf("never", null), list.models["codex"]?.map { it.daybreak })
        assertEquals(mapOf("codex" to false), list.daybreak)
        assertEquals(emptyMap(), KitJson.decodeFromString(TerminalList.serializer(), """{"terminals":[],"agents":[]}""").daybreak)
        assertEquals(TerminalEvent.Daybreak(false), TerminalEvent.parse("daybreak", """{"type":"daybreak","on":false}"""))
        assertNull(TerminalEvent.parse("daybreak", """{"type":"daybreak"}"""))
    }

    /**
     * What the model control opens on the phone (2026-10-07, user, of a Codex terminal: 手机上怎么还是不能选模型): the
     * agent's models wherever the Mac can set one, not for Claude Code alone.
     */
    @Test
    fun testTheModelControlListsModelsWhereverTheMacCanSetOne() {
        val never = TerminalModelOption(id = "gpt-6.1-sol", name = "GPT-6.1-Sol", daybreak = "never")
        val also = TerminalModelOption(id = "gpt-6-sol", name = "GPT-6-Sol", daybreak = "also")
        val only = TerminalModelOption(id = "gpt-daybreak-blue-latest", name = "Daybreak Blue", daybreak = "only")
        val codex = listOf(never, also, only)
        fun offer(harness: String, sets: Boolean?, options: List<TerminalModelOption>, exited: Boolean = false, resting: Boolean = true, daybreak: Boolean? = null): TerminalModelMenu =
            TerminalModelMenu.offer(harness, sets, exited, resting, options, daybreak)
        // A Codex terminal the Mac can set a model for (it runs behind its own server): its models, as its Daybreak
        // switch stands; not while it works or waits; its own picker where the Mac cannot (started on its own).
        assertEquals(TerminalModelMenu.Models(codex), offer("codex", true, codex))
        assertEquals(TerminalModelMenu.Models(listOf(also, only)), offer("codex", true, codex, daybreak = true))
        assertEquals(TerminalModelMenu.Models(listOf(never, also)), offer("codex", true, codex, daybreak = false))
        assertEquals(TerminalModelMenu.Busy, offer("codex", true, codex, resting = false))
        assertEquals(TerminalModelMenu.Picker, offer("codex", false, codex))
        assertEquals(TerminalModelMenu.Picker, offer("codex", true, emptyList())) // its list was not read: nothing to choose from here
        assertEquals(TerminalModelMenu.Ended, offer("codex", true, codex, exited = true))
        // A Mac that does not say: Claude Code alone, as before.
        assertEquals(TerminalModelMenu.Models(listOf(also)), offer("claude-code", null, listOf(also)))
        assertEquals(TerminalModelMenu.Picker, offer("codex", null, codex))
        assertEquals(TerminalModelMenu.Models(listOf(also)), offer("opencode", true, listOf(also)))
        // The level: from here for the same agents; while it works only Claude Code.
        assertEquals(true, TerminalModelMenu.levelTakenWhileWorking("claude-code", null))
        assertEquals(false, TerminalModelMenu.levelTakenWhileWorking("codex", true))
        assertNull(TerminalModelMenu.levelTakenWhileWorking("codex", null))
        assertNull(TerminalModelMenu.levelTakenWhileWorking("codex", false))
        val info = KitJson.decodeFromString(TerminalInfo.serializer(), """{"id":"t1","harness":"codex","cwd":"/w","name":"a","status":"idle","createdAt":1,"sets":true}""")
        assertEquals(true, info.sets)
        assertNull(KitJson.decodeFromString(TerminalInfo.serializer(), """{"id":"t1","harness":"codex","cwd":"/w","name":"a","status":"idle","createdAt":1}""").sets)
    }

    // MARK: the profile a terminal runs under, and its colour (docs/profiles-v0.md §3.2)

    @Test
    fun testATerminalCarriesItsProfileAndItsColour() {
        // The names are the Mac's (`PROFILE_COLORS` in the daemon's profiles/store.ts), in its order.
        assertEquals(listOf("violet", "sand", "mint", "orchid", "olive", "slate"), ProfileColor.entries.map { it.rawValue })
        assertEquals(ProfileColor.entries.size, ProfileColor.entries.map { it.dark }.toSet().size)
        assertEquals(ProfileColor.entries.size, ProfileColor.entries.map { it.light }.toSet().size)
        fun terminal(profile: String): TerminalInfo =
            KitJson.decodeFromString(TerminalInfo.serializer(), """{"id":"t1","harness":"claude-code","cwd":"/w","name":"a","status":"idle","createdAt":1,"profile":$profile}""")
        assertEquals(
            TerminalProfile(name = "cwork1", color = ProfileColor.Violet),
            terminal("""{"id":"abc123def0","name":"cwork1","exit":{"ip":"203.0.113.9","place":"Tokyo"},"color":"violet"}""").profile,
        )
        // No colour, or one this app does not know yet: the profile all the same, without a dot.
        assertEquals(TerminalProfile(name = "cwork1"), terminal("""{"id":"abc123def0","name":"cwork1"}""").profile)
        assertEquals(TerminalProfile(name = "cwork1"), terminal("""{"id":"abc123def0","name":"cwork1","color":"plaid"}""").profile)
        // The Mac's own, and a Mac that does not say.
        assertNull(terminal("null").profile)
        assertNull(KitJson.decodeFromString(TerminalInfo.serializer(), """{"id":"t1","harness":"codex"}""").profile)
    }

    // MARK: the profile is chosen where a terminal is made (docs/profiles-v0.md §3.3)

    @Test
    fun testTheProfileGoesWithTheRequestThatStartsOrContinuesATerminal() {
        assertEquals("abc123def0", (KitJson.encodeToJsonElementOf(NewTerminalRequest(harness = "claude-code", cwd = "~/p", profile = "abc123def0"))["profile"] as JsonPrimitive).content)
        assertNull(KitJson.encodeToJsonElementOf(NewTerminalRequest(harness = "codex", cwd = "~/p"))["profile"])
        assertNull(KitJson.encodeToJsonElementOf(ResumeTerminalRequest(harness = "claude-code", cwd = "/w", agentSessionId = "s1"))["profile"])
        val named = ResumeTerminalRequest(harness = "claude-code", cwd = "/w", agentSessionId = "s1", profile = "default")
        assertEquals("default", (KitJson.encodeToJsonElementOf(named)["profile"] as JsonPrimitive).content)
        assertEquals("default", named.continuing("/elsewhere").profile)

        // The list says which profile a conversation last ran under, when it is not the Mac's own.
        val listed = KitJson.decodeFromString(
            ListSerializer(SessionSummary.serializer()),
            """[{"harness":"claude-code","id":"s1","cwd":"/w","profile":"abc123def0"},{"harness":"claude-code","id":"s2","cwd":"/w"}]""",
        )
        assertEquals(listOf("abc123def0", null), listed.map { it.profile })

        // The profiles as the Mac lists them (`GET /profiles`): what is needed to choose between them, the rest left.
        val reply = KitJson.decodeFromString(
            MapSerializer(String.serializer(), ProfileChoices.serializer()),
            KitJson.parseToJsonElement(
                """
                {"agents":{"claude-code":{"current":"abc123def0","creatable":true,"profiles":[
                    {"id":"default","name":"Default","kind":"subscription","createdAt":0,"account":"me@example.com"},
                    {"id":"abc123def0","name":"cwork1","kind":"subscription","createdAt":1,"color":"violet","proxy":{"server":"http://proxy.example:8080","sealed":true},"exit":{"ip":"203.0.113.9","place":"Tokyo"}},
                    {"id":"abc123def1","name":"later","kind":"subscription","createdAt":2,"color":"a-colour-of-a-newer-mac"}]},
                  "codex":{"current":"default","creatable":false,"profiles":[{"id":"default","name":"Default","kind":"subscription","createdAt":0}]}}}
                """.trimIndent(),
            ).jsonObject["agents"].toString(),
        )
        val agents = reply
        val claude = assertNotNull(agents["claude-code"])
        assertTrue(claude.several)
        assertEquals(
            ProfileChoice(id = "abc123def0", name = "cwork1", color = ProfileColor.Violet, proxy = ProxySetting(server = "http://proxy.example:8080", sealed = true), exit = ProxyExit(ip = "203.0.113.9", place = "Tokyo")),
            claude.offered,
        )
        assertEquals(listOf("me@example.com", "Not Signed In", "Not Signed In"), claude.profiles.map { it.who })
        assertNull(claude.profiles[2].color)
        assertEquals(false, agents["codex"]?.several)
        assertEquals("This Mac’s own", agents["codex"]?.profiles?.first()?.who)
        assertEquals("default", ProfileChoices(current = "gone000000", profiles = claude.profiles).offered?.id)
    }

    // MARK: how far a turn has come, and what was sent (2026-10-08)

    @Test
    fun testTurnProgressAndSentRepliesParse() {
        assertEquals(TerminalEvent.Progress(TurnProgress(tokens = 1300)), TerminalEvent.parse("progress", """{"type":"progress","progress":{"tokens":1300,"way":"down"}}"""))
        assertEquals(TerminalEvent.Progress(null), TerminalEvent.parse("progress", """{"type":"progress","progress":null}"""))
        assertEquals(
            TerminalEvent.Sent(listOf(SentReply(id = "r1", text = "你好", at = 1_700_000_000_000, files = 1))),
            TerminalEvent.parse("sent", """{"type":"sent","replies":[{"id":"r1","text":"你好","at":1700000000000,"files":1}]}"""),
        )
        assertEquals(TerminalEvent.Sent(emptyList()), TerminalEvent.parse("sent", """{"type":"sent","replies":[]}"""))
    }

    /** A list on the agent's own screen with all it says above its rows (docs/simple-view-v0.md §5.17). */
    @Test
    fun testAListOffTheAgentsScreenParsesWithWhatItAsks() {
        val folder = """{"type":"choices","choices":{"title":"Trust this folder? Codex can read, edit, and run files here.","options":[{"label":"Trust and continue"},{"label":"Quit"}],"selected":0,"text":"Folder access\n/tmp/w\nTrust this folder? Codex can read, edit, and run files here."}}"""
        val asked = ScreenChoices(
            title = "Trust this folder? Codex can read, edit, and run files here.",
            options = listOf(ScreenChoices.Option("Trust and continue"), ScreenChoices.Option("Quit")), selected = 0,
            text = "Folder access\n/tmp/w\nTrust this folder? Codex can read, edit, and run files here.",
        )
        assertEquals(TerminalEvent.Choices(asked), TerminalEvent.parse("choices", folder))
        // The card's lines: the screen's own, the question marked among them.
        assertEquals(listOf("Folder access", "/tmp/w", "Trust this folder? Codex can read, edit, and run files here."), asked.said.map { it.text })
        assertEquals(listOf(false, false, true), asked.said.map { it.asks })
        // A list with a title alone (a service that says no more, Codex's `/model`): the title is the card's one line.
        val model = """{"type":"choices","choices":{"title":"Select Model and Effort","options":[{"label":"gpt-6-sol","detail":"Frontier model"}],"selected":0}}"""
        assertEquals(
            TerminalEvent.Choices(ScreenChoices(title = "Select Model and Effort", options = listOf(ScreenChoices.Option("gpt-6-sol", "Frontier model")), selected = 0)),
            TerminalEvent.parse("choices", model),
        )
        assertEquals(listOf(ScreenChoices.Line(0, "Select Model and Effort", true)), ScreenChoices.said("Select Model and Effort", null))
        assertEquals(emptyList(), ScreenChoices.said("", null))
        // Lines that do not hold the title as one of them (it was cut short): the first stands for it; blank ones go.
        assertEquals(listOf(true, false), ScreenChoices.said("A long question that was cu", "A long question that was cut\n\n  and what it means ").map { it.asks })
        assertEquals(TerminalEvent.Choices(null), TerminalEvent.parse("choices", """{"type":"choices","choices":null}"""))
    }

    @Test
    fun testTurnTokensReadAsTheAgentsOwnLine() {
        assertNull(RecordDisplay.turnTokens(null))
        assertNull(RecordDisplay.turnTokens(TurnProgress(tokens = 0)))
        assertEquals("↓ 1 token", RecordDisplay.turnTokens(TurnProgress(tokens = 1)))
        assertEquals("↓ 250 tokens", RecordDisplay.turnTokens(TurnProgress(tokens = 250)))
        assertEquals("↓ 1.3k tokens", RecordDisplay.turnTokens(TurnProgress(tokens = 1300)))
        assertEquals("↓ 2k tokens", RecordDisplay.turnTokens(TurnProgress(tokens = 2000)))
        assertEquals("↑ 12.5k tokens", RecordDisplay.turnTokens(TurnProgress(tokens = 12_500, way = "up")))
        assertEquals("↓ 123k tokens", RecordDisplay.turnTokens(TurnProgress(tokens = 123_456)))
        assertEquals("↓ 1.2M tokens", RecordDisplay.turnTokens(TurnProgress(tokens = 1_200_000)))
    }

    @Test
    fun testSentRepliesStandAtTheRecordsEndUntilItHoldsThem() {
        val said = RecordItem(id = "10", kind = RecordItem.Kind.User, at = 1_000, text = "把重试次数改成 3")
        val answer = RecordItem(id = "20", kind = RecordItem.Kind.Answer, at = 2_000, text = "改好了。")
        val reply = SentReply(id = "r1", text = "顺便把测试也跑一遍", at = 10_000)
        val waiting = SentReply.appended(listOf(said, answer), listOf(reply), working = true)
        assertEquals(listOf("10", "20", "sent-r1"), waiting.map { it.id })
        assertEquals(listOf(true, true, true, true), waiting.last().let { listOf(it.kind == RecordItem.Kind.User, it.queued, it.text == reply.text, it.at == 10_000L) })
        assertEquals(false, SentReply.appended(listOf(said, answer), listOf(reply), working = false).last().queued)
        // The record holds it (its page came before the service's word that it does): shown once.
        val held = RecordItem(id = "30", kind = RecordItem.Kind.User, at = 10_400, text = "顺便把测试也跑一遍")
        assertEquals(listOf("10", "20", "30"), SentReply.appended(listOf(said, answer, held), listOf(reply), working = true).map { it.id })
        // The same words said before it was sent are another message; an answer with those words is not yours.
        val before = RecordItem(id = "5", kind = RecordItem.Kind.User, at = 1_000, text = "顺便把测试也跑一遍")
        assertEquals(listOf("5", "20", "sent-r1"), SentReply.appended(listOf(before, answer), listOf(reply), working = false).map { it.id })
        assertEquals(2, SentReply.appended(listOf(RecordItem(id = "40", kind = RecordItem.Kind.Answer, at = 10_400, text = reply.text)), listOf(reply), working = false).size)
        // One that went with files reads otherwise in the record: the time decides.
        val withFile = SentReply(id = "r2", text = "看这张 /tmp/a.png", at = 20_000, files = 1)
        assertEquals(
            listOf("50"),
            SentReply.appended(listOf(RecordItem(id = "50", kind = RecordItem.Kind.User, at = 20_300, text = "看这张 [Image #1]", images = 1)), listOf(withFile), working = false).map { it.id },
        )
        assertEquals(listOf(said), SentReply.appended(listOf(said), emptyList(), working = true))
    }

    @Test
    fun testANoticeGoesWhereItsTimePutsItFirstWhenOlderThanAll() {
        val items = listOf(RecordItem(id = "u", kind = RecordItem.Kind.User, at = 2_000, text = "自托管 chromium 吧"), RecordItem(id = "a", kind = RecordItem.Kind.Answer, at = 3_000))
        fun notice(at: Long) = ScreenNotice(id = "n$at", text = "Set model", at = at)
        assertEquals(listOf("u", "notice-n2500", "a"), ScreenNotice.placed(items, listOf(notice(2_500))).map { it.id })
        assertEquals(listOf("notice-n1000", "u", "a"), ScreenNotice.placed(items, listOf(notice(1_000))).map { it.id })
        assertEquals(listOf("u", "a", "notice-n9000"), ScreenNotice.placed(items, listOf(notice(9_000))).map { it.id })
        assertEquals(listOf("notice-n1000"), ScreenNotice.placed(emptyList(), listOf(notice(1_000))).map { it.id })
    }

    /**
     * 2026-11-08, user's picture of `:codex-file-citation{…}` shown as is on the phone: the service takes a citation
     * out of the text and names the file; the screen shows it as a file to open.
     */
    @Test
    fun testAnAnswersFiles() {
        val page = """[{"type":"answer","id":"5","ts":1,"text":"做好了。","files":[{"path":"/Users/you/out/cyber_alive_oauth_65.xlsx","kind":"workbook"},{"path":"/Users/you/notes.md"}]},{"type":"answer","id":"9","ts":2,"text":"没有文件。"}]"""
        val items = KitJson.decodeFromString(ListSerializer(RecordItem.serializer()), page)
        assertEquals(listOf("cyber_alive_oauth_65.xlsx", "notes.md"), items[0].files.map { it.name })
        assertEquals(listOf("/Users/you/out", "/Users/you"), items[0].files.map { it.folder })
        assertEquals(listOf("Workbook", null), items[0].files.map { it.kindWord })
        assertEquals("Source Code", RecordFile(path = "/a/b.py", kind = "source_code").kindWord)
        assertNull(RecordFile(path = "/a/b.py", kind = "").kindWord)
        assertEquals(emptyList(), items[1].files)
    }
}

private fun <T> kotlinx.serialization.json.Json.encodeToJsonElementOf(value: T): JsonObject = when (value) {
    is NewTerminalRequest -> encodeToJsonElement(NewTerminalRequest.serializer(), value).jsonObject
    is ResumeTerminalRequest -> encodeToJsonElement(ResumeTerminalRequest.serializer(), value).jsonObject
    else -> error("no serializer")
}

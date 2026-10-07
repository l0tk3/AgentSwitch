import XCTest
@testable import AgentSwitchKit

/// A session's record on the phone (docs/simple-view-v0.md §2, §4, §5): what the Mac sends decoded, the words the
/// simple view puts on it, and the same record from a Mac that only has the session's messages.
final class RecordTests: XCTestCase {
    private let session = #"{"harness":"claude-code","id":"c1","cwd":"/Users/u/code/site","title":"删除按钮标红","lastText":"改好了","updatedAt":1791342000000.5,"startedAt":1791341000000,"active":true}"#

    private func record(_ rest: String) throws -> SessionRecord {
        try JSONDecoder().decode(SessionRecord.self, from: Data(#"{"session":\#(session),\#(rest)}"#.utf8))
    }

    func testDecodesTheRecordAsTheMacSendsIt() throws {
        let r = try record(#"""
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
        """#)
        // An item of a kind a newer Mac added is left out; the rest stands.
        XCTAssertEqual(r.items.map(\.kind), [.user, .work, .answer, .user, .note])
        XCTAssertEqual(r.items[0].images, 1)
        XCTAssertEqual(r.items[1].seconds, 70)
        XCTAssertEqual(r.items[1].steps.map(\.kind), [.think, .read, .run, .edit, .tool, .tool])
        XCTAssertEqual(r.items[1].steps[4], RecordStep(kind: .tool, text: "http://127.0.0.1:8765/", tool: "browser · navigate", out: "Error: page crashed", failed: true))
        // A step of a kind this app does not know is a tool by that name.
        XCTAssertEqual(r.items[1].steps[5].tool, "teleport")
        XCTAssertTrue(r.items[2].clipped)
        XCTAssertEqual(r.items[2].at, 1_791_341_072_000)
        XCTAssertTrue(r.items[3].queued)
        XCTAssertEqual(r.items[3].offset, 9200)
        XCTAssertTrue(r.more)
        XCTAssertEqual(r.cursor, 120)
        XCTAssertEqual(r.plan.map(\.state), [.done, .doing, .todo, .todo])
        XCTAssertEqual(r.usage, RecordUsage(model: "claude-opus-5-5", used: 124_012))
        XCTAssertEqual(r.mode, "acceptEdits")
        XCTAssertEqual(r.session.sessionId, "c1")
    }

    /// A record as a running Mac gave it (`AGENTSWITCH_RECORD_JSON=<file>`: the body of `GET /sessions/…/record`):
    /// every item decodes, each under its own id. Skipped without the file.
    func testDecodesARecordFromARunningMac() throws {
        guard let path = ProcessInfo.processInfo.environment["AGENTSWITCH_RECORD_JSON"], !path.isEmpty else {
            throw XCTSkip("set AGENTSWITCH_RECORD_JSON to a record's JSON")
        }
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        let raw = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let r = try JSONDecoder().decode(SessionRecord.self, from: data)
        XCTAssertEqual(r.items.count, (raw["items"] as? [Any])?.count)
        XCTAssertFalse(r.items.isEmpty)
        XCTAssertEqual(Set(r.items.map(\.id)).count, r.items.count)
        XCTAssertTrue(r.items.allSatisfy { $0.at > 0 })
        XCTAssertFalse(r.rev.isEmpty)
        for item in r.items where item.kind == .work { XCTAssertFalse(RecordDisplay.summary(item).isEmpty) }
    }

    func testARunOfWorkOnOneLine() {
        let work = RecordItem(id: "1", kind: .work, seconds: 72, steps: [
            RecordStep(kind: .think, text: "…"), RecordStep(kind: .read, text: "a.swift"), RecordStep(kind: .search, text: "Delete"),
            RecordStep(kind: .run, text: "swift build"), RecordStep(kind: .todo, text: "标红"), RecordStep(kind: .run, text: "swift test"),
            RecordStep(kind: .edit, text: "a.swift", added: 12, removed: 1), RecordStep(kind: .write, text: "b.swift", added: 2, removed: 0),
            RecordStep(kind: .tool, text: "x", tool: "browser · navigate"), RecordStep(kind: .tool, text: "y", tool: "Artifact"), RecordStep(kind: .agent, text: "找出所有用到的地方"),
        ])
        XCTAssertEqual(RecordDisplay.summary(work), "Worked 1m 12s · Read 1 · Searched 1 · Ran 2 · Edited 2 · Tools 2 · Agent 1")
        XCTAssertEqual(RecordDisplay.summary(work, running: true), "Working 1m 12s · Read 1 · Searched 1 · Ran 2 · Edited 2 · Tools 2 · Agent 1")
        XCTAssertEqual(RecordDisplay.summary(RecordItem(id: "2", kind: .work, steps: [RecordStep(kind: .list, text: "src")])), "Worked · Listed 1")
        // A step that brought pictures back says how many; one that says nothing has none (an older Mac).
        let steps = try? JSONDecoder().decode([RecordStep].self, from: Data(#"[{"kind":"read","text":"shot.png","images":2},{"kind":"read","text":"a.ts"}]"#.utf8))
        XCTAssertEqual(steps?.map(\.images), [2, 0])
        XCTAssertEqual(RecordDisplay.summary(RecordItem(id: "3", kind: .work, steps: [RecordStep(kind: .think, text: "…")])), "Worked")
        let stat = RecordDisplay.stat(work.steps)
        XCTAssertEqual(stat?.added, 14)
        XCTAssertEqual(stat?.removed, 1)
        XCTAssertNil(RecordDisplay.stat([RecordStep(kind: .run, text: "ls")]))
        // Opened: its thinking only in the verbose transcript.
        XCTAssertEqual(RecordDisplay.shown(work.steps, verbose: false).count, 10)
        XCTAssertEqual(RecordDisplay.shown(work.steps, verbose: true).count, 11)
        XCTAssertEqual(work.steps.map(RecordDisplay.label), ["Thought", "Read", "Search", "Run", "Tasks", "Run", "Edit", "Write", "browser · navigate", "Artifact", "Agent"])
    }

    func testTimesContextModeAndTheTaskList() {
        XCTAssertEqual([0, 8, 59, 60, 72, 3599, 3600, 3725].map(RecordDisplay.duration), ["0s", "8s", "59s", "1m 00s", "1m 12s", "59m 59s", "1h 00m", "1h 02m"])
        XCTAssertEqual([0, 41, 725, 3745].map(RecordDisplay.clock), ["0:00", "0:41", "12:05", "1:02:25"])
        XCTAssertEqual(RecordDisplay.context(RecordUsage(used: 51_000, window: 272_000)), "19%")
        XCTAssertEqual(RecordDisplay.context(RecordUsage(used: 300_000, window: 272_000)), "100%")
        XCTAssertEqual(RecordDisplay.context(RecordUsage(used: 124_012)), "124k")
        XCTAssertEqual(RecordDisplay.context(RecordUsage(used: 1_240_000)), "1.2M")
        XCTAssertNil(RecordDisplay.context(RecordUsage(model: "x")))
        XCTAssertNil(RecordDisplay.context(nil))
        XCTAssertEqual(["default", "acceptEdits", "plan", "auto", "bypassPermissions", "on-request", "never", "untrusted"].map(RecordDisplay.mode),
                       ["Ask", "Edits", "Plan", "Auto", "Bypass", "On Request", "Never Ask", "Ask"])
        XCTAssertNil(RecordDisplay.mode("something-new"))
        XCTAssertNil(RecordDisplay.mode(nil))
        let plan = RecordDisplay.plan([PlanEntry(text: "找", state: .done), PlanEntry(text: "标红", state: .doing), PlanEntry(text: "构建", state: .todo)])
        XCTAssertEqual(plan?.done, 1)
        XCTAssertEqual(plan?.total, 3)
        XCTAssertEqual(plan?.now, "标红")
        XCTAssertEqual(RecordDisplay.plan([PlanEntry(text: "a", state: .done), PlanEntry(text: "b", state: .todo)])?.now, "b")
        XCTAssertEqual(RecordDisplay.plan([PlanEntry(text: "a", state: .done)])?.now, "")
        XCTAssertNil(RecordDisplay.plan([]))
    }

    func testAMacWithOnlyTheMessagesStillGivesARecord() throws {
        let summary = try JSONDecoder().decode(SessionSummary.self, from: Data(session.utf8))
        let detail = SessionDetail(session: summary, messages: [
            SessionMessage(role: .user, text: "跑测试", ts: 1000),
            SessionMessage(role: .tool, text: "npm test\n--watch=false", ts: 2000, tool: "Bash"),
            SessionMessage(role: .tool, text: "src/a.ts", ts: 3000, tool: "Read"),
            SessionMessage(role: .tool, text: "click", ts: 4000, tool: "mcp__browser__browser_click"),
            SessionMessage(role: .assistant, text: "通过了。", ts: 5000),
            SessionMessage(role: .tool, text: "src/a.ts", ts: 6000, tool: "Edit"),
        ])
        let r = SessionRecord(coarse: detail)
        XCTAssertEqual(r.items.map(\.kind), [.user, .work, .answer, .work])
        XCTAssertEqual(r.items[1].steps.map(\.kind), [.run, .read, .tool])
        XCTAssertEqual(r.items[1].steps[0].text, "npm test")
        XCTAssertEqual(r.items[1].at, 2000)
        XCTAssertEqual(Set(r.items.map(\.id)).count, 4)
        XCTAssertNil(r.items[0].offset)
        XCTAssertFalse(r.more)
    }

    func testALongAnswerFoldsWhereAParagraphEnds() {
        XCTAssertNil(RecordDisplay.preview(String(repeating: "字", count: 2000)))
        let paragraphs = (0..<40).map { "第 \($0) 段，" + String(repeating: "话", count: 90) }.joined(separator: "\n\n")
        let head = RecordDisplay.preview(paragraphs)!
        XCTAssertLessThanOrEqual(head.count, RecordDisplay.previewChars)
        XCTAssertTrue(paragraphs.hasPrefix(head))
        XCTAssertTrue(head.hasSuffix("话"))
        XCTAssertFalse(head.hasSuffix("\n"))
        // Cut inside a block of code: the block is closed, so what follows on the screen is not drawn as code.
        let code = "说明：\n\n```swift\n" + (0..<200).map { "let x\($0) = \($0)" }.joined(separator: "\n") + "\n```\n\n完。"
        let cut = RecordDisplay.preview(code)!
        XCTAssertTrue(cut.hasSuffix("\n```"))
        XCTAssertEqual(cut.components(separatedBy: "```").count - 1, 2)
    }

    func testChangingTheModel() throws {
        XCTAssertEqual(RecordDisplay.modelCommand("opus"), "/model opus")
        XCTAssertEqual(RecordDisplay.modelCommand("claude-opus-5-5[1m]"), "/model claude-opus-5-5[1m]")
        // Nothing that would read as a second line or a flag's value.
        XCTAssertEqual(RecordDisplay.modelCommand("sonnet\nrm -rf ~"), "/model sonnetrm-rf")
        XCTAssertEqual(RecordDisplay.modelPicker("codex"), "/model")
        XCTAssertEqual(RecordDisplay.modelPicker("opencode"), "/models")
        XCTAssertEqual(RecordDisplay.model(now: "claude-sonnet-5-5", record: "claude-opus-5-5", started: "opus"), "claude-sonnet-5-5")
        XCTAssertEqual(RecordDisplay.model(now: nil, record: "claude-opus-5-5", started: "opus"), "claude-opus-5-5")
        XCTAssertEqual(RecordDisplay.model(now: nil, record: nil, started: "opus"), "opus")
        let opus = TerminalModelOption(id: "opus", name: "Opus 5.5"), sonnet = TerminalModelOption(id: "sonnet", name: "Sonnet 5.5")
        XCTAssertTrue(RecordDisplay.isCurrent(opus, model: "opus"))
        XCTAssertTrue(RecordDisplay.isCurrent(opus, model: "claude-opus-5-5"))
        XCTAssertFalse(RecordDisplay.isCurrent(sonnet, model: "claude-opus-5-5"))
        XCTAssertFalse(RecordDisplay.isCurrent(opus, model: nil))
        XCTAssertEqual(TerminalEvent.parse(event: "model", data: #"{"type":"model","model":"claude-sonnet-5-5"}"#), .model("claude-sonnet-5-5"))
        let info = try JSONDecoder().decode(TerminalInfo.self, from: Data(#"{"id":"t1","harness":"claude-code","model":"opus","modelNow":"claude-sonnet-5-5","status":"idle"}"#.utf8))
        XCTAssertEqual(info.modelNow, "claude-sonnet-5-5")
        XCTAssertNil(try JSONDecoder().decode(TerminalInfo.self, from: Data(#"{"id":"t1","harness":"codex"}"#.utf8)).modelNow)
    }

    func testThinkingLevelsByAgentAndModel() throws {
        let list = try JSONDecoder().decode(TerminalList.self, from: Data(#"""
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
        """#.utf8))
        XCTAssertEqual(list.terminals[0].effort, "xhigh")
        // A new terminal: the chosen model's levels; none chosen, the agent's default model's.
        XCTAssertEqual(EffortDisplay.levels(list, harness: "claude-code", model: nil), ["low", "medium", "high", "xhigh", "max"])
        XCTAssertEqual(EffortDisplay.levels(list, harness: "claude-code", model: "claude-opus-4-6"), ["low", "medium", "high", "max"])
        XCTAssertEqual(EffortDisplay.levels(list, harness: "claude-code", model: "haiku"), [])
        XCTAssertEqual(EffortDisplay.levels(list, harness: "codex", model: ""), ["low", "medium", "high", "xhigh", "max", "ultra"])
        XCTAssertEqual(EffortDisplay.levels(list, harness: "pi", model: nil).count, 7)
        // OpenCode's variants belong to a model: nothing without one, nothing for a model whose variants are not listed.
        XCTAssertEqual(EffortDisplay.levels(list, harness: "opencode", model: nil), [])
        XCTAssertEqual(EffortDisplay.levels(list, harness: "opencode", model: "deepseek/deepseek-flash"), ["none", "low", "high", "max"])
        XCTAssertEqual(EffortDisplay.levels(list, harness: "opencode", model: "openai/gpt-6"), [])
        XCTAssertEqual(EffortDisplay.levels(nil, harness: "claude-code", model: nil), [])
        XCTAssertEqual(EffortDisplay.defaultLevel(list, harness: "codex", model: nil), "low")
        XCTAssertEqual(EffortDisplay.defaultLevel(list, harness: "codex", model: "gpt-6-luna"), "medium")
        XCTAssertNil(EffortDisplay.defaultLevel(list, harness: "claude-code", model: "opus"))
        // A running terminal: the levels of the model it is on, found by the id it reports as by the alias listed.
        XCTAssertEqual(EffortDisplay.levels(list, harness: "claude-code", current: "claude-opus-4-6"), ["low", "medium", "high", "max"])
        XCTAssertEqual(EffortDisplay.levels(list, harness: "claude-code", current: "claude-opus-5-5"), ["low", "medium", "high", "xhigh", "max"])
        XCTAssertEqual(EffortDisplay.levels(list, harness: "claude-code", current: "claude-haiku-4-5-20251001"), [])
        XCTAssertEqual(EffortDisplay.levels(list, harness: "claude-code", current: nil), ["low", "medium", "high", "xhigh", "max"])
        // The model changes: a level it does not take goes back to its default.
        XCTAssertEqual(EffortDisplay.kept("xhigh", in: ["low", "medium", "high", "max"]), "")
        XCTAssertEqual(EffortDisplay.kept("max", in: ["low", "medium", "high", "max"]), "max")
        XCTAssertEqual(["low", "xhigh", "max", "minimal", "none", "off", "ultra"].map(EffortDisplay.name), ["Low", "XHigh", "Max", "Minimal", "None", "Off", "Ultra"])
        XCTAssertEqual(["claude-code", "codex", "opencode", "pi"].map(EffortDisplay.word), ["Effort", "Reasoning", "Variant", "Thinking"])
        XCTAssertEqual(EffortDisplay.level(asked: nil, record: "medium", started: "xhigh"), "medium")
        XCTAssertEqual(EffortDisplay.level(asked: "high", record: "medium", started: nil), "high")
        XCTAssertEqual(EffortDisplay.command("xhigh"), "/effort xhigh")
        XCTAssertEqual(EffortDisplay.command("high\n/clear"), "/effort highclear")
        XCTAssertEqual(EffortDisplay.picker("opencode"), "/variants")
        XCTAssertNil(EffortDisplay.picker("codex"))
        let usage = try JSONDecoder().decode(RecordUsage.self, from: Data(#"{"model":"claude-opus-5-5","used":1000,"effort":"xhigh"}"#.utf8))
        XCTAssertEqual(usage.effort, "xhigh")
        let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(NewTerminalRequest(harness: "codex", cwd: "~/p", model: "gpt-6-luna", effort: "high"))) as? [String: Any]
        XCTAssertEqual(body?["effort"] as? String, "high")
        XCTAssertNil((try JSONSerialization.jsonObject(with: JSONEncoder().encode(NewTerminalRequest(harness: "codex", cwd: "~/p"))) as? [String: Any])?["effort"])
    }

    /// A picture sent with a message (2026-10-07): asked of the Mac by the item it came with and its place among
    /// that item's pictures; what it is, by its first bytes.
    func testAMessagesPictureIsAskedByItsItemAndPlace() async throws {
        let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3])
        let transport = FakeTransport { req, _ in
            req.url?.path.hasSuffix("/images/1024.2/1") == true ? (png, httpResponse(req.url, contentType: "image/png"))
                : (json(["error": "no such picture"]), httpResponse(req.url, status: 404))
        }
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(APIEndpoint(host: "192.168.1.5", port: 4400, kind: .lan)), transport: transport, token: "tok")
        let data = try await api.sessionImage(harness: "claude-code", id: "c7", item: "1024.2", n: 1)
        XCTAssertEqual(data, png)
        XCTAssertEqual(transport.paths, ["/sessions/claude-code/c7/images/1024.2/1"])
        XCTAssertEqual(transport.requests.first?.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
        // An older Mac, or a picture no longer there: an HTTP error, not a picture.
        do {
            _ = try await api.sessionImage(harness: "codex", id: "x1", item: "0", n: 0)
            XCTFail("a picture that is not there")
        } catch APIError.http(let status, _) {
            XCTAssertEqual(status, 404)
        }

        XCTAssertEqual(RecordDisplay.pictureExtension(png), "png")
        XCTAssertEqual(RecordDisplay.pictureExtension(Data([0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10])), "jpg")
        XCTAssertEqual(RecordDisplay.pictureExtension(Data("GIF89a....".utf8)), "gif")
        XCTAssertEqual(RecordDisplay.pictureExtension(Data("RIFF\u{24}\u{0}\u{0}\u{0}WEBPVP8 ".utf8)), "webp")
        XCTAssertEqual(RecordDisplay.pictureExtension(Data([0, 0, 0, 0x18] + Array("ftypheic".utf8))), "heic")
        XCTAssertEqual(RecordDisplay.pictureExtension(Data()), "png")
        XCTAssertEqual(RecordDisplay.pictureExtension(Data("RIFF....WAVE".utf8)), "png")
    }

    /// 2026-10-07, user: 怎么少了思考细节呢 / 官方的代码执行块里看没有省略而且有高亮显示.
    func testThoughtsNotesAndAStepWhole() async throws {
        let page = #"[{"type":"answer","id":"5","ts":1,"text":"先看列表的底色。","thinking":true},{"type":"work","id":"9","ts":2,"secs":3,"steps":[{"kind":"run","text":"git status","note":"Check the tree"},{"kind":"run","text":"ls","note":""}]},{"type":"answer","id":"20","ts":6,"text":"好了"}]"#
        let items = try JSONDecoder().decode([RecordItem].self, from: Data(page.utf8))
        XCTAssertEqual(items.map(\.thinking), [true, false, false])
        XCTAssertEqual(items[1].steps.map(\.note), ["Check the tree", nil])
        let busy = try JSONDecoder().decode(TerminalActivity.self, from: Data(#"{"tool":"Bash","target":"cat > x","note":"Write the patch"}"#.utf8))
        XCTAssertEqual(busy, TerminalActivity(tool: "Bash", target: "cat > x", note: "Write the patch"))
        XCTAssertNil(try JSONDecoder().decode(TerminalActivity.self, from: Data(#"{"tool":"Bash","target":"ls"}"#.utf8)).note)

        let transport = FakeTransport { req, _ in
            req.url?.path == "/sessions/claude-code/c7/steps/1024/2"
                ? (Data(#"{"kind":"run","text":"a\nb","note":"Two lines","out":"x","clipped":true}"#.utf8), httpResponse(req.url))
                : (json(["error": "no such step"]), httpResponse(req.url, status: 404))
        }
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(APIEndpoint(host: "192.168.1.5", port: 4400, kind: .lan)), transport: transport, token: "tok")
        let step = try await api.sessionStep(harness: "claude-code", id: "c7", work: "1024", n: 2)
        XCTAssertEqual(step, RecordStepDetail(text: "a\nb", note: "Two lines", out: "x", clipped: true))
        // An older Mac: no such route, the record's own line stays.
        let none = try await api.sessionStep(harness: "claude-code", id: "c7", work: "1024", n: 9)
        XCTAssertNil(none)

        // One small picture for each kind of step, no two alike.
        let kinds: [RecordStep.Kind] = [.read, .search, .list, .run, .edit, .write, .web, .agent, .todo, .think, .tool]
        XCTAssertEqual(Set(kinds.map(RecordDisplay.symbol)).count, kinds.count)
        XCTAssertEqual(RecordDisplay.symbol(.run), "terminal")
        XCTAssertEqual(RecordDisplay.symbol(.web), "globe")
        // What it is doing now has the picture of the step it will be; thinking, the thinking one.
        XCTAssertEqual(RecordDisplay.toolSymbol("Bash"), "terminal")
        XCTAssertEqual(RecordDisplay.toolSymbol("MultiEdit"), "pencil")
        XCTAssertEqual(RecordDisplay.toolSymbol("WebSearch"), "globe")
        XCTAssertEqual(RecordDisplay.toolSymbol("Agent"), RecordDisplay.symbol(.agent))
        XCTAssertEqual(RecordDisplay.toolSymbol("TodoWrite"), RecordDisplay.symbol(.todo))
        // The browser's tools read as the web here (ToolDisplay's word for them); any other tool is a tool.
        XCTAssertEqual(RecordDisplay.toolSymbol("mcp__browser__browser_click"), "globe")
        XCTAssertEqual(RecordDisplay.toolSymbol("mcp__github__create_issue"), RecordDisplay.symbol(.tool))
        XCTAssertEqual(RecordDisplay.toolSymbol(nil), RecordDisplay.symbol(.think))

        typealias R = ShellHighlight.Run
        XCTAssertEqual(ShellHighlight.runs("cd /a && git commit -F - <<'EOF'\nfix: it\nEOF\ngit log 2>&1 | head -1 # last"),
                       [R("cd", .command), R(" /a && ", .plain), R("git", .command), R(" commit -F - <<", .plain), R("'EOF'", .string), R("\n", .plain), R("fix: it\nEOF", .string), R("\n", .plain),
                        R("git", .command), R(" log 2>&1 | ", .plain), R("head", .command), R(" -1 ", .plain), R("# last", .comment)])
        for source in ["echo \"never closed", "cat <<EOF\nno end", "", "FOO=1 make 'a b'"] {
            XCTAssertEqual(ShellHighlight.runs(source).map(\.text).joined(), source)
        }
    }

    /// The effort slider (2026-10-07, user: 思考强度改成滑块调节): the levels are stops on a line.
    func testEffortAsAPlaceOnALine() {
        let levels = ["low", "medium", "high", "xhigh", "max"]
        XCTAssertEqual(EffortScale.index(of: "high", in: levels), 2)
        XCTAssertNil(EffortScale.index(of: nil, in: levels))
        // The nearest stop to where the finger is, never off the line's ends.
        XCTAssertEqual([-40, 0, 24, 26, 100, 149, 151, 200, 900].map { EffortScale.stop(at: $0, width: 200, count: 5) }, [0, 0, 0, 1, 2, 3, 3, 4, 4])
        XCTAssertEqual(EffortScale.stop(at: 50, width: 200, count: 1), 0)
        XCTAssertEqual((0..<5).map { EffortScale.place(of: $0, width: 200, count: 5) }, [0, 50, 100, 150, 200])
        XCTAssertEqual((0..<5).map { EffortScale.heat($0, count: 5) }, [0, 0.25, 0.5, 0.75, 1])
        // VoiceOver's step: one stop either way, stopping at the ends; from none chosen, the default.
        XCTAssertEqual(EffortScale.step(from: 4, by: 1, start: nil, count: 5), 4)
        XCTAssertEqual(EffortScale.step(from: nil, by: 1, start: 1, count: 5), 1)
        XCTAssertNil(EffortScale.step(from: nil, by: 1, start: nil, count: 0))
    }

    func testChangesDecode() throws {
        let list = try JSONDecoder().decode(FileDiffList.self, from: Data(#"""
        {"files":[{"path":"src/retry.ts","added":1,"removed":1,"hunks":[{"header":"@@ -3,1 +3,1 @@","lines":["-const RETRIES = 5;","+const RETRIES = 3;"]}]},
                  {"path":"big.txt","added":420,"removed":0,"hunks":[{"header":"","lines":["+l0"]}],"clipped":true}]}
        """#.utf8))
        XCTAssertEqual(list.files.map(\.path), ["src/retry.ts", "big.txt"])
        XCTAssertEqual(list.files[0].hunks[0].lines.count, 2)
        XCTAssertTrue(list.files[1].clipped)
    }

    func testTheRecordStreamsOwnEvents() {
        XCTAssertEqual(TerminalEvent.parse(event: "record", data: #"{"type":"record","rev":"k3-x9"}"#), .record(rev: "k3-x9"))
        XCTAssertEqual(TerminalEvent.parse(event: "activity", data: #"{"type":"activity","activity":null,"subagents":[]}"#), .activity(nil, []))
        let busy = TerminalEvent.parse(event: "activity", data: #"{"type":"activity","activity":{"tool":"Bash","target":"npm test"},"subagents":[{"id":"a1","type":"Explore","name":"找出所有用到的地方","activity":{"tool":"Grep","target":"Delete"},"since":1,"doing":"搜索 Delete"}]}"#)
        guard case .activity(let activity, let subagents)? = busy else { return XCTFail("not an activity") }
        XCTAssertEqual(activity, TerminalActivity(tool: "Bash", target: "npm test"))
        XCTAssertEqual(subagents.map(\.name), ["找出所有用到的地方"])
        XCTAssertEqual(subagents.first?.doing, "搜索 Delete")
    }
}

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

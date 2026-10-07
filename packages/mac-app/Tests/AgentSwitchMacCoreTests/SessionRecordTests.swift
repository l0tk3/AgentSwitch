import XCTest
@testable import AgentSwitchMacCore

/// A session's record on the Mac (docs/simple-view-v0.md §2, §4, §5.2): what the service sends decoded, the words the
/// simple view puts on it, a page laid over what a pane holds, and what its stream and its keys say.
final class SessionRecordTests: XCTestCase {
    private let session = #"{"harness":"claude-code","id":"c1","cwd":"/Users/u/code/site","title":"删除按钮标红","lastText":"改好了","updatedAt":1791342000000,"startedAt":1791341000000,"active":true}"#

    func testDecodesTheRecordAsTheServiceSendsIt() throws {
        let r = try JSONDecoder().decode(SessionRecord.self, from: Data(#"""
        {"session":\#(session),"items":[
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
         "more":true,"cursor":120,"rev":"abc-1","plan":[{"text":"找","state":"done"},{"text":"标红","state":"doing"},{"text":"以后","state":"someday"}],
         "usage":{"model":"claude-opus-5-5","used":124012,"effort":"xhigh"},"mode":"acceptEdits"}
        """#.utf8))
        // An item of a kind a newer service added is left out; a step of an unknown kind is a tool by that name.
        XCTAssertEqual(r.items.map(\.kind), [.user, .work, .answer, .user, .note])
        XCTAssertEqual(r.items[1].steps.map(\.kind), [.think, .read, .run, .edit, .tool, .tool])
        XCTAssertEqual(r.items[1].steps[5].tool, "teleport")
        XCTAssertEqual(r.items[1].seconds, 70)
        XCTAssertTrue(r.items[2].clipped)
        XCTAssertTrue(r.items[3].queued)
        XCTAssertEqual(r.items[3].offset, 9200)
        XCTAssertEqual(r.cursor, 120)
        XCTAssertEqual(r.plan.map(\.state), [.done, .doing, .todo])
        XCTAssertEqual(r.usage, RecordUsage(model: "claude-opus-5-5", used: 124_012, effort: "xhigh"))
        XCTAssertEqual(r.mode, "acceptEdits")
        XCTAssertEqual(r.session.sessionId, "c1")
    }

    func testARunOfWorkOnOneLineAndTheOtherWords() {
        let work = RecordItem(id: "1", kind: .work, seconds: 72, steps: [
            RecordStep(kind: .think, text: "…"), RecordStep(kind: .read, text: "a.swift"), RecordStep(kind: .search, text: "Delete"),
            RecordStep(kind: .run, text: "swift build"), RecordStep(kind: .todo, text: "标红"), RecordStep(kind: .run, text: "swift test"),
            RecordStep(kind: .edit, text: "a.swift", added: 12, removed: 1), RecordStep(kind: .write, text: "b.swift", added: 2, removed: 0),
            RecordStep(kind: .tool, text: "x", tool: "browser · navigate"), RecordStep(kind: .tool, text: "y", tool: "Artifact"), RecordStep(kind: .agent, text: "找"),
        ])
        XCTAssertEqual(RecordDisplay.summary(work), "Worked 1m 12s · Read 1 · Searched 1 · Ran 2 · Edited 2 · Tools 2 · Agent 1")
        XCTAssertEqual(RecordDisplay.summary(work, running: true).prefix(15), "Working 1m 12s ")
        XCTAssertEqual(RecordDisplay.summary(RecordItem(id: "3", kind: .work, steps: [RecordStep(kind: .think, text: "…")])), "Worked")
        XCTAssertEqual(RecordDisplay.stat(work.steps)?.added, 14)
        XCTAssertEqual(RecordDisplay.stat(work.steps)?.removed, 1)
        XCTAssertNil(RecordDisplay.stat([RecordStep(kind: .run, text: "ls")]))
        XCTAssertEqual(RecordDisplay.shown(work.steps, verbose: false).count, 10)
        XCTAssertEqual(work.steps.map(RecordDisplay.label), ["Thought", "Read", "Search", "Run", "Tasks", "Run", "Edit", "Write", "browser · navigate", "Artifact", "Agent"])
        XCTAssertEqual(work.steps.map(RecordDisplay.namesFile), [false, true, false, false, false, false, true, true, false, false, false])
        XCTAssertEqual([0, 8, 60, 72, 3725].map(RecordDisplay.duration), ["0s", "8s", "1m 00s", "1m 12s", "1h 02m"])
        XCTAssertEqual([41, 725, 3745].map(RecordDisplay.clock), ["0:41", "12:05", "1:02:25"])
        XCTAssertEqual(RecordDisplay.context(RecordUsage(used: 51_000, window: 272_000)), "19%")
        XCTAssertEqual(RecordDisplay.context(RecordUsage(used: 124_012)), "124k")
        XCTAssertNil(RecordDisplay.context(nil))
        XCTAssertEqual(["default", "acceptEdits", "plan", "bypassPermissions", "on-request", "never"].map(RecordDisplay.mode), ["Ask", "Edits", "Plan", "Bypass", "On Request", "Never Ask"])
        XCTAssertNil(RecordDisplay.mode("something-new"))
        XCTAssertEqual(RecordDisplay.plan([PlanEntry(text: "找", state: .done), PlanEntry(text: "标红", state: .doing)])?.now, "标红")
        XCTAssertEqual(["Bash", "Read", "Edit", "Grep", "WebFetch", "Agent", "mcp__browser__browser_navigate"].map(RecordDisplay.toolWord), ["Run", "Read", "Edit", "Search", "Web", "Agent", "Browser"])
        XCTAssertEqual(RecordDisplay.model(now: nil, record: "claude-opus-5-5", started: "opus"), "claude-opus-5-5")
        XCTAssertNil(RecordDisplay.preview(String(repeating: "字", count: 3000)))
        let code = "说明：\n\n```swift\n" + (0..<400).map { "let x\($0) = \($0)" }.joined(separator: "\n") + "\n```\n\n完。"
        XCTAssertTrue(RecordDisplay.preview(code)!.hasSuffix("\n```"), "a block of code cut open is closed")
    }

    /// The latest page over what a pane holds: earlier pages it asked for stay, the page's own stretch is replaced.
    func testALaterPageIsLaidOverWhatIsHeld() {
        func item(_ at: Int, _ text: String = "") -> RecordItem { RecordItem(id: String(at), kind: .answer, text: text) }
        let held = [item(100), item(200), item(300), item(400, "old")]
        let page = [item(300), item(400, "new"), item(500)]
        let merged = SessionRecord.merged(held: held, page: page)
        XCTAssertEqual(merged.items.map(\.id), ["100", "200", "300", "400", "500"])
        XCTAssertEqual(merged.items[3].text, "new")
        XCTAssertFalse(merged.replaced, "the earlier pages are still the start: their cursor stands")
        // Nothing held, a gap between the two, or items without a place in a file: the page is the record.
        XCTAssertTrue(SessionRecord.merged(held: [], page: page).replaced)
        XCTAssertEqual(SessionRecord.merged(held: [item(10), item(20)], page: page).items.map(\.id), ["300", "400", "500"])
        XCTAssertEqual(SessionRecord.merged(held: [RecordItem(id: "m0", kind: .user)], page: [RecordItem(id: "m0", kind: .user), RecordItem(id: "m1", kind: .answer)]).items.count, 2)
    }

    func testTheRecordStreamsEventsAndThePagesKey() {
        XCTAssertEqual(TerminalRecordEvent.decode(event: "record", data: #"{"type":"record","rev":"k3-x9"}"#), .record(rev: "k3-x9"))
        XCTAssertEqual(TerminalRecordEvent.decode(event: "model", data: #"{"type":"model","model":"claude-sonnet-5-5"}"#), .model("claude-sonnet-5-5"))
        XCTAssertEqual(TerminalRecordEvent.decode(event: "activity", data: #"{"type":"activity","activity":null,"subagents":[]}"#), .activity(nil, []))
        let busy = TerminalRecordEvent.decode(event: "activity", data: #"{"activity":{"tool":"Bash","target":"npm test"},"subagents":[{"id":"a1","type":"Explore","name":"找","activity":null,"since":1,"doing":"搜索 Delete"}]}"#)
        XCTAssertEqual(busy, .activity(TerminalActivity(tool: "Bash", target: "npm test"), [TerminalSubagent(id: "a1", type: "Explore", name: "找", doing: "搜索 Delete")]))
        // The terminal's own events are its model's, not the record's.
        XCTAssertNil(TerminalRecordEvent.decode(event: "status", data: #"{"status":"idle"}"#))
        // ⌘⇧E: the pane in focus as its record, or as the terminal again — from the screen and from a field alike.
        let press = ItemWindowKey.Press(key: "e", keyCode: 14, command: true, shift: true)
        for editing in [false, true] {
            XCTAssertEqual(TerminalsPageKey.action(for: press, editing: editing, plainField: false, marking: false, inSeal: false, cardHasKeys: false, creating: false), .toggleView)
        }
        // The status bar says `Simple` where the size was: a record holds no size here.
        var context = TerminalContext(harness: "claude-code", cols: 139, rows: 46)
        XCTAssertTrue(context.size.contains("139"))
        context.simple = true
        XCTAssertEqual(context.size, "Simple")
    }

    /// A reply's files (2026-10-07): placeholders as the phone's, a file on this Mac by where it is.
    func testAReplysFilesStandAsPlaceholdersAndGoByTheirPath() throws {
        XCTAssertEqual(TerminalDraft.token(image: true, number: 1), "[Image #1]")
        XCTAssertEqual(TerminalDraft.token(image: false, number: 12), "[File #12]")
        XCTAssertTrue(TerminalDraft.isImage(name: "屏幕截图 (2).PNG"))
        XCTAssertTrue(TerminalDraft.isImage(name: "a.b.jpeg"))
        XCTAssertFalse(TerminalDraft.isImage(name: "notes.pdf"))
        XCTAssertFalse(TerminalDraft.isImage(name: "png"))
        // Typed at the caret: a space before only where the text has none, one after each.
        XCTAssertEqual(TerminalDraft.typed(["[Image #1]"], after: nil), "[Image #1] ")
        XCTAssertEqual(TerminalDraft.typed(["[Image #1]", "[File #2]"], after: "看"), " [Image #1] [File #2] ")
        XCTAssertEqual(TerminalDraft.typed(["[File #2]"], after: " "), "[File #2] ")
        XCTAssertEqual(TerminalDraft.typed([], after: "x"), "")
        XCTAssertEqual(TerminalDraft.remove("[Image #1]", from: "看 [Image #1] 和 [Image #11]"), "看 和 [Image #11]")
        XCTAssertEqual(TerminalDraft.remove("[File #2]", from: "[File #2]"), "")

        struct Body: Encodable { let attachments: [TerminalReplyFile] }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let wire = String(decoding: try encoder.encode(Body(attachments: [TerminalReplyFile(token: "[Image #1]", path: "/Users/u/a b.png"), TerminalReplyFile(token: "[Image #2]", upload: "u_9")])), as: UTF8.self)
        // One of the two each, never a null for the other: the service takes exactly one.
        XCTAssertEqual(wire, #"{"attachments":[{"path":"/Users/u/a b.png","token":"[Image #1]"},{"token":"[Image #2]","upload":"u_9"}]}"#)
    }

    func testChangesDecode() throws {
        struct Reply: Decodable { let files: [FileDiff] }
        let list = try JSONDecoder().decode(Reply.self, from: Data(#"""
        {"files":[{"path":"src/retry.ts","added":1,"removed":1,"hunks":[{"header":"@@ -3,1 +3,1 @@","lines":["-const RETRIES = 5;","+const RETRIES = 3;"]}]},
                  {"path":"big.txt","added":420,"removed":0,"hunks":[{"header":"","lines":["+l0"]}],"clipped":true}]}
        """#.utf8))
        XCTAssertEqual(list.files.map(\.path), ["src/retry.ts", "big.txt"])
        XCTAssertTrue(list.files[1].clipped)
    }
}

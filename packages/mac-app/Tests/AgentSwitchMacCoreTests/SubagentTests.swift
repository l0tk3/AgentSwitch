import XCTest
@testable import AgentSwitchMacCore

/// A session's sub-agents on the Mac (docs/simple-view-v0.md §5.22, 2026-11-10): what the service sends decoded, what
/// the card says of a sub-agent and when, how its runs of work fold, and the routes it reads by.
final class SubagentTests: XCTestCase {
    private let session = #"{"harness":"claude-code","id":"c1","cwd":"/Users/u/code/site","title":"查登录为什么慢","lastText":"","updatedAt":1794250000000,"startedAt":1794249000000,"active":true}"#

    func testDecodesTheListAndARecordAsTheServiceSendsThem() throws {
        struct List: Decodable { let subagents: [SubagentSummary] }
        let list = try JSONDecoder().decode(List.self, from: Data(#"""
        {"subagents":[
          {"id":"a1","type":"Explore","name":"查登录慢","startedAt":1794249001000.4,"updatedAt":1794249059000,"done":true},
          {"id":"a2"}]}
        """#.utf8))
        XCTAssertEqual(list.subagents[0], SubagentSummary(id: "a1", type: "Explore", name: "查登录慢", startedAt: 1_794_249_001_000, updatedAt: 1_794_249_059_000, done: true))
        // One the agent wrote nothing beside: by its id alone, still at work as far as anything says.
        XCTAssertEqual(list.subagents[1], SubagentSummary(id: "a2"))

        let record = try JSONDecoder().decode(SubagentRecord.self, from: Data(#"""
        {"session":\#(session),"agent":{"id":"a1","type":"Explore","name":"查登录慢","startedAt":1794249001000,"updatedAt":1794249059000,"done":true},
         "items":[
          {"type":"user","id":"0","ts":1794249001000,"text":"<task>查登录接口为什么慢</task>"},
          {"type":"work","id":"812","ts":1794249003000,"secs":37,"steps":[
            {"kind":"search","text":"login"},
            {"kind":"run","text":"time curl -s localhost:8080/login","note":"Time the login","out":"real 0m2.31s"},
            {"kind":"agent","text":"读日志","agent":"a9"},
            {"kind":"agent","text":"还没有结果的"},
            {"kind":"agent","text":"空的","agent":""}]},
          {"type":"hologram","id":"900","ts":1},
          {"type":"answer","id":"4100","ts":1794249058000,"text":"登录慢在密码哈希。"}],
         "more":true,"cursor":812,"rev":"k2f-mw9abc-done","plan":[],"usage":{"model":"claude-haiku-5-5","used":52000},"mode":null}
        """#.utf8))
        XCTAssertEqual(record.agent.id, "a1")
        XCTAssertTrue(record.agent.done)
        // An item of a kind a newer service added is left out, as in a session's record.
        XCTAssertEqual(record.items.map(\.kind), [.user, .work, .answer])
        // The step that sent a sub-agent names it; one with no result yet, and an empty name, name none.
        XCTAssertEqual(record.items[1].steps.map(\.agent), [nil, nil, "a9", nil, nil])
        XCTAssertTrue(record.more)
        XCTAssertEqual(record.cursor, 812)
        XCTAssertEqual(record.rev, "k2f-mw9abc-done")
        XCTAssertEqual(record.usage, RecordUsage(model: "claude-haiku-5-5", used: 52_000))
        // Without what the list says of it, it is not a sub-agent's record.
        XCTAssertThrowsError(try JSONDecoder().decode(SubagentRecord.self, from: Data(#"{"session":\#(session),"items":[]}"#.utf8)))
    }

    func testASessionsOwnRecordKeepsTheSubagentItsStepSent() throws {
        let record = try JSONDecoder().decode(SessionRecord.self, from: Data(#"""
        {"session":\#(session),"items":[{"type":"work","id":"5","ts":1,"secs":2,"steps":[{"kind":"agent","text":"看连接池","agent":"a2"},{"kind":"read","text":"a.ts"}]}],"rev":"r"}
        """#.utf8))
        XCTAssertEqual(record.items[0].steps.map(\.agent), ["a2", nil])
        XCTAssertEqual(RecordStep(kind: .agent, text: "x", agent: "a7").agent, "a7")
        XCTAssertNil(RecordStep(kind: .agent, text: "x").agent)
    }

    func testOnlyAnAgentThatKeepsWhatItsSubagentsDidHasCards() {
        XCTAssertTrue(SubagentDisplay.hasRecords("claude-code"))
        for other in ["codex", "opencode", "pi", "", "shell"] { XCTAssertFalse(SubagentDisplay.hasRecords(other), other) }
    }

    func testHowASubagentStands() {
        let now = Date(timeIntervalSince1970: 1_794_250_000)
        let ago = { (seconds: Double) in Int64((now.timeIntervalSince1970 - seconds) * 1000) }
        // Ended, as the agent marks it — whatever else is said.
        XCTAssertEqual(SubagentDisplay.state(done: true, live: true, terminalRuns: true, updatedAt: ago(1), now: now), .done)
        XCTAssertEqual(SubagentDisplay.state(done: true, live: false, terminalRuns: false, updatedAt: ago(9000), now: now), .done)
        // At work: its terminal lists it, however long it has written nothing (one long step).
        XCTAssertEqual(SubagentDisplay.state(done: false, live: true, terminalRuns: true, updatedAt: ago(900), now: now), .working)
        // Not listed (its terminal forgot it when the turn that sent it ended): at work while it wrote a moment ago…
        XCTAssertEqual(SubagentDisplay.state(done: false, live: false, terminalRuns: true, updatedAt: ago(5), now: now), .working)
        XCTAssertEqual(SubagentDisplay.state(done: false, live: false, terminalRuns: true, updatedAt: ago(SubagentDisplay.fresh - 1), now: now), .working)
        // …and nothing is said of it once it has not for a while: it may have stopped short.
        XCTAssertEqual(SubagentDisplay.state(done: false, live: false, terminalRuns: true, updatedAt: ago(SubagentDisplay.fresh + 1), now: now), .quiet)
        // Before its record is read there is nothing to doubt yet.
        XCTAssertEqual(SubagentDisplay.state(done: false, live: false, terminalRuns: true, updatedAt: nil, now: now), .working)
        XCTAssertEqual(SubagentDisplay.state(done: false, live: false, terminalRuns: true, updatedAt: 0, now: now), .working)
        // Its terminal's program is gone: nothing of it works, whatever the list last said.
        XCTAssertEqual(SubagentDisplay.state(done: false, live: true, terminalRuns: false, updatedAt: ago(1), now: now), .quiet)
    }

    func testTheCardsTitleItsKindAndHowLongItTook() {
        XCTAssertEqual(SubagentDisplay.title(name: "找登录入口", type: "Explore"), "找登录入口")
        XCTAssertEqual(SubagentDisplay.kind(name: "找登录入口", type: "Explore"), "Explore")
        // One its terminal took in by its kind is named by it: the kind is not said twice.
        XCTAssertEqual(SubagentDisplay.title(name: "general-purpose", type: "general-purpose"), "general-purpose")
        XCTAssertNil(SubagentDisplay.kind(name: "general-purpose", type: "general-purpose"))
        XCTAssertEqual(SubagentDisplay.title(name: "  ", type: "Explore"), "Explore")
        XCTAssertNil(SubagentDisplay.kind(name: "", type: "Explore"))
        XCTAssertEqual(SubagentDisplay.title(name: "", type: ""), "Sub-Agent")
        XCTAssertNil(SubagentDisplay.kind(name: "", type: ""))
        XCTAssertEqual(SubagentDisplay.kind(name: "查一下", type: ""), nil)

        XCTAssertEqual(SubagentDisplay.seconds(startedAt: 1_000_000, updatedAt: 1_125_400), 125)
        XCTAssertNil(SubagentDisplay.seconds(startedAt: 0, updatedAt: 1_125_400))
        XCTAssertNil(SubagentDisplay.seconds(startedAt: 2_000_000, updatedAt: 1_000_000))
        XCTAssertEqual(SubagentDisplay.doneWords(SubagentSummary(id: "a", startedAt: 1_000_000, updatedAt: 1_125_400, done: true)), "Done · 2m 05s")
        XCTAssertEqual(SubagentDisplay.doneWords(SubagentSummary(id: "a", done: true)), "Done")
        XCTAssertEqual(SubagentDisplay.doneWords(nil), "Done")
    }

    func testTheSessionsSubagentsToChooseBetween() {
        let kept = [SubagentSummary(id: "a1", type: "Explore", name: "查登录慢", startedAt: 1, updatedAt: 5, done: true),
                    SubagentSummary(id: "a2", type: "general-purpose", name: "看连接池", startedAt: 2, updatedAt: 9),
                    SubagentSummary(id: "a3", startedAt: 3, updatedAt: 9)]
        let live = [TerminalSubagent(id: "a2", type: "general-purpose", name: "看连接池", doing: "读 pool.ts"),
                    TerminalSubagent(id: "a3", type: "Explore", name: "读日志"),
                    // Just sent off: the service has no file of it yet.
                    TerminalSubagent(id: "a4", type: "general-purpose", name: "general-purpose")]
        let all = SubagentDisplay.choices(kept: kept, live: live)
        XCTAssertEqual(all.map(\.id), ["a1", "a2", "a3", "a4"])
        XCTAssertEqual(all.map(\.words), ["查登录慢 · Explore", "看连接池 · general-purpose · Working", "读日志 · Explore · Working", "general-purpose · Working"])
        XCTAssertEqual(all.map(\.done), [true, false, false, false])
        // Named as its terminal names it where the service gives it no name: the card opens under that.
        XCTAssertEqual(all[2].name, "读日志")
        XCTAssertEqual(all[2].type, "Explore")
        // One the agent marks ended is not at work, whatever its terminal still lists.
        let stale = SubagentDisplay.choices(kept: [kept[0]], live: [TerminalSubagent(id: "a1", type: "Explore", name: "查登录慢")])
        XCTAssertEqual(stale.map(\.working), [false])
        // The latest so many of a session that sent a great many.
        let many = (0..<40).map { SubagentSummary(id: "s\($0)", startedAt: Int64($0)) }
        XCTAssertEqual(SubagentDisplay.choices(kept: many, live: []).count, SubagentDisplay.choicesShown)
        XCTAssertEqual(SubagentDisplay.choices(kept: many, live: []).last?.id, "s39")
        XCTAssertEqual(SubagentDisplay.choices(kept: [], live: []), [])
    }

    func testHowARunOfWorkFoldsInTheCard() {
        // The run still going shows its latest steps without being asked; the others their one line.
        XCTAssertEqual(SubagentDisplay.fold(chosen: nil, running: true), .tail)
        XCTAssertEqual(SubagentDisplay.fold(chosen: nil, running: false), .closed)
        // What the reader opened or closed themselves stands, still going or not.
        XCTAssertEqual(SubagentDisplay.fold(chosen: true, running: false), .open)
        XCTAssertEqual(SubagentDisplay.fold(chosen: true, running: true), .open)
        XCTAssertEqual(SubagentDisplay.fold(chosen: false, running: true), .closed)

        let steps = [RecordStep(kind: .think, text: "…"), RecordStep(kind: .read, text: "a.ts"), RecordStep(kind: .search, text: "login"), RecordStep(kind: .think, text: "…"),
                     RecordStep(kind: .run, text: "npm test"), RecordStep(kind: .web, text: "https://x"), RecordStep(kind: .edit, text: "a.ts"), RecordStep(kind: .run, text: "git diff")]
        let closed = SubagentDisplay.steps(steps, fold: .closed)
        XCTAssertTrue(closed.shown.isEmpty)
        XCTAssertEqual(closed.hidden, 6)
        // Each shown step keeps its place among all the run's steps (it is asked for whole by that place); what it
        // thought on the way is not listed.
        let open = SubagentDisplay.steps(steps, fold: .open)
        XCTAssertEqual(open.shown.map(\.index), [1, 2, 4, 5, 6, 7])
        XCTAssertEqual(open.hidden, 0)
        let tail = SubagentDisplay.steps(steps, fold: .tail)
        XCTAssertEqual(tail.shown.map(\.index), [4, 5, 6, 7])
        XCTAssertEqual(tail.shown.map(\.step.text), ["npm test", "https://x", "a.ts", "git diff"])
        XCTAssertEqual(tail.hidden, 2)
        // A run of few steps shows them all, with none said to be hidden.
        let few = SubagentDisplay.steps(Array(steps.prefix(3)), fold: .tail)
        XCTAssertEqual(few.shown.map(\.index), [1, 2])
        XCTAssertEqual(few.hidden, 0)
        XCTAssertTrue(SubagentDisplay.steps([], fold: .tail).shown.isEmpty)

        // Its one line may take two in the small view: it breaks between its parts, never inside one.
        XCTAssertEqual(SubagentDisplay.summaryLine("Working 1m 12s · Read 3 · Agent 1"), "Working\u{a0}1m\u{a0}12s · Read\u{a0}3 · Agent\u{a0}1")
        XCTAssertEqual(SubagentDisplay.summaryLine("Worked"), "Worked")
    }

    func testTheCardIsASmallViewUntilAskedToBeTallAndNeverLargerThanItsPane() {
        let small = SubagentDisplay.size(pane: (1200, 800), tall: false)
        XCTAssertEqual(small.width, SubagentDisplay.width)
        XCTAssertEqual(small.height, SubagentDisplay.height)
        let tall = SubagentDisplay.size(pane: (1200, 800), tall: true)
        XCTAssertEqual(tall.width, SubagentDisplay.width)
        XCTAssertEqual(tall.height, 800 - 2 * SubagentDisplay.margin)
        // A narrow, low pane: what the pane leaves.
        let tight = SubagentDisplay.size(pane: (420, 300), tall: false)
        XCTAssertEqual(tight.width, 420 - 2 * SubagentDisplay.margin)
        XCTAssertEqual(tight.height, 300 - 2 * SubagentDisplay.margin)
        let none = SubagentDisplay.size(pane: (10, 10), tall: true)
        XCTAssertEqual(none.width, 0)
        XCTAssertEqual(none.height, 0)
    }

    func testALongTaskAndALongAnswerShowTheirStartFirst() {
        XCTAssertNil(SubagentDisplay.taskPreview("查登录接口为什么慢"))
        let task = String(repeating: "看一下这个接口。\n", count: 120)
        XCTAssertNotNil(SubagentDisplay.taskPreview(task))
        XCTAssertLessThanOrEqual(SubagentDisplay.taskPreview(task)!.count, 300)
        XCTAssertNil(SubagentDisplay.answerPreview(String(repeating: "好。", count: 400)))
        XCTAssertLessThanOrEqual(SubagentDisplay.answerPreview(String(repeating: "一句话。\n\n", count: 600))!.count, 1200)
    }

    func testTheRoutesItReadsBy() async throws {
        let agent = #"{"id":"a 1","type":"Explore","name":"查","startedAt":1,"updatedAt":2,"done":false}"#
        let session = session
        let transport = HeaderTransport { request in
            let path = request.url?.path ?? "", query = request.url?.query ?? ""
            if path.hasSuffix("/subagents") { return (200, #"{"subagents":[{"id":"a1","type":"Explore"},{"type":"no id"},{"id":"a2"}]}"#, [:]) }
            if path.hasSuffix("/record") {
                // Asked with the version it has: nothing sent.
                if request.value(forHTTPHeaderField: "If-None-Match") == "\"v1\"" { return (304, "", ["ETag": "\"v1\""]) }
                return (200, #"{"session":\#(session),"agent":\#(agent),"items":[{"type":"user","id":"0","ts":1,"text":"查"}],"rev":"v1","more":\#(query.contains("before=") ? "false" : "true"),"cursor":40}"#,
                        query.contains("before=") ? [:] : ["ETag": "\"v1\""])
            }
            if path.hasSuffix("/steps/812/3") { return (200, #"{"kind":"run","text":"npm test","out":"ok"}"#, [:]) }
            if path.hasSuffix("/images/0") { return (200, "png", [:]) }
            return (404, #"{"error":"no such step"}"#, [:])
        }
        let client = DaemonClient(port: 4811, transport: transport)
        let target = SubagentTarget(harness: "claude-code", session: "c 1", agent: "a 1")

        // An entry that is not a sub-agent is left out, not fatal.
        let list = try await client.sessionSubagents(harness: "claude-code", id: "c 1")
        XCTAssertEqual(list.map(\.id), ["a1", "a2"])

        let first = try await client.subagentRecord(target)
        XCTAssertEqual(first?.value.items.map(\.text), ["查"])
        XCTAssertEqual(first?.version, "\"v1\"")
        let same = try await client.subagentRecord(target, unless: first?.version)
        XCTAssertNil(same)
        // An earlier page is asked for whole, whatever version is held: it is another stretch of the record.
        let page = try await client.subagentRecord(target, limit: 80, before: 40, unless: "\"v1\"")
        XCTAssertEqual(page?.value.more, false)
        XCTAssertNil(page?.version)

        let step = await client.subagentStep(target, work: "812", n: 3)
        XCTAssertEqual(step, RecordStepDetail(text: "npm test", out: "ok"))
        let none = await client.subagentStep(target, work: "812", n: 9)
        XCTAssertNil(none)
        let picture = try await client.subagentStepImage(target, work: "812", n: 3, k: 0)
        XCTAssertEqual(picture, Data("png".utf8))

        // Each part of the path is its own segment, whatever is in an id.
        let asked = transport.requests.map { $0.url?.absoluteString.replacingOccurrences(of: "http://127.0.0.1:4811", with: "") ?? "" }
        XCTAssertEqual(asked, [
            "/sessions/claude-code/c%201/subagents",
            "/sessions/claude-code/c%201/subagents/a%201/record?limit=60",
            "/sessions/claude-code/c%201/subagents/a%201/record?limit=60",
            "/sessions/claude-code/c%201/subagents/a%201/record?limit=80&before=40",
            "/sessions/claude-code/c%201/subagents/a%201/steps/812/3",
            "/sessions/claude-code/c%201/subagents/a%201/steps/812/9",
            "/sessions/claude-code/c%201/subagents/a%201/steps/812/3/images/0",
        ])
        XCTAssertEqual(transport.requests.map { $0.value(forHTTPHeaderField: "If-None-Match") }, [nil, nil, "\"v1\"", nil, nil, nil, nil])
    }

    func testAnOlderServiceHasNoSuchRoutes() async {
        // A 404 that is not the service's own JSON: the route is not there.
        let old = DaemonClient(port: 4811, transport: StubTransport { _ in (404, "404 Not Found") })
        let target = SubagentTarget(harness: "claude-code", session: "c1", agent: "a1")
        do {
            _ = try await old.subagentRecord(target)
            XCTFail("an older service has no record to give")
        } catch let error as DaemonError {
            guard case .notSupported = error else { return XCTFail("\(error)") }
        } catch { XCTFail("\(error)") }
        // Its list likewise: said as such, not as a session that sent none.
        do {
            _ = try await old.sessionSubagents(harness: "claude-code", id: "c1")
            XCTFail("an older service has no list to give")
        } catch let error as DaemonError {
            guard case .notSupported = error else { return XCTFail("\(error)") }
        } catch { XCTFail("\(error)") }
        // The service's own 404: no such sub-agent (not yet, or never).
        let gone = DaemonClient(port: 4811, transport: StubTransport { _ in (404, #"{"error":"no such sub-agent"}"#) })
        do {
            _ = try await gone.subagentRecord(target)
            XCTFail("no such sub-agent")
        } catch let error as DaemonError {
            XCTAssertEqual(error, .http(status: 404, message: "no such sub-agent"))
        } catch { XCTFail("\(error)") }
    }
}

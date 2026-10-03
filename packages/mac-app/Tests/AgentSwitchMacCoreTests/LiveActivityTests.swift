import XCTest
@testable import AgentSwitchMacCore

/// The menu bar's Live Activity (assistant-v0 §4): `GET /live` decoded, and when the card opens and closes by itself.
final class LiveActivityTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_790_000_000)

    private func row(_ id: String, waiting: Bool = false, ask: LiveSnapshot.Ask? = nil, kind: LiveSnapshot.Kind = .task, at: TimeInterval = 0) -> LiveSnapshot.Row {
        LiveSnapshot.Row(id: id, kind: kind, title: id, step: "", startedAt: t0.addingTimeInterval(at), needsYou: waiting, ask: ask)
    }

    private func snap(_ rows: [LiveSnapshot.Row], ended: [LiveSnapshot.End] = [], at: TimeInterval) -> LiveSnapshot {
        LiveSnapshot(rows: rows, ended: ended, now: t0.addingTimeInterval(at))
    }

    private func end(_ id: String, ok: Bool = true, at: TimeInterval) -> LiveSnapshot.End {
        LiveSnapshot.End(taskId: id, title: id, line: "done", ok: ok, at: t0.addingTimeInterval(at))
    }

    private let perm = LiveSnapshot.Ask.decide(id: "p1", tool: "Bash", target: "npm test", place: "~/Projects/web")

    func testDecodesTheDaemonsAnswer() throws {
        let json = """
        {"rows":[
          {"id":"k1","kind":"terminal","title":"fix-login","step":"Bash: npm test","model":"Claude Code","agent":"claude-code","startedAt":1790000002000,"needsYou":true,
           "ask":{"kind":"permission","id":"p1","tool":"Bash","target":"npm test","where":"~/Projects/web"}},
          {"id":"t2","kind":"task","title":"清理旧构建","step":"要删掉吗？","model":null,"agent":null,"startedAt":1790000000000,"needsYou":true,
           "ask":{"kind":"question","id":"a2","questionId":"q0","text":"要删掉吗？","options":["删掉","保留"],"answerable":true}},
          {"id":"t3","kind":"task","title":"整理下载目录","step":"交给 DeepSeek Flash","model":"DeepSeek Flash","agent":null,"startedAt":1789999990000,"needsYou":false,"ask":null}],
         "running":1,"waiting":2,"ended":[{"kind":"task","id":"t9","taskId":"t9","title":"总结","line":"好了","ok":true,"at":1789999999000},
           {"kind":"terminal","id":"k1","title":"fix-login","line":"rate_limit: You have hit your limit","ok":false,"at":1789999998000}],"now":1790000010000}
        """
        let s = try JSONDecoder().decode(LiveSnapshot.self, from: Data(json.utf8))
        XCTAssertEqual(s.rows.map(\.id), ["k1", "t2", "t3"])
        XCTAssertEqual(s.rows[0].ask, perm)
        XCTAssertEqual(s.rows[0].kind, .terminal)
        XCTAssertEqual(s.rows[0].startedAt, t0.addingTimeInterval(2))
        XCTAssertEqual(s.rows[1].ask, .question(id: "a2", questionId: "q0", text: "要删掉吗？", options: ["删掉", "保留"], answerable: true))
        XCTAssertNil(s.rows[2].ask)
        XCTAssertEqual(s.ended, [LiveSnapshot.End(taskId: "t9", title: "总结", line: "好了", ok: true, at: t0.addingTimeInterval(-1)),
                                 LiveSnapshot.End(kind: .terminal, id: "k1", title: "fix-login", line: "rate_limit: You have hit your limit", ok: false, at: t0.addingTimeInterval(-2))])
        XCTAssertEqual(s.now, t0.addingTimeInterval(10))
        XCTAssertEqual([s.running, s.waiting], [1, 2])
    }

    func testWhatWaitsWhenTheAppStartsIsKnownAlready() {
        var p = LivePresenter()
        XCTAssertNil(p.receive(snap([row("k1", waiting: true, ask: perm)], ended: [end("t9", at: 0)], at: 1), at: t0))
        XCTAssertFalse(p.isOpen)
        XCTAssertTrue(p.visible)
        XCTAssertEqual(p.look, .waiting)
        XCTAssertEqual(p.trail, .clock(since: t0, waiting: true))
    }

    func testANewRequestOpensTheCardAndSoundsItClosesOnceAnswered() {
        var p = LivePresenter()
        p.receive(snap([row("t1")], at: 0), at: t0)
        XCTAssertFalse(p.isOpen)
        XCTAssertEqual(p.look, .busy)
        XCTAssertEqual(p.receive(snap([row("k1", waiting: true, ask: perm, at: 5), row("t1")], at: 5), at: t0), .needsYou)
        XCTAssertEqual(p.opener, .request)
        XCTAssertEqual(p.trail, .tally(waiting: 1, running: 1))
        XCTAssertNil(p.receive(snap([row("k1", waiting: true, ask: perm, at: 5), row("t1")], at: 6), at: t0), "the same request: no second sound")
        p.receive(snap([row("t1")], at: 7), at: t0)
        XCTAssertFalse(p.isOpen, "answered: the card it opened closes")
    }

    func testACardTheUserOpenedStaysOpenAndAClosedRequestDoesNotReopen() {
        var p = LivePresenter()
        p.receive(snap([row("t1")], at: 0), at: t0)
        p.toggle()
        XCTAssertEqual(p.opener, .user)
        p.receive(snap([row("k1", waiting: true, ask: perm), row("t1")], at: 1), at: t0)
        XCTAssertEqual(p.opener, .user)
        p.receive(snap([row("t1")], at: 2), at: t0)
        XCTAssertEqual(p.opener, .user)
        p.receive(snap([row("k1", waiting: true, ask: perm), row("t1")], at: 3), at: t0)
        p.toggle()
        XCTAssertFalse(p.isOpen)
        p.receive(snap([row("k1", waiting: true, ask: perm), row("t1")], at: 4), at: t0)
        XCTAssertFalse(p.isOpen, "closed with the request still open: it stays closed, the capsule stays amber")
        XCTAssertEqual(p.look, .waiting)
    }

    func testAResultShowsForAFewSecondsWithItsToneThenTheCapsuleKeepsItsColourForTheMinute() {
        var p = LivePresenter()
        p.receive(snap([row("t1")], at: 0), at: t0)
        XCTAssertEqual(p.receive(snap([], ended: [end("t1", at: 9)], at: 10), at: t0), .done)
        XCTAssertEqual(p.opener, .result)
        XCTAssertEqual(p.shownEnd?.id, "t1")
        XCTAssertEqual(p.look, .done)
        p.tick(t0.addingTimeInterval(LivePresenter.resultShown))
        XCTAssertFalse(p.isOpen)
        XCTAssertEqual(p.look, .done, "nothing runs: the last end colours the capsule for the rest of the minute")
        p.receive(snap([], at: 80), at: t0.addingTimeInterval(70))
        XCTAssertFalse(p.visible)
    }

    // 2026-09-30, user: 遇到报错、任务完成之类的也要提示；不然报错静默消失都不知道.
    func testAFailureStaysUntilItIsLookedAt() {
        var p = LivePresenter()
        p.receive(snap([row("t1"), row("t2")], at: 0), at: t0)
        XCTAssertEqual(p.receive(snap([row("t2")], ended: [end("t1", ok: false, at: 9)], at: 10), at: t0), .failed)
        XCTAssertEqual(p.trail, .result(ok: false))
        p.tick(t0.addingTimeInterval(LivePresenter.resultShown))
        XCTAssertFalse(p.isOpen)
        XCTAssertEqual(p.look, .incomplete, "still red while t2 runs")
        p.close()   // a click in another app closed nothing it had not opened
        p.receive(snap([], at: 200), at: t0.addingTimeInterval(200))
        XCTAssertTrue(p.visible, "past the minute's window: still there")
        XCTAssertEqual(p.cardEnds.map(\.id), ["t1"])
        p.toggle()
        XCTAssertEqual(p.opener, .user)
        p.toggle()
        XCTAssertFalse(p.visible, "looked at: gone")
    }

    func testFailuresListTheNewestFirstAndARequestComesFirst() {
        var p = LivePresenter()
        p.receive(snap([row("t1"), row("t2"), row("t3")], at: 0), at: t0)
        p.receive(snap([row("t3")], ended: [end("t2", ok: false, at: 9), end("t1", ok: false, at: 8)], at: 10), at: t0)
        p.tick(t0.addingTimeInterval(20))
        XCTAssertEqual(p.cardEnds.map(\.id), ["t2", "t1"])
        p.receive(snap([row("k1", waiting: true, ask: perm), row("t3")], ended: [end("t2", ok: false, at: 9), end("t1", ok: false, at: 8)], at: 30), at: t0)
        XCTAssertNil(p.shownEnd, "a request is never covered")
        XCTAssertEqual(p.look, .waiting)
        p.opened(LiveSnapshot.End(taskId: "t2", title: "", line: "", ok: false, at: t0))
        XCTAssertEqual(p.unseenFailures.map(\.id), ["t1"])
    }

    func testTheTerminalOnScreenSaysNothingOfItsOwnTurns() {
        var p = LivePresenter()
        p.receive(snap([row("k1", kind: .terminal)], at: 0), at: t0)
        let failed = LiveSnapshot.End(kind: .terminal, id: "k1", title: "fix", line: "rate_limit", ok: false, at: t0.addingTimeInterval(9))
        XCTAssertNil(p.receive(snap([], ended: [failed], at: 10), at: t0, watching: "k1"))
        XCTAssertFalse(p.isOpen)
        XCTAssertTrue(p.unseenFailures.isEmpty)
        let again = LiveSnapshot.End(kind: .terminal, id: "k1", title: "fix", line: "rate_limit", ok: false, at: t0.addingTimeInterval(19))
        XCTAssertEqual(p.receive(snap([], ended: [again, failed], at: 20), at: t0, watching: nil), .failed, "another turn, not looked at")
        p.receive(snap([], ended: [again, failed], at: 21), at: t0, watching: "k1")
        XCTAssertTrue(p.unseenFailures.isEmpty, "opened in the window: seen")
    }

    /// The main window open on a task's page (dispatch-v0 §1): its result drops no card and rings nothing, its failure
    /// is seen; another task's still does.
    func testTheTaskOnScreenSaysNothingOfItsOwnResult() {
        var p = LivePresenter()
        p.receive(snap([row("t1"), row("t2")], at: 0), at: t0)
        let failed = end("t1", ok: false, at: 9)
        XCTAssertNil(p.receive(snap([row("t2")], ended: [failed], at: 10), at: t0, watchingTask: "t1"))
        XCTAssertFalse(p.isOpen)
        XCTAssertTrue(p.unseenFailures.isEmpty)
        XCTAssertEqual(p.receive(snap([], ended: [end("t2", at: 19), failed], at: 20), at: t0, watchingTask: "t1"), .done, "another task")
        XCTAssertEqual(p.opener, .result)
        let terminal = LiveSnapshot.End(kind: .terminal, id: "t3", title: "t3", line: "", ok: false, at: t0.addingTimeInterval(29))
        XCTAssertEqual(p.receive(snap([], ended: [terminal], at: 30), at: t0, watchingTask: "t3"), .failed, "a terminal of the same id is not the task")
    }

    func testAResultNeverCoversARequest() {
        var p = LivePresenter()
        p.receive(snap([row("t1"), row("t2")], at: 0), at: t0)
        p.receive(snap([row("k1", waiting: true, ask: perm), row("t2")], ended: [end("t1", at: 4)], at: 5), at: t0)
        XCTAssertEqual(p.opener, .request)
        XCTAssertNil(p.shownEnd)
        XCTAssertEqual(p.look, .waiting)
    }

    func testAnEndWhileOthersRunShowsThenTheCapsuleGoesBackToWork() {
        var p = LivePresenter()
        p.receive(snap([row("t1"), row("t2")], at: 0), at: t0)
        p.receive(snap([row("t2")], ended: [end("t1", at: 4)], at: 5), at: t0)
        XCTAssertEqual(p.look, .done)
        p.tick(t0.addingTimeInterval(5))
        XCTAssertEqual(p.look, .busy)
        XCTAssertEqual(p.trail, .clock(since: t0, waiting: false))
    }

    func testAnOldEndSeenLateDoesNotOpenTheCard() {
        var p = LivePresenter()
        p.receive(snap([], at: 0), at: t0)
        p.receive(snap([], ended: [end("t1", at: 0)], at: 30), at: t0)
        XCTAssertFalse(p.isOpen)
        XCTAssertEqual(p.look, .done)
    }

    func testTheServiceGoneHidesEverything() {
        var p = LivePresenter()
        p.receive(snap([row("t1")], at: 0), at: t0)
        p.toggle()
        p.receive(nil, at: t0)
        XCTAssertFalse(p.visible)
        XCTAssertFalse(p.isOpen)
    }

    func testTheCardShowsThreeRowsAndCountsTheRest() {
        var p = LivePresenter()
        p.receive(snap((1...5).map { row("t\($0)") }, at: 0), at: t0)
        XCTAssertEqual(p.cardRows.map(\.id), ["t1", "t2", "t3"])
        XCTAssertEqual(p.moreRows, 2)
    }

    func testAnswersGoToTheRightRoutes() async throws {
        let stub = StubTransport { _ in (200, #"{"ok":true}"#) }
        let client = DaemonClient(port: 4811, transport: stub)
        try await client.decide(row("k 1", waiting: true, ask: perm, kind: .terminal), allow: true)
        try await client.decide(row("t1", waiting: true, ask: .decide(id: "a1", tool: "Bash", target: "rm", place: "~")), allow: false)
        try await client.answer(row("t2", waiting: true, ask: .question(id: "a2", questionId: "q0", text: "?", options: ["删掉"], answerable: true)), option: "删掉")
        try await client.answer(row("t3", waiting: true, ask: .question(id: "a3", questionId: "q0", text: "?", options: [], answerable: false)), option: "x")
        let sent = stub.requests.map { "\($0.httpMethod ?? "") \($0.url?.path(percentEncoded: true) ?? "") \(String(decoding: $0.httpBody ?? Data(), as: UTF8.self))" }
        XCTAssertEqual(sent.count, 3, "a question that is not answerable on the card sends nothing")
        XCTAssertEqual(sent[0], #"POST /terminals/k%201/permissions/p1 {"decision":"allow"}"#)
        XCTAssertTrue(sent[1].hasPrefix("POST /tasks/t1/approve "))
        XCTAssertTrue(sent[1].contains(#""approval_id":"a1""#) && sent[1].contains(#""decision":"deny""#))
        XCTAssertTrue(sent[2].hasPrefix("POST /tasks/t2/answer "))
        XCTAssertTrue(sent[2].contains(#""answers":{"q0":["删掉"]}"#) || sent[2].contains(#""answers":{"q0":["删掉"]}"#))
    }
}

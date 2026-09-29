import AgentSwitchLive
import XCTest
@testable import AgentSwitchKit

/// terminal-v0 §1's reminders: a terminal that newly waits for you gets the "needs you" cue once (the first look only
/// sets the baseline), and the terminals waiting are rows of the Live Activity beside the tasks.
final class TerminalAttentionTests: XCTestCase {
    private func terminal(_ id: String, _ status: TerminalStatus = .working, asks: [String] = [], name: String = "修复登录",
                          harness: String = "claude-code", at: Int64 = 1_700_000_000_000) -> TerminalInfo {
        TerminalInfo(id: id, harness: harness, cwd: "/Users/me/p", name: name, status: status, createdAt: 1, lastOutputAt: 1_600_000_000_000,
                     permissions: asks.map { TerminalPermission(id: $0, tool: "Bash", summary: "Bash: npm test", at: at) })
    }

    func testWaitingIsAPermissionOrTheWaitingStateButNeverOnceExited() {
        XCTAssertFalse(terminal("a").waitsForYou)
        XCTAssertFalse(terminal("a", .idle).waitsForYou)
        XCTAssertTrue(terminal("a", .waiting).waitsForYou)
        XCTAssertTrue(terminal("a", .working, asks: ["p1"]).waitsForYou)
        XCTAssertFalse(terminal("a", .exited, asks: ["p1"]).waitsForYou)
    }

    func testNewlyWaitingOnlyOnceAfterTheBaseline() {
        var tracker = TerminalCueTracker()
        XCTAssertEqual(tracker.newlyWaiting([terminal("a", .waiting, asks: ["p1"]), terminal("b")]).map(\.id), [],
                       "already waiting when the phone first looks is not news")
        XCTAssertEqual(tracker.newlyWaiting([terminal("a", .waiting, asks: ["p1"]), terminal("b")]).map(\.id), [])
        XCTAssertEqual(tracker.newlyWaiting([terminal("a", .waiting, asks: ["p1", "p2"]), terminal("b")]).map(\.id), ["a"],
                       "a second request while it still waits")
        XCTAssertEqual(tracker.newlyWaiting([terminal("a"), terminal("b", .waiting)]).map(\.id), ["b"],
                       "turned to waiting without a request (a prompt on its screen)")
        XCTAssertEqual(tracker.newlyWaiting([terminal("a"), terminal("b", .waiting)]).map(\.id), [])
        XCTAssertEqual(tracker.newlyWaiting([terminal("a", asks: ["p1"]), terminal("b", .waiting)]).map(\.id), ["a"],
                       "waiting again after it was answered, even with an id seen before")
        XCTAssertEqual(tracker.newlyWaiting([terminal("a", .exited, asks: ["p3"]), terminal("c", asks: ["p1"])]).map(\.id), ["c"],
                       "an ended one is not waiting; a request id is the terminal's own")
    }

    func testWhatVoiceModeSays() {
        XCTAssertEqual(terminal("a", asks: ["p1"]).spokenWait, "终端「修复登录」等你批准：Bash")
        XCTAssertEqual(terminal("a", .waiting, name: "").spokenWait, "终端「Claude Code」等你处理")
        XCTAssertEqual(terminal("a", .waiting, name: "", harness: "pi").spokenWait, "终端「pi」等你处理")
    }

    func testAWaitingTerminalIsARowAndStartsTheSummaryOnItsOwn() throws {
        XCTAssertNil(LiveSummary.state(tasks: [], approvals: [], threadTitles: [:], terminals: [terminal("b", .idle), terminal("c", .exited)]),
                     "an idle or ended terminal is not in it")
        let state = try XCTUnwrap(LiveSummary.state(tasks: [], approvals: [], threadTitles: [:], terminals: [terminal("a", asks: ["p1"])]))
        XCTAssertEqual(state.phase, .needsYou)
        XCTAssertEqual(state.waiting, 1)
        XCTAssertEqual(state.running, 0)
        XCTAssertFalse(state.hasTasks, "no conclusion to show once it is answered")
        let row = try XCTUnwrap(state.lead)
        XCTAssertEqual(row.kind, .terminal)
        XCTAssertEqual(row.title, "修复登录")
        XCTAssertEqual(row.step, "Bash: npm test")
        XCTAssertEqual(row.model, "Claude Code")
        XCTAssertEqual(row.startedAt, Date(timeIntervalSince1970: 1_700_000_000), "the clock counts from the request")
        XCTAssertEqual(row.link, LiveLink.terminal("a"))
        let screen = try XCTUnwrap(LiveSummary.state(tasks: [], approvals: [], threadTitles: [:], terminals: [terminal("a", .waiting)])?.lead)
        XCTAssertEqual(screen.step, "等你处理")
        XCTAssertEqual(screen.startedAt, Date(timeIntervalSince1970: 1_600_000_000), "no request: since its last output")
    }

    /// 2026-09-30, user: 实时活动应该包括终端里的活动，不只是路由器调度的.
    func testATerminalAtWorkIsARowInProgressSayingWhatItUses() throws {
        let busy = TerminalInfo(id: "k1", harness: "codex", cwd: "/p", name: "api-refactor", status: .working, createdAt: 1, lastOutputAt: 9,
                                activity: TerminalActivity(tool: "Bash", target: "/bin/zsh -lc 'npm test'"), statusSince: 1_700_000_000_000)
        let state = try XCTUnwrap(LiveSummary.state(tasks: [], approvals: [], threadTitles: [:], terminals: [busy, terminal("b", .idle)]))
        XCTAssertEqual(state.phase, .running)
        XCTAssertEqual(state.running, 1)
        XCTAssertEqual(state.waiting, 0)
        let row = try XCTUnwrap(state.lead)
        XCTAssertEqual(row.kind, .terminal)
        XCTAssertFalse(row.needsYou)
        XCTAssertEqual(row.title, "api-refactor")
        XCTAssertEqual(row.step, "运行 npm test")
        XCTAssertEqual(row.model, "Codex")
        XCTAssertEqual(row.startedAt, Date(timeIntervalSince1970: 1_700_000_000), "since this turn began")
        let quiet = try XCTUnwrap(LiveSummary.state(tasks: [], approvals: [], threadTitles: [:], terminals: [terminal("a")])?.lead)
        XCTAssertEqual(quiet.step, "进行中", "no tool reported yet")
    }

    func testTerminalsAndTasksWaitingComeFirstNewestFirst() throws {
        let running = try JSONDecoder().decode(AgentTask.self, from: JSONSerialization.data(withJSONObject: [
            "id": "t1", "createdAt": 1_800_000_000_000, "updatedAt": 1_800_000_000_000, "status": "running", "task": "整理下载目录"]))
        let state = try XCTUnwrap(LiveSummary.state(tasks: [running], approvals: [], threadTitles: [:],
                                                    terminals: [terminal("old", asks: ["p"], at: 1_000), terminal("new", asks: ["p"], at: 2_000)]))
        XCTAssertEqual(state.rows.map(\.id), ["new", "old", "t1"])
        XCTAssertEqual(state.waiting, 2)
        XCTAssertEqual(state.running, 1)
        XCTAssertTrue(state.hasTasks)
        XCTAssertEqual(state.rows.last?.link, LiveLink.task("t1"))
    }

    func testTerminalLinksGoBothWaysAndAreNotTaskLinks() throws {
        let url = LiveLink.terminal("a1b2c3d4")
        XCTAssertEqual(url.absoluteString, "agentswitch://terminal/a1b2c3d4")
        XCTAssertEqual(LiveLink.terminalId(from: url), "a1b2c3d4")
        XCTAssertNil(LiveLink.taskId(from: url))
        XCTAssertNil(LiveLink.terminalId(from: LiveLink.task("a1b2c3d4")))
        XCTAssertNil(LiveLink.terminalId(from: try XCTUnwrap(URL(string: "agentswitch://terminal/"))))
    }

    func testAStateSavedBeforeRowsHadAKindReadsAsTasks() throws {
        let old = #"{"rows":[{"id":"t1","title":"x","step":"y","startedAt":0,"needsYou":false}],"running":1,"waiting":0}"#
        let state = try JSONDecoder().decode(LiveState.self, from: Data(old.utf8))
        XCTAssertEqual(state.rows.first?.kind, .task)
        let again = try JSONDecoder().decode(LiveState.self, from: JSONEncoder().encode(
            LiveState(rows: [.init(id: "a", title: "x", step: "y", model: nil, startedAt: Date(), needsYou: true, kind: .terminal)], running: 0, waiting: 1)))
        XCTAssertEqual(again.rows.first?.kind, .terminal)
    }
}

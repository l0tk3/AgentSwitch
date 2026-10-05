import XCTest
@testable import AgentSwitchMacCore

/// The native Terminals page's rules (docs/terminal-v0.md §1 Mac, 2026-10-05): the list's rows, its words, its keys.
final class TerminalsPageRulesTests: XCTestCase {
    private func term(_ id: String, _ cwd: String, created: Int64, status: String = "idle", subagents: [TerminalSubagent] = []) -> TerminalInfo {
        TerminalInfo(id: id, harness: "claude-code", cwd: cwd, name: id, status: status, createdAt: created, subagents: subagents)
    }
    private func session(_ id: String, _ cwd: String, started: Int64) -> SessionSummary {
        SessionSummary(harness: "claude-code", id: id, cwd: cwd, title: id, updatedAt: started, startedAt: started)
    }
    /// The rows in a line each: what they are, their branch, their name.
    private func lines(_ rows: [TerminalListRow]) -> [String] {
        rows.map { row in
            switch row {
            case .folder(let f): "\(String(repeating: " ", count: f.depth))\(f.name)/ \(f.closed ? "closed" : "open")\(f.holds ? " holds" : "") live \(f.live)\(f.waiting ? "!" : "") sessions \(f.sessions)"
            case .terminal(let t, let twig, _, let index): "\(twig) \(t.id) #\(index.map { String($0 + 1) } ?? "-")"
            case .subagent(let a, _, let twig, _): "\(twig) sub \(a.name)"
            case .session(let s, let twig, _): "\(twig) \(s.sessionId)"
            case .more(_, let twig, _, let hidden, let all): "\(twig) \(all ? "less" : "\(hidden) more")"
            case .hit(_, let text, let twig, _, _): "\(twig) “\(text)”"
            case .found(let said): said
            case .note(let said): said
            }
        }
    }
    private var tree: (folders: [TerminalTree.Folder], terminals: [TerminalInfo]) {
        let terminals = [term("t2", "/Users/u/Work/api", created: 20, status: "waiting"),
                         term("t1", "/Users/u/Work/api", created: 10, subagents: [TerminalSubagent(id: "a", type: "Explore", name: "找入口"), TerminalSubagent(id: "b", type: "Explore", name: "看测试")])]
        let sessions = (1...5).map { session("s\($0)", "/Users/u/Work/api", started: Int64(100 - $0)) } + [session("w1", "/Users/u/Work/web", started: 5)]
        return (TerminalTree.build(terminals: terminals, sessions: sessions), terminals)
    }

    func testAFoldersTerminalsThenItsFirstSessionsThenTheRest() {
        let (folders, terminals) = tree
        let order = TerminalListRows.order(terminals)
        XCTAssertEqual(order, ["t1", "t2"], "as they were opened")
        XCTAssertEqual(lines(TerminalListRows.build(folders, order: order)), [
            "Work/ open live 2! sessions 6",
            " api/ open live 2! sessions 5",
            "├─ t1 #1", "│\u{a0}├─ sub 找入口", "│\u{a0}└─ sub 看测试", "├─ t2 #2", "├─ s1", "├─ s2", "├─ s3", "└─ 2 more",
            " web/ open live 0 sessions 1", "└─ w1",
        ])
        let all = lines(TerminalListRows.build(folders, expanded: ["/Users/u/Work/api"], order: order))
        XCTAssertEqual(Array(all[6...10]), ["├─ s1", "├─ s2", "├─ s3", "├─ s4", "├─ s5"])
        XCTAssertEqual(all[11], "└─ less")
    }

    func testAFoldedFolderShowsOnlyItsLineMarkedWhenItHoldsTheTerminalOnScreen() {
        let (folders, _) = tree
        let rows = TerminalListRows.build(folders, collapsed: ["/Users/u/Work/api"], current: "t2")
        XCTAssertEqual(lines(rows), ["Work/ open live 2! sessions 6", " api/ closed holds live 2! sessions 5", " web/ open live 0 sessions 1", "└─ w1"])
        XCTAssertEqual(lines(TerminalListRows.build(folders, collapsed: ["/Users/u/Work"], current: nil)), ["Work/ closed live 2! sessions 6"])
        XCTAssertEqual(TerminalListRows.build([]), [.note("暂无会话。")])
        XCTAssertEqual(Set(rows.map(\.id)).count, rows.count, "every row its own id")
    }

    // 2026-10-05: a Codex session id with three records drew two of its rows empty.
    func testRecordsThatShareASessionsIdAreRowsOfTheirOwn() {
        let twins = [SessionSummary(harness: "codex", id: "c1", cwd: "/Users/u/Codex", title: "企业申请", updatedAt: 300, startedAt: 250),
                     SessionSummary(harness: "codex", id: "c1", cwd: "/Users/u/Codex", title: "监控温度", updatedAt: 250, startedAt: 200),
                     SessionSummary(harness: "codex", id: "c1", cwd: "/Users/u/Codex", title: "威胁情报", updatedAt: 200, startedAt: 100)]
        let rows = TerminalListRows.build(TerminalTree.build(terminals: [], sessions: twins))
        XCTAssertEqual(rows.count, 4)
        XCTAssertEqual(Set(rows.map(\.id)).count, 4, "every row its own id")
        let found = TerminalListRows.found(TerminalSearch.run(TerminalTree.build(terminals: [], sessions: twins), query: "x",
                                                              said: ["codex:c1": "an x here"]), query: "x")
        XCTAssertEqual(Set(found.map(\.id)).count, found.count, "also what a search shows")
    }

    func testASearchKeepsTheTreesOrderAndShowsTheWordsThatMatched() {
        let (folders, terminals) = tree
        let said = ["claude-code:s2": "…先看了一下配置文件，发现连接池太小"]
        let rows = TerminalListRows.found(TerminalSearch.run(folders, query: "连接池", said: said), query: "连接池", order: TerminalListRows.order(terminals))
        XCTAssertEqual(lines(rows), ["// 1 in text", "Work/api/ open live 0 sessions 1", "└─ s2", "\u{a0}\u{a0}└─ “…置文件，发现连接池太小”"])
        XCTAssertEqual(lines(TerminalListRows.found(TerminalSearch.run(folders, query: "zzz"), query: " zzz ")), ["没有找到与“zzz”相关的文件夹或会话。"])
        let byFolder = TerminalListRows.found(TerminalSearch.run(folders, query: "web"), query: "web")
        XCTAssertEqual(lines(byFolder), ["// 1 folder", "Work/web/ open live 0 sessions 1", "└─ w1"])
    }

    func testTheShortWords() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let ms = { (seconds: Double) in Int64((1_000_000 - seconds) * 1000) }
        XCTAssertEqual(TerminalListText.age(since: ms(10), now: now), "Now")
        XCTAssertEqual(TerminalListText.age(since: ms(12 * 60), now: now), "12m")
        XCTAssertEqual(TerminalListText.age(since: ms(13 * 3600), now: now), "13h")
        XCTAssertEqual(TerminalListText.age(since: ms(6 * 86400), now: now), "6d")
        XCTAssertEqual(TerminalListText.age(since: ms(13 * 3600), now: now, classic: true), "13h ago")
        XCTAssertEqual(TerminalListText.age(since: ms(10), now: now, classic: true), "Now")
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        XCTAssertEqual(TerminalListText.age(since: 0, now: now, calendar: utc, classic: true), "1/1", "a date says no more")
        XCTAssertEqual(TerminalListText.status("working"), "Busy")
        XCTAssertEqual(TerminalListText.status("odd"), "odd")
        XCTAssertEqual(TerminalListText.agentName("claude-code"), "Claude Code")
        XCTAssertEqual(TerminalListText.agentName("new-agent"), "new-agent")
        let models = [TerminalModelOption(id: "opus", name: "Opus"), TerminalModelOption(id: "opus-old", name: "Opus"), TerminalModelOption(id: "sonnet", name: "Sonnet")]
        XCTAssertEqual(TerminalListText.modelTitle(models[0], among: models), "Opus · opus")
        XCTAssertEqual(TerminalListText.modelTitle(models[2], among: models), "Sonnet")
    }

    func testAllTheTerminalsAtAGlance() {
        XCTAssertEqual(TerminalListText.mark([]).state, "off")
        XCTAssertEqual(TerminalListText.mark([term("a", "/p", created: 1, status: "exited")]).state, "off")
        XCTAssertEqual(TerminalListText.mark([term("a", "/p", created: 1)]).tag, "Idle")
        XCTAssertEqual(TerminalListText.mark([term("a", "/p", created: 1), term("b", "/p", created: 2, status: "working")]).tag, "Busy")
        let waiting = TerminalListText.mark([term("a", "/p", created: 1, status: "waiting"), term("b", "/p", created: 2, status: "working"), term("c", "/p", created: 3, status: "waiting")])
        XCTAssertEqual(waiting.state, "waiting")
        XCTAssertEqual(waiting.tag, "2 Waiting")
    }

    func testOutputThatPaints() {
        XCTAssertFalse(TerminalListText.paints("\u{1b}[?25l\u{1b}[2J\u{1b}[H  \r\n"), "modes, moves and blank space draw nothing")
        XCTAssertFalse(TerminalListText.paints("\u{1b}]0;title\u{07}"))
        XCTAssertTrue(TerminalListText.paints("\u{1b}[1mWelcome\u{1b}[0m"))
    }

    private func key(_ key: String, code: UInt16 = 0, command: Bool = false, shift: Bool = false, option: Bool = false, editing: Bool = false,
                     plain: Bool = false, inSeal: Bool = false, card: Bool = false, creating: Bool = false) -> TerminalsPageKey? {
        TerminalsPageKey.action(for: .init(key: key, keyCode: code, command: command, option: option, shift: shift), editing: editing || plain || inSeal,
                                plainField: plain, marking: false, inSeal: inSeal, cardHasKeys: card, creating: creating)
    }

    func testThePagesOwnKeys() {
        XCTAssertEqual(key("t", command: true), .newTerminal)
        XCTAssertEqual(key("w", command: true), .closeTerminal)
        XCTAssertEqual(key("b", command: true), .toggleList)
        XCTAssertEqual(key("f", command: true), .search)
        XCTAssertEqual(key("d", command: true), .split(.right))
        XCTAssertEqual(key("d", command: true, shift: true), .split(.bottom))
        XCTAssertEqual(key("\r", code: 36, command: true, shift: true), .zoom)
        XCTAssertEqual(key("", code: 123, command: true, option: true), .neighbor(dx: -1, dy: 0))
        XCTAssertEqual(key("", code: 126, command: true, option: true), .neighbor(dx: 0, dy: -1))
        XCTAssertEqual(key("3", command: true), .select(3))
        XCTAssertNil(key("0", command: true), "the window's: Dispatch")
        XCTAssertEqual(key("v", command: true, shift: true), .item(.seal))
        XCTAssertEqual(key("\r", code: 36, command: true), .item(.primary))
        XCTAssertEqual(key("", code: 51, command: true), .item(.deny))
        XCTAssertNil(key("\r", code: 36), "typed into the terminal")
    }

    func testAFieldOfThePagesOwnKeepsItsKeysButNotThePagesCommands() {
        XCTAssertNil(key("\r", code: 36, plain: true), "the field's own: a name taken, a search left")
        XCTAssertNil(key("", code: 53, plain: true))
        XCTAssertNil(key("\r", code: 36, plain: true, creating: true), "the panel's folder starts by itself")
        XCTAssertEqual(key("t", command: true, plain: true), .newTerminal)
        XCTAssertEqual(key("v", command: true, plain: true), .item(.edit("paste:")))
        XCTAssertEqual(key("a", command: true, plain: true), .item(.edit("selectAll:")))
        XCTAssertEqual(key("\r", code: 36, inSeal: true), .item(.send))
    }

    func testTheNewTerminalPanelStartsOnReturnAndLeavesOnEsc() {
        XCTAssertEqual(key("\r", code: 36, creating: true), .start)
        XCTAssertEqual(key("", code: 53, creating: true), .cancelCreate)
        XCTAssertNil(key("x", creating: true))
    }
}

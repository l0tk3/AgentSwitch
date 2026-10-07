import XCTest
@testable import AgentSwitchMacCore

/// The Terminals page's split panes (docs/terminal-v0.md §1 分屏): the tree of splits, what a drop does, the lines'
/// limits, what is kept across a restart — the web page's tests of the same rules (packages/daemon/tests/terminalPanes.test.ts).
final class TerminalPanesTests: XCTestCase {
    /// 2026-10-07, user: 简略模式下我点击分屏会切回暗黑终端模式…如果我在简略模式点分屏出来的也是简略模式.
    func testAPaneSplitOffARecordWaitsAsTheSimpleViewForWhatLandsInIt() {
        // Pane 2 was split off a record and is still empty; pane 3 too, and a terminal has just landed in it.
        let settled = SimplePanes.settle(waiting: [2, 3, 9], panes: [(1, "t1"), (2, nil), (3, "t7")])
        XCTAssertEqual(settled.terminals, ["t7"])
        // Pane 2 goes on waiting; pane 3 has what it waited for; pane 9 is no longer there.
        XCTAssertEqual(settled.waiting, [2])
        // A pane nobody flagged changes nothing, whatever it shows.
        let none = SimplePanes.settle(waiting: [], panes: [(1, "t1"), (2, nil)])
        XCTAssertTrue(none.terminals.isEmpty)
        XCTAssertTrue(none.waiting.isEmpty)
    }

    private typealias P = TerminalPanes
    private func terms(_ node: PaneNode) -> [String?] { P.panes(of: node).map(\.term) }
    private let box = CGRect(x: 0, y: 0, width: 1001, height: 601)
    /// t1 | (t2 over t3).
    private func three() -> PaneNode {
        let a = P.split(P.single("t1"), 1, .right, "t2")!
        return P.split(a.root, a.pane, .bottom, "t3")!.root
    }
    private func direction(_ node: PaneNode) -> PaneNode.Direction? {
        if case .split(_, let dir, _, _, _) = node { return dir }
        return nil
    }
    private func splitID(_ node: PaneNode) -> Int? {
        if case .split(let id, _, _, _, _) = node { return id }
        return nil
    }
    private func second(_ node: PaneNode) -> PaneNode? {
        if case .split(_, _, _, _, let b) = node { return b }
        return nil
    }
    private func term(_ id: String, _ harness: String, session: String? = nil, name: String = "") -> TerminalInfo {
        TerminalInfo(id: id, harness: harness, cwd: "/p", name: name, status: "idle", agentSessionId: session)
    }

    func testStartsAsOnePaneAndSplitsBesideThePaneAsked() {
        let one = P.single("t1")
        XCTAssertEqual(terms(one), ["t1"])
        let right = P.split(one, 1, .right, "t2")!
        XCTAssertEqual(terms(right.root), ["t1", "t2"])
        XCTAssertEqual(P.paneShowing(right.root, "t2")?.id, right.pane)
        XCTAssertEqual(terms(P.split(one, 1, .left, "t2")!.root), ["t2", "t1"])
        XCTAssertEqual(direction(P.split(one, 1, .top)!.root), .col)
        XCTAssertEqual(terms(P.split(one, 1, .bottom)!.root), ["t1", nil])
        XCTAssertNil(P.split(one, 9, .right))
        XCTAssertEqual(one, P.single("t1"), "every change is a new tree")
    }

    func testHoldsAtMostFourPanes() {
        var root = P.single("t1")
        for i in 2...P.maxPanes { root = P.split(root, P.panes(of: root)[0].id, .right, "t\(i)")!.root }
        XCTAssertEqual(P.panes(of: root).count, 4)
        XCTAssertNil(P.split(root, P.panes(of: root)[0].id, .right))
        XCTAssertEqual(Set(P.panes(of: root).map(\.id)).count, 4)
    }

    func testATerminalIsInOnePaneAtMost() {
        let root = three()
        let all = P.panes(of: root)
        XCTAssertEqual(terms(P.show(root, all[0].id, "t3")), ["t3", "t2"], "shown in another pane, it leaves the first, which closes")
        XCTAssertEqual(terms(P.show(root, all[2].id, nil)), ["t1", "t2", nil])
        XCTAssertEqual(terms(P.show(root, all[0].id, "t1")), ["t1", "t2", "t3"])
    }

    func testClosingAPaneGivesItsRoomToItsSibling() {
        let root = three()
        let all = P.panes(of: root)
        XCTAssertEqual(terms(P.close(root, all[1].id)), ["t1", "t3"])
        let left = P.close(root, all[0].id)
        XCTAssertEqual(direction(left), .col)
        XCTAssertEqual(terms(left), ["t2", "t3"])
        XCTAssertEqual(P.close(P.single("t1"), 1), .pane(TerminalPane(id: 1)), "the last pane is only emptied")
        XCTAssertEqual(P.close(root, 99), root)
    }

    func testADropInTheMiddleShowsItThereAndOnAnEdgeSplitsThatSide() {
        let root = three()
        let all = P.panes(of: root)
        XCTAssertEqual(terms(P.drop(root, "t9", on: all[0].id, .center)!.root), ["t9", "t2", "t3"])
        let split = P.drop(root, "t9", on: all[1].id, .side(.left))!
        XCTAssertEqual(terms(split.root), ["t1", "t9", "t2", "t3"])
        XCTAssertEqual(P.paneShowing(split.root, "t9")?.id, split.pane)
        // t3 dragged onto t1's right edge: its own pane closes, three panes stay.
        XCTAssertEqual(terms(P.drop(root, "t3", on: all[0].id, .side(.right))!.root), ["t1", "t3", "t2"])
        XCTAssertNil(P.drop(root, "t1", on: all[0].id, .center), "onto itself")
        XCTAssertNil(P.drop(root, "t9", on: 99, .center))
    }

    func testPlacesPanesAndLinesInTheRectOnePointBetweenPanes() {
        let placed = P.place(three(), in: box)
        XCTAssertEqual(placed.panes.map(\.rect), [CGRect(x: 0, y: 0, width: 500, height: 601), CGRect(x: 501, y: 0, width: 500, height: 300),
                                                 CGRect(x: 501, y: 301, width: 500, height: 300)])
        XCTAssertEqual(placed.lines.map(\.dir), [.row, .col])
        XCTAssertEqual(placed.lines.map(\.rect), [CGRect(x: 500, y: 0, width: 1, height: 601), CGRect(x: 501, y: 300, width: 500, height: 1)])
        XCTAssertEqual(placed.lines[1].box, CGRect(x: 501, y: 0, width: 500, height: 601))
    }

    func testALineDraggedKeepsEveryPaneAtItsLeastSize() throws {
        let root = three()
        let id = try XCTUnwrap(splitID(root))
        XCTAssertEqual(P.least(root, wide: true), 2 * P.minWidth + P.gap)
        XCTAssertEqual(P.least(root, wide: false), 2 * P.minHeight + P.gap)
        XCTAssertEqual(P.ratio(root, line: id, in: box, at: 500), 0.5, accuracy: 0.001)
        XCTAssertEqual(P.ratio(root, line: id, in: box, at: 10), Double(P.minWidth) / 1000, accuracy: 0.001)
        XCTAssertEqual(P.ratio(root, line: id, in: box, at: 990), 1 - Double(P.minWidth) / 1000, accuracy: 0.001)
        let inner = try XCTUnwrap(second(root).flatMap(splitID))
        XCTAssertEqual(P.ratio(root, line: inner, in: CGRect(x: 501, y: 0, width: 500, height: 601), at: 20), Double(P.minHeight) / 600, accuracy: 0.001)
        XCTAssertEqual(P.ratio(root, line: id, in: CGRect(x: 0, y: 0, width: 400, height: 601), at: 100), 0.5, "no room for both: half each")
        guard case .split(_, _, let ratio, _, _)? = second(P.resize(root, inner, 0.3)) else { return XCTFail("a split") }
        XCTAssertEqual(ratio, 0.3)
        XCTAssertEqual(P.resize(root, 99, 0.3), root)
    }

    func testADropLandsOnTheNearestEdgeWithinAQuarterElseTheMiddle() {
        let r = CGRect(x: 100, y: 50, width: 800, height: 400)
        XCTAssertEqual(P.zone(in: r, at: CGPoint(x: 500, y: 250), count: 1), P.Drop(zone: .center, rect: r, full: false))
        XCTAssertEqual(P.zone(in: r, at: CGPoint(x: 880, y: 250), count: 1), P.Drop(zone: .side(.right), rect: CGRect(x: 500, y: 50, width: 400, height: 400), full: false))
        XCTAssertEqual(P.zone(in: r, at: CGPoint(x: 110, y: 250), count: 1).zone, .side(.left))
        XCTAssertEqual(P.zone(in: r, at: CGPoint(x: 500, y: 60), count: 1), P.Drop(zone: .side(.top), rect: CGRect(x: 100, y: 50, width: 800, height: 200), full: false))
        XCTAssertEqual(P.zone(in: r, at: CGPoint(x: 500, y: 440), count: 1).zone, .side(.bottom))
        XCTAssertEqual(P.zone(in: r, at: CGPoint(x: 880, y: 250), count: P.maxPanes), P.Drop(zone: .center, rect: r, full: true))
        XCTAssertEqual(P.zone(in: CGRect(x: 100, y: 50, width: 500, height: 400), at: CGPoint(x: 590, y: 250), count: 1).zone, .center, "too narrow for two")
        XCTAssertEqual(P.zone(in: CGRect(x: 100, y: 50, width: 800, height: 300), at: CGPoint(x: 500, y: 340), count: 1).zone, .center, "too low for two")
    }

    func testFindsThePaneNextDoorByDirection() {
        let panes = P.place(three(), in: box).panes
        let (p1, p2, p3) = (panes[0].id, panes[1].id, panes[2].id)
        XCTAssertEqual(P.neighbor(panes, of: p1, dx: 1, dy: 0), p2)
        XCTAssertEqual(P.neighbor(panes, of: p2, dx: -1, dy: 0), p1)
        XCTAssertEqual(P.neighbor(panes, of: p2, dx: 0, dy: 1), p3)
        XCTAssertEqual(P.neighbor(panes, of: p3, dx: 0, dy: -1), p2)
        XCTAssertNil(P.neighbor(panes, of: p1, dx: -1, dy: 0))
        XCTAssertNil(P.neighbor(panes, of: 99, dx: 1, dy: 0))
    }

    func testKeepsTheSessionOfAPaneWhoseTerminalIsGoneOrClosesThePane() {
        let live = [term("t1", "claude-code", session: "s-1", name: "发布前检查"), term("t2", "codex"), term("t3", "codex", session: "s-3", name: "构建")]
        let noted = P.settle(three(), live)
        XCTAssertEqual(P.panes(of: noted).map { $0.was?.session }, ["s-1", nil, "s-3"])
        XCTAssertEqual(P.settle(noted, live), noted, "nothing new: the same tree")
        // The service restarted: every terminal gone, the panes stay with what to go on with.
        let after = P.settle(noted, [])
        XCTAssertEqual(terms(after), [nil, nil, nil])
        XCTAssertEqual(P.panes(of: after)[0].was, PaneSession(harness: "claude-code", session: "s-1", title: "发布前检查"))
        XCTAssertNil(P.panes(of: after)[1].was)
        // One closed while the page is open: its pane closes; the last pane is emptied.
        XCTAssertEqual(terms(P.settle(noted, Array(live.prefix(2)), closing: true)), ["t1", "t2"])
        XCTAssertEqual(terms(P.settle(P.single("t9"), [], closing: true)), [nil])
        // Shown again, the pane forgets the old session.
        let first = P.panes(of: after)[0].id
        XCTAssertEqual(P.panes(of: P.show(after, first, "t7"))[0], TerminalPane(id: first, term: "t7"))
    }

    func testReadsBackOnlyAWellFormedTree() throws {
        let root = P.settle(three(), [term("t1", "claude-code", session: "s-1", name: "a")])
        XCTAssertEqual(P.restore(P.kept(root)), root)
        XCTAssertNil(P.restore(nil))
        func read(_ json: String) -> PaneNode? { P.restore(Data(json.utf8)) }
        XCTAssertNil(read(#"{"k":"pane","id":0,"term":"t1"}"#))
        XCTAssertNil(read(#"{"k":"split","id":2,"dir":"row","ratio":1.2,"a":{"k":"pane","id":1,"term":"a"},"b":{"k":"pane","id":3,"term":"b"}}"#))
        XCTAssertNil(read(#"{"k":"split","id":2,"dir":"row","ratio":0.5,"a":{"k":"pane","id":1,"term":"a"},"b":{"k":"pane","id":1,"term":"b"}}"#), "an id twice")
        XCTAssertNil(read(#"{"k":"split","id":2,"dir":"row","ratio":0.5,"a":{"k":"pane","id":1,"term":"a"},"b":{"k":"pane","id":3,"term":"a"}}"#), "a terminal twice")
        XCTAssertNil(read(#"{"k":"split","id":2,"dir":"diag","ratio":0.5,"a":{"k":"pane","id":1,"term":"a"},"b":{"k":"pane","id":3,"term":"b"}}"#))
        XCTAssertNil(read("not json"))
        var five = P.single("t1")
        for i in 2...4 { five = P.split(five, 1, .right, "t\(i)")!.root }
        let extra = PaneNode.split(id: 50, dir: .col, ratio: 0.5, a: five, b: .pane(TerminalPane(id: 51, term: "t5")))
        XCTAssertNil(P.restore(P.kept(extra)), "more panes than the page holds")
        XCTAssertEqual(read(#"{"k":"pane","id":4,"term":7,"was":{"harness":1}}"#), .pane(TerminalPane(id: 4)), "what does not read is none")
    }
}

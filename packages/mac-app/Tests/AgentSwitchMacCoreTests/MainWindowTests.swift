import XCTest
@testable import AgentSwitchMacCore

/// The Mac's main window (docs/dispatch-v0.md §1): its pages, what each has going on, the refresh that draws a page in,
/// its shortcuts and the bar's trouble word.
final class MainWindowTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_790_000_000)

    private func row(_ id: String, _ kind: LiveSnapshot.Kind, waiting: Bool = false) -> LiveSnapshot.Row {
        LiveSnapshot.Row(id: id, kind: kind, title: id, step: "", startedAt: t0, needsYou: waiting)
    }

    // MARK: pages

    func testOpensOnThePageShownLastAndOnDispatchTheFirstTime() {
        XCTAssertEqual(MainPage.restored(nil), .dispatch)
        XCTAssertEqual(MainPage.restored("terminals"), .terminals)
        XCTAssertEqual(MainPage.restored("dispatch"), .dispatch)
        XCTAssertEqual(MainPage.restored("browser"), .browser)
        XCTAssertEqual(MainPage.restored("tasks"), .dispatch, "a word it does not know")
    }

    func testPageWords() {
        XCTAssertEqual(MainPage.allCases.map(\.title), ["Dispatch", "Terminals", "Browser"], "the bar's order")
    }

    func testPagesCycleBothWays() {
        XCTAssertEqual(MainPage.dispatch.next, .terminals)
        XCTAssertEqual(MainPage.terminals.next, .browser)
        XCTAssertEqual(MainPage.browser.next, .dispatch)
        XCTAssertEqual(MainPage.dispatch.previous, .browser)
        XCTAssertEqual(MainPage.browser.previous, .terminals)
        XCTAssertEqual(MainPage.terminals.previous, .dispatch)
    }

    func testTerminalsAndBrowserAreAlwaysDark() {
        XCTAssertFalse(MainPage.dispatch.alwaysDark, "Dispatch follows the system")
        XCTAssertTrue(MainPage.terminals.alwaysDark)
        XCTAssertTrue(MainPage.browser.alwaysDark)
    }

    // MARK: activity

    func testEachPageCountsItsOwnRows() {
        let snapshot = LiveSnapshot(rows: [row("t1", .task), row("t2", .task, waiting: true), row("t3", .task),
                                           row("k1", .terminal)], now: t0)
        let dispatch = PageActivity.of(.dispatch, in: snapshot)
        XCTAssertEqual(dispatch, PageActivity(busy: 2, waiting: 1))
        XCTAssertEqual(dispatch.mark, .waiting, "anything waiting for you comes before busy")
        let terminals = PageActivity.of(.terminals, in: snapshot)
        XCTAssertEqual(terminals, PageActivity(busy: 1, waiting: 0))
        XCTAssertEqual(terminals.mark, .busy)
        XCTAssertEqual(PageActivity.of(.browser, in: snapshot), .none, "the browser's tabs come from its own list")
    }

    func testNothingGoingOnHasNoMark() {
        XCTAssertEqual(PageActivity.of(.dispatch, in: nil), .none)
        XCTAssertEqual(PageActivity.of(.terminals, in: LiveSnapshot(rows: [row("t1", .task)], now: t0)).mark, .none)
    }

    // MARK: the refresh

    func testThePageSwitchIsThePhonesRefreshAndTheTerminalSwitchAQuickerOne() {
        XCTAssertEqual(ScanRefresh.page.steps, 13)
        XCTAssertEqual(ScanRefresh.page.duration, 260, "0.26 s, as the phone and the web terminal")
        XCTAssertEqual(ScanRefresh.terminal.steps, 9)
        XCTAssertEqual(ScanRefresh.terminal.duration, 180, "0.18 s")
    }

    func testStepsFollowTheClockWithoutEasing() {
        let refresh = ScanRefresh.page
        XCTAssertEqual(refresh.step(at: 0), 0)
        XCTAssertEqual(refresh.step(at: 19), 0)
        XCTAssertEqual(refresh.step(at: 20), 1)
        XCTAssertEqual(refresh.step(at: 130), 6)
        XCTAssertEqual(refresh.step(at: 259), 12)
        XCTAssertNil(refresh.step(at: 260), "over: nothing of it left")
        XCTAssertNil(refresh.step(at: 5_000))
        XCTAssertEqual(refresh.step(at: -5), 0)
    }

    func testThePageComesInFromTheTopInEvenSteps() {
        let refresh = ScanRefresh.page
        let edges = (0..<refresh.steps).map { refresh.edge(at: $0, height: 260) }
        XCTAssertEqual(edges, stride(from: 0.0, to: 260, by: 20).map { $0 }, "a thirteenth of the height a step")
        XCTAssertEqual(edges.first, 0, "nothing in at the first step")
        XCTAssertLessThan(edges.last!, 260, "the last step's share is still the ground")
        XCTAssertEqual(refresh.edge(at: refresh.steps, height: 260), 260)
        // Whole points on any height.
        for step in 0..<refresh.steps {
            let edge = refresh.edge(at: step, height: 787)
            XCTAssertEqual(edge, edge.rounded())
        }
        XCTAssertEqual(ScanRefresh.terminal.edge(at: 3, height: 450), 150)
    }

    func testTheScanLineRunsOnTheEdgeAndStaysInside() {
        let refresh = ScanRefresh.page
        XCTAssertEqual(refresh.line(at: 0, height: 260), 0, "at the top first")
        XCTAssertEqual(refresh.line(at: 6, height: 260), 120)
        XCTAssertEqual(refresh.line(at: 13, height: 260), 258, "never below the bottom")
        XCTAssertEqual(ScanRefresh.lineThickness, 2)
    }

    // MARK: shortcuts

    private func press(_ key: String, keyCode: UInt16 = 0, command: Bool = true, control: Bool = false, shift: Bool = false) -> MainShortcut.Press {
        MainShortcut.Press(key: key, keyCode: keyCode, command: command, control: control, option: false, shift: shift)
    }

    func testShortcutsOnBothPages() {
        for page in MainPage.allCases {
            XCTAssertEqual(MainShortcut.action(for: press("0"), on: page, canGoBack: false), .page(.dispatch))
            XCTAssertEqual(MainShortcut.action(for: press("n"), on: page, canGoBack: false), .newTask)
            XCTAssertEqual(MainShortcut.action(for: press(","), on: page, canGoBack: false), .settings)
            XCTAssertEqual(MainShortcut.action(for: press("\t", keyCode: MainShortcut.tab, command: false, control: true), on: page, canGoBack: false), .nextPage)
            XCTAssertEqual(MainShortcut.action(for: press("\t", keyCode: MainShortcut.tab, command: false, control: true, shift: true), on: page, canGoBack: false), .previousPage)
            XCTAssertEqual(MainShortcut.action(for: press("b", shift: true), on: page, canGoBack: false), .page(.browser), "⌘⇧B")
        }
    }

    func testTheBrowsersOwnKeys() {
        XCTAssertEqual(MainShortcut.action(for: press("t"), on: .browser, canGoBack: false), .browser(.newTab))
        XCTAssertEqual(MainShortcut.action(for: press("l"), on: .browser, canGoBack: false), .browser(.address))
        XCTAssertEqual(MainShortcut.action(for: press("r"), on: .browser, canGoBack: false), .browser(.reload))
        XCTAssertEqual(MainShortcut.action(for: press("["), on: .browser, canGoBack: false), .browser(.back))
        XCTAssertEqual(MainShortcut.action(for: press("]"), on: .browser, canGoBack: false), .browser(.forward))
        XCTAssertEqual(MainShortcut.action(for: press("2"), on: .browser, canGoBack: false), .terminal(2), "⌘1–9 cross to the terminals")
        for page in [MainPage.dispatch, .terminals] {
            XCTAssertNil(MainShortcut.action(for: press("l"), on: page, canGoBack: false))
            XCTAssertNil(MainShortcut.action(for: press("r"), on: page, canGoBack: false))
            XCTAssertNil(MainShortcut.action(for: press("]"), on: page, canGoBack: false))
        }
        XCTAssertNil(MainShortcut.action(for: press("a"), on: .browser, canGoBack: false), "⌘A is the page's")
        XCTAssertNil(MainShortcut.action(for: press("v"), on: .browser, canGoBack: false), "⌘V is the screen's")
        let esc = press("\u{1b}", keyCode: MainShortcut.escape, command: false)
        XCTAssertNil(MainShortcut.action(for: esc, on: .browser, canGoBack: true), "Esc is the page's")
    }

    func testTheTerminalsShortcutsCrossFromDispatchAndAreThePagesOnTerminals() {
        XCTAssertEqual(MainShortcut.action(for: press("3"), on: .dispatch, canGoBack: false), .terminal(3))
        XCTAssertEqual(MainShortcut.action(for: press("t"), on: .dispatch, canGoBack: false), .newTerminal)
        XCTAssertNil(MainShortcut.action(for: press("3"), on: .terminals, canGoBack: false), "the terminal page's own ⌘1–9")
        XCTAssertNil(MainShortcut.action(for: press("t"), on: .terminals, canGoBack: false), "the terminal page's own ⌘T")
        XCTAssertNil(MainShortcut.action(for: press("b"), on: .dispatch, canGoBack: false), "⌘B is the terminals' list")
    }

    func testBackOnlyWhereThereIsABack() {
        let esc = press("\u{1b}", keyCode: MainShortcut.escape, command: false)
        XCTAssertEqual(MainShortcut.action(for: esc, on: .dispatch, canGoBack: true), .back)
        XCTAssertEqual(MainShortcut.action(for: press("["), on: .dispatch, canGoBack: true), .back)
        XCTAssertNil(MainShortcut.action(for: esc, on: .dispatch, canGoBack: false), "Esc is the page's own")
        XCTAssertNil(MainShortcut.action(for: esc, on: .terminals, canGoBack: true), "Esc belongs to the terminal")
        XCTAssertNil(MainShortcut.action(for: press("["), on: .terminals, canGoBack: true))
        XCTAssertNil(MainShortcut.action(for: esc, on: .dispatch, canGoBack: true, composing: true), "an input method's Esc cancels its composition")
    }

    func testOtherModifiersAreNotTheseShortcuts() {
        XCTAssertNil(MainShortcut.action(for: press("n", shift: true), on: .dispatch, canGoBack: false))
        XCTAssertNil(MainShortcut.action(for: press("0", command: false), on: .dispatch, canGoBack: false))
        XCTAssertNil(MainShortcut.action(for: press("\t", keyCode: MainShortcut.tab, command: false), on: .dispatch, canGoBack: false), "plain Tab")
        XCTAssertNil(MainShortcut.action(for: press("12"), on: .dispatch, canGoBack: false))
    }

    // MARK: trouble

    func testTheBarSaysWhenTheServiceOrTheGatewayIsDown() {
        let ok = StatusLine("OK", .ok)
        XCTAssertNil(ServiceTrouble.word(service: ok, gateway: ok))
        XCTAssertNil(ServiceTrouble.word(service: StatusLine("Starting", .busy), gateway: ok), "starting is not down")
        XCTAssertEqual(ServiceTrouble.word(service: ok, gateway: StatusLine("Failed", .error)), "Gateway Down")
        XCTAssertEqual(ServiceTrouble.word(service: ok, gateway: StatusLine("No Response", .warning)), "Gateway Down")
        XCTAssertEqual(ServiceTrouble.word(service: StatusLine("Stopped", .off), gateway: StatusLine("Failed", .error)), "Service Down",
                       "the service before the gateway")
    }
}

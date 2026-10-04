import XCTest
@testable import AgentSwitchMacCore

/// The Mac's main window (docs/dispatch-v0.md §1): its pages, what each has going on, the refresh that draws a page in,
/// its shortcuts, and the status bar's words (proposal B, 2026-10-03).
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
        XCTAssertEqual(MainPage.allCases.map(\.title), ["Dispatch", "Terminals", "Browser"], "the rail's order")
    }

    func testTheRailSaysEachPageWithTheKeyThatGoesThere() {
        XCTAssertEqual(MainPage.allCases.map(\.railHelp), ["Dispatch ⌘0", "Terminals ⌘1–9", "Browser ⌘⇧B"])
        for page in MainPage.allCases {
            let key = page.railHelp.split(separator: " ").last.map(String.init) ?? ""
            let press: MainShortcut.Press? = switch key {
            case "⌘0": press("0")
            case "⌘⇧B": press("b", shift: true)
            case "⌘1–9": press("1")
            default: nil
            }
            XCTAssertNotNil(press, page.railHelp)
            let action = press.flatMap { MainShortcut.action(for: $0, on: .dispatch, canGoBack: false) }
            XCTAssertTrue(action == .page(page) || (page == .terminals && action == .terminal(1)), "\(page.railHelp) goes to \(page)")
        }
    }

    func testOnlyTerminalsAndBrowserHaveAList() {
        XCTAssertEqual(MainPage.allCases.filter(\.hasList), [.terminals, .browser], "the bar's list button is dimmed on Dispatch")
    }

    func testPagesCycleBothWays() {
        XCTAssertEqual(MainPage.dispatch.next, .terminals)
        XCTAssertEqual(MainPage.terminals.next, .browser)
        XCTAssertEqual(MainPage.browser.next, .dispatch)
        XCTAssertEqual(MainPage.dispatch.previous, .browser)
        XCTAssertEqual(MainPage.browser.previous, .terminals)
        XCTAssertEqual(MainPage.terminals.previous, .dispatch)
    }

    func testEveryPageIsDark() {
        XCTAssertTrue(MainPage.allCases.allSatisfy(\.alwaysDark), "Dispatch too since 2026-10-03: no light page between the dark ones")
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
        XCTAssertEqual(MainShortcut.action(for: press("b"), on: .browser, canGoBack: false), .browser(.toggleList), "⌘B: the tab list, as on Terminals")
        XCTAssertNil(MainShortcut.action(for: press("b"), on: .terminals, canGoBack: false), "the terminal page's own ⌘B")
        XCTAssertEqual(MainShortcut.action(for: press("2"), on: .browser, canGoBack: false), .terminal(2), "⌘1–9 cross to the terminals")
        for page in [MainPage.dispatch, .terminals] {
            XCTAssertNil(MainShortcut.action(for: press("l"), on: page, canGoBack: false))
            XCTAssertNil(MainShortcut.action(for: press("r"), on: page, canGoBack: false))
            XCTAssertNil(MainShortcut.action(for: press("]"), on: page, canGoBack: false))
        }
        XCTAssertEqual(MainShortcut.action(for: press("t", shift: true), on: .browser, canGoBack: false), .browser(.hold),
                       "⌘⇧T: the status bar's Take Over / Hand Back")
        XCTAssertNil(MainShortcut.action(for: press("t", shift: true), on: .terminals, canGoBack: false), "nothing to take over there")
        XCTAssertNil(MainShortcut.action(for: press("t", shift: true), on: .dispatch, canGoBack: false))
        XCTAssertNil(MainShortcut.action(for: press("a"), on: .browser, canGoBack: false), "⌘A is the page's")
        XCTAssertNil(MainShortcut.action(for: press("v"), on: .browser, canGoBack: false), "⌘V is the screen's")
        let esc = press("\u{1b}", keyCode: MainShortcut.escape, command: false)
        XCTAssertNil(MainShortcut.action(for: esc, on: .browser, canGoBack: true), "Esc is the page's")
    }

    func testTheBrowsersZoomKeys() {
        // docs/browser-v0.md §1 页面缩放 (2026-10-03): ⌘= and ⌘+ zoom in, ⌘− out; the keypad's keys too.
        let keypadPlus: UInt16 = 69, keypadMinus: UInt16 = 78
        XCTAssertEqual(MainShortcut.action(for: press("="), on: .browser, canGoBack: false), .browser(.zoomIn), "⌘=")
        XCTAssertEqual(MainShortcut.action(for: press("+", shift: true), on: .browser, canGoBack: false), .browser(.zoomIn), "⌘+ is ⌘⇧= on most layouts")
        XCTAssertEqual(MainShortcut.action(for: press("+"), on: .browser, canGoBack: false), .browser(.zoomIn), "a layout with + on a key of its own")
        XCTAssertEqual(MainShortcut.action(for: press("=", shift: true), on: .browser, canGoBack: false), .browser(.zoomIn), "a layout with = under shift")
        XCTAssertEqual(MainShortcut.action(for: press("+", keyCode: keypadPlus), on: .browser, canGoBack: false), .browser(.zoomIn), "the keypad's +")
        XCTAssertEqual(MainShortcut.action(for: press("-"), on: .browser, canGoBack: false), .browser(.zoomOut), "⌘−")
        XCTAssertEqual(MainShortcut.action(for: press("-", keyCode: keypadMinus), on: .browser, canGoBack: false), .browser(.zoomOut), "the keypad's −")
        XCTAssertEqual(MainShortcut.action(for: press("0"), on: .browser, canGoBack: false), .page(.dispatch), "⌘0 stays Dispatch: Actual Size has no key")
        for key in ["=", "+", "-"] {
            XCTAssertNil(MainShortcut.action(for: press(key, command: false), on: .browser, canGoBack: false), "typed into the page")
            XCTAssertNil(MainShortcut.action(for: press(key, control: true), on: .browser, canGoBack: false), "not with control")
            let option = MainShortcut.Press(key: key, keyCode: 0, command: true, control: false, option: true, shift: false)
            XCTAssertNil(MainShortcut.action(for: option, on: .browser, canGoBack: false), "⌥⌘= ⌥⌘− are the system's zoom")
            for page in [MainPage.dispatch, .terminals] {
                XCTAssertNil(MainShortcut.action(for: press(key), on: page, canGoBack: false), "only the Browser page has a page to zoom")
            }
        }
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

    // MARK: the status bar

    func testTheGatewayWord() {
        let ok = StatusLine("OK", .ok)
        XCTAssertEqual(MainStatus.gateway(service: ok, gateway: ok), MainStatus.Word("Gateway", .ok))
        XCTAssertEqual(MainStatus.gateway(service: StatusLine("Starting", .busy), gateway: ok), MainStatus.Word("Starting", .busy))
        XCTAssertEqual(MainStatus.gateway(service: ok, gateway: StatusLine("Failed", .error)), MainStatus.Word("Gateway Down", .failed))
        XCTAssertEqual(MainStatus.gateway(service: StatusLine("Stopped", .off), gateway: StatusLine("Starting", .busy)),
                       MainStatus.Word("Service Down", .failed), "down before starting")
    }

    func testThePhonesOnline() {
        func device(_ id: String, _ platform: String = "ios", online: Bool? = nil, revoked: Bool = false) -> Device {
            Device(id: id, name: id, platform: platform, createdAt: nil, lastSeenAt: nil, revokedAt: revoked ? t0 : nil, online: online)
        }
        XCTAssertNil(MainStatus.phones([device("a")], online: 1, remoteEnabled: false), "remote access off: nothing")
        XCTAssertNil(MainStatus.phones(nil, online: nil, remoteEnabled: true), "nothing known yet")
        XCTAssertEqual(MainStatus.phones([], online: 0, remoteEnabled: true), "Not Paired")
        XCTAssertEqual(MainStatus.phones([device("a", revoked: true)], online: nil, remoteEnabled: true), "Not Paired", "a revoked one is not paired")
        XCTAssertEqual(MainStatus.phones([device("a", online: true)], online: 1, remoteEnabled: true), "iPhone Online")
        XCTAssertEqual(MainStatus.phones([device("a"), device("b")], online: 0, remoteEnabled: true), "No Device Online")
        XCTAssertEqual(MainStatus.phones([device("a", "web", online: true)], online: 1, remoteEnabled: true), "1 Device Online")
        XCTAssertEqual(MainStatus.phones([device("a", online: true), device("b", online: true)], online: 2, remoteEnabled: true), "2 Devices Online")
        XCTAssertEqual(MainStatus.phones(nil, online: 2, remoteEnabled: true), "2 Devices Online", "the count without the list")
        XCTAssertEqual(MainStatus.phones([device("a", online: true), device("b", online: false)], online: nil, remoteEnabled: true), "iPhone Online",
                       "the list without the count")
    }

    func testDispatchsRouterAndTopics() {
        XCTAssertEqual(MainStatus.dispatch(router: "deepseek/deepseek-v4.1-flash", topics: 2), ["Router · DeepSeek V4.1 Flash", "2 Topics"])
        XCTAssertEqual(MainStatus.dispatch(router: nil, topics: 1), ["1 Topic"])
        XCTAssertEqual(MainStatus.dispatch(router: "", topics: 0), [])
    }

    func testTheTerminalOnScreen() {
        let here = TerminalContext(harness: "claude-code", model: "claude-opus-5-5", mode: "bypass", cols: 139, rows: 46)
        XCTAssertEqual(here.agent, "claude · Opus 5.5")
        XCTAssertEqual(here.size, "On Mac · 139×46")
        let phone = TerminalContext(harness: "codex", cols: 50, rows: 30, away: "iphone")
        XCTAssertEqual(phone.agent, "codex", "the agent alone without a model")
        XCTAssertEqual(phone.size, "On iPhone · 50×30")
        XCTAssertEqual(TerminalContext(harness: "opencode", away: "web").size, "On Web", "the place alone without a grid")
        XCTAssertEqual(TerminalContext(harness: "pi", away: "mac").size, "On Mac", "another window of a Mac, as the placeholder says it")
    }

    func testTheScreensGridAndHolderComeFirst() {
        let page = TerminalContext(harness: "codex", cols: 100, rows: 30, away: nil)
        XCTAssertEqual(page.seen(cols: 139, rows: 46, away: nil).size, "On Mac · 139×46", "the stream's grid before the list catches up")
        XCTAssertEqual(page.seen(cols: 50, rows: 30, away: "iphone").size, "On iPhone · 50×30")
        XCTAssertEqual(page.seen(cols: nil, rows: nil, away: "iphone"), page, "not heard yet: the page's words stay")
    }

    func testThePagesReport() {
        let report: [String: Any] = ["type": "context", "harness": "claude-code", "model": "", "mode": "auto", "cols": 120, "rows": 40,
                                     "away": "", "running": false]
        XCTAssertEqual(TerminalContext(report: report),
                       TerminalContext(harness: "claude-code", model: nil, mode: "auto", cols: 120, rows: 40, away: nil, running: false),
                       "empty words are none")
        XCTAssertNil(TerminalContext(report: ["type": "context"]), "none on screen")
        XCTAssertNil(TerminalContext(report: ["harness": ""]))
    }

    func testTheRailsIconsAreFinePixels() {
        XCTAssertEqual(PixelArt.railDispatch.count, PixelArt.markHeight)
        XCTAssertTrue(PixelArt.railDispatch.allSatisfy { $0.count == PixelArt.markWidth && $0.allSatisfy { $0 == "#" || $0 == "." } })
        XCTAssertEqual(PixelArt.railBrowser.count, 15)
        XCTAssertTrue(PixelArt.railBrowser.allSatisfy { $0.count == 15 })
        XCTAssertEqual(PixelArt.railBrowser, PixelArt.railBrowser.reversed(), "the globe is the same upside down")
        XCTAssertEqual(PixelArt.railBrowser, PixelArt.railBrowser.map { String($0.reversed()) }, "and mirrored")
        XCTAssertEqual(PixelArt.railBrowser[7], String(repeating: "#", count: 15), "the equator")
        XCTAssertEqual(PixelArt.railTerminals.count, 12)
        XCTAssertTrue(PixelArt.railTerminals.allSatisfy { $0.count == 16 })
    }

    func testTheSplitButtonsAreTheListsWindowWithALineThroughIt() {
        for rows in [PixelArt.toolbarSplitRight, PixelArt.toolbarSplitDown] {
            XCTAssertEqual(rows.count, PixelArt.toolbarList.count, "the bar's buttons are one height")
            XCTAssertTrue(rows.allSatisfy { $0.count == PixelArt.toolbarList[0].count })
            XCTAssertEqual(rows.first, PixelArt.toolbarList.first)
        }
        XCTAssertTrue(PixelArt.toolbarSplitRight.dropFirst().dropLast().allSatisfy { Array($0)[9] == "#" }, "a line down the middle")
        XCTAssertEqual(PixelArt.toolbarSplitDown.filter { !$0.contains(".") }.count, 1, "one line across")
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

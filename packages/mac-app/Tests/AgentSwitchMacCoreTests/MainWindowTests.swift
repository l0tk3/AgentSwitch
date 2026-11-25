import XCTest
@testable import AgentSwitchMacCore

/// The Mac's main window (docs/dispatch-v0.md §1): its pages, what each has going on, the refresh that draws a page in,
/// its shortcuts, and the status bar's words (proposal B, 2026-10-03).
final class MainWindowTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_790_000_000)

    private func row(_ id: String, waiting: Bool = false, node: LiveSnapshot.Node? = nil) -> LiveSnapshot.Row {
        LiveSnapshot.Row(id: id, title: id, step: "", startedAt: t0, needsYou: waiting, node: node)
    }

    // MARK: pages

    func testOpensOnThePageShownLastAndOnDispatchTheFirstTime() {
        XCTAssertEqual(MainPage.restored(nil), .terminals)
        XCTAssertEqual(MainPage.restored("terminals"), .terminals)
        XCTAssertEqual(MainPage.restored("dispatch"), .dispatch)
        XCTAssertEqual(MainPage.restored("browser"), .browser)
        XCTAssertEqual(MainPage.restored("tasks"), .terminals, "a word it does not know")
    }

    func testPageWords() {
        XCTAssertEqual(MainPage.allCases.map(\.title), ["Terminals", "Dispatch", "Chat Room", "Browser", "Clash"], "the rail's order")
    }

    func testTheRailSaysEachPageWithTheKeyThatGoesThere() {
        XCTAssertEqual(MainPage.allCases.map(\.railHelp), ["Terminals ⌘1–9", "Dispatch ⌘0", "Chat Room ⌘⇧M", "Browser ⌘⇧B", "Clash ⌘⇧K"])
        for page in MainPage.allCases {
            let key = page.railHelp.split(separator: " ").last.map(String.init) ?? ""
            let press: MainShortcut.Press? = switch key {
            case "⌘0": press("0")
            case "⌘⇧B": press("b", shift: true)
            case "⌘⇧K": press("k", shift: true)
            case "⌘⇧M": press("m", shift: true)
            case "⌘⇧L": press("l", shift: true)
            case "⌘1–9": press("1")
            default: nil
            }
            XCTAssertNotNil(press, page.railHelp)
            let action = press.flatMap { MainShortcut.action(for: $0, on: .dispatch) }
            XCTAssertTrue(action == .page(page) || (page == .terminals && action == .terminal(1)), "\(page.railHelp) goes to \(page)")
        }
    }

    func testOnlyTerminalsAndBrowserHaveAList() {
        XCTAssertEqual(MainPage.allCases.filter(\.hasList), [.terminals, .browser], "the bar's list button is dimmed on Dispatch")
    }

    func testThePasswordBookIsAWindowOfItsOwn() {
        // ⇧⌘L from any page (user #400): not a page of the rail's.
        XCTAssertEqual(MainShortcut.action(for: .init(key: "l", keyCode: 37, command: true, control: false, option: false, shift: true), on: .terminals), .passwords)
        XCTAssertFalse(MainPage.allCases.map(\.title).contains("Passwords"))
    }

    func testPagesCycleBothWays() {
        XCTAssertEqual(MainPage.terminals.next, .dispatch)
        XCTAssertEqual(MainPage.dispatch.next, .rooms)
        XCTAssertEqual(MainPage.rooms.next, .browser)
        XCTAssertEqual(MainPage.browser.next, .clash)
        XCTAssertEqual(MainPage.clash.next, .terminals)
        XCTAssertEqual(MainPage.terminals.previous, .clash)
        XCTAssertEqual(MainPage.clash.previous, .browser)
        XCTAssertEqual(MainPage.browser.previous, .rooms)
        XCTAssertEqual(MainPage.rooms.previous, .dispatch)
        XCTAssertEqual(MainPage.dispatch.previous, .terminals)
    }

    func testEveryPageIsDark() {
        // Since 2026-11-24 a choice: following the system, only Terminals stays dark; Always Dark, all of them.
        let kept = UserDefaults.standard.object(forKey: MainPage.followSystemKey)
        defer { UserDefaults.standard.set(kept, forKey: MainPage.followSystemKey) }
        UserDefaults.standard.set(true, forKey: MainPage.followSystemKey)
        XCTAssertEqual(MainPage.allCases.filter(\.alwaysDark), [.terminals])
        UserDefaults.standard.set(false, forKey: MainPage.followSystemKey)
        XCTAssertTrue(MainPage.allCases.allSatisfy(\.alwaysDark))
    }

    // MARK: activity

    func testTheTerminalsPageCountsThisMacsTerminals() {
        let there = LiveSnapshot.Node(id: "7c1e5a90b3d2", name: "Studio")
        let snapshot = LiveSnapshot(rows: [row("k1"), row("k2", waiting: true), row("k3"), row("k4", waiting: true, node: there)], now: t0)
        let terminals = PageActivity.terminals(in: snapshot)
        XCTAssertEqual(terminals, PageActivity(busy: 2, waiting: 1), "another node's are the menu bar's card's, not this page's")
        XCTAssertEqual(terminals.mark, .waiting, "anything waiting for you comes before busy")
        XCTAssertEqual(PageActivity.terminals(in: LiveSnapshot(rows: [row("k1")], now: t0)).mark, .busy)
    }

    func testNothingGoingOnHasNoMark() {
        XCTAssertEqual(PageActivity.terminals(in: nil), .none)
        XCTAssertEqual(PageActivity.terminals(in: LiveSnapshot(rows: [], now: t0)).mark, .none)
    }

    // MARK: the refresh

    func testThePageSwitchIsThePhonesRefreshAndTheTerminalSwitchAQuickerOne() {
        XCTAssertEqual(ScanRefresh.page.steps, 13)
        XCTAssertEqual(ScanRefresh.page.duration, 260, "0.26 s, as the phone and the web terminal")
        XCTAssertEqual(ScanRefresh.terminal.steps, 9)
        XCTAssertEqual(ScanRefresh.terminal.duration, 180, "0.18 s")
    }

    func testTheRefreshPlaysInThePixelLookAloneAndNotUnderReduceMotion() {
        XCTAssertTrue(ScanRefresh.plays(in: .pixel, reduceMotion: false))
        XCTAssertFalse(ScanRefresh.plays(in: .classic, reduceMotion: false), "the classic look changes pages at once")
        XCTAssertFalse(ScanRefresh.plays(in: .pixel, reduceMotion: true))
        XCTAssertFalse(ScanRefresh.plays(in: .classic, reduceMotion: true))
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

    func testFilesColumnOnEveryPage() {
        for page in MainPage.allCases {
            XCTAssertEqual(MainShortcut.action(for: MainShortcut.Press(key: "f", keyCode: 3, command: true, control: false, option: false, shift: true), on: page), .files)
        }
    }

    func testShortcutsOnBothPages() {
        for page in MainPage.allCases {
            XCTAssertEqual(MainShortcut.action(for: press("0"), on: page), .page(.dispatch))
            XCTAssertNil(MainShortcut.action(for: press("n"), on: page), "⌘N is the page's")
            XCTAssertEqual(MainShortcut.action(for: press(","), on: page), .settings)
            XCTAssertEqual(MainShortcut.action(for: press("\t", keyCode: MainShortcut.tab, command: false, control: true), on: page), .nextPage)
            XCTAssertEqual(MainShortcut.action(for: press("\t", keyCode: MainShortcut.tab, command: false, control: true, shift: true), on: page), .previousPage)
            XCTAssertEqual(MainShortcut.action(for: press("b", shift: true), on: page), .page(.browser), "⌘⇧B")
        }
    }

    func testTheBrowsersOwnKeys() {
        XCTAssertEqual(MainShortcut.action(for: press("t"), on: .browser), .browser(.newTab))
        XCTAssertEqual(MainShortcut.action(for: press("l"), on: .browser), .browser(.address))
        XCTAssertEqual(MainShortcut.action(for: press("r"), on: .browser), .browser(.reload))
        XCTAssertEqual(MainShortcut.action(for: press("["), on: .browser), .browser(.back))
        XCTAssertEqual(MainShortcut.action(for: press("]"), on: .browser), .browser(.forward))
        XCTAssertEqual(MainShortcut.action(for: press("b"), on: .browser), .browser(.toggleList), "⌘B: the tab list, as on Terminals")
        XCTAssertNil(MainShortcut.action(for: press("b"), on: .terminals), "the terminal page's own ⌘B")
        XCTAssertEqual(MainShortcut.action(for: press("2"), on: .browser), .terminal(2), "⌘1–9 cross to the terminals")
        for page in [MainPage.dispatch, .terminals] {
            XCTAssertNil(MainShortcut.action(for: press("l"), on: page))
            XCTAssertNil(MainShortcut.action(for: press("r"), on: page))
            XCTAssertNil(MainShortcut.action(for: press("]"), on: page))
        }
        XCTAssertEqual(MainShortcut.action(for: press("t", shift: true), on: .browser), .browser(.hold),
                       "⌘⇧T: the status bar's Take Over / Hand Back")
        XCTAssertNil(MainShortcut.action(for: press("t", shift: true), on: .terminals), "nothing to take over there")
        XCTAssertNil(MainShortcut.action(for: press("t", shift: true), on: .dispatch))
        XCTAssertNil(MainShortcut.action(for: press("a"), on: .browser), "⌘A is the page's")
        XCTAssertNil(MainShortcut.action(for: press("v"), on: .browser), "⌘V is the screen's")
        let esc = press("\u{1b}", keyCode: 53, command: false)
        XCTAssertNil(MainShortcut.action(for: esc, on: .browser), "Esc is the page's")
    }

    func testTheBrowsersZoomKeys() {
        // docs/browser-v0.md §1 页面缩放 (2026-10-03): ⌘= and ⌘+ zoom in, ⌘− out; the keypad's keys too.
        let keypadPlus: UInt16 = 69, keypadMinus: UInt16 = 78
        XCTAssertEqual(MainShortcut.action(for: press("="), on: .browser), .browser(.zoomIn), "⌘=")
        XCTAssertEqual(MainShortcut.action(for: press("+", shift: true), on: .browser), .browser(.zoomIn), "⌘+ is ⌘⇧= on most layouts")
        XCTAssertEqual(MainShortcut.action(for: press("+"), on: .browser), .browser(.zoomIn), "a layout with + on a key of its own")
        XCTAssertEqual(MainShortcut.action(for: press("=", shift: true), on: .browser), .browser(.zoomIn), "a layout with = under shift")
        XCTAssertEqual(MainShortcut.action(for: press("+", keyCode: keypadPlus), on: .browser), .browser(.zoomIn), "the keypad's +")
        XCTAssertEqual(MainShortcut.action(for: press("-"), on: .browser), .browser(.zoomOut), "⌘−")
        XCTAssertEqual(MainShortcut.action(for: press("-", keyCode: keypadMinus), on: .browser), .browser(.zoomOut), "the keypad's −")
        XCTAssertEqual(MainShortcut.action(for: press("0"), on: .browser), .page(.dispatch), "⌘0 stays Dispatch: Actual Size has no key")
        for key in ["=", "+", "-"] {
            XCTAssertNil(MainShortcut.action(for: press(key, command: false), on: .browser), "typed into the page")
            XCTAssertNil(MainShortcut.action(for: press(key, control: true), on: .browser), "not with control")
            let option = MainShortcut.Press(key: key, keyCode: 0, command: true, control: false, option: true, shift: false)
            XCTAssertNil(MainShortcut.action(for: option, on: .browser), "⌥⌘= ⌥⌘− are the system's zoom")
            for page in [MainPage.dispatch, .terminals] {
                XCTAssertNil(MainShortcut.action(for: press(key), on: page), "only the Browser page has a page to zoom")
            }
        }
    }

    func testTheTerminalsShortcutsCrossFromDispatchAndAreThePagesOnTerminals() {
        XCTAssertEqual(MainShortcut.action(for: press("3"), on: .dispatch), .terminal(3))
        XCTAssertEqual(MainShortcut.action(for: press("t"), on: .dispatch), .newTerminal)
        XCTAssertNil(MainShortcut.action(for: press("3"), on: .terminals), "the terminal page's own ⌘1–9")
        XCTAssertNil(MainShortcut.action(for: press("t"), on: .terminals), "the terminal page's own ⌘T")
        XCTAssertNil(MainShortcut.action(for: press("b"), on: .dispatch), "⌘B is the terminals' list")
    }

    func testEscAndBackAreThePagesOwn() {
        let esc = press("\u{1b}", keyCode: 53, command: false)
        for page in MainPage.allCases {
            XCTAssertNil(MainShortcut.action(for: esc, on: page), "Esc is the page's own")
            if page != .browser { XCTAssertNil(MainShortcut.action(for: press("["), on: page)) }
        }
    }

    // MARK: the rail, put away (2026-10-04)

    func testTheRailIsShownUntilItIsPutAway() {
        XCTAssertFalse(MainRailLayout.hidden(nil), "the first time")
        XCTAssertTrue(MainRailLayout.hidden(true))
        XCTAssertFalse(MainRailLayout.hidden(false))
        XCTAssertLessThan(MainRailLayout.stripWidth, MainRailLayout.width / 4, "the edge, not a narrower rail")
        XCTAssertLessThan(MainRailLayout.barWidth, MainRailLayout.stripWidth, "a bar stands out of the edge inside the strip")
        XCTAssertGreaterThan(MainRailLayout.longBar, MainRailLayout.shortBar)
    }

    func testAPutAwayRailLeavesABarOnlyWhereThereIsSomethingToSay() {
        // The page on screen: a long bar in the colour of what is selected, still. Another page with nothing going on:
        // no bar at all.
        XCTAssertEqual(RailBar.of(current: true, activity: .none), RailBar(long: true, tone: .selected, pace: .still))
        XCTAssertNil(RailBar.of(current: false, activity: .none))
    }

    func testABarsColourSaysOneThing() {
        // Amber is what waits for you, on the page on screen too; the selected colour is only ever the page on screen;
        // work under way elsewhere is ink.
        XCTAssertEqual(RailBar.of(current: false, activity: .busy), RailBar(long: false, tone: .ink, pace: .slow))
        XCTAssertEqual(RailBar.of(current: true, activity: .busy), RailBar(long: true, tone: .selected, pace: .slow), "where you are, and alive")
        XCTAssertEqual(RailBar.of(current: false, activity: .waiting), RailBar(long: false, tone: .waiting, pace: .quick))
        XCTAssertEqual(RailBar.of(current: true, activity: .waiting), RailBar(long: true, tone: .waiting, pace: .quick), "amber wins")
        for activity in [PageActivity.Mark.none, .busy, .waiting] {
            XCTAssertNotEqual(RailBar.of(current: false, activity: activity)?.tone, .selected, "never a page you are not on")
            XCTAssertEqual(RailBar.of(current: true, activity: activity)?.long, true, "its length says where you are")
            XCTAssertNotEqual(RailBar.of(current: false, activity: activity)?.long, true)
        }
    }

    func testABarBreathesOnlyWhileSomethingGoesOn() {
        for current in [true, false] {
            XCTAssertEqual(RailBar.of(current: current, activity: .busy)?.pace, .slow)
            XCTAssertEqual(RailBar.of(current: current, activity: .waiting)?.pace, .quick, "what waits for you is the more pressing")
        }
        XCTAssertEqual(RailBar.of(current: true, activity: .none)?.pace, .still)
    }

    func testOptionCommandBPutsTheRailAwayAndBringsItBackOnEveryPage() {
        let key = MainShortcut.Press(key: "b", keyCode: 11, command: true, control: false, option: true, shift: false)
        for page in MainPage.allCases {
            XCTAssertEqual(MainShortcut.action(for: key, on: page), .toggleRail)
            XCTAssertEqual(MainShortcut.action(for: key, on: page), .toggleRail)
        }
        var shifted = key
        shifted.shift = true
        XCTAssertNil(MainShortcut.action(for: shifted, on: .terminals))
        XCTAssertNil(MainShortcut.action(for: press("b"), on: .terminals), "⌘B is still the list's")
        XCTAssertEqual(MainRailLayout.help(hidden: false), "Hide Rail ⌥⌘B")
        XCTAssertEqual(MainRailLayout.help(hidden: true), "Show Rail ⌥⌘B")
    }

    func testOtherModifiersAreNotTheseShortcuts() {
        XCTAssertNil(MainShortcut.action(for: press("n", shift: true), on: .dispatch))
        XCTAssertNil(MainShortcut.action(for: press("0", command: false), on: .dispatch))
        XCTAssertNil(MainShortcut.action(for: press("\t", keyCode: MainShortcut.tab, command: false), on: .dispatch), "plain Tab")
        XCTAssertNil(MainShortcut.action(for: press("12"), on: .dispatch))
    }

    // MARK: the status bar

    func testTheServiceWord() {
        XCTAssertEqual(MainStatus.service(StatusLine("OK", .ok)), MainStatus.Word("Service", .ok))
        XCTAssertEqual(MainStatus.service(StatusLine("Starting", .busy)), MainStatus.Word("Starting", .busy))
        XCTAssertEqual(MainStatus.service(StatusLine("Failed", .error)), MainStatus.Word("Service Down", .failed))
        XCTAssertEqual(MainStatus.service(StatusLine("Stopped", .off)), MainStatus.Word("Service Down", .failed))
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

    func testTheBarSaysWhenTheServiceIsDown() {
        XCTAssertNil(ServiceTrouble.word(service: StatusLine("OK", .ok)))
        XCTAssertNil(ServiceTrouble.word(service: StatusLine("Starting", .busy)), "starting is not down")
        XCTAssertEqual(ServiceTrouble.word(service: StatusLine("Failed", .error)), "Service Down")
        XCTAssertEqual(ServiceTrouble.word(service: StatusLine("No Response", .warning)), "Service Down")
        XCTAssertEqual(ServiceTrouble.word(service: StatusLine("Stopped", .off)), "Service Down")
    }
}

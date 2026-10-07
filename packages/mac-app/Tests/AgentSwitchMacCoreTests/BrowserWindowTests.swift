import XCTest
@testable import AgentSwitchMacCore

/// The Browser page when the browser's tabs have windows of their own (docs/browser-v0.md §7.2; design page
/// implemented/browser-window.html): the list says so, a window is brought forward and pictured, and the detail pane's
/// words and buttons for a tab of yours, an agent's, one you stepped into, one a phone holds.
final class BrowserWindowTests: XCTestCase {
    func testABrowserThatWasJustStartedGivesTheFrontBackUnlessItWasAskedFor() {
        // Started by the service (an agent opened a tab) while the person works elsewhere.
        XCTAssertTrue(BrowserFrontPolicy.givesBack(sinceStarted: 0.4, sinceAsked: nil, hasPrevious: true, done: 0))
        XCTAssertTrue(BrowserFrontPolicy.givesBack(sinceStarted: 3, sinceAsked: 60, hasPrevious: true, done: 1))
        // Asked for here a moment ago: Show Window, a tab opened on the Browser page.
        XCTAssertFalse(BrowserFrontPolicy.givesBack(sinceStarted: 0.4, sinceAsked: 1, hasPrevious: true, done: 0))
        // Still coming up with its tabs, twenty seconds in.
        XCTAssertTrue(BrowserFrontPolicy.givesBack(sinceStarted: 20, sinceAsked: nil, sinceClick: 40, hasPrevious: true, done: 0))
        // The person clicked it forward (its window, its Dock icon) a moment before.
        XCTAssertFalse(BrowserFrontPolicy.givesBack(sinceStarted: 3, sinceAsked: nil, sinceClick: 0.2, hasPrevious: true, done: 0))
        // It has been up for a while: whoever brings it forward now means it.
        XCTAssertFalse(BrowserFrontPolicy.givesBack(sinceStarted: 45, sinceAsked: nil, hasPrevious: true, done: 0))
        XCTAssertFalse(BrowserFrontPolicy.givesBack(sinceStarted: nil, sinceAsked: nil, hasPrevious: true, done: 0))
        // Brought forward again and again right after: the person insists.
        XCTAssertFalse(BrowserFrontPolicy.givesBack(sinceStarted: 2, sinceAsked: nil, hasPrevious: true, done: 2))
        XCTAssertFalse(BrowserFrontPolicy.givesBack(sinceStarted: 0.4, sinceAsked: nil, hasPrevious: false, done: 0))
    }

    private func tab(_ owner: BrowserOwner = .you, held: String? = nil, url: String = "https://github.com/l0tk3/AgentSwitch/pulls",
                     status: BrowserTabStatus = .idle, action: BrowserAction? = nil) -> BrowserTab {
        BrowserTab(id: "t1", owner: owner, title: "Pull requests", url: url, site: "github.com", kind: .web, status: status, heldBy: held, action: action)
    }

    private let codex = BrowserOwner(kind: .terminal, id: "k1", label: "codex · AgentSwitch")

    func testTheListSaysWhichBrowserItIsAndWhetherItsTabsHaveWindows() throws {
        let with = try JSONDecoder().decode(BrowserTabList.self, from: Data(#"{"running":true,"groups":[],"engine":"camoufox","windows":true}"#.utf8))
        XCTAssertEqual(with.engine, "camoufox")
        XCTAssertTrue(with.windows)
        // A service from before windows: Chrome, pictures.
        let before = try JSONDecoder().decode(BrowserTabList.self, from: Data(#"{"running":true,"groups":[]}"#.utf8))
        XCTAssertEqual(before.engine, "chrome")
        XCTAssertFalse(before.windows)
        XCTAssertFalse(BrowserTabList.empty.windows)
    }

    func testAWindowIsBroughtForwardAndPicturedOverTheLocalAPI() async throws {
        let transport = StubTransport { request in
            request.url!.path.hasSuffix("/preview") ? (200, "JPEG") : (200, #"{"ok":true}"#)
        }
        let client = DaemonClient(port: 1, transport: transport)
        try await client.showTab(id: "a b")
        let picture = try await client.tabPreview(id: "t1")
        XCTAssertEqual(String(decoding: picture, as: UTF8.self), "JPEG")
        XCTAssertEqual(transport.requests.map { "\($0.httpMethod!) \($0.url!.path(percentEncoded: true))" }, ["POST /browser/tabs/a%20b/show", "GET /browser/tabs/t1/preview"])
    }

    func testWhoHasATabAndWhatCanBeDoneWithIt() {
        // Your own tab.
        let mine = tab()
        XCTAssertEqual(BrowserWindowText.state(mine), .yours)
        XCTAssertEqual(BrowserWindowText.who(mine), "You")
        XCTAssertEqual(BrowserWindowText.buttons(mine), [.show, .fill, .copy, .close])
        XCTAssertEqual(BrowserWindowText.primary(mine), .show)
        // Not http(s): nothing to fill a ciphertext into.
        XCTAssertEqual(BrowserWindowText.buttons(tab(url: "file:///Users/me/site/index.html")), [.show, .copy, .close])

        // An agent's, at work.
        let theirs = tab(codex, status: .busy, action: BrowserAction(tool: "browser_click", description: #"click "Merge pull request""#))
        XCTAssertEqual(BrowserWindowText.state(theirs), .agent)
        XCTAssertEqual(BrowserWindowText.who(theirs), "codex · AgentSwitch")
        XCTAssertEqual(BrowserWindowText.doing(theirs), #"click "Merge pull request""#)
        XCTAssertEqual(BrowserWindowText.buttons(theirs), [.show, .copy, .close])
        XCTAssertTrue(BrowserWindowText.hint(theirs).contains("在它的窗口里操作即视为接手"))

        // You acted in its window: yours until you hand it back.
        let took = tab(codex, held: BrowserDefaults.windowScreen)
        XCTAssertEqual(BrowserWindowText.state(took), .steppedIn)
        XCTAssertEqual(BrowserWindowText.who(took), "You · Taken Over from Codex")
        XCTAssertEqual(BrowserWindowText.buttons(took), [.handBack, .show, .copy])
        XCTAssertEqual(BrowserWindowText.primary(took), .handBack)
        XCTAssertEqual(BrowserWindowText.hint(took), "2 分钟无操作将自动交还。agent 排队等待的操作在交还后继续。")

        // A phone has it: its window is the phone's size meanwhile.
        let away = tab(codex, held: "phone-1a2b3c4d")
        XCTAssertEqual(BrowserWindowText.state(away), .elsewhere)
        XCTAssertEqual(BrowserWindowText.doing(away), "On iPhone · Phone Size")
        XCTAssertEqual(BrowserWindowText.buttons(away), [.show, .copy])
        XCTAssertEqual(BrowserWindowText.hint(away), "正在 iPhone 上使用。手机交还后窗口恢复原来的大小。")
        XCTAssertEqual(BrowserWindowText.doing(tab(held: "dev-9")), "On Another Device")
    }

    func testTheRowsTagSaysWhoHoldsATab() {
        XCTAssertNil(BrowserWindowText.tag(tab()))
        XCTAssertEqual(BrowserWindowText.tag(tab(codex, held: BrowserDefaults.windowScreen)), "You")
        XCTAssertEqual(BrowserWindowText.tag(tab(codex, held: "phone-1a2b3c4d")), "On iPhone")
    }

    func testWhereTheBrowsersOwnAppIs() {
        let home = URL(fileURLWithPath: "/Users/me/Library/Application Support/AgentSwitch")
        XCTAssertEqual(BrowserEngineLocation.camoufoxApp(agentswitchHome: home).path, "/Users/me/Library/Application Support/AgentSwitch/browser/engine/camoufox/current/Camoufox.app")
    }
}

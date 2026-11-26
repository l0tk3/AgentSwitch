import XCTest
@testable import AgentSwitchMacCore

/// A terminal's tabs for the simple view's side pane (`GET /terminals/:id/browser`, docs/browser-v0.md §9): the browser
/// it uses and its tabs as the service sorted them; the picture's stream kept small.
final class TerminalBrowserTests: XCTestCase {
    func testDecodesTheBrowserAndTheTabsInOrder() throws {
        let json = #"{"browser":"claude-code.abc123def0","tabs":[{"id":"b2","owner":{"kind":"terminal","id":"t1","label":"claude · x"},"title":"Sign in","url":"https://a.example/","site":"a.example","kind":"web","status":"waiting","usedAt":5},{"id":"b1","title":"","url":"about:blank","kind":"blank","usedAt":1}]}"#
        let got = try JSONDecoder().decode(TerminalBrowserTabs.self, from: Data(json.utf8))
        XCTAssertEqual(got.browser, "claude-code.abc123def0")
        XCTAssertEqual(got.tabs.map(\.id), ["b2", "b1"])
        XCTAssertEqual(got.tabs[0].status, .waiting)
        XCTAssertEqual(got.tabs[0].owner.id, "t1")
        let shared = try JSONDecoder().decode(TerminalBrowserTabs.self, from: Data(#"{"browser":null,"tabs":[]}"#.utf8))
        XCTAssertEqual(shared, .none)
    }

    func testThePictureStreamIsSmallAndSlow() {
        let options = TerminalBrowserTabs.stream(width: 360, backingScale: 2)
        XCTAssertEqual(options.fps, 2)
        XCTAssertEqual(options.maxWidth, 720)
        XCTAssertNil(options.scale)
        XCTAssertEqual(TerminalBrowserTabs.stream(width: 2000, backingScale: 2).maxWidth, 960)
        XCTAssertEqual(TerminalBrowserTabs.stream(width: 50, backingScale: 1).maxWidth, 200)
    }
}

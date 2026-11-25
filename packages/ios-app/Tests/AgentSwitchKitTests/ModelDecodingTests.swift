import XCTest
@testable import AgentSwitchKit

final class ModelDecodingTests: XCTestCase {
    func testMeAcceptsIdOrDeviceId() throws {
        XCTAssertEqual(try JSONDecoder().decode(Me.self, from: Data(#"{"id":"d1","name":"iPhone"}"#.utf8)).deviceId, "d1")
        XCTAssertEqual(try JSONDecoder().decode(Me.self, from: Data(#"{"deviceId":"d2"}"#.utf8)).deviceId, "d2")
        XCTAssertNil(try JSONDecoder().decode(Me.self, from: Data("{}".utf8)).deviceId)
    }

    /// Codex wraps every command in a login shell; the line shows what it runs.
    func testAShellWrapperIsTakenOffACommand() {
        XCTAssertEqual(EventDescriber.unwrapShell("/bin/zsh -lc 'ps -A | head'"), "ps -A | head")
        XCTAssertEqual(EventDescriber.unwrapShell(#"bash -c "git status""#), "git status")
        XCTAssertEqual(EventDescriber.unwrapShell("ls -la"), "ls -la")
        XCTAssertEqual(EventDescriber.unwrapShell("/bin/zsh -lc ''"), "/bin/zsh -lc ''", "nothing inside: as it is")
    }

    func testToolsAsPeopleSayThem() {
        XCTAssertEqual(ToolDisplay.label("Bash"), "运行")
        XCTAssertEqual(ToolDisplay.label("commandExecution"), "运行")
        XCTAssertEqual(ToolDisplay.label("mcp__playwright__browser_click"), "浏览器 · 点击")
        XCTAssertEqual(ToolDisplay.label("playwright.browser_snapshot"), "浏览器 · 读取页面")
        XCTAssertEqual(ToolDisplay.label("mcp__github__list_issues"), "github · list_issues")
        XCTAssertEqual(ToolDisplay.word("apply_patch"), "Edit")
        XCTAssertEqual(ToolDisplay.word("browser_navigate"), "Web")
        XCTAssertEqual(ToolDisplay.word("something_new"), "Tool")
    }
}

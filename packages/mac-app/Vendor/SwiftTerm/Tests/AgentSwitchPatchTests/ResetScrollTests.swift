// AgentSwitch's patch "A reset follows the bottom again" (PATCHES.md): the Terminals page shows another terminal in the
// same screen by resetting it and feeding the new terminal's snapshot; a viewport scrolled back in the one before must
// not leave the new one shown from the top of its scrollback.
import XCTest
@testable import SwiftTerm

final class ResetScrollTests: XCTestCase {
    private final class Quiet: TerminalDelegate {
        func send(source: Terminal, data: ArraySlice<UInt8>) {}
    }

    private let quiet = Quiet()

    private func lines(_ count: Int, _ word: String) -> String {
        (1...count).map { "\(word) \($0)" }.joined(separator: "\r\n")
    }

    func testOutputAfterAResetFollowsTheBottomThoughTheViewportHadBeenScrolledBack() {
        let terminal = Terminal(delegate: quiet, options: TerminalOptions(cols: 40, rows: 10))
        terminal.feed(text: lines(60, "first"))
        // The user scrolls back in the first terminal (what the view's scroller and wheel do).
        terminal.userScrolling = true
        terminal.buffer.yDisp = 20

        terminal.resetToInitialState()
        XCTAssertFalse(terminal.userScrolling)
        terminal.feed(text: lines(80, "second"))

        XCTAssertGreaterThan(terminal.buffer.yBase, 0)
        XCTAssertEqual(terminal.buffer.yDisp, terminal.buffer.yBase)
    }

    func testOutputWithoutAResetKeepsAViewportTheUserScrolledBack() {
        let terminal = Terminal(delegate: quiet, options: TerminalOptions(cols: 40, rows: 10))
        terminal.feed(text: lines(60, "first"))
        terminal.userScrolling = true
        terminal.buffer.yDisp = 20

        terminal.feed(text: "\r\n" + lines(5, "more"))

        XCTAssertEqual(terminal.buffer.yDisp, 20)
        XCTAssertGreaterThan(terminal.buffer.yBase, 20)
    }
}

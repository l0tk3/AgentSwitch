import XCTest
@testable import AgentSwitchMacCore

/// What is typed on a terminal screen on its way to the service (docs/app-v0.md §4 省电第二轮): one request under way
/// at a time, what comes meanwhile going together in the next.
final class TerminalWriteQueueTests: XCTestCase {
    func testTheFirstBytesGoAtOnceAndWhatComesMeanwhileGoesTogether() {
        var queue = TerminalWriteQueue()
        queue.add(Array("a".utf8))
        XCTAssertEqual(queue.next(), "a")
        // A pointer crossing an agent's screen with mouse tracking on: a report a cell.
        queue.add(Array("\u{1b}[<35;10;5M".utf8))
        queue.add(Array("\u{1b}[<35;11;5M".utf8))
        XCTAssertNil(queue.next(), "one request under way: nothing more is sent yet")
        queue.sent()
        XCTAssertEqual(queue.next(), "\u{1b}[<35;10;5M\u{1b}[<35;11;5M")
        queue.sent()
        XCTAssertNil(queue.next(), "nothing waits")
    }

    func testNothingToSendIsNothing() {
        var queue = TerminalWriteQueue()
        XCTAssertNil(queue.next())
        XCTAssertNil(queue.drain())
        queue.sent()
        queue.add([])
        XCTAssertNil(queue.next())
    }

    /// A named key must come after what was typed before it: what waits goes now, behind the request under way.
    func testDrainingGivesWhatWaitsWhateverIsUnderWay() {
        var queue = TerminalWriteQueue()
        queue.add(Array("ls".utf8))
        XCTAssertEqual(queue.next(), "ls")
        queue.add(Array(" -la".utf8))
        XCTAssertEqual(queue.drain(), " -la")
        XCTAssertNil(queue.drain())
        // The request that was under way ends: nothing is left behind, and the next bytes go at once.
        queue.sent()
        XCTAssertNil(queue.next())
        queue.add(Array("x".utf8))
        XCTAssertEqual(queue.next(), "x")
    }

    func testDroppingForgetsWhatWaits() {
        var queue = TerminalWriteQueue()
        queue.add(Array("typed for another terminal".utf8))
        queue.drop()
        XCTAssertNil(queue.next())
        // A request under way when the terminal changed still ends; the queue is ready after it.
        queue.add(Array("a".utf8))
        XCTAssertEqual(queue.next(), "a")
        queue.drop()
        queue.add(Array("b".utf8))
        XCTAssertNil(queue.next())
        queue.sent()
        XCTAssertEqual(queue.next(), "b")
    }

    /// Bytes of one character typed apart (an input method, a paste cut mid-character) are sent whole.
    func testBytesAreJoinedBeforeTheyAreRead() {
        var queue = TerminalWriteQueue()
        let bytes = Array("中".utf8)
        queue.add(Array(bytes[0..<1]))
        queue.add(Array(bytes[1...]))
        XCTAssertEqual(queue.next(), "中")
    }
}

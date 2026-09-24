import XCTest
@testable import AgentSwitchKit

final class SSEParserTests: XCTestCase {
    func testDaemonStreamFixture() throws {
        var parser = SSEParser()
        let messages = parser.feed(try Fixture.data("events.sse"))
        XCTAssertEqual(messages.map(\.event), ["queued", "dispatched", "text", "approval_request", "done"])
        XCTAssertEqual(messages.map(\.id), ["1", "2", "3", "4", "5"])
        let events = messages.compactMap { AgentSwitchAPI.taskEvent(from: $0, taskId: "t_1") }
        XCTAssertEqual(events.map(\.seq), [1, 2, 3, 4, 5])
        XCTAssertEqual(events[2].payload["text"]?.string, "第一行\n第二行 ✓")
        XCTAssertTrue(events[4].endsStream)
    }

    func testAnyChunkingGivesTheSameEvents() throws {
        let data = try Fixture.data("events.sse")
        var whole = SSEParser()
        let expected = whole.feed(data)
        for size in [1, 2, 3, 7, 64] {
            var parser = SSEParser()
            var got: [SSEMessage] = []
            var i = data.startIndex
            while i < data.endIndex {
                let end = data.index(i, offsetBy: size, limitedBy: data.endIndex) ?? data.endIndex
                got += parser.feed(data[i..<end])
                i = end
            }
            XCTAssertEqual(got, expected, "chunk size \(size)")
        }
    }

    func testLineEndingsCommentsMultilineAndBOM() {
        var parser = SSEParser()
        let text = "\u{FEFF}: hello\r\nevent: a\r\ndata: one\r\ndata:two\r\ndata\r\nretry: 3000\r\n\r\n" + "id: 9\rdata: cr\r\r" + "data: lf\n\n"
        let messages = parser.feed(Data(text.utf8))
        XCTAssertEqual(messages, [
            SSEMessage(id: nil, event: "a", data: "one\ntwo\n", retry: 3000),
            SSEMessage(id: "9", event: "message", data: "cr", retry: 3000),
            SSEMessage(id: "9", event: "message", data: "lf", retry: 3000),
        ])
    }

    func testCRLFSplitAcrossChunks() {
        var parser = SSEParser()
        XCTAssertEqual(parser.feed(Data("data: x\r".utf8)), [])
        XCTAssertEqual(parser.feed(Data("\n\r\n".utf8)), [SSEMessage(id: nil, event: "message", data: "x")])
    }

    func testIncompleteEventIsNotDispatchedAndEmptyDataIsSkipped() {
        var parser = SSEParser()
        XCTAssertEqual(parser.feed(Data("event: only\n\ndata: half".utf8)), [])
        XCTAssertEqual(parser.lastId, nil)
    }

    func testForeignOrBrokenFramesAreSkipped() {
        XCTAssertNil(AgentSwitchAPI.taskEvent(from: SSEMessage(id: "1", event: "text", data: "{bad"), taskId: "t"))
        let other = #"{"taskId":"other","seq":1,"ts":1,"type":"text","payload":{}}"#
        XCTAssertNil(AgentSwitchAPI.taskEvent(from: SSEMessage(id: "1", event: "text", data: other), taskId: "t"))
    }
}

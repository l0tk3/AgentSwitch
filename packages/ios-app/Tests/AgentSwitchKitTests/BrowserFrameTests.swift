import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import AgentSwitchKit

/// A tab's frames on their way to the phone's screen (docs/browser-v0.md §1 画面流; 2026-10-02 review): only the newest
/// waits, between the connection and the page and again while one is decoded; decoding is off the main thread.
final class BrowserFrameTests: XCTestCase {
    private func frame(_ seq: Int, jpeg: Data = Data()) -> BrowserEvent {
        .frame(BrowserFrame(seq: seq, jpeg: jpeg, width: 4, height: 3))
    }

    private func seqs(_ events: [BrowserEvent?]) -> [String] {
        events.map { event in
            switch event {
            case .frame(let f)?: return "f\(f.seq)"
            case .title(let t)?: return t
            case nil: return "end"
            default: return "other"
            }
        }
    }

    // MARK: the buffer

    func testOnlyTheNewestFrameWaitsAndChangesKeepTheirOrder() async throws {
        let buffer = BrowserEventBuffer()
        for n in 1...5 { buffer.push(frame(n)) }
        buffer.push(.title("a"))
        buffer.push(frame(6))
        buffer.push(frame(7))
        buffer.push(.title("b"))
        XCTAssertEqual(buffer.count, 3)
        buffer.finish()
        var got: [BrowserEvent?] = []
        for _ in 0..<4 { got.append(try await buffer.next()) }
        XCTAssertEqual(seqs(got), ["a", "f7", "b", "end"])
    }

    func testAtMostTheLimitWaitsTheOldestGoing() async throws {
        let buffer = BrowserEventBuffer(limit: 3)
        for t in ["a", "b", "c", "d", "e"] { buffer.push(.title(t)) }
        buffer.finish()
        var got: [BrowserEvent?] = []
        for _ in 0..<4 { got.append(try await buffer.next()) }
        XCTAssertEqual(seqs(got), ["c", "d", "e", "end"])
    }

    func testAWaitingReaderGetsTheEventAtOnceAndAnErrorComesAfterWhatWaits() async throws {
        let buffer = BrowserEventBuffer()
        let reader = Task { try await buffer.next() }
        try await Task.sleep(for: .milliseconds(20))
        buffer.push(frame(1))
        let first = try await reader.value
        XCTAssertEqual(seqs([first]), ["f1"])
        buffer.push(.title("last"))
        buffer.finish(throwing: APIError.http(status: 500, message: "x"))
        buffer.push(.title("after the end"))
        let last = try await buffer.next()
        XCTAssertEqual(seqs([last]), ["last"])
        do {
            _ = try await buffer.next()
            XCTFail("the error after what was waiting")
        } catch {
            XCTAssertEqual(error as? APIError, .http(status: 500, message: "x"))
        }
        let after = try await buffer.next()
        XCTAssertNil(after, "thrown once")
    }

    func testACancelledReaderEndsAndStopsTheConnection() async throws {
        let buffer = BrowserEventBuffer()
        let stopped = expectation(description: "the producer is told")
        buffer.whenCancelled { stopped.fulfill() }
        let reader = Task { try await buffer.next() }
        try await Task.sleep(for: .milliseconds(20))
        reader.cancel()
        let got = try await reader.value
        XCTAssertNil(got)
        await fulfillment(of: [stopped], timeout: 1)
        buffer.push(frame(1))
        XCTAssertEqual(buffer.count, 0, "nothing kept once the reader is gone")
        let late = expectation(description: "told at once")
        buffer.whenCancelled { late.fulfill() }
        await fulfillment(of: [late], timeout: 1)
    }

    func testTheStreamStopsConnectingWhenItsReaderGoes() async throws {
        let lan = APIEndpoint(host: "192.168.1.5", port: 4713, kind: .lan)
        let transport = FakeTransport(stream: { req, _ in (httpResponse(req.url, contentType: "text/event-stream"), [], APIError.transport("dropped")) })
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")
        let reader = Task {
            var n = 0
            for try await event in api.browserEvents("a1", options: BrowserStreamPolicy.local,
                                                     policy: ReconnectPolicy(initial: .milliseconds(5), maximum: .milliseconds(5))) {
                if case .dropped = event { n += 1 }
            }
            return n
        }
        try await Task.sleep(for: .milliseconds(60))
        reader.cancel()
        _ = try await reader.value
        // A connection already being made when the reader went may still go out; none after that.
        try await Task.sleep(for: .milliseconds(30))
        let made = transport.requests.count
        try await Task.sleep(for: .milliseconds(80))
        XCTAssertEqual(transport.requests.count, made, "no connection after the reader went")
    }

    // MARK: decoding

    private func jpeg(width: Int, height: Int) throws -> Data {
        let ctx = try XCTUnwrap(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                          space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
        ctx.setFillColor(CGColor(red: 0.2, green: 0.6, blue: 0.9, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let out = NSMutableData()
        let dest = try XCTUnwrap(CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(dest, try XCTUnwrap(ctx.makeImage()), nil)
        XCTAssertTrue(CGImageDestinationFinalize(dest))
        return out as Data
    }

    func testAFrameDecodesToItsPicture() throws {
        let decoded = try XCTUnwrap(BrowserDecodedFrame.decode(BrowserFrame(seq: 3, jpeg: try jpeg(width: 40, height: 30), width: 40, height: 30)))
        XCTAssertEqual(decoded.image.width, 40)
        XCTAssertEqual(decoded.image.height, 30)
        XCTAssertEqual(decoded.frame.seq, 3)
        XCTAssertNil(BrowserDecodedFrame.decode(BrowserFrame(seq: 4, jpeg: Data("not a picture".utf8), width: 1, height: 1)))
    }

    @MainActor
    func testFramesThatComeWhileOneIsDecodedOnlyTheNewestIsShown() async throws {
        let data = try jpeg(width: 64, height: 48)
        let decoder = BrowserFrameDecoder()
        var shown: [Int] = []
        decoder.onFrame = { shown.append($0.frame.seq) }
        for n in 1...5 { decoder.take(BrowserFrame(seq: n, jpeg: data, width: 64, height: 48)) }
        try await waitUntil { shown.last == 5 }
        XCTAssertEqual(shown, [5], "the ones waiting were replaced before the decode began")
        decoder.take(BrowserFrame(seq: 6, jpeg: data, width: 64, height: 48))
        try await waitUntil { shown.last == 6 }
        // A reset drops a decode under way: the frame from before it never shows.
        decoder.take(BrowserFrame(seq: 7, jpeg: data, width: 64, height: 48))
        decoder.reset()
        decoder.take(BrowserFrame(seq: 8, jpeg: data, width: 64, height: 48))
        try await waitUntil { shown.last == 8 }
        XCTAssertEqual(shown, [5, 6, 8])
    }

    @MainActor
    private func waitUntil(_ done: () -> Bool) async throws {
        for _ in 0..<200 where !done() { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(done())
    }

    // MARK: names

    func testAgentsAreCalledByTheirNames() {
        let codex = BrowserTabOwner(kind: .terminal, id: "t9", label: "codex · AgentSwitch")
        XCTAssertEqual(codex.agentName(), "Codex")
        XCTAssertEqual(BrowserTabOwner(kind: .terminal, id: "t1", label: "claude · site").agentName(), "Claude Code")
        XCTAssertEqual(BrowserTabOwner(kind: .terminal, id: "t1", label: "opencode · site").agentName(), "OpenCode")
        XCTAssertEqual(BrowserTabOwner(kind: .task, id: "k", label: "登录财务平台").agentName(harness: "claude-code"), "Claude Code",
                       "the task's own agent")
        XCTAssertEqual(BrowserTabOwner(kind: .task, id: "k", label: "登录财务平台").agentName(), "登录财务平台")
    }
}

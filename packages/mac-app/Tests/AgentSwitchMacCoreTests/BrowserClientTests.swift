import XCTest
@testable import AgentSwitchMacCore

/// The shared browser's routes on the local API (docs/browser-v0.md §5; the daemon's api/browser.ts): what each call
/// sends, what it makes of the answers and refusals, and a tab's stream — events in order, reconnecting after a dropped
/// connection, ending on `closed`, failing when the tab is gone.
final class BrowserClientTests: XCTestCase {
    private typealias F = DispatchFixture
    private let fast = DispatchReconnectPolicy(initial: .milliseconds(5), maximum: .milliseconds(20))

    private func client(_ transport: DispatchFakeTransport) throws -> DaemonClient {
        let home = TestSupport.tempDir("browser")
        let token = home.appendingPathComponent(DaemonClient.tokenFileName)
        try "tok-b".write(to: token, atomically: true, encoding: .utf8)
        return DaemonClient(port: 4811, transport: transport, tokenFile: token)
    }

    private static func tab(_ id: String = "t1", heldBy: Any = NSNull()) -> Data {
        F.json(["tab": BrowserModelTests.tabObject(id, heldBy: heldBy)])
    }

    private static func sse(_ event: String, _ object: [String: Any]) -> Data {
        var withType = object
        withType["type"] = event
        return Data("event: \(event)\ndata: \(String(decoding: F.json(withType), as: UTF8.self))\n\n".utf8)
    }

    // MARK: calls

    func testEachCallSendsWhatTheDaemonTakes() async throws {
        let transport = DispatchFakeTransport { request, _ in
            switch (request.httpMethod ?? "", request.url?.path ?? "") {
            case ("GET", "/browser/tabs"): return (200, F.json(["running": true, "groups": []]))
            case ("POST", "/browser/tabs"): return (201, Self.tab("new"))
            case ("DELETE", _): return (200, F.json(["ok": true]))
            case ("POST", "/browser/tabs/t1/input"): return (200, F.json(["ok": true]))
            case ("GET", "/browser/servers"): return (200, F.json(["servers": [["port": 5173, "name": "vite", "cwd": "/x"]]]))
            default: return (200, Self.tab("t1", heldBy: "mac-main"))
            }
        }
        let c = try client(transport)
        let screen = BrowserDefaults.screen
        _ = try await c.browserTabs()
        let opened = try await c.openTab(.typed("localhost:5173"))
        XCTAssertEqual(opened.id, "new")
        _ = try await c.openTab(.path("~/x.html"))
        _ = try await c.openTab(.port(3000))
        try await c.closeTab(id: "a/b")
        try await c.sendInput(tabId: "t1", events: [.text("hi"), .key("Enter")], screen: screen)
        _ = try await c.navigate(tabId: "t1", to: .typed("github.com"), screen: screen)
        _ = try await c.history(tabId: "t1", .reload, screen: screen)
        let held = try await c.takeOver(tabId: "t1", screen: screen)
        XCTAssertEqual(held.heldBy, "mac-main")
        _ = try await c.handBack(tabId: "t1", screen: screen)
        _ = try await c.setViewport(tabId: "t1", BrowserViewportRequest(width: 900, height: 600, scale: 2), screen: screen)
        let servers = try await c.localServers()
        XCTAssertEqual(servers.map(\.name), ["vite"])

        XCTAssertEqual(transport.lines, [
            "GET /browser/tabs", "POST /browser/tabs", "POST /browser/tabs", "POST /browser/tabs", "DELETE /browser/tabs/a/b",
            "POST /browser/tabs/t1/input", "POST /browser/tabs/t1/navigate", "POST /browser/tabs/t1/navigate", "POST /browser/tabs/t1/take",
            "POST /browser/tabs/t1/release", "POST /browser/tabs/t1/viewport", "GET /browser/servers",
        ])
        XCTAssertEqual(transport.requests[4].url?.absoluteString, "http://127.0.0.1:4811/browser/tabs/a%2Fb", "an id is one path segment")
        let bodies = transport.requests.map(F.body)
        XCTAssertEqual(bodies[1] as NSDictionary?, ["url": "localhost:5173"])
        XCTAssertEqual(bodies[2] as NSDictionary?, ["path": "~/x.html"])
        XCTAssertEqual(bodies[3] as NSDictionary?, ["port": 3000])
        XCTAssertEqual(bodies[5]?["screen"] as? String, "mac-main")
        XCTAssertEqual((bodies[5]?["events"] as? [[String: Any]])?.map { $0["type"] as? String }, ["text", "key"])
        XCTAssertEqual(bodies[6] as NSDictionary?, ["url": "github.com", "screen": "mac-main"])
        XCTAssertEqual(bodies[7] as NSDictionary?, ["action": "reload", "screen": "mac-main"])
        XCTAssertEqual(bodies[8] as NSDictionary?, ["screen": "mac-main"])
        XCTAssertEqual(bodies[10] as NSDictionary?, ["width": 900, "height": 600, "scale": 2, "mobile": false, "screen": "mac-main"])
        for request in transport.requests {
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer tok-b")
        }
        XCTAssertEqual(transport.requests[1].timeoutInterval, BrowserTimeouts.open, "the first tab starts Chrome")
    }

    func testManyEventsGoInRequestsOfFifty() async throws {
        let transport = DispatchFakeTransport { _, _ in (200, F.json(["ok": true])) }
        let events = (0..<120).map { BrowserInputEvent.mouse(.move, x: Double($0), y: 0) }
        try await client(transport).sendInput(tabId: "t", events: events, screen: "mac-main")
        let counts = transport.requests.map { (F.body($0)?["events"] as? [Any])?.count ?? 0 }
        XCTAssertEqual(counts, [50, 50, 20])
        try await client(transport).sendInput(tabId: "t", events: [], screen: "mac-main")
        XCTAssertEqual(transport.requests.count, 3, "nothing to send, no request")
    }

    func testRefusalsComeBackInTheDaemonsWords() async throws {
        let transport = DispatchFakeTransport { request, _ in
            if request.url?.path == "/browser/servers" { return (404, Data("404 Not Found".utf8)) }
            if request.url?.path.hasSuffix("/input") == true { return (409, F.json(["error": "此标签由 agent 使用，请先接手。"])) }
            return (403, F.json(["error": "~/.ssh/id_ed25519 位于凭据目录中（SSH、云服务、GPG、钥匙串等），不在浏览器中打开。"]))
        }
        let c = try client(transport)
        do {
            _ = try await c.openTab(.path("~/.ssh/id_ed25519"))
            XCTFail("refused")
        } catch let error as DaemonError {
            XCTAssertEqual(error, .http(status: 403, message: "~/.ssh/id_ed25519 位于凭据目录中（SSH、云服务、GPG、钥匙串等），不在浏览器中打开。"))
            XCTAssertTrue(error.reason.hasPrefix("~/.ssh"))
        }
        do {
            try await c.sendInput(tabId: "t", events: [.text("x")], screen: "mac-main")
            XCTFail("refused")
        } catch let error as DaemonError {
            XCTAssertEqual(error.reason, "此标签由 agent 使用，请先接手。")
        }
        do {
            _ = try await c.localServers()
            XCTFail("no browser")
        } catch let error as DaemonError {
            guard case .notSupported = error else { return XCTFail("\(error)") }
        }
    }

    // MARK: the stream

    func testTheStreamDeliversInOrderUntilClosed() async throws {
        let frame = Self.sse("frame", ["seq": 1, "data": "AAAA", "format": "jpeg", "width": 1280, "height": 800, "scale": 1,
                                       "viewport": ["width": 1280, "height": 800], "pageScale": 1, "scrollX": 0, "scrollY": 0])
        let transport = DispatchFakeTransport.streaming({ _, _ in
            (200, [Self.sse("tab", ["tab": BrowserModelTests.tabObject("t1")]), frame.prefix(40), frame.dropFirst(40), Data(": ping\n\n".utf8),
                   Self.sse("title", ["title": "New"]), Data("event: mystery\ndata: {}\n\n".utf8), Self.sse("closed", ["reason": "closed"]),
                   Self.sse("title", ["title": "after the end"])], nil)
        })
        var got: [String] = []
        for try await event in try client(transport).tabStream(id: "t1", options: BrowserStreamOptions(quality: 80, fps: 15), policy: fast) {
            switch event {
            case .tab(let tab): got.append("tab \(tab.id)")
            case .frame(let frame): got.append("frame \(frame.seq)")
            case .title(let title): got.append("title \(title)")
            case .closed(let reason): got.append("closed \(reason?.rawValue ?? "-")")
            default: got.append("other")
            }
        }
        XCTAssertEqual(got, ["tab t1", "frame 1", "title New", "closed closed"])
        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(request.url?.absoluteString, "http://127.0.0.1:4811/browser/tabs/t1/stream?quality=80&fps=15")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "text/event-stream")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer tok-b")
    }

    func testADroppedConnectionIsFollowedAgain() async throws {
        let transport = DispatchFakeTransport.streaming({ _, n in
            switch n {
            case 0: return (200, [Self.sse("tab", ["tab": BrowserModelTests.tabObject("t1")])], DaemonError.unreachable("connection lost"))
            case 1: throw URLError(.networkConnectionLost)
            case 2: return (200, [Self.sse("title", ["title": "x"])], nil)   // the daemon restarted: ended without `closed`
            default: return (200, [Self.sse("tab", ["tab": BrowserModelTests.tabObject("t1")]), Self.sse("closed", ["reason": "shutdown"])], nil)
            }
        })
        var got: [String] = []
        for try await event in try client(transport).tabStream(id: "t1", options: BrowserStreamOptions(), policy: fast) {
            if case .tab = event { got.append("tab") }
            if case .title = event { got.append("title") }
            if case .closed(let reason) = event { got.append(reason?.rawValue ?? "-") }
        }
        XCTAssertEqual(got, ["tab", "title", "tab", "shutdown"])
        XCTAssertEqual(transport.requests.count, 4)
    }

    func testAGoneTabEndsTheStreamWithItsError() async throws {
        let transport = DispatchFakeTransport.streaming({ _, _ in (404, [F.json(["error": "not found"])], nil) })
        do {
            for try await _ in try client(transport).tabStream(id: "gone", options: BrowserStreamOptions(), policy: fast) {}
            XCTFail("a 404 ends it")
        } catch let error as DaemonError {
            XCTAssertEqual(error, .http(status: 404, message: "not found"))
        }
        XCTAssertEqual(transport.requests.count, 1, "not retried")
    }

    func testStreamOptionsStayInTheDaemonsRange() {
        XCTAssertEqual(BrowserStreamOptions(quality: 500, fps: 0, maxWidth: 800).query, "quality=100&fps=1&maxWidth=800")
        XCTAssertEqual(BrowserStreamOptions().query, "quality=\(BrowserDefaults.streamQuality)&fps=\(BrowserDefaults.streamFPS)")
    }
}

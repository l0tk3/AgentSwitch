import XCTest
@testable import AgentSwitchKit

/// The Browser tab's client side (docs/browser-v0.md §5): the list, a tab's stream, and what the phone may send.
final class BrowserTests: XCTestCase {
    private let lan = APIEndpoint(host: "192.168.1.5", port: 4713, kind: .lan)

    private func json(_ object: Any) -> Data { try! JSONSerialization.data(withJSONObject: object) }
    private func body(_ request: URLRequest) throws -> [String: Any] {
        try XCTUnwrap(request.httpBody.flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: Any] })
    }

    static var codexTab: [String: Any] { [
        "id": "a1", "owner": ["kind": "terminal", "id": "t9", "label": "codex · AgentSwitch"], "title": "Pull Request #128",
        "url": "https://github.com/acme/app/pull/128", "site": "github.com", "kind": "web", "status": "busy", "loading": false,
        "heldBy": NSNull(), "action": ["tool": "browser_click", "description": "click \"Merge\"", "box": ["x": 10, "y": 20, "width": 100, "height": 30], "at": 5],
        "viewport": ["width": 1280, "height": 800, "scale": 1, "mobile": false, "by": NSNull()], "openedAt": 1,
    ] }

    func testTheListDecodesByOwnerAndLeniently() throws {
        let list = try JSONDecoder().decode(BrowserTabList.self, from: json([
            "running": true,
            "groups": [
                ["owner": ["kind": "terminal", "id": "t9", "label": "codex · AgentSwitch"], "tabs": [Self.codexTab]],
                ["owner": ["kind": "task", "id": "k1", "label": "登录财务平台"], "tabs": [["id": "b2", "status": "waiting", "owner": ["kind": "task", "id": "k1", "label": "登录财务平台"],
                                                                                         "action": ["tool": "needs_user", "description": "等你：短信验证码"]]]],
                ["owner": ["kind": "you", "id": "you", "label": "You"], "tabs": [["id": "c3", "kind": "file", "site": "~/x/mesh.html", "status": "someday",
                                                                                  "heldBy": "phone-7c", "viewport": ["width": 390, "height": 600, "scale": 3, "mobile": true, "by": "phone-7c"]]]],
                ["owner": ["kind": "you", "id": "you", "label": "You"], "tabs": []],
            ],
        ]))
        XCTAssertTrue(list.running)
        XCTAssertEqual(list.groups.count, 3, "an empty group is not listed")
        let pr = list.groups[0].tabs[0]
        XCTAssertEqual(pr.owner.kind, .terminal)
        XCTAssertEqual(pr.owner.namedHarness, "codex")
        XCTAssertEqual(pr.status, .busy)
        XCTAssertEqual(pr.action?.box, BrowserBox(x: 10, y: 20, width: 100, height: 30))
        XCTAssertEqual(pr.action?.said(by: "codex"), "codex · click \"Merge\"")
        XCTAssertNil(pr.heldBy)
        XCTAssertNil(pr.viewport.by)
        XCTAssertEqual(list.groups[1].tabs[0].waitingReason, "等你：短信验证码")
        XCTAssertEqual(list.waiting, 1)
        let mine = list.groups[2].tabs[0]
        XCTAssertEqual(mine.status, .other("someday"))
        XCTAssertEqual(mine.kind, .file)
        XCTAssertEqual(mine.viewport, BrowserViewport(width: 390, height: 600, scale: 3, mobile: true, by: "phone-7c"))
        XCTAssertEqual(mine.displayTitle, "~/x/mesh.html", "no title yet: where it is")
        XCTAssertEqual(BrowserTabStatus.busy.label, "Busy")
        XCTAssertEqual(list.removing("a1").groups.count, 2)
        let added = list.adding(BrowserTabInfo(id: "d4", site: "localhost:5173", kind: .local))
        XCTAssertEqual(added.groups.last?.tabs.map(\.id), ["c3", "d4"], "with your other tabs")
    }

    /// Who may drive a tab (host.ts mayDrive): its holder; nobody's is yours to drive, an agent's only once taken over.
    func testOnlyTheHolderDrivesAndAnAgentsTabIsTakenOverFirst() throws {
        let agents = try JSONDecoder().decode(BrowserTabInfo.self, from: json(Self.codexTab))
        XCTAssertFalse(agents.drivable(by: "phone-1"))
        XCTAssertTrue(agents.applying(.held("phone-1", reason: .take)).drivable(by: "phone-1"))
        XCTAssertFalse(agents.applying(.held("mac-2", reason: .take)).drivable(by: "phone-1"))
        let yours = BrowserTabInfo(id: "y")
        XCTAssertTrue(yours.drivable(by: "phone-1"))
        XCTAssertFalse(yours.applying(.held("mac-2", reason: .take)).drivable(by: "phone-1"))
        XCTAssertEqual(BrowserHolder("mac-3f"), .mac)
        XCTAssertEqual(BrowserHolder("local"), .mac)
        XCTAssertEqual(BrowserHolder("phone-1").label, "On iPhone")
        XCTAssertEqual(BrowserHolder("web-9"), .web)
        XCTAssertEqual(BrowserHolder("dev-123").said, "此标签正在另一台设备上使用。")
    }

    func testStreamEventsParseAndChangeTheTab() throws {
        let jpeg = Data([0xFF, 0xD8, 0xFF, 0xD9])
        let frame = BrowserEvent.parse(event: "frame", data: String(data: json([
            "type": "frame", "seq": 42, "data": jpeg.base64EncodedString(), "format": "jpeg", "width": 640, "height": 400, "scale": 0.5,
            "viewport": ["width": 1280, "height": 800], "pageScale": 1, "scrollX": 0, "scrollY": 120,
        ]), encoding: .utf8)!)
        XCTAssertEqual(frame, .frame(BrowserFrame(seq: 42, jpeg: jpeg, width: 640, height: 400, scale: 0.5, viewportWidth: 1280, viewportHeight: 800)))
        XCTAssertNil(BrowserEvent.parse(event: "frame", data: #"{"seq":1,"data":"%%%","width":1,"height":1}"#), "a picture it cannot read is skipped")
        XCTAssertEqual(BrowserEvent.parse(event: "url", data: #"{"type":"url","url":"http://localhost:5173/","site":"localhost:5173","kind":"local"}"#),
                       .url("http://localhost:5173/", site: "localhost:5173", kind: .local))
        XCTAssertEqual(BrowserEvent.parse(event: "title", data: #"{"title":"Acme · Dev"}"#), .title("Acme · Dev"))
        XCTAssertEqual(BrowserEvent.parse(event: "loading", data: #"{"loading":true}"#), .loading(true))
        XCTAssertEqual(BrowserEvent.parse(event: "status", data: #"{"status":"waiting"}"#), .status(.waiting))
        XCTAssertEqual(BrowserEvent.parse(event: "held", data: #"{"heldBy":null,"reason":"idle"}"#), .held(nil, reason: .idle))
        XCTAssertEqual(BrowserEvent.parse(event: "held", data: #"{"heldBy":"phone-1","reason":"take"}"#), .held("phone-1", reason: .take))
        XCTAssertEqual(BrowserEvent.parse(event: "action", data: #"{"action":null}"#), .action(nil))
        XCTAssertEqual(BrowserEvent.parse(event: "viewport", data: #"{"viewport":{"width":390,"height":700,"scale":3,"mobile":true,"by":"phone-1"}}"#),
                       .viewport(BrowserViewport(width: 390, height: 700, scale: 3, mobile: true, by: "phone-1")))
        XCTAssertEqual(BrowserEvent.parse(event: "closed", data: #"{"reason":"browser-exited"}"#), .closed(.browserExited))
        XCTAssertEqual(BrowserClosedReason.shutdown.said, "Mac 上的 AgentSwitch 服务已停止，标签已关闭。")
        XCTAssertNil(BrowserEvent.parse(event: "future", data: "{}"))
        guard case .tab(let tab)? = BrowserEvent.parse(event: "tab", data: String(data: json(["type": "tab", "tab": Self.codexTab]), encoding: .utf8)!) else {
            return XCTFail("tab")
        }
        let moved = tab.applying(.url("https://github.com/acme/app", site: "github.com", kind: .web)).applying(.title("acme/app"))
            .applying(.status(.idle)).applying(.action(nil)).applying(.held("phone-1", reason: .take))
        XCTAssertEqual(moved.url, "https://github.com/acme/app")
        XCTAssertEqual(moved.title, "acme/app")
        XCTAssertEqual(moved.status, .idle)
        XCTAssertNil(moved.action)
        XCTAssertEqual(moved.heldBy, "phone-1")
        XCTAssertNil(moved.applying(.held(nil, reason: .handBack)).heldBy)
    }

    func testOpeningNavigatingAndHoldingSendWhatTheMacTakes() async throws {
        let tab = String(data: json(["tab": ["id": "a1", "owner": ["kind": "you", "id": "you", "label": "You"]]]), encoding: .utf8)!
        let transport = FakeTransport { req, _ in (Data(tab.utf8), httpResponse(req.url, status: req.httpMethod == "POST" && req.url?.path == "/browser/tabs" ? 201 : 200)) }
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")
        let opened = try await api.openBrowserTab(.url("localhost:5173"))
        XCTAssertEqual(opened.id, "a1")
        _ = try await api.openBrowserTab(.port(3000))
        _ = try await api.navigateBrowserTab("a1", to: .path("~/x/mesh.html"), screen: "phone-1")
        _ = try await api.browserHistory("a1", .back, screen: "phone-1")
        _ = try await api.takeBrowserTab("a1", screen: "phone-1")
        _ = try await api.setBrowserViewport("a1", width: 393, height: 120, scale: 3, mobile: true, screen: "phone-1")
        _ = try await api.releaseBrowserTab("a1", screen: "phone-1")
        try await api.closeBrowserTab("a1")
        XCTAssertEqual(transport.paths, ["/browser/tabs", "/browser/tabs", "/browser/tabs/a1/navigate", "/browser/tabs/a1/navigate",
                                         "/browser/tabs/a1/take", "/browser/tabs/a1/viewport", "/browser/tabs/a1/release", "/browser/tabs/a1"])
        let r = transport.requests
        XCTAssertEqual(try body(r[0]) as NSDictionary, ["url": "localhost:5173"])
        XCTAssertEqual(try body(r[1]) as NSDictionary, ["port": 3000])
        XCTAssertEqual(try body(r[2]) as NSDictionary, ["path": "~/x/mesh.html", "screen": "phone-1"])
        XCTAssertEqual(try body(r[3]) as NSDictionary, ["action": "back", "screen": "phone-1"])
        XCTAssertEqual(try body(r[4]) as NSDictionary, ["screen": "phone-1"])
        XCTAssertEqual(try body(r[5]) as NSDictionary, ["width": 393, "height": 200, "scale": 3, "mobile": true, "screen": "phone-1"],
                       "a height under the Mac's 200 is raised to it")
        XCTAssertEqual(r[7].httpMethod, "DELETE")
    }

    func testARefusalCarriesItsReason() async throws {
        let transport = FakeTransport { req, _ in
            (Data(#"{"error":"~/x/.env 属于凭据文件（.env、私钥、证书、令牌配置等），不在浏览器中打开。"}"#.utf8), httpResponse(req.url, status: 403))
        }
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")
        do {
            _ = try await api.openBrowserTab(.url("~/x/.env"))
            XCTFail("403 is an error")
        } catch let error as APIError {
            XCTAssertEqual(error.localizedDescription, "~/x/.env 属于凭据文件（.env、私钥、证书、令牌配置等），不在浏览器中打开。")
        }
    }

    func testInputGoesInOrderAsFramePixels() async throws {
        let transport = FakeTransport()
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")
        try await api.sendBrowserInput("a1", [.click(x: 10.04, y: 20.06, seq: 7), .click(x: 1, y: 2, button: .right, seq: nil),
                                              .wheel(x: 5, y: 6, deltaX: 0, deltaY: -120.55, seq: 7), .text("你好"), .key(.backspace)], screen: "phone-1")
        try await api.sendBrowserInput("a1", [], screen: "phone-1")
        XCTAssertEqual(transport.paths, ["/browser/tabs/a1/input"], "nothing to send, nothing sent")
        let sent = try body(transport.requests[0])
        XCTAssertEqual(sent["screen"] as? String, "phone-1")
        let events = try XCTUnwrap(sent["events"] as? [NSDictionary])
        XCTAssertEqual(events[0], ["type": "mouse", "action": "click", "x": 10, "y": 20.1, "button": "left", "clickCount": 1, "seq": 7])
        XCTAssertEqual(events[1], ["type": "mouse", "action": "click", "x": 1, "y": 2, "button": "right", "clickCount": 1])
        XCTAssertEqual(events[2], ["type": "wheel", "x": 5, "y": 6, "deltaX": 0, "deltaY": -120.6, "seq": 7])
        XCTAssertEqual(events[3], ["type": "text", "text": "你好"])
        XCTAssertEqual(events[4], ["type": "key", "key": "Backspace"])
    }

    /// A drag's wheel turns go together; the order of everything else is kept; a request carries at most 50.
    func testTheQueueJoinsWheelTurnsAndBatches() {
        var queue = BrowserInputQueue()
        queue.append(.wheel(x: 1, y: 1, deltaX: 0, deltaY: 10, seq: 1))
        queue.append(.wheel(x: 2, y: 3, deltaX: 1, deltaY: 15, seq: 2))
        queue.append(.click(x: 4, y: 4, seq: 2))
        queue.append(.wheel(x: 2, y: 3, deltaX: 0, deltaY: 5, seq: 2))
        XCTAssertEqual(queue.events, [.wheel(x: 2, y: 3, deltaX: 1, deltaY: 25, seq: 2), .click(x: 4, y: 4, seq: 2), .wheel(x: 2, y: 3, deltaX: 0, deltaY: 5, seq: 2)])
        for i in 0..<60 { queue.append(.text("\(i)")) }
        XCTAssertEqual(queue.next().count, 50)
        XCTAssertEqual(queue.next().count, 13)
        XCTAssertTrue(queue.isEmpty)
    }

    func testFillingACiphertextAndAMacWithoutIt() async throws {
        let tab = String(data: json(["tab": Self.codexTab]), encoding: .utf8)!
        let transport = FakeTransport { req, n in
            if n == 0 { return (Data(#"{"ok":true}"#.utf8), httpResponse(req.url)) }
            // An older Mac: no fill route, the tab itself there.
            if req.url?.path == "/browser/tabs/a1" { return (Data(tab.utf8), httpResponse(req.url)) }
            return (Data(#"{"error":"not found"}"#.utf8), httpResponse(req.url, status: 404))
        }
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")
        let filled = try await api.fillBrowserTab("a1", token: "enc:v1:abc", screen: "phone-1")
        XCTAssertTrue(filled)
        XCTAssertEqual(try body(transport.requests[0]) as NSDictionary, ["token": "enc:v1:abc", "screen": "phone-1"])
        let older = try await api.fillBrowserTab("a1", token: "enc:v1:abc", screen: "phone-1")
        XCTAssertFalse(older, "404 while the tab is there: this Mac cannot fill yet")
        XCTAssertEqual(transport.paths, ["/browser/tabs/a1/fill", "/browser/tabs/a1/fill", "/browser/tabs/a1"])
    }

    /// 2026-10-02 review: a 404 from a tab closed meanwhile is not taken for an older Mac (which would hide the key).
    func testFillingATabThatIsGoneSaysSo() async throws {
        let transport = FakeTransport { req, _ in (Data(#"{"error":"not found"}"#.utf8), httpResponse(req.url, status: 404)) }
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")
        do {
            _ = try await api.fillBrowserTab("gone", token: "enc:v1:abc", screen: "phone-1")
            XCTFail("a closed tab is an error, not an older Mac")
        } catch {
            XCTAssertEqual(error as? APIError, .http(status: 404, message: "此标签已关闭。"))
        }
        XCTAssertEqual(transport.paths, ["/browser/tabs/gone/fill", "/browser/tabs/gone"])
    }

    /// The Mac's refusals are shown in its words: 400 for a field that takes no ciphertext, 409 on an agent's tab.
    func testAFillRefusalCarriesTheMacsWords() async throws {
        let transport = FakeTransport { req, _ in
            (Data(#"{"error":"只能填入密码或验证码输入框。"}"#.utf8), httpResponse(req.url, status: 400))
        }
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")
        do {
            _ = try await api.fillBrowserTab("a1", token: "enc:v1:abc", screen: "phone-1")
            XCTFail("refused")
        } catch {
            XCTAssertEqual(error.localizedDescription, "只能填入密码或验证码输入框。")
        }
    }

    func testLocalServersDecode() async throws {
        let transport = FakeTransport { req, _ in
            (Data(#"{"servers":[{"port":5173,"bind":"loopback","pid":42,"name":"vite","cwd":"/Users/me/Projects/site","url":"http://localhost:5173/"},{"port":3000}]}"#.utf8), httpResponse(req.url))
        }
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")
        let servers = try await api.browserServers()
        XCTAssertEqual(servers, [BrowserLocalServer(port: 5173, pid: 42, name: "vite", cwd: "/Users/me/Projects/site"),
                                 BrowserLocalServer(port: 3000, name: "", cwd: "")])
    }

    func testTheStreamAsksForItsQualityReconnectsAndEndsWhenClosed() async throws {
        let first = "event: tab\ndata: \(String(data: json(["type": "tab", "tab": Self.codexTab]), encoding: .utf8)!)\n\n: ping\n\nevent: status\ndata: {\"status\":\"idle\"}\n\n"
        let transport = FakeTransport(stream: { req, n in
            if n == 0 { return (httpResponse(req.url, contentType: "text/event-stream"), [Data(first.utf8)], APIError.transport("dropped")) }
            return (httpResponse(req.url, contentType: "text/event-stream"), [Data("event: closed\ndata: {\"reason\":\"closed\"}\n\nevent: title\ndata: {\"title\":\"x\"}\n\n".utf8)], nil)
        })
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")
        var got: [BrowserEvent] = []
        for try await event in api.browserEvents("a1", options: BrowserStreamOptions(quality: 45, fps: 5, maxWidth: 1179),
                                                 policy: ReconnectPolicy(initial: .milliseconds(1), maximum: .milliseconds(2))) {
            got.append(event)
        }
        XCTAssertEqual(got.count, 4)
        guard case .tab = got[0] else { return XCTFail("the tab first") }
        XCTAssertEqual(Array(got[1...]), [.status(.idle), .dropped, .closed(.closed)], "nothing after closed")
        XCTAssertEqual(transport.requests.first?.url?.query, "quality=45&fps=5&maxWidth=1179")
        XCTAssertEqual(transport.requests.first?.value(forHTTPHeaderField: "Accept"), "text/event-stream")
        XCTAssertEqual(transport.requests.count, 2)
    }

    func testAStreamForATabThatIsGoneSaysClosed() async throws {
        let transport = FakeTransport(stream: { req, _ in (httpResponse(req.url, status: 404), [Data(#"{"error":"not found"}"#.utf8)], nil) })
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")
        var got: [BrowserEvent] = []
        for try await event in api.browserEvents("gone", options: BrowserStreamPolicy.local) { got.append(event) }
        XCTAssertEqual(got, [.closed(.closed)])
    }

    // MARK: quality

    func testTheStreamAsksForLessOverARelay() {
        XCTAssertEqual(BrowserStreamPolicy.options(kind: .lan, probeSeconds: 0.02), BrowserStreamOptions(quality: 70, fps: 15))
        XCTAssertEqual(BrowserStreamPolicy.options(kind: .bonjour, probeSeconds: nil), BrowserStreamPolicy.local)
        XCTAssertEqual(BrowserStreamPolicy.options(kind: .tailnet, probeSeconds: 0.08), BrowserStreamOptions(quality: 60, fps: 10))
        XCTAssertEqual(BrowserStreamPolicy.options(kind: .tailnet, probeSeconds: 0.9, screenPixels: CGSize(width: 1179, height: 2556)),
                       BrowserStreamOptions(quality: 45, fps: 5, maxWidth: 1179, maxHeight: 2556))
        XCTAssertEqual(BrowserStreamPolicy.options(kind: .tailnet, probeSeconds: nil).fps, 5, "not known: taken for a relay")
        XCTAssertEqual(BrowserStreamOptions(quality: 0, fps: 99, maxWidth: 20).query.map(\.value), ["1", "30", "100"])
    }

    // MARK: the address bar

    func testWhatTheAddressBarSends() {
        XCTAssertEqual(BrowserAddress.target(for: " 5173 "), .port(5173))
        XCTAssertEqual(BrowserAddress.target(for: ":3000"), .port(3000))
        XCTAssertEqual(BrowserAddress.target(for: "99999"), .url("99999"), "not a port: the Mac says it cannot read it")
        XCTAssertEqual(BrowserAddress.target(for: "localhost:5173"), .url("localhost:5173"))
        XCTAssertEqual(BrowserAddress.target(for: "~/Projects/x/index.html"), .url("~/Projects/x/index.html"))
        XCTAssertNil(BrowserAddress.target(for: "   "))
        XCTAssertEqual(BrowserAddress.remember("github.com", in: ["a", "github.com", "b"]), ["github.com", "a", "b"])
        XCTAssertEqual(BrowserAddress.remember("x", in: (0..<8).map(String.init)).count, 8)
    }

    func testWhatTheAddressBarShows() {
        XCTAssertEqual(BrowserAddress.display("https://github.com/acme/app/pull/128").text, "github.com/acme/app/pull/128")
        XCTAssertTrue(BrowserAddress.display("https://www.example.com/").secure)
        XCTAssertEqual(BrowserAddress.display("https://www.example.com/").text, "example.com")
        XCTAssertFalse(BrowserAddress.display("http://localhost:5173/").secure)
        XCTAssertEqual(BrowserAddress.display("http://localhost:5173/").text, "localhost:5173")
        XCTAssertEqual(BrowserAddress.display("file:///Users/me/My%20Site/index.html").text, "file:///Users/me/My Site/index.html")
        XCTAssertEqual(BrowserAddress.display("about:blank").text, "about:blank")
    }

    // MARK: the picture on the phone

    /// Watching: a desktop-sized frame fitted to the width, its top at the top; a touch maps back to frame pixels.
    func testATouchMapsToTheFramePixelUnderIt() throws {
        let layout = BrowserLayout(frame: CGSize(width: 1280, height: 800), area: CGSize(width: 400, height: 600))
        XCTAssertEqual(layout.picture, CGRect(x: 0, y: 0, width: 400, height: 250))
        let p = try XCTUnwrap(layout.framePoint(at: CGPoint(x: 200, y: 125)))
        XCTAssertEqual(p.x, 640, accuracy: 0.001)
        XCTAssertEqual(p.y, 400, accuracy: 0.001)
        XCTAssertNil(layout.framePoint(at: CGPoint(x: 200, y: 400)), "under the picture")
        // a tall frame fitted by its height sits in the middle of the width
        let tall = BrowserLayout(frame: CGSize(width: 300, height: 1200), area: CGSize(width: 400, height: 600))
        XCTAssertEqual(tall.picture, CGRect(x: 125, y: 0, width: 150, height: 600))
        XCTAssertEqual(try XCTUnwrap(tall.framePoint(at: CGPoint(x: 125, y: 300))).y, 600, accuracy: 0.001)
    }

    /// Two fingers zoom the picture only: the point under them stays put, and a touch still lands on the same pixel.
    func testZoomKeepsThePointUnderTheFingers() throws {
        let area = CGSize(width: 400, height: 600)
        let zoom = BrowserZoom.none.pinched(to: 2, around: CGPoint(x: 100, y: 100), area: area)
        XCTAssertEqual(zoom.offset, CGPoint(x: -100, y: -100))
        let layout = BrowserLayout(frame: CGSize(width: 400, height: 600), area: area, zoom: zoom)
        let under = try XCTUnwrap(layout.framePoint(at: CGPoint(x: 100, y: 100)))
        XCTAssertEqual(under.x, 100, accuracy: 0.001)
        XCTAssertEqual(try XCTUnwrap(layout.framePoint(at: CGPoint(x: 300, y: 100))).x, 200, accuracy: 0.001)
        XCTAssertEqual(layout.pointsPerPixel, 2, accuracy: 0.001)
        // the zoomed picture keeps covering the area
        XCTAssertEqual(zoom.panned(by: CGSize(width: 500, height: -900), area: area).offset, CGPoint(x: 0, y: -600))
        XCTAssertEqual(BrowserZoom.none.pinched(to: 9, around: .zero, area: area).scale, 4)
        XCTAssertEqual(zoom.pinched(to: 0.5, around: CGPoint(x: 50, y: 50), area: area), BrowserZoom.none, "back to the whole picture")
    }

    /// What the agent just did, outlined where it is: the box in CSS pixels, the frame `scale` pixels per CSS pixel.
    func testTheAgentsBoxIsDrawnWhereItIs() {
        let layout = BrowserLayout(frame: CGSize(width: 640, height: 400), area: CGSize(width: 320, height: 600))
        let rect = layout.screenRect(ofPage: BrowserBox(x: 100, y: 200, width: 300, height: 40), frameScale: 0.5)
        XCTAssertEqual(rect, CGRect(x: 25, y: 50, width: 75, height: 10))
        let zoomed = BrowserLayout(frame: CGSize(width: 640, height: 400), area: CGSize(width: 320, height: 600), zoom: BrowserZoom(scale: 2, offset: CGPoint(x: -10, y: 0)))
        XCTAssertEqual(zoomed.screenRect(ofPage: BrowserBox(x: 100, y: 200, width: 300, height: 40), frameScale: 0.5), CGRect(x: 40, y: 100, width: 150, height: 20))
    }

    /// A drag scrolls the page with the finger, in frame pixels.
    func testADragIsTheWheelInFramePixels() {
        let layout = BrowserLayout(frame: CGSize(width: 1280, height: 800), area: CGSize(width: 400, height: 600))
        XCTAssertEqual(layout.wheelDelta(forDrag: CGSize(width: 0, height: -40)), CGSize(width: 0, height: 128))
    }

    /// Holding the tab at the phone's size, the keyboard up: the picture keeps its size and lifts what was touched into
    /// sight; with the keyboard down it fits again.
    func testTheKeyboardLiftsThePictureToWhatWasTouched() throws {
        let frame = CGSize(width: 390, height: 700)
        XCTAssertEqual(BrowserLayout.lift(toShow: 400, frame: frame, areaWidth: 390, visible: 380), 400 - 152, accuracy: 0.001)
        XCTAssertEqual(BrowserLayout.lift(toShow: 100, frame: frame, areaWidth: 390, visible: 380), 0, accuracy: 0.001)
        XCTAssertEqual(BrowserLayout.lift(toShow: 690, frame: frame, areaWidth: 390, visible: 380), 320, accuracy: 0.001, "no further than the bottom")
        let lifted = BrowserLayout(frame: frame, area: CGSize(width: 390, height: 380), fillWidth: true, lift: 300)
        XCTAssertEqual(lifted.picture, CGRect(x: 0, y: -300, width: 390, height: 700))
        XCTAssertEqual(try XCTUnwrap(lifted.framePoint(at: CGPoint(x: 10, y: 300))).y, 600, accuracy: 0.001)
        let down = BrowserLayout(frame: frame, area: CGSize(width: 390, height: 700), fillWidth: true, lift: 300)
        XCTAssertEqual(down.picture.minY, 0, "nothing to lift")
    }

    func testTheTabIconIsAGlobe() {
        XCTAssertEqual(PixelArt.globe.count, 11)
        XCTAssertTrue(PixelArt.globe.allSatisfy { $0.count == 11 })
        XCTAssertEqual(PixelArt.globe, PixelArt.globe.map { String($0.reversed()) }, "symmetric left and right")
        XCTAssertEqual(PixelArt.globe, PixelArt.globe.reversed(), "and top and bottom")
        XCTAssertEqual(PixelArt.globeSmall, [".###.", "#.#.#", "#####", "#.#.#", ".###."], "the demo page's")
    }
}

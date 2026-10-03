import XCTest
@testable import AgentSwitchMacCore

/// Fill Ciphertext on the Browser page (docs/browser-v0.md §1, §6; the daemon's `POST /browser/tabs/:id/fill`): what the
/// call sends and reads, every refusal in words a person can act on (the daemon's and the gate's own where they give
/// them, a formal sentence where the answer is only a code), and what the page checks before sending.
final class BrowserFillTests: XCTestCase {
    private typealias F = DispatchFixture
    private static let token = "enc:v1:" + String(repeating: "Ab0_-=", count: 6)

    private func client(_ transport: DispatchFakeTransport) throws -> DaemonClient {
        let home = TestSupport.tempDir("browser-fill")
        let token = home.appendingPathComponent(DaemonClient.tokenFileName)
        try "tok-f".write(to: token, atomically: true, encoding: .utf8)
        return DaemonClient(port: 4812, transport: transport, tokenFile: token)
    }

    // MARK: the call

    func testFillSendsTheCiphertextAndTheScreenAndReadsWhatWasFilled() async throws {
        let transport = DispatchFakeTransport { _, _ in
            (200, F.json(["tab": BrowserModelTests.tabObject("a/b", heldBy: "mac-main"),
                          "filled": ["label": "portal/pass", "host": "portal.example.com:443"]]))
        }
        let result = try await client(transport).fill(tabId: "a/b", token: Self.token, screen: BrowserDefaults.screen)

        XCTAssertEqual(result.label, "portal/pass")
        XCTAssertEqual(result.host, "portal.example.com:443")
        XCTAssertEqual(result.tab?.id, "a/b")
        XCTAssertEqual(result.tab?.heldBy, "mac-main")
        XCTAssertEqual(transport.lines, ["POST /browser/tabs/a/b/fill"])
        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(request.url?.absoluteString, "http://127.0.0.1:4812/browser/tabs/a%2Fb/fill", "an id is one path segment")
        XCTAssertEqual(F.body(request) as NSDictionary?, ["token": Self.token, "screen": "mac-main"])
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer tok-f")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(request.timeoutInterval, BrowserTimeouts.fill, "the gate may take its 15 s")
        XCTAssertGreaterThan(BrowserTimeouts.fill, 15)
    }

    func testAnAnswerWithoutTheTabStillSaysWhatWasFilled() async throws {
        let transport = DispatchFakeTransport { _, _ in (200, F.json(["filled": ["label": "fin/pass", "host": "fin.example.com:8443"]])) }
        let result = try await client(transport).fill(tabId: "t1", token: Self.token, screen: "mac-main")
        XCTAssertEqual(result, BrowserFillResult(tab: nil, label: "fin/pass", host: "fin.example.com:8443"))
    }

    func testAnAnswerWithoutFilledIsNotTakenForAFill() async throws {
        let transport = DispatchFakeTransport { _, _ in (200, F.json(["tab": BrowserModelTests.tabObject("t1")])) }
        do {
            _ = try await client(transport).fill(tabId: "t1", token: Self.token, screen: "mac-main")
            XCTFail("no `filled`, no fill")
        } catch let error as DaemonError {
            guard case .decoding = error else { return XCTFail("\(error)") }
        }
    }

    // MARK: refusals

    func testEachRefusalIsSaidInWordsAPersonCanActOn() async throws {
        let cases: [(status: Int, body: Data, said: String)] = [
            // The daemon's bad body is a bare English code; its own sentences pass through.
            (400, F.json(["error": "give a ciphertext (token)"]), "请求无效，未填入。请粘贴一条完整的 enc:v1: 密文。"),
            (400, F.json(["error": "请先点选要填入的输入框。"]), "请先点选要填入的输入框。"),
            // The gate's reason as it gives it, in whatever language; the daemon's own for a page that is not http(s).
            (403, F.json(["error": "page portal.evil.example:443 is not allowed for portal/pass"]),
             "page portal.evil.example:443 is not allowed for portal/pass"),
            (403, F.json(["error": "只能在 http(s) 页面中填入密文。"]), "只能在 http(s) 页面中填入密文。"),
            (403, Data(), "凭据网关拒绝了此密文，未填入。"),
            // An unknown tab answers `not found`; an older service has no route at all (no JSON).
            (404, F.json(["error": "not found"]), "此标签已关闭。"),
            (404, Data("404 Not Found".utf8), "当前服务不支持填入密文，请更新 AgentSwitch。"),
            (409, F.json(["error": "此标签由 agent 使用，请先接手。"]), "此标签由 agent 使用，请先接手。"),
            (409, F.json(["error": "输入焦点已改变，未填入。请重新点选输入框后再试。"]), "输入焦点已改变，未填入。请重新点选输入框后再试。"),
            (409, F.json(["error": "conflict"]), "此标签已由其他屏幕接手，或输入焦点已改变，未填入。"),
            (503, F.json(["error": "凭据网关不可用，无法填入密文。"]), "凭据网关不可用，无法填入密文。"),
            (503, Data(), "凭据网关不可用，无法填入密文。"),
            (500, F.json(["error": "Internal Server Error"]), "服务返回 500，未填入。"),
        ]
        for refusal in cases {
            let transport = DispatchFakeTransport { _, _ in (refusal.status, refusal.body) }
            do {
                _ = try await client(transport).fill(tabId: "t1", token: Self.token, screen: "mac-main")
                XCTFail("\(refusal.status) is a refusal")
            } catch {
                XCTAssertEqual(BrowserFillText.reason(error), refusal.said, "\(refusal.status) \(String(decoding: refusal.body, as: UTF8.self))")
            }
        }
    }

    func testAServiceThatIsNotThereIsSaidSo() async throws {
        let transport = DispatchFakeTransport { _, _ in throw URLError(.cannotConnectToHost) }
        do {
            _ = try await client(transport).fill(tabId: "t1", token: Self.token, screen: "mac-main")
            XCTFail("unreachable")
        } catch {
            XCTAssertTrue(BrowserFillText.reason(error).hasPrefix("无法连接服务："), BrowserFillText.reason(error))
        }
        XCTAssertEqual(BrowserFillText.reason(DaemonError.decoding("x")), "无法解析服务的响应：x")
    }

    // MARK: before sending

    func testOnlyAWholeCiphertextIsSent() {
        XCTAssertNil(BrowserFillText.problem(Self.token))
        XCTAssertNil(BrowserFillText.problem("  \(Self.token)\n"), "spaces and a line break around a pasted ciphertext are dropped")
        XCTAssertEqual(BrowserFillText.problem(""), "请粘贴一条 enc:v1: 密文。")
        XCTAssertEqual(BrowserFillText.problem(" \n"), "请粘贴一条 enc:v1: 密文。")
        XCTAssertEqual(BrowserFillText.problem("enc:ref:portal/pass#3"), "引用（enc:ref:）仅在登记它的任务中有效。此处只接受完整的 enc:v1: 密文。")
        for wrong in ["hunter2", "enc:v1:short", "enc:v1:" + String(repeating: "A", count: 15), "enc:v2:" + String(repeating: "A", count: 40),
                      Self.token + " tail", "enc:v1:" + String(repeating: "A", count: 20) + "/",
                      "enc:v1:" + String(repeating: "A", count: BrowserFillText.maxLength)] {
            XCTAssertEqual(BrowserFillText.problem(wrong), "不是完整的 enc:v1: 密文。", String(wrong.prefix(40)))
        }
    }

    func testFillIsOfferedOnWebPagesOnly() {
        for url in ["https://portal.example.com/login", "http://localhost:5173/", "HTTPS://Example.com"] {
            XCTAssertTrue(BrowserFillText.offered(on: url), url)
        }
        for url in ["file:///Users/me/x.html", "about:blank", "", "data:text/html,<input>", "javascript:alert(1)"] {
            XCTAssertFalse(BrowserFillText.offered(on: url), url)
        }
    }

    /// 2026-10-02: a person fills only on their own tabs (the daemon answers 409 on an agent's, held or not).
    func testFillIsOfferedOnYourOwnTabsOnly() {
        let codex = BrowserOwner(kind: .terminal, id: "k", label: "codex · AgentSwitch")
        let task = BrowserOwner(kind: .task, id: "t", label: "登录财务平台")
        XCTAssertTrue(BrowserFillText.offered(on: BrowserTab(id: "a", url: "https://portal.example.com/login")))
        XCTAssertFalse(BrowserFillText.offered(on: BrowserTab(id: "a", owner: codex, url: "https://github.com/login", heldBy: "mac-main")))
        XCTAssertFalse(BrowserFillText.offered(on: BrowserTab(id: "a", owner: task, url: "https://portal.example.com/login", heldBy: "mac-main")))
        XCTAssertFalse(BrowserFillText.offered(on: BrowserTab(id: "a", url: "file:///Users/me/x.html")))
    }

    /// The daemon's sentence for a field that takes no ciphertext is shown as it is.
    func testOnlyPasswordAndCodeFieldsSaidAsTheDaemonSaysIt() {
        XCTAssertEqual(BrowserFillText.reason(DaemonError.http(status: 400, message: "只能填入密码或验证码输入框。")), "只能填入密码或验证码输入框。")
    }

    func testTheNoteNamesTheLabelAndTheHost() {
        XCTAssertEqual(BrowserFillText.done(BrowserFillResult(label: "portal/pass", host: "portal.example.com:443")),
                       "Filled portal/pass · portal.example.com:443")
        XCTAssertEqual(BrowserFillText.done(BrowserFillResult(label: "", host: "localhost:5173")), "Filled · localhost:5173")
        XCTAssertEqual(BrowserFillText.done(BrowserFillResult(label: "fin/pass", host: "")), "Filled fin/pass")
    }
}

import XCTest
@testable import AgentSwitchMacCore

/// The browser's identity and engine as the Mac shows them (docs/browser-v0.md §7.2 第 5、6 条; design page
/// implemented/browser-window.html, states identity / update / missing): what the service says, the status bar's words,
/// the requests.
final class BrowserIdentityTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T { try JSONDecoder().decode(type, from: Data(json.utf8)) }

    private let identityJSON = #"{"fingerprint":{"summary":{"system":"macOS","browser":"Firefox 156","cores":8,"language":null,"timezone":"Asia/Tokyo","timezoneFrom":"exit"},"since":1791200000000,"source":"generated","config":{"navigator.hardwareConcurrency":8}},"proxy":{"server":"socks5://proxy.example.net:1080","username":"l0tk3","sealed":true},"exit":{"ip":"203.0.113.24","place":"Tokyo","timezone":"Asia/Tokyo","checkedAt":1},"restartNeeded":true}"#

    func testReadsTheIdentity() throws {
        let identity = try decode(BrowserIdentity.self, identityJSON)
        XCTAssertEqual(identity.fingerprint.system, "macOS")
        XCTAssertEqual(identity.fingerprint.browser, "Firefox 156")
        XCTAssertEqual(identity.fingerprint.cores, 8)
        XCTAssertNil(identity.fingerprint.language)
        XCTAssertEqual(identity.fingerprint.source, "generated")
        XCTAssertEqual(identity.fingerprint.since, Date(timeIntervalSince1970: 1_791_200_000))
        XCTAssertEqual(identity.proxy, BrowserProxy(server: "socks5://proxy.example.net:1080", username: "l0tk3", sealed: true))
        XCTAssertEqual(identity.fingerprint.timezone, "Asia/Tokyo")
        XCTAssertTrue(identity.fingerprint.timezoneFollowsExit)
        XCTAssertEqual(identity.exit, .found(ip: "203.0.113.24", place: "Tokyo"))
        XCTAssertTrue(identity.restartNeeded)
        let plain = try decode(BrowserIdentity.self, #"{"fingerprint":{"summary":{"system":"Linux","browser":"Firefox 140"},"since":0,"source":"imported"},"proxy":null}"#)
        XCTAssertNil(plain.proxy)
        XCTAssertNil(plain.fingerprint.cores)
        XCTAssertNil(plain.exit)
        XCTAssertFalse(plain.restartNeeded)
        let failed = try decode(BrowserIdentity.self, #"{"fingerprint":{"summary":{"system":"macOS","browser":"Firefox 156"},"since":0,"source":"generated"},"proxy":{"server":"http://p.example.net:80","sealed":false},"exit":{"problem":"未能查到出口地址。"},"restartNeeded":false}"#)
        XCTAssertEqual(failed.exit, .problem("未能查到出口地址。"))
    }

    func testTheStatusBarSaysTheIdentityInAFewWords() throws {
        let identity = try decode(BrowserIdentity.self, identityJSON)
        // The place it leaves at, once known; the proxy's host until then.
        XCTAssertEqual(BrowserIdentityText.status(identity, engine: "camoufox"), "macOS · Firefox 156 · socks5 Tokyo")
        let unknown = BrowserIdentity(fingerprint: identity.fingerprint, proxy: identity.proxy)
        XCTAssertEqual(BrowserIdentityText.status(unknown, engine: "camoufox"), "macOS · Firefox 156 · socks5 proxy.example.net")
        XCTAssertEqual(BrowserIdentityText.exit(identity.exit), "203.0.113.24 · Tokyo")
        XCTAssertEqual(BrowserIdentityText.exit(.problem("未能查到出口地址。")), "未能查到出口地址。")
        XCTAssertEqual(BrowserIdentityText.exit(nil), "—")
        let direct = BrowserIdentity(fingerprint: BrowserIdentity.Fingerprint(system: "macOS", browser: "Firefox 156", cores: 8), proxy: nil)
        XCTAssertEqual(BrowserIdentityText.status(direct, engine: "camoufox"), "macOS · Firefox 156 · direct")
        // Chrome stands in until Camoufox is installed: it has no identity to show.
        XCTAssertEqual(BrowserIdentityText.status(direct, engine: "chrome"), "Chrome · No Identity")
        XCTAssertEqual(BrowserIdentityText.status(nil, engine: "camoufox"), "Identity")
        XCTAssertEqual(BrowserIdentityText.rows(identity.fingerprint).map(\.0), ["system", "browser", "cores", "language", "time zone", "since"])
        XCTAssertEqual(BrowserIdentityText.rows(identity.fingerprint)[3].1, "System")
        XCTAssertEqual(BrowserIdentityText.rows(identity.fingerprint)[4].1, "Asia/Tokyo（随代理出口）")
        XCTAssertEqual(BrowserIdentityText.rows(direct.fingerprint)[4].1, "System")
    }

    func testAProxyIsTakenApartForItsFieldsAndForTheSiteItsPasswordIsSealedFor() {
        XCTAssertEqual(BrowserIdentityText.proxySite("socks5://proxy.example.net:1080"), "proxy.example.net:1080")
        XCTAssertEqual(BrowserIdentityText.proxySite(" http://10.0.0.2:3128 "), "10.0.0.2:3128")
        XCTAssertNil(BrowserIdentityText.proxySite("proxy.example.net"))
        XCTAssertNil(BrowserIdentityText.proxySite("ftp://x:1"))
    }

    func testTheProxyFieldsSayWhatApplyWillDo() {
        let current = BrowserProxy(server: "socks5://proxy.example.net:1080", username: "l0tk3", sealed: true)
        var draft = BrowserProxyDraft(current)
        XCTAssertEqual(draft, BrowserProxyDraft(server: "socks5://proxy.example.net:1080", username: "l0tk3"))
        XCTAssertTrue(draft.canApply)
        // Nothing typed for the password: the sealed one stays.
        XCTAssertEqual(draft.request(ciphertext: nil, current: current), BrowserProxyRequest(server: "socks5://proxy.example.net:1080", username: "l0tk3", keepPassword: true))
        draft.password = "hunter2"
        XCTAssertFalse(draft.keepsPassword(of: current))
        XCTAssertEqual(draft.request(ciphertext: "enc:v1:abcdefghijklmnopqrstuvwx", current: current).password, "enc:v1:abcdefghijklmnopqrstuvwx")
        XCTAssertNil(draft.request(ciphertext: "enc:v1:abcdefghijklmnopqrstuvwx", current: current).keepPassword)
        draft.username = " "
        XCTAssertEqual(draft.problem, "带密码的代理需要用户名。")
        XCTAssertFalse(draft.canApply)
        XCTAssertNil(BrowserProxyDraft().problem)
        XCTAssertFalse(BrowserProxyDraft().canApply)
        XCTAssertNotNil(BrowserProxyDraft(server: "proxy.example.net").problem)
        // A proxy without a user has no password to keep.
        XCTAssertFalse(BrowserProxyDraft(server: "http://p.example.net:80").keepsPassword(of: current))
    }

    func testReadsTheEngineAndSaysWhereAnUpdateIs() throws {
        let idle = try decode(BrowserEngine.self, #"{"camoufox":{"installed":{"version":"156.0.1-beta.34","digest":"sha256:aa","bytes":1289764252,"installedAt":1},"ready":true},"playwright":{"bundled":"1.64.0-alpha","installed":null,"active":"bundled","version":"1.64.0-alpha","firefox":"156.0"},"update":{"running":false},"available":{"camoufox":{"version":"156.0.1-beta.36","bytes":1290000000,"prerelease":false},"checkedAt":5}}"#)
        XCTAssertEqual(idle.camoufox, "156.0.1-beta.34")
        XCTAssertTrue(idle.ready)
        XCTAssertEqual(idle.playwright, "1.64.0-alpha")
        XCTAssertEqual(idle.available?.version, "156.0.1-beta.36")
        XCTAssertFalse(idle.update.running)
        XCTAssertEqual(BrowserEngineText.offer(idle), "156.0.1-beta.36 · 1.29 GB")
        XCTAssertEqual(BrowserEngineText.camoufox(idle), "156.0.1-beta.34")
        XCTAssertEqual(BrowserEngineText.playwright(idle), "1.64.0-alpha (bundled)")
        // A build's own stamp after the version is left out (it does not fit the row).
        XCTAssertEqual(BrowserEngineText.short("1.64.0-alpha-1759292000"), "1.64.0-alpha")
        XCTAssertEqual(BrowserEngineText.short("1.64.0-alpha-2026-10-01"), "1.64.0-alpha")
        XCTAssertEqual(BrowserEngineText.short("1.65.1"), "1.65.1")
        XCTAssertEqual(BrowserEngineText.short("156.0.1-beta.34"), "156.0.1-beta.34")
        XCTAssertNil(BrowserEngineText.status(idle))
        XCTAssertNil(BrowserEngineText.progress(idle.update))

        let missing = try decode(BrowserEngine.self, #"{"camoufox":{"installed":null,"ready":false},"playwright":{"bundled":"1.64.0","installed":null,"active":"bundled","version":"1.64.0","firefox":"156.0"},"update":{"running":false}}"#)
        XCTAssertNil(missing.camoufox)
        XCTAssertFalse(missing.ready)
        XCTAssertNil(missing.available)
        XCTAssertEqual(BrowserEngineText.camoufox(missing), "Not Installed")
        XCTAssertEqual(BrowserEngineText.status(missing), "Camoufox Not Installed")

        let running = try decode(BrowserEngine.self, #"{"camoufox":{"installed":null,"ready":false},"playwright":{"bundled":"1","installed":null,"active":"bundled","version":"1","firefox":"156.0"},"update":{"running":true,"to":{"camoufox":"156.0.1-beta.36"},"part":"camoufox","phase":"download","received":620,"total":1000}}"#)
        XCTAssertEqual(BrowserEngineText.progress(running.update), "download 62%")
        XCTAssertEqual(BrowserEngineText.camoufox(running), "Not Installed")
        XCTAssertEqual(BrowserEngineText.target(running), "156.0.1-beta.36")
        XCTAssertNil(BrowserEngineText.target(idle))
        XCTAssertEqual(BrowserEngineText.status(running), "engine: download 62%")
        XCTAssertEqual(BrowserEngineText.fraction(running.update), 0.62)
        XCTAssertEqual(BrowserEngineText.steps(running.update).map(\.state), [.now, .waiting, .waiting, .waiting, .waiting])
        let checking = BrowserEngineUpdate(running: true, phase: "check")
        XCTAssertEqual(BrowserEngineText.progress(checking), "self-check")
        XCTAssertEqual(BrowserEngineText.steps(checking).map(\.state), [.done, .done, .done, .now, .waiting])
        // The settings' Environment page: one line.
        XCTAssertEqual(BrowserEngineText.environment(idle), StatusLine("Camoufox 156.0.1-beta.34 · Playwright 1.64.0-alpha", .ok))
        XCTAssertEqual(BrowserEngineText.environment(missing), StatusLine("Camoufox Not Installed · Chrome in Use", .warning))
        XCTAssertEqual(BrowserEngineText.environment(running), StatusLine("Updating: download 62%", .busy))
        XCTAssertEqual(BrowserEngineText.environment(nil), StatusLine("Unknown", .busy))
        let failed = try decode(BrowserEngineUpdate.self, #"{"running":false,"ok":false,"phase":"check","error":"自检未通过：改尺寸：协议报错"}"#)
        XCTAssertEqual(failed.error, "自检未通过：改尺寸：协议报错")
        XCTAssertNil(BrowserEngineText.progress(failed))
    }

    func testAsksTheServiceForTheIdentityAndTheEngine() async throws {
        let identity = identityJSON
        let transport = StubTransport { request in
            request.url!.path.hasPrefix("/browser/engine") ? (request.httpMethod == "GET" ? 200 : 202, #"{"camoufox":{"installed":null,"ready":false},"playwright":{"bundled":"1","installed":null,"active":"bundled","version":"1","firefox":"156.0"},"update":{"running":false}}"#) : (200, identity)
        }
        let client = DaemonClient(port: 1, transport: transport)
        _ = try await client.browserIdentity()
        _ = try await client.newFingerprint()
        _ = try await client.setProxy(BrowserProxyRequest(server: "socks5://p.example.net:1080", username: "u", password: "enc:v1:abcdefghijklmnopqrstuvwx"))
        _ = try await client.setProxy(nil)
        _ = try await client.browserEngine(check: true)
        try await client.updateEngine(camoufox: "latest")
        try await client.cancelEngineUpdate()
        _ = try await client.restartBrowser()
        _ = try await client.importFingerprint(json: Data(#"{"navigator.hardwareConcurrency":16}"#.utf8))
        do { _ = try await client.importFingerprint(json: Data("[1]".utf8)); XCTFail("an array is not a fingerprint") } catch {}
        let sent = transport.requests.map { "\($0.httpMethod!) \($0.url!.path)\($0.url!.query.map { "?\($0)" } ?? "") \(String(decoding: $0.httpBody ?? Data(), as: UTF8.self))" }
        XCTAssertEqual(sent[0], "GET /browser/identity ")
        XCTAssertEqual(sent[1], #"PUT /browser/identity {"fingerprint":"new"}"#)
        XCTAssertTrue(sent[2].hasPrefix("PUT /browser/identity "))
        let proxyBody = try XCTUnwrap(JSONSerialization.jsonObject(with: transport.requests[2].httpBody!) as? [String: [String: String]])
        XCTAssertEqual(proxyBody["proxy"], ["server": "socks5://p.example.net:1080", "username": "u", "password": "enc:v1:abcdefghijklmnopqrstuvwx"])
        XCTAssertEqual(sent[3], #"PUT /browser/identity {"proxy":null}"#)
        XCTAssertEqual(sent[4], "GET /browser/engine?check=1 ")
        XCTAssertEqual(sent[5], #"POST /browser/engine/update {"camoufox":"latest"}"#)
        XCTAssertEqual(sent[6], "POST /browser/engine/cancel {}")
        XCTAssertEqual(sent[7], "POST /browser/identity/restart {}")
        XCTAssertEqual(sent[8], #"PUT /browser/identity {"fingerprint":{"config":{"navigator.hardwareConcurrency":16}}}"#)
        XCTAssertEqual(sent.count, 9)
    }
}

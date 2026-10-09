import Sodium
import XCTest
@testable import AgentSwitchKit

/// Proxies from the phone (docs/clash-v0.md §9, docs/profiles-v0.md §4.2, docs/browser-v0.md §7.6): the Clash page's
/// models, the proxy form, the password sealed here, and the calls as the Mac's service takes them.
final class ProxyTests: XCTestCase {
    private let lan = APIEndpoint(host: "192.168.1.5", port: 4713, kind: .lan)

    /// `GET /clash` as the service answers a phone (the address Clash Verge fetches by is empty).
    private static let clash = #"""
    {"found":true,"running":true,"version":"v1.19.31","mode":"rule","tun":false,
     "source":{"kind":"link","name":"Mine","host":"sub.example","updatedAt":1760000000000,"nodes":3,
               "providers":[{"name":"tgyun","host":"sub.example:9888","updatedAt":1,"nodes":3}],"traffic":{"used":3221225472,"total":107374182400,"expire":1893456000000}},
     "nodes":["🇯🇵 日本家宽-01","🇯🇵 日本家宽-02","🇺🇸 美国-01"],
     "profiles":[{"uid":"Lbw7BJYzpand","name":"mine.yaml","type":"local","file":"Lbw7BJYzpand.yaml"}],
     "settings":{"claude":{"nodes":["🇯🇵 日本家宽-01","gone"]},"openai":{"nodes":[]},"direct":["5.102.107.254"],"autoUpdateHours":24,
                 "templates":{"domestic":{"on":true,"rules":null},"block":{"on":false,"rules":["DOMAIN-SUFFIX,ads.example"]}},"renameDefault":false,"dns":{"on":false,"text":null}},
     "services":{"claude":{"group":"Claude","auto":"Claude自动选择","live":true,"now":"Claude自动选择","autoNow":"🇯🇵 日本家宽-01","missing":["gone"]},
                 "openai":{"group":"OpenAI","auto":"OpenAI自动选择","live":false,"now":null,"autoNow":null,"missing":[]}},
     "templates":{"domestic":{"on":true,"custom":false,"count":169},"block":{"on":false,"custom":true,"count":1}},
     "defaultGroup":null,"dns":{"on":false,"custom":false,"overridden":false},"active":true,"upToDate":false,"install":"","fetchedAt":null}
    """#

    func testTheClashPageIsReadAsTheServiceGivesIt() throws {
        let view = try JSONDecoder().decode(ClashView.self, from: Data(Self.clash.utf8))
        XCTAssertEqual(view.word, "Set Up")
        XCTAssertEqual(view.todo.count, 2)   // Clash Verge has to fetch again; TUN is off
        XCTAssertTrue(view.todo[1].contains("TUN"))
        XCTAssertEqual(view.nodes.count, 3)
        XCTAssertEqual(view.state(.claude)?.automatic, true)
        XCTAssertEqual(view.state(.claude)?.missing, ["gone"])
        XCTAssertEqual(view.state(.openai)?.live, false)
        XCTAssertEqual(view.state(.block)?.custom, true)
        XCTAssertEqual(view.settings.templates.block.rules, ["DOMAIN-SUFFIX,ads.example"])
        let source = try XCTUnwrap(view.source)
        XCTAssertEqual(ClashText.origin(source), "sub.example")
        XCTAssertEqual(source.traffic.map { ClashText.traffic($0, calendar: Calendar(identifier: .gregorian)) }?.hasPrefix("3 / 100 GB · Expires 20"), true)
        XCTAssertEqual(ClashText.delay(.some(.some(428))), "428 ms")
        XCTAssertEqual(ClashText.delay(.some(nil)), "Timeout")
        XCTAssertEqual(ClashText.interval(hours: 0), "Off")

        // Nothing found, not running, all in order.
        func state(_ change: (inout [String: Any]) -> Void) throws -> ClashView {
            var object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(Self.clash.utf8)) as? [String: Any])
            change(&object)
            return try JSONDecoder().decode(ClashView.self, from: JSONSerialization.data(withJSONObject: object))
        }
        XCTAssertEqual(try state { $0["found"] = false }.word, "Not Found")
        XCTAssertEqual(try state { $0["running"] = false }.word, "Not Running")
        XCTAssertEqual(try state { $0["upToDate"] = true; $0["tun"] = true }.word, "Running")
        XCTAssertTrue(try XCTUnwrap(try state { $0["source"] = NSNull() }.todo.first).contains("订阅"))
    }

    func testSettingsGoBackWithNullsSaid() throws {
        var settings = try JSONDecoder().decode(ClashView.self, from: Data(Self.clash.utf8)).settings
        settings[.openai].nodes = ["🇺🇸 美国-01"]
        settings.templates[.block].rules = nil
        let sent = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(settings)) as? [String: Any])
        XCTAssertEqual((sent["openai"] as? [String: [String]])?["nodes"], ["🇺🇸 美国-01"])
        let templates = try XCTUnwrap(sent["templates"] as? [String: [String: Any]])
        XCTAssertTrue(templates["block"]?["rules"] is NSNull)
        XCTAssertTrue((sent["dns"] as? [String: Any])?["text"] is NSNull)
        XCTAssertEqual(sent["autoUpdateHours"] as? Int, 24)
    }

    func testClashCallsAreWhatTheServiceTakes() async throws {
        let transport = FakeTransport { req, _ in
            if req.url?.path == "/clash/delays" { return (Data(#"{"delays":{"a":428,"b":null}}"#.utf8), httpResponse(req.url)) }
            if req.url?.path == "/clash/check" { return (Data(#"{"rows":[{"id":"claude","title":"Claude","host":"claude.ai","expect":{"kind":"group","group":"Claude"},"observed":{"outcome":"proxied","rule":"RuleSet as-claude","path":["Claude","日本家宽-02"],"exit":{"ip":"126.36.1.2","loc":"JP"},"ms":362},"ok":true}]}"#.utf8), httpResponse(req.url)) }
            return (Data(Self.clash.utf8), httpResponse(req.url))
        }
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")
        _ = try await api.selectClash(.claude, node: nil)
        _ = try await api.selectClash(.openai, node: "🇺🇸 美国-01")
        _ = try await api.setClashSource(link: "https://sub.example/a?token=s")
        _ = try await api.setClashSource(verge: "Lbw7BJYzpand")
        _ = try await api.removeClashSource()
        _ = try await api.updateClash()
        let delays = try await api.clashDelays(.claude, all: true)
        let rows = try await api.checkClash()
        XCTAssertEqual(delays["a"], .some(428))
        XCTAssertEqual(delays["b"], .some(nil))
        XCTAssertEqual(rows.first?.route, "RuleSet as-claude → Claude → 日本家宽-02")
        XCTAssertEqual(rows.first?.seen, "JP 126.36.1.2 · 362 ms")
        XCTAssertEqual(transport.requests.map { "\($0.httpMethod ?? "") \($0.url?.path ?? "")" },
                       ["POST /clash/select", "POST /clash/select", "POST /clash/source", "POST /clash/source", "DELETE /clash/source", "POST /clash/update", "POST /clash/delays", "POST /clash/check"])
        func body(_ n: Int) throws -> [String: Any] { try XCTUnwrap(transport.requests[n].httpBody.flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: Any] }) }
        XCTAssertTrue(try body(0)["node"] is NSNull)
        XCTAssertEqual(try body(1)["node"] as? String, "🇺🇸 美国-01")
        XCTAssertEqual(try body(2) as? [String: String], ["link": "https://sub.example/a?token=s"])
        XCTAssertEqual(try body(6) as? [String: String], ["service": "claude", "scope": "all"])
    }

    func testAMacThatKeepsProxiesToItselfShowsNothing() async throws {
        for status in [403, 404] {
            let transport = FakeTransport { req, _ in (Data(#"{"error":"Clash is set up on the Mac"}"#.utf8), httpResponse(req.url, status: status)) }
            let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")
            let clash = try await api.clash()
            let browser = try await api.browserProxy()
            XCTAssertNil(clash)
            XCTAssertNil(browser)
        }
    }

    // MARK: the form

    func testAProxyWrittenWholeIsTakenApart() {
        XCTAssertEqual(ProxyDraft(server: "http://me:p%40ss@proxy.example:8080/").split(), ProxyDraft(server: "http://proxy.example:8080", username: "me", password: "p@ss"))
        XCTAssertEqual(ProxyDraft(server: "proxy.example:8080:me:word").split(), ProxyDraft(server: "http://proxy.example:8080", username: "me", password: "word"))
        XCTAssertEqual(ProxyDraft(server: "SOCKS5://10.0.0.2:1080").split(), ProxyDraft(server: "socks5://10.0.0.2:1080"))
        XCTAssertEqual(ProxyDraft(server: "proxy.example:8080").split().server, "http://proxy.example:8080")
        XCTAssertEqual(ProxyDraft(server: "ftp://proxy.example:21").split().server, "ftp://proxy.example:21")
    }

    func testWhatStandsInTheWayOfApply() {
        XCTAssertNil(ProxyDraft().problem)
        XCTAssertFalse(ProxyDraft().canApply)
        XCTAssertEqual(ProxyDraft(server: "proxy.example").problem?.contains("scheme://host:port"), true)
        XCTAssertEqual(ProxyDraft(server: "http://proxy.example:8080", password: "x").problem, "带密码的代理需要用户名。")
        XCTAssertTrue(ProxyDraft(server: " http://proxy.example:8080 ", username: "me", password: "x").canApply)
        XCTAssertNil(ProxyText.site("http://proxy.example:99999"))
        XCTAssertEqual(ProxyText.site("socks5://[fd7a::1]:1080"), "[fd7a::1]:1080")
    }

    func testThePasswordStaysWhenNoneIsTyped() throws {
        let current = ProxySetting(server: "http://proxy.example:8080", username: "me", sealed: true)
        let kept = ProxyDraft(current).request(ciphertext: nil, current: current)
        XCTAssertEqual(kept, ProxyRequest(server: "http://proxy.example:8080", username: "me", password: nil, keepPassword: true))
        let sent = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(kept)) as? [String: Any])
        XCTAssertEqual(Set(sent.keys), ["server", "username", "keepPassword"])
        // A new one typed: it goes as a ciphertext and nothing is kept.
        var typed = ProxyDraft(current)
        typed.password = "hunter2"
        XCTAssertEqual(typed.request(ciphertext: "enc:v1:abc", current: current), ProxyRequest(server: "http://proxy.example:8080", username: "me", password: "enc:v1:abc"))
        // No user: nobody's password to keep.
        XCTAssertNil(ProxyDraft(server: "http://proxy.example:8080").request(ciphertext: nil, current: current).keepPassword)
    }

    func testThePasswordIsSealedForTheProxyItselfAndNowhereElse() throws {
        let draft = ProxyDraft(server: "http://Proxy.Example:8080", username: "me", password: "hunter2")
        let payload = try XCTUnwrap(try draft.sealing(label: ProxyOwner.profile(agent: "claude-code", id: "abc").sealLabel))
        XCTAssertEqual(payload.hosts, ["proxy.example:8080"])
        XCTAssertEqual(payload.uses, [.fill, .http])
        XCTAssertEqual(payload.label, "profile/proxy")
        XCTAssertEqual(payload.value, "hunter2")
        XCTAssertEqual(ProxyOwner.browser.sealLabel, "browser/proxy")
        XCTAssertNil(try ProxyDraft(server: "http://proxy.example:8080", username: "me").sealing(label: "browser/proxy"))
        // What it becomes is a ciphertext the gate's own format, and the value is not in it.
        let keys = try XCTUnwrap(Sodium().box.keyPair())
        let token = try TokenMinter(publicKey: keys.publicKey).mint(payload)
        XCTAssertTrue(TokenMinter.looksLikeToken(token))
        XCTAssertFalse(token.contains("hunter2"))
    }

    // MARK: whose proxy

    func testAProfilesProxyAndTheSharedBrowsersAreRead() throws {
        let reply = try JSONDecoder().decode(ProfileProxyReply.self, from: Data(#"""
        {"agents":{"claude-code":{"current":"default","creatable":true,"profiles":[
          {"id":"default","name":"Default","kind":"subscription","createdAt":0},
          {"id":"abc123def0","name":"Work","kind":"subscription","createdAt":1,"color":"violet","proxy":{"server":"http://proxy.example:8080","username":"me","sealed":true},"exit":{"ip":"203.0.113.9","place":"Tokyo","checkedAt":5}},
          {"id":"abc123def1","name":"Side","kind":"subscription","createdAt":2,"proxy":{"server":"socks5://10.0.0.2:1080","sealed":false}}]}},
         "problem":"代理是通的，但几个出口查询都没有给出地址，所以不知道从哪里出去。"}
        """#.utf8))
        let profiles = try XCTUnwrap(reply.agents["claude-code"]?.profiles)
        XCTAssertEqual(profiles.map(\.way), ["This Mac", "Tokyo 203.0.113.9", "10.0.0.2:1080"])
        XCTAssertEqual(profiles[1].proxy, ProxySetting(server: "http://proxy.example:8080", username: "me", sealed: true))
        XCTAssertEqual(reply.problem?.hasPrefix("代理是通的"), true)

        // The shared browser, as a phone is told it: the fingerprint in a line, without its text.
        let found = try JSONDecoder().decode(BrowserProxyState.self, from: Data(#"""
        {"fingerprint":{"summary":{"system":"macOS","browser":"Firefox 156","cores":8,"language":"en-US","timezone":null,"timezoneFrom":"exit"},"since":1,"source":"generated"},
         "proxy":{"server":"socks5://proxy.example.net:1080","username":"me","sealed":true},"exit":{"ip":"203.0.113.9","place":"Tokyo","timezone":"Asia/Tokyo","checkedAt":5},"restartNeeded":true}
        """#.utf8))
        XCTAssertEqual(found.fingerprint, "macOS · Firefox 156")
        XCTAssertEqual(found.way, "Tokyo 203.0.113.9")
        XCTAssertTrue(found.restartNeeded)
        let down = try JSONDecoder().decode(BrowserProxyState.self, from: Data(#"{"fingerprint":{"summary":{"system":"macOS","browser":"Firefox 156"}},"proxy":{"server":"http://proxy.example:8080","sealed":false},"exit":{"problem":"代理没有回应。"},"restartNeeded":false}"#.utf8))
        XCTAssertEqual(down.exit, .problem("代理没有回应。"))
        XCTAssertEqual(down.way, "proxy.example:8080")
        let direct = try JSONDecoder().decode(BrowserProxyState.self, from: Data(#"{"fingerprint":{"summary":{"system":"macOS","browser":"Firefox 156"}},"proxy":null,"exit":null,"restartNeeded":false}"#.utf8))
        XCTAssertEqual(direct.way, "Direct")
        XCTAssertNil(direct.proxy)
    }

    func testProxyCallsAreWhatTheServiceTakes() async throws {
        let transport = FakeTransport { req, _ in
            let path = req.url?.path ?? ""
            if path.hasPrefix("/profiles/") { return (Data(#"{"agents":{}}"#.utf8), httpResponse(req.url)) }
            return (Data(#"{"fingerprint":{"summary":{"system":"macOS","browser":"Firefox 156"}},"proxy":null,"exit":null,"restartNeeded":false}"#.utf8), httpResponse(req.url))
        }
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")
        _ = try await api.setProfileProxy(agent: "claude-code", id: "abc123def0", proxy: ProxyRequest(server: "http://proxy.example:8080", username: "me", password: "enc:v1:abc"))
        _ = try await api.setProfileProxy(agent: "claude-code", id: "abc123def0", proxy: nil)
        _ = try await api.checkProfileExit(agent: "claude-code", id: "abc123def0")
        _ = try await api.setBrowserProxy(ProxyRequest(server: "socks5://10.0.0.2:1080"))
        _ = try await api.setBrowserProxy(nil)
        _ = try await api.restartBrowser()
        XCTAssertEqual(transport.requests.map { "\($0.httpMethod ?? "") \($0.url?.path ?? "")" },
                       ["PUT /profiles/claude-code/abc123def0/proxy", "PUT /profiles/claude-code/abc123def0/proxy", "POST /profiles/claude-code/abc123def0/check",
                        "PUT /browser/identity", "PUT /browser/identity", "POST /browser/identity/restart"])
        func body(_ n: Int) throws -> [String: Any] { try XCTUnwrap(transport.requests[n].httpBody.flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: Any] }) }
        XCTAssertEqual(try body(0) as? [String: String], ["server": "http://proxy.example:8080", "username": "me", "password": "enc:v1:abc"])
        XCTAssertTrue(try body(1)["server"] is NSNull)
        XCTAssertEqual((try body(3)["proxy"] as? [String: String]), ["server": "socks5://10.0.0.2:1080"])
        XCTAssertTrue(try body(4)["proxy"] is NSNull)
        // A phone changes no fingerprint: nothing but the proxy is ever in what it sends.
        XCTAssertEqual(Set(try body(3).keys), ["proxy"])
    }
}

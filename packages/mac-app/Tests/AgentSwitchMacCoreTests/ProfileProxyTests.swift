import XCTest
@testable import AgentSwitchMacCore

/// A profile's own proxy (docs/profiles-v0.md §4): what the service says of it is read as it is; where what runs under
/// a profile leaves from is said in a few words; a terminal carries its profile's exit beside the profile's name.
final class ProfileProxyTests: XCTestCase {
    func testAProfileSaysWhereWhatRunsUnderItLeavesFrom() throws {
        let agents = try JSONDecoder().decode([String: AgentProfiles].self, from: Data(#"""
        {"claude-code":{"current":"abc123def0","creatable":true,"profiles":[
          {"id":"default","name":"Default","kind":"subscription","createdAt":0,"account":"me@example.com"},
          {"id":"abc123def0","name":"cwork1","kind":"subscription","createdAt":1,"proxy":{"server":"http://proxy.example:8080","username":"me","sealed":true},
           "exit":{"ip":"203.0.113.9","place":"Tokyo","timezone":"Asia/Tokyo","checkedAt":2}},
          {"id":"0fed321cba","name":"cwork2","kind":"subscription","createdAt":3,"proxy":{"server":"socks5://10.0.0.2:1080","sealed":false}}]}}
        """#.utf8))
        let list = try XCTUnwrap(agents["claude-code"]).profiles
        XCTAssertEqual(list.map(\.way), ["This Mac", "Tokyo 203.0.113.9", "10.0.0.2:1080"])
        XCTAssertEqual(list[1].proxy, BrowserProxy(server: "http://proxy.example:8080", username: "me", sealed: true))
        XCTAssertEqual(list[1].exit, ProfileExit(ip: "203.0.113.9", place: "Tokyo"))
        XCTAssertNil(list[0].proxy)
        XCTAssertEqual(ProfileExit(ip: "203.0.113.9").text, "203.0.113.9")
        // The fields of the sheet start from the proxy in force, its password never among them.
        let draft = BrowserProxyDraft(list[1].proxy)
        XCTAssertEqual([draft.server, draft.username, draft.password], ["http://proxy.example:8080", "me", ""])
        XCTAssertEqual(draft.request(ciphertext: nil, current: list[1].proxy), BrowserProxyRequest(server: "http://proxy.example:8080", username: "me", keepPassword: true))
    }

    func testAProxyWrittenWholeIsTakenApart() {
        let parts = { (text: String) -> [String] in let d = BrowserProxyDraft(server: text).split(); return [d.server, d.username, d.password] }
        XCTAssertEqual(parts("http://alice:s3cret@proxy.example:8080"), ["http://proxy.example:8080", "alice", "s3cret"])
        XCTAssertEqual(parts("  HTTP://alice:s3cret@proxy.example:8080/ \n"), ["http://proxy.example:8080", "alice", "s3cret"])
        XCTAssertEqual(parts("socks5://alice:s3cret@10.0.0.2:1080"), ["socks5://10.0.0.2:1080", "alice", "s3cret"])
        // Without a scheme `http` is meant; the sellers' `host:port:user:pass`; a bare `host:port`.
        XCTAssertEqual(parts("alice:s3cret@proxy.example:8080"), ["http://proxy.example:8080", "alice", "s3cret"])
        XCTAssertEqual(parts("proxy.example:8080:alice:s3cret"), ["http://proxy.example:8080", "alice", "s3cret"])
        XCTAssertEqual(parts("203.0.113.7:3128"), ["http://203.0.113.7:3128", "", ""])
        // A password with `@` or `:` in it, or written with escapes; a name alone; an IPv6 host.
        XCTAssertEqual(parts("http://alice:p@ss:w0rd@proxy.example:8080"), ["http://proxy.example:8080", "alice", "p@ss:w0rd"])
        XCTAssertEqual(parts("http://alice%40corp:p%3Ass%2F1@proxy.example:8080"), ["http://proxy.example:8080", "alice@corp", "p:ss/1"])
        XCTAssertEqual(parts("http://alice@proxy.example:8080"), ["http://proxy.example:8080", "alice", ""])
        XCTAssertEqual(parts("http://alice:s3cret@[2001:db8::1]:8080"), ["http://[2001:db8::1]:8080", "alice", "s3cret"])
        // What is already in its fields stays where the address says nothing of it; what is not a proxy is left as it is.
        let kept = BrowserProxyDraft(server: "http://proxy.example:8080", username: "bob", password: "typed").split()
        XCTAssertEqual([kept.server, kept.username, kept.password], ["http://proxy.example:8080", "bob", "typed"])
        for text in ["", "proxy.example", "http://proxy.example", "ftp://alice:s3cret@proxy.example:21", "http://alice:s3cret@proxy.example:port"] { XCTAssertEqual(parts(text)[0], text) }
        // Taken apart, it can be applied; whole, the strict form could not.
        XCTAssertFalse(BrowserProxyDraft(server: "http://alice:s3cret@proxy.example:8080").canApply)
        XCTAssertTrue(BrowserProxyDraft(server: "http://alice:s3cret@proxy.example:8080").split().canApply)
        XCTAssertNil(BrowserProxyDraft(server: "proxy.example:8080:alice:s3cret").split().problem)
    }

    func testATerminalCarriesItsProfilesExitBesideItsName() throws {
        let terminal = { (profile: String) throws -> TerminalInfo in
            try JSONDecoder().decode(TerminalInfo.self, from: Data(#"{"id":"t1","harness":"claude-code","cwd":"/w","name":"n","status":"working","model":"claude-opus-5-5","mode":"manual","cols":120,"rows":36,"profile":\#(profile)}"#.utf8))
        }
        XCTAssertEqual(try terminal(#"{"id":"abc123def0","name":"cwork1","exit":{"ip":"203.0.113.9","place":"Tokyo"}}"#).profileName, "cwork1 · Tokyo 203.0.113.9")
        XCTAssertEqual(try terminal(#"{"id":"abc123def0","name":"cwork1"}"#).profileName, "cwork1")
        XCTAssertNil(try terminal("null").profileName)
        // The status bar says it between the agent and the model.
        XCTAssertEqual(try terminal(#"{"id":"abc123def0","name":"cwork1","exit":{"ip":"203.0.113.9","place":null}}"#).context.profile, "cwork1 · 203.0.113.9")
    }

    // MARK: a profile's colour (docs/profiles-v0.md §3.2)

    func testAProfileHasAColourAndItsTerminalsCarryIt() throws {
        // The names are the service's (`PROFILE_COLORS` in the daemon's profiles/store.ts), in its order.
        XCTAssertEqual(ProfileColor.allCases.map(\.rawValue), ["violet", "sand", "mint", "orchid", "olive", "slate"])
        XCTAssertEqual(ProfileColor.sand.title, "Sand")
        // No two look alike, in either appearance; none is a colour a state, the signal or the accent is said in.
        XCTAssertEqual(Set(ProfileColor.allCases.map(\.dark)).count, ProfileColor.allCases.count)
        XCTAssertEqual(Set(ProfileColor.allCases.map(\.light)).count, ProfileColor.allCases.count)
        let taken: Set<UInt32> = [0x2EE6FF, 0x0086A8, 0xFFB000, 0xC27400, 0x9BE22D, 0x3F8F00, 0xFF4A3D, 0xD7261B, 0xFF2E88, 0xE0106E, 0x34C759, 0x30D158, 0xFF9500, 0xFF9F0A, 0xFF3B30, 0xFF453A, 0x007AFF, 0x0A84FF]
        XCTAssertTrue(taken.isDisjoint(with: ProfileColor.allCases.flatMap { [$0.dark, $0.light] }))

        let list = try JSONDecoder().decode(AgentProfiles.self, from: Data(#"""
        {"current":"abc123def0","creatable":true,"profiles":[
          {"id":"default","name":"Default","kind":"subscription","account":"me@example.com"},
          {"id":"abc123def0","name":"cwork1","kind":"subscription","color":"mint"},
          {"id":"abc123def1","name":"later","kind":"subscription","color":"a-colour-of-a-newer-service"}]}
        """#.utf8))
        XCTAssertEqual(list.profiles.map(\.tint), [nil, .mint, nil])
        XCTAssertEqual(list.profiles[2].color, "a-colour-of-a-newer-service")

        let terminal = { (profile: String, status: String) throws -> TerminalInfo in
            try JSONDecoder().decode(TerminalInfo.self, from: Data(#"{"id":"t1","harness":"claude-code","cwd":"/w","name":"n","status":"\#(status)","profile":\#(profile)}"#.utf8))
        }
        let under = try terminal(#"{"id":"abc123def0","name":"cwork1","color":"mint"}"#, "idle")
        XCTAssertEqual(under.profileColor, .mint)
        XCTAssertEqual(under.context.profileColor, .mint)
        // What its stream says of it later does not drop the colour.
        XCTAssertEqual(under.with(status: "working").profileColor, .mint)
        XCTAssertNil(try terminal(#"{"id":"abc123def0","name":"cwork1"}"#, "idle").profileColor)
        XCTAssertNil(try terminal(#"{"id":"abc123def0","name":"cwork1","color":"plaid"}"#, "idle").profileColor)
        XCTAssertNil(try terminal("null", "idle").profileColor)
        // A terminal that ended still knows whose it was; the screens draw the dot only while it runs.
        XCTAssertFalse(try terminal(#"{"id":"abc123def0","name":"cwork1","color":"mint"}"#, "exited").running)
        XCTAssertEqual(TerminalInfo(id: "t9", harness: "claude-code", cwd: "/w", name: "n", status: "idle", createdAt: 1).under(profile: "side", color: .sand).profileColor, .sand)
    }

    // MARK: the profile is chosen where a terminal is made (docs/profiles-v0.md §3.3)

    func testTheProfileGoesWithTheRequestThatStartsOrContinuesATerminal() throws {
        func sent(_ body: some Encodable) throws -> [String: Any] { try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any]) }
        // A new terminal under the one chosen in the panel; nothing said where the agent has only the Mac's own.
        XCTAssertEqual(try sent(NewTerminalRequest(harness: "claude-code", cwd: "~/p", profile: "abc123def0"))["profile"] as? String, "abc123def0")
        XCTAssertNil(try sent(NewTerminalRequest(harness: "codex", cwd: "~/p"))["profile"])
        // A conversation: under the one it last ran under unless `Resume As` names another — which a fork and a folder
        // picked later keep.
        let plain = ResumeTerminalRequest(harness: "claude-code", cwd: "/w", agentSessionId: "s1")
        XCTAssertNil(try sent(plain)["profile"])
        let named = ResumeTerminalRequest(harness: "claude-code", cwd: "/w", agentSessionId: "s1", profile: "default")
        XCTAssertEqual(try sent(named)["profile"] as? String, "default")
        XCTAssertEqual(named.forking().profile, "default")
        XCTAssertEqual(named.forking().fork, true)
        XCTAssertEqual(named.continuing(in: "/elsewhere").profile, "default")

        // The list says which profile a conversation last ran under, when it is not the Mac's own.
        let listed = try JSONDecoder().decode([SessionSummary].self, from: Data(#"[{"harness":"claude-code","id":"s1","cwd":"/w","profile":"abc123def0"},{"harness":"claude-code","id":"s2","cwd":"/w"},{"harness":"claude-code","id":"s3","cwd":"/w","profile":""}]"#.utf8))
        XCTAssertEqual(listed.map(\.profile), ["abc123def0", nil, nil])

        // What the panel offers: only where there is something to choose between; first the one last chosen, while it is there.
        let own = AgentProfile(id: "default", name: "Default", account: "me@example.com"), work = AgentProfile(id: "abc123def0", name: "cwork1", color: "violet")
        XCTAssertFalse(AgentProfiles(current: "default", profiles: [own], creatable: true).several)
        let two = AgentProfiles(current: "abc123def0", profiles: [own, work], creatable: true)
        XCTAssertTrue(two.several)
        XCTAssertEqual(two.offered, work)
        XCTAssertEqual(AgentProfiles(current: "gone000000", profiles: [own, work], creatable: true).offered, own)
        XCTAssertEqual(ProfileWords.line(own), "Default — me@example.com")
        XCTAssertEqual(ProfileWords.line(work), "cwork1 — Not Signed In")
        XCTAssertEqual(ProfileWords.who(AgentProfile(id: "default", name: "Default")), "This Mac’s own")
    }
}

/// A profile's own browser on the Browser page (docs/profiles-v0.md §5.2): the browsers there are, and the browser
/// routes asked of the one chosen.
final class ProfileBrowserTests: XCTestCase {
    func testTheSeveralCamoufoxAreToldApartByTheirFolder() {
        let home = URL(fileURLWithPath: "/Users/me/Library/Application Support/AgentSwitch")
        let app = "/Users/me/Library/Application Support/AgentSwitch/browser/engine/camoufox/current/Camoufox.app/Contents/MacOS/camoufox"
        let commands: [Int32: String] = [
            101: "\(app) -no-remote -headless -profile /Users/me/Library/Application Support/AgentSwitch/browser-profiles/main-camoufox -juggler-pipe",
            202: "\(app) -no-remote -profile /Users/me/Library/Application Support/AgentSwitch/browser-profiles/claude-code.abc123def0-camoufox -juggler-pipe",
            303: "\(app) -no-remote -profile /Users/me/Library/Application Support/AgentSwitch/browser-profiles/claude-code.abc123def0-camoufox-2",
        ]
        // The folder has spaces in it (`Application Support`): it is looked for as the whole path it is.
        XCTAssertEqual(BrowserEngineLocation.camoufoxProfile(nil, agentswitchHome: home), "/Users/me/Library/Application Support/AgentSwitch/browser-profiles/main-camoufox")
        XCTAssertEqual(BrowserEngineLocation.process(of: nil, among: commands, agentswitchHome: home), 101)
        XCTAssertEqual(BrowserEngineLocation.process(of: "claude-code.abc123def0", among: commands, agentswitchHome: home), 202)
        XCTAssertNil(BrowserEngineLocation.process(of: "claude-code.0000000000", among: commands, agentswitchHome: home))
        XCTAssertNil(BrowserEngineLocation.process(of: nil, among: [:], agentswitchHome: home))
    }

    func testTheBrowserItselfIsFoundNotOneOfItsHelpers() {
        // As seen on a Mac with one profile's Camoufox running (2026-10-09): macOS lists the browser and six of its
        // helper programs as running apps; every one of them was started with the profile's folder in its arguments.
        let home = URL(fileURLWithPath: "/Users/me/Library/Application Support/AgentSwitch")
        let engine = URL(fileURLWithPath: "/Users/me/Library/Application Support/AgentSwitch/browser/engine/camoufox/current/Camoufox.app")
        let folder = "/Users/me/Library/Application Support/AgentSwitch/browser-profiles/claude-code.abc123def0-camoufox"
        let helper = "\(engine.path)/Contents/MacOS/plugin-container.app/Contents/MacOS/plugin-container"
        let commands: [Int32: String] = [
            50729: "\(engine.path)/Contents/MacOS/camoufox -no-remote -wait-for-browser -foreground -profile \(folder) -juggler-pipe about:blank",
            50745: "\(engine.path)/Contents/MacOS/gpu-helper.app/Contents/MacOS/Camoufox GPU Helper -parentBuildID 20261006020952 -sbStartup -parentPid 50729 -profile \(folder) gpu",
            50746: "\(helper) -parentBuildID 20261006020952 -prefsHandle 0:26724 -sbStartup -parentPid 50729 -profile \(folder) socket",
            50748: "\(helper) -isForBrowser -prefsHandle 0:26978 -jsInitHandle 2:162620 -sbStartup -parentPid 50729 -profile \(folder) tab",
            50200: "\(helper) -isForBrowser -prefsHandle 0:1 -sbStartup -parentPid 50729 -profile \(folder) tab",
        ]
        // Whichever way the list is gone through, it is the browser: a helper cannot be brought forward.
        for _ in 0..<20 { XCTAssertEqual(BrowserEngineLocation.process(of: "claude-code.abc123def0", among: commands, agentswitchHome: home), 50729) }
        // Only helpers left (the browser is going away): none.
        XCTAssertNil(BrowserEngineLocation.process(of: "claude-code.abc123def0", among: commands.filter { $0.key != 50729 }, agentswitchHome: home))

        // What macOS says of each: the browser is the engine's app; a helper is an app inside it.
        XCTAssertTrue(BrowserEngineLocation.isBrowserItself(bundle: engine, executable: engine.appendingPathComponent("Contents/MacOS/camoufox"), engine: engine))
        XCTAssertTrue(BrowserEngineLocation.isBrowserItself(bundle: nil, executable: engine.appendingPathComponent("Contents/MacOS/camoufox"), engine: engine))
        XCTAssertFalse(BrowserEngineLocation.isBrowserItself(bundle: engine.appendingPathComponent("Contents/MacOS/plugin-container.app"), executable: URL(fileURLWithPath: helper), engine: engine))
        XCTAssertFalse(BrowserEngineLocation.isBrowserItself(bundle: nil, executable: URL(fileURLWithPath: helper), engine: engine))
        XCTAssertFalse(BrowserEngineLocation.isBrowserItself(bundle: URL(fileURLWithPath: "/Applications/Firefox.app"), executable: URL(fileURLWithPath: "/Applications/Firefox.app/Contents/MacOS/firefox"), engine: engine))
        XCTAssertFalse(BrowserEngineLocation.isBrowserItself(bundle: nil, executable: nil, engine: engine))
    }

    func testAPageShownInAProfilesBrowserBringsItsWindowForwardOnce() throws {
        let snapshot = try JSONDecoder().decode(LiveSnapshot.self, from: Data(#"{"rows":[],"ended":[],"open":1,"now":1791500010000,"shown":{"browser":"claude-code.abc123def0","tab":"t3","at":1791500008000}}"#.utf8))
        let shown = try XCTUnwrap(snapshot.shown)
        XCTAssertEqual(shown, LiveSnapshot.Shown(browser: "claude-code.abc123def0", tab: "t3", at: 1_791_500_008_000))
        // Just now and not acted on yet: once. The same one again, or one from long ago (the app was just opened): not.
        XCTAssertTrue(shown.fresh(after: nil, now: snapshot.now))
        XCTAssertFalse(shown.fresh(after: shown.at, now: snapshot.now))
        XCTAssertTrue(shown.fresh(after: shown.at - 1, now: snapshot.now))
        XCTAssertFalse(shown.fresh(after: nil, now: snapshot.now.addingTimeInterval(60)))
        XCTAssertNil(try JSONDecoder().decode(LiveSnapshot.self, from: Data(#"{"rows":[],"now":1}"#.utf8)).shown)
    }

    func testTheBrowserRoutesAreAskedOfTheBrowserChosen() async throws {
        let transport = StubTransport { request in
            request.url?.path == "/browsers"
                ? (200, #"{"browsers":[{"key":null,"name":"Shared","running":true},{"key":"claude-code.abc123def0","name":"cwork1","agent":"claude-code","exit":{"ip":"203.0.113.9","place":"Tokyo"},"running":false}]}"#)
                : (200, #"{"running":false,"groups":[],"engine":"camoufox","windows":true}"#)
        }
        let client = DaemonClient(port: 4711, transport: transport)
        let browsers = try await client.browsers()
        XCTAssertEqual(browsers, [BrowserChoice(key: nil, name: "Shared", running: true),
                                  BrowserChoice(key: "claude-code.abc123def0", name: "cwork1", agent: "claude-code", exit: ProfileExit(ip: "203.0.113.9", place: "Tokyo"))])
        XCTAssertEqual(browsers.map(\.id), ["", "claude-code.abc123def0"])
        // The shared browser's routes as they are; a profile's own under its address; the engine is one for all.
        _ = try await client.browserTabs()
        let own = client.forBrowser("claude-code.abc123def0")
        _ = try await own.browserTabs()
        _ = try? await own.browserIdentity()
        _ = try? await own.browserEngine()
        _ = try? await own.profiles()
        _ = try await own.forBrowser(nil).browserTabs()
        XCTAssertEqual(transport.requests.dropFirst().map { $0.url!.path }, [
            "/browser/tabs", "/profile-browser/claude-code.abc123def0/browser/tabs", "/profile-browser/claude-code.abc123def0/browser/identity",
            "/browser/engine", "/profiles", "/browser/tabs"])
        XCTAssertEqual(own.browserPrefix, "/profile-browser/claude-code.abc123def0")
        XCTAssertEqual(client.browserPrefix, "")
    }
}

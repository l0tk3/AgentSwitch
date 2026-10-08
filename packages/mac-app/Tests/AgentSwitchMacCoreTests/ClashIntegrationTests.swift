import XCTest
@testable import AgentSwitchMacCore

/// Clash Integration (docs/clash-v0.md §7): what the service says is read as it is, what is still to do in Clash Verge
/// is said in order, the settings go back whole, and the page's short words are written as units.
final class ClashIntegrationTests: XCTestCase {
    private func view(_ fields: String, source: Bool = true) throws -> ClashView {
        let kept = #"{"kind":"file","name":"tgyun_config.yaml","updatedAt":1791462000000,"nodes":42,"providers":[{"name":"tgyun","host":"sub.example:9888","updatedAt":1791462000000,"nodes":42}],"traffic":{"used":13207024435,"total":107374182400,"expire":1798675200000}}"#
        let json = """
        {\(fields),"source":\(source ? kept : "null"),"nodes":["A","B","C"],"profiles":[{"uid":"Lbw7BJYzpand","name":"mine.yaml","type":"local","file":"Lbw7BJYzpand.yaml"}],
         "settings":{"claude":{"nodes":["B","A"]},"openai":{"nodes":[]},"direct":["5.102.107.254"],"autoUpdateHours":6,"renameDefault":true,
                     "templates":{"domestic":{"on":true,"rules":null},"block":{"on":false,"rules":["DOMAIN,ads.example"]}}},
         "templates":{"domestic":{"on":true,"custom":false,"count":169},"block":{"on":false,"custom":true,"count":1}},"defaultGroup":"Candy",
         "services":{"claude":{"group":"Claude","auto":"Claude自动选择","live":true,"now":"Claude自动选择","autoNow":"B","missing":[]},
                     "openai":{"group":"OpenAI","auto":"OpenAI自动选择","live":false,"now":null,"autoNow":null,"missing":["gone"]}},
         "install":"clash://install-config?url=x","fetchedAt":null}
        """
        return try JSONDecoder().decode(ClashView.self, from: Data(json.utf8))
    }

    func testWhatTheServiceSaysIsReadAsItIs() throws {
        let seen = try view(#""found":true,"running":true,"version":"v1.19.31","tun":true,"active":true,"upToDate":true"#)
        XCTAssertEqual(seen.settings, ClashSettings(claude: .init(nodes: ["B", "A"]), openai: .init(), direct: ["5.102.107.254"], autoUpdateHours: 6,
                                                    templates: .init(domestic: .init(on: true), block: .init(on: false, rules: ["DOMAIN,ads.example"])), renameDefault: true))
        XCTAssertEqual(seen.state(.domestic), ClashTemplateState(on: true, custom: false, count: 169))
        XCTAssertEqual(seen.state(.block).map { ClashText.rules($0.count) }, "1 Rule")
        XCTAssertEqual(seen.defaultGroup, "Candy")
        XCTAssertEqual(seen.settings[.claude].nodes, ["B", "A"])
        XCTAssertEqual(seen.source?.providers, [ClashSourceProvider(name: "tgyun", host: "sub.example:9888", nodes: 42, error: nil)])
        XCTAssertEqual(seen.source.map(ClashText.origin), "tgyun_config.yaml")
        let claude = try XCTUnwrap(seen.state(.claude)), openai = try XCTUnwrap(seen.state(.openai))
        XCTAssertTrue(claude.live && claude.automatic)
        XCTAssertEqual(claude.autoNow, "B")
        XCTAssertFalse(openai.live || openai.automatic)
        XCTAssertEqual(openai.missing, ["gone"])
        XCTAssertNil(seen.fetchedAt)
        XCTAssertEqual(seen.todo, [])
    }

    func testWhatIsStillToDoIsSaidInOrder() throws {
        XCTAssertEqual(try view(#""found":false,"running":false,"active":false,"upToDate":false"#).todo.count, 1)
        XCTAssertTrue(try view(#""found":true,"running":false,"active":false,"upToDate":false"#).todo[0].contains("没有在运行"))
        let none = try view(#""found":true,"running":true,"tun":false,"active":false,"upToDate":false"#, source: false).todo
        XCTAssertEqual(none.count, 2)
        XCTAssertTrue(none[0].contains("订阅") && none[1].contains("TUN"))
        XCTAssertEqual(try view(#""found":true,"running":true,"tun":true,"active":false,"upToDate":false"#).todo, ["在 Clash Verge 里添加并切换到 AgentSwitch 订阅。"])
        XCTAssertTrue(try view(#""found":true,"running":true,"tun":true,"active":true,"upToDate":false"#).todo[0].contains("更新一次"))
    }

    func testSettingsGoBackWhole() throws {
        var settings = ClashSettings()
        settings[.openai].nodes = ["US 01"]
        settings.autoUpdateHours = 0
        let sent = try JSONSerialization.jsonObject(with: JSONEncoder().encode(settings)) as? [String: Any]
        XCTAssertEqual((sent?["claude"] as? [String: Any])?["nodes"] as? [String], [])
        XCTAssertEqual((sent?["openai"] as? [String: Any])?["nodes"] as? [String], ["US 01"])
        XCTAssertEqual(sent?["direct"] as? [String], [])
        XCTAssertEqual(sent?["autoUpdateHours"] as? Int, 0)
        // A template that was not edited says so (`null`), one that was sends its lines; the rename is a plain yes or no.
        settings.templates[.block] = ClashTemplateSetting(on: true, rules: ClashText.lines("DOMAIN,ads.example\n\n# mine\n"))
        let again = try JSONSerialization.jsonObject(with: JSONEncoder().encode(settings)) as? [String: Any]
        let templates = again?["templates"] as? [String: [String: Any]]
        XCTAssertTrue(templates?["domestic"]?["rules"] is NSNull)
        XCTAssertEqual(templates?["domestic"]?["on"] as? Bool, false)
        XCTAssertEqual(templates?["block"]?["rules"] as? [String], ["DOMAIN,ads.example", "", "# mine", ""])
        XCTAssertEqual(again?["renameDefault"] as? Bool, false)
        XCTAssertEqual(ClashTemplate.allCases.map(\.title), ["Domestic & Local Direct", "Block Ads & Trackers"])
        XCTAssertEqual([ClashText.rules(169), ClashText.rules(1)], ["169 Rules", "1 Rule"])
        XCTAssertTrue(ClashSettings.updateHours.contains(ClashSettings().autoUpdateHours))
    }

    func testShortWords() {
        XCTAssertEqual([ClashText.delay(.some(428)), ClashText.delay(.some(nil)), ClashText.delay(nil)], ["428 ms", "Timeout", ""])
        XCTAssertEqual(ClashSettings.updateHours.map(ClashText.interval), ["Off", "1 h", "6 h", "12 h", "24 h"])
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        XCTAssertEqual(ClashText.traffic(ClashTraffic(used: 13_207_024_435, total: 107_374_182_400, expire: 1_798_675_200_000), calendar: utc), "12.3 / 100 GB · Expires 2026/12/31")
        XCTAssertEqual(ClashText.traffic(ClashTraffic(used: 0, total: 53_687_091_200, expire: nil)), "0 / 50 GB")
    }
}

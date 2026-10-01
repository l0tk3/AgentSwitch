import XCTest
@testable import AgentSwitchMacCore

final class UsageTests: XCTestCase {
    /// A real `GET /quota` answer (2026-09-27).
    static let live = """
    [{"harness":"codex","fetchedAt":1790482051141,"remaining":0.92,"detail":{"planType":"pro","windows":[{"label":"7d","usedPercent":8,"resetsAt":1791053972}],"credits":{"hasCredits":false,"unlimited":false,"balance":"0"},"rateLimitReachedType":null},"source":"codex app-server account/rateLimits/read","error":null},
     {"harness":"opencode","fetchedAt":1790482049570,"remaining":1,"detail":{"is_available":true,"balances":[{"currency":"CNY","total":"96.23","granted":"0.00","topped_up":"96.23"}]},"source":"deepseek /user/balance","error":null},
     {"harness":"claude-code","fetchedAt":1790482049405,"remaining":0.18,"detail":{"windows":[{"label":"5h","usedPercent":20,"resetsAt":1790496600},{"label":"7d","usedPercent":82,"resetsAt":1790485200}],"windowsAgeMs":155743},"source":"claude rate_limit_event (subscription windows)","error":null}]
    """

    private var calendar: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }
    /// 2026-09-27 04:07:31 UTC, when the live answer was read.
    private let now = Date(timeIntervalSince1970: 1_790_482_051)

    private func readings(_ json: String = UsageTests.live) throws -> [QuotaReading] {
        try QuotaReading.decodeList(Data(json.utf8))
    }

    func testTheDaemonsAnswerDecodes() throws {
        let list = try readings()
        XCTAssertEqual(list.map(\.harness), ["codex", "opencode", "claude-code"])
        XCTAssertEqual(list[0].planType, "pro")
        XCTAssertEqual(list[0].windows, [QuotaWindow(label: "7d", usedPercent: 8, resetsAt: Date(timeIntervalSince1970: 1_791_053_972))])
        XCTAssertEqual(list[1].balances, [QuotaBalance(currency: "CNY", total: "96.23")])
        XCTAssertEqual(list[2].windows.map(\.label), ["5h", "7d"])
        XCTAssertEqual(list[2].fetchedAt, Date(timeIntervalSince1970: 1_790_482_049.405))
        XCTAssertNil(list[2].error)
        XCTAssertEqual(Usage.readAt(list), Date(timeIntervalSince1970: 1_790_482_051.141))
    }

    func testRowsComeInTheFixedOrderWithBothSlots() throws {
        let rows = Usage.rows(try readings(), now: now, calendar: calendar)
        XCTAssertEqual(rows.map(\.title), ["Claude Code", "Codex · Pro", "OpenCode"])

        let claude = rows[0]
        XCTAssertEqual(claude.slots.map(\.label), ["5h", "7d"])
        XCTAssertEqual(claude.slots.map(\.percent), [20, 82])
        XCTAssertEqual(claude.slots.map(\.valueText), ["20%", "82%"])
        XCTAssertEqual(claude.slots.map(\.note), ["Resets 08:10", "Resets 05:00"])
        XCTAssertFalse(claude.showsBalance)

        let codex = rows[1]
        XCTAssertEqual(codex.slots.map(\.label), ["5h", "7d"])
        XCTAssertEqual(codex.slots.map(\.percent), [nil, 8])
        XCTAssertEqual(codex.slots[0].valueText, "—")
        XCTAssertEqual(codex.slots[0].note, "No Reading")
        XCTAssertEqual(codex.slots[0].fraction, 0)
        XCTAssertEqual(codex.slots[1].note, "Resets 10/3 18:59")

        let opencode = rows[2]
        XCTAssertTrue(opencode.showsBalance)
        XCTAssertEqual(opencode.slots, [])
        XCTAssertEqual(opencode.balanceText, "Balance ¥96.23")
    }

    func testAWindowWhoseResetHasPassedShowsNoReading() throws {
        let later = Date(timeIntervalSince1970: 1_790_490_000)   // 06:20: after 7d's reset (05:00), before 5h's (08:10)
        let claude = Usage.rows(try readings(), now: later, calendar: calendar)[0]
        XCTAssertEqual(claude.slots.map(\.percent), [20, nil])
        XCTAssertEqual(claude.slots[1].note, "Reset")
        XCTAssertNil(claude.slots[1].resetsAt)
    }

    func testOtherClaudeWindowsStayOutAndValuesAreClamped() {
        let windows = [QuotaWindow(label: "7d opus", usedPercent: 99, resetsAt: nil),
                       QuotaWindow(label: "7d sonnet", usedPercent: 40, resetsAt: nil),
                       QuotaWindow(label: "5h", usedPercent: 104.6, resetsAt: nil)]
        let rows = Usage.rows([QuotaReading(harness: "claude-code", fetchedAt: now, windows: windows)], now: now, calendar: calendar)
        XCTAssertEqual(rows[0].slots.map(\.percent), [100, nil])
        XCTAssertEqual(rows[0].slots[0].note, "")
        XCTAssertTrue(rows[0].slots[0].isHigh)
        XCTAssertEqual(Usage.slot("5h", windows: [QuotaWindow(label: "5h", usedPercent: 89.4, resetsAt: nil)], now: now).isHigh, false)
        XCTAssertEqual(Usage.slot("5h", windows: [QuotaWindow(label: "5h", usedPercent: 89.5, resetsAt: nil)], now: now).isHigh, true)
    }

    func testErrorsWithNothingUsableShowDashes() throws {
        let json = """
        [{"harness":"opencode","fetchedAt":1790482049570,"remaining":null,"detail":{},"source":"deepseek /user/balance","error":"HTTP 401"},
         {"harness":"codex","fetchedAt":1790482049570,"remaining":null,"detail":{},"source":"codex app-server","error":"spawn codex ENOENT"}]
        """
        let list = try readings(json)
        XCTAssertEqual(list.map(\.error), ["HTTP 401", "spawn codex ENOENT"])
        let rows = Usage.rows(list, now: now, calendar: calendar)
        XCTAssertEqual(rows.map(\.title), ["Claude Code", "Codex", "OpenCode"], "a harness the daemon did not report still gets its row")
        XCTAssertEqual(rows[0].slots.map(\.valueText), ["—", "—"])
        XCTAssertEqual(rows[1].slots.map(\.valueText), ["—", "—"])
        XCTAssertEqual(rows[2].balanceText, "Balance —")
    }

    func testNoReadingsNoRows() {
        XCTAssertEqual(Usage.rows([], now: now), [])
    }

    func testAnEntryThatCannotBeReadIsSkipped() throws {
        let json = #"[{"fetchedAt":1},{"harness":"codex","detail":{"windows":[{"label":"5h"},{"label":"5h","usedPercent":"x"},{"label":"7d","usedPercent":12.4}]}}]"#
        let list = try readings(json)
        XCTAssertEqual(list.map(\.harness), ["codex"])
        XCTAssertEqual(list[0].windows.map(\.label), ["7d"])
        XCTAssertNil(list[0].fetchedAt)
        XCTAssertNil(Usage.readAt(list))
    }

    func testBalancesAndPlans() {
        XCTAssertEqual(Usage.money(QuotaBalance(currency: "CNY", total: "96.23")), "¥96.23")
        XCTAssertEqual(Usage.money(QuotaBalance(currency: "usd", total: "12")), "$12.00")
        XCTAssertEqual(Usage.money(QuotaBalance(currency: "EUR", total: "3.5")), "3.50 EUR")
        XCTAssertEqual(Usage.money(QuotaBalance(currency: "CNY", total: "")), nil)
        XCTAssertEqual(Usage.balance([QuotaBalance(currency: "CNY", total: "1"), QuotaBalance(currency: "USD", total: "2")]), "¥1.00 · $2.00")
        XCTAssertNil(Usage.balance([]))
        let numeric = try? QuotaReading.decodeList(Data(#"[{"harness":"opencode","detail":{"balances":[{"currency":"CNY","total":5}]}}]"#.utf8))
        XCTAssertEqual(numeric?.first?.balances.first.flatMap(Usage.money), "¥5.00")
        XCTAssertEqual(Usage.title(.codex, plan: "pro"), "Codex · Pro")
        XCTAssertEqual(Usage.title(.codex, plan: "team_plus"), "Codex · Team Plus")
        XCTAssertEqual(Usage.title(.codex, plan: " "), "Codex")
        XCTAssertEqual(Usage.title(.codex, plan: nil), "Codex")
        XCTAssertEqual(Usage.harness(named: "claude-code"), .claude)
        XCTAssertNil(Usage.harness(named: "gemini"))
    }

    func testResetTimes() {
        XCTAssertEqual(Usage.resetText(Date(timeIntervalSince1970: 1_790_496_600), now: now, calendar: calendar), "Resets 08:10")
        XCTAssertEqual(Usage.resetText(now.addingTimeInterval(86_400), now: now, calendar: calendar), "Resets Tomorrow 04:07")
        XCTAssertEqual(TimeText.at(now.addingTimeInterval(-86_400), now: now, calendar: calendar), "Yesterday 04:07")
        XCTAssertEqual(TimeText.at(now, now: now, calendar: calendar), "04:07")
    }

    func testTheClientReadsCachedOrFresh() async throws {
        let stub = StubTransport { req in
            req.url?.path == "/quota" ? (200, UsageTests.live) : (404, "404 Not Found")
        }
        let client = DaemonClient(port: 4811, transport: stub)
        let cached = try await client.quota()
        XCTAssertEqual(cached.count, 3)
        _ = try await client.quota(refresh: true)
        XCTAssertEqual(stub.requests.map { $0.url!.absoluteString },
                       ["http://127.0.0.1:4811/quota", "http://127.0.0.1:4811/quota?refresh=1"])
        XCTAssertEqual(stub.requests.map(\.httpMethod), ["GET", "GET"])

        let old = DaemonClient(port: 4811, transport: StubTransport { _ in (404, "404 Not Found") })
        do { _ = try await old.quota(); XCTFail() } catch {
            XCTAssertEqual(error as? DaemonError, .notSupported("GET /quota"))
        }
    }
}

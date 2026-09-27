import Foundation
import XCTest
@testable import AgentSwitchKit

/// 设置 › 用量 (docs/ui-v0.md §4.2): `GET /quota` as rows.
final class UsageTests: XCTestCase {
    /// A real `GET /quota` answer (2026-09-27), in the daemon's order.
    private static let real = #"""
    [{"harness":"codex","fetchedAt":1790482051141,"remaining":0.92,"detail":{"planType":"pro","windows":[{"label":"7d","usedPercent":8,"resetsAt":1791053972}],"credits":{"hasCredits":false,"unlimited":false,"balance":"0"},"rateLimitReachedType":null},"source":"codex app-server account/rateLimits/read","error":null},
     {"harness":"opencode","fetchedAt":1790482049570,"remaining":1,"detail":{"is_available":true,"balances":[{"currency":"CNY","total":"96.23","granted":"0.00","topped_up":"96.23"}]},"source":"deepseek /user/balance","error":null},
     {"harness":"claude-code","fetchedAt":1790482049405,"remaining":0.18,"detail":{"windows":[{"label":"5h","usedPercent":20,"resetsAt":1790496600},{"label":"7d","usedPercent":82,"resetsAt":1790485200},{"label":"7d opus","usedPercent":40,"resetsAt":1790485200}],"windowsAgeMs":155743},"source":"claude rate_limit_event (subscription windows)","error":null}]
    """#

    private static let fetched = Date(timeIntervalSince1970: 1790482051)

    private func readings(_ text: String = real) throws -> [QuotaReading] {
        try JSONDecoder().decode([QuotaReading].self, from: Data(text.utf8))
    }

    func testRealReadingBecomesThreeRowsInOrder() throws {
        let rows = Usage.rows(try readings(), now: Self.fetched)
        XCTAssertEqual(rows.map(\.harness), ["claude-code", "codex", "opencode"])
        XCTAssertEqual(rows.map(\.title), ["Claude Code", "Codex · Pro", "OpenCode"])

        let claude = rows[0]
        XCTAssertEqual(claude.slots.map(\.label), ["5h", "7d"], "extra windows such as 7d opus are left out")
        XCTAssertEqual(claude.slots.map(\.percent), [20, 82])
        XCTAssertEqual(claude.slots.map(\.percentText), ["20%", "82%"])
        XCTAssertEqual(claude.slots[0].resetsAt, Date(timeIntervalSince1970: 1790496600))
        XCTAssertNil(claude.balance)
        XCTAssertFalse(claude.showsBalance)

        let codex = rows[1]
        XCTAssertEqual(codex.slots.map(\.label), ["5h", "7d"], "both slots even without a 5h window")
        XCTAssertEqual(codex.slots.map(\.percent), [nil, 8])
        XCTAssertEqual(codex.slots.map(\.percentText), ["—", "8%"])
        XCTAssertNil(codex.slots[0].resetsAt)

        let opencode = rows[2]
        XCTAssertTrue(opencode.slots.isEmpty)
        XCTAssertTrue(opencode.showsBalance)
        XCTAssertEqual(opencode.balance, "¥96.23")
        XCTAssertEqual(opencode.balanceText, "余额 ¥96.23")
    }

    func testWindowWhoseResetHasPassedHasNoReading() throws {
        let later = Date(timeIntervalSince1970: 1790485200 + 1)   // Claude's 7d window reset one second ago
        let claude = try XCTUnwrap(Usage.rows(try readings(), now: later).first)
        XCTAssertEqual(claude.slots.map(\.percent), [20, nil])
        XCTAssertNil(claude.slots[1].resetsAt)
        XCTAssertEqual(claude.slots[1].percentText, "—")
    }

    func testFailedReadingShowsDashes() throws {
        let failed = try readings(#"""
        [{"harness":"claude-code","remaining":null,"detail":{},"source":"local count","fetchedAt":1790000000000,"error":"quota timed out after 10000 ms"},
         {"harness":"codex","remaining":null,"detail":null,"source":"codex app-server","fetchedAt":1790000000000,"error":"spawn codex ENOENT"},
         {"harness":"opencode","remaining":null,"detail":{},"source":"deepseek","fetchedAt":1790000000000,"error":"no key"}]
        """#)
        let rows = Usage.rows(failed, now: Self.fetched)
        XCTAssertEqual(rows.map(\.title), ["Claude Code", "Codex", "OpenCode"], "no plan without a reading")
        XCTAssertEqual(rows[0].slots.map(\.percentText), ["—", "—"])
        XCTAssertEqual(rows[1].slots.map(\.percentText), ["—", "—"])
        XCTAssertNil(rows[2].balance)
        XCTAssertEqual(rows[2].balanceText, "余额 —")
    }

    func testOnlyKnownExecutorsThatAnswered() throws {
        let some = try readings(#"""
        [{"harness":"echo","remaining":1,"detail":{},"source":"none","fetchedAt":1790000000000,"error":null},
         {"harness":"codex","remaining":1,"detail":{"planType":"plus","windows":[{"label":"5h","usedPercent":3,"resetsAt":null}]},"source":"x","fetchedAt":1790000000000,"error":null}]
        """#)
        let rows = Usage.rows(some, now: Self.fetched)
        XCTAssertEqual(rows.map(\.title), ["Codex · Plus"])
        XCTAssertEqual(rows[0].slots.map(\.percent), [3, nil], "a window without a reset time keeps its reading")
        XCTAssertTrue(Usage.rows([], now: Self.fetched).isEmpty)
    }

    func testPercentIsRoundedAndClampedAndHighFromNinety() throws {
        let values = try readings(#"""
        [{"harness":"claude-code","remaining":0,"detail":{"windows":[{"label":"5h","usedPercent":89.6,"resetsAt":null},{"label":"7d","usedPercent":130,"resetsAt":null}]},"source":"x","fetchedAt":1790000000000,"error":null},
         {"harness":"codex","remaining":1,"detail":{"windows":[{"label":"5h","usedPercent":-4,"resetsAt":null},{"label":"7d","usedPercent":89.4,"resetsAt":null}]},"source":"x","fetchedAt":1790000000000,"error":null}]
        """#)
        let rows = Usage.rows(values, now: Self.fetched)
        XCTAssertEqual(rows[0].slots.map(\.percent), [90, 100])
        XCTAssertEqual(rows[0].slots.map(\.isHigh), [true, true])
        XCTAssertEqual(rows[1].slots.map(\.percent), [0, 89])
        XCTAssertEqual(rows[1].slots.map(\.isHigh), [false, false])
    }

    func testBalancesByCurrency() throws {
        let money = try readings(#"""
        [{"harness":"opencode","remaining":1,"detail":{"balances":[{"currency":"USD","total":"5"},{"currency":"CNY","total":"0.5"},{"currency":"EUR","total":"2.10"}]},"source":"x","fetchedAt":1790000000000,"error":null}]
        """#)
        XCTAssertEqual(Usage.rows(money, now: Self.fetched).first?.balance, "$5.00 · ¥0.50 · 2.10 EUR")
    }

    func testReadAtIsTheOldestReadingShown() throws {
        XCTAssertEqual(Usage.readAt(try readings()), Date(milliseconds: 1790482049405))
        XCTAssertNil(Usage.readAt([]))
    }

    func testSpokenLabels() throws {
        let claude = try XCTUnwrap(Usage.rows(try readings(), now: Self.fetched).first)
        XCTAssertEqual(claude.slots.map(\.spokenLabel), ["5 小时", "7 天"])
    }
}

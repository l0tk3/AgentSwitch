import XCTest
@testable import AgentSwitchKit

/// The line under the reply box (docs/simple-view-v0.md §5.25; user #599): the context's fill and the allowances, as
/// the Mac says them.
final class UsageLineTests: XCTestCase {
    let now: Int64 = 1_795_685_000_000

    func testTheStatusLinesNumbersComeFirstAndTheRecordsAfter() {
        let meter = TerminalMeter(context: .init(percent: 28.4, used: 280_000, window: 1_000_000),
                                  limits: [UsageLimit(label: "5h", percent: 12, resetsAt: now + 7_260_000), UsageLimit(label: "7d", percent: 83.4, resetsAt: now + 5 * 86_400_000 + 8 * 3_600_000)])
        let line = RecordDisplay.usageLine(RecordUsage(used: 270_000), meter: meter, now: now)
        XCTAssertEqual(line.context, "28%")
        XCTAssertEqual(line.contextHelp, "280k / 1M")
        XCTAssertEqual(line.limits.map(\.text), ["5h 12%", "7d 83%"])
        XCTAssertEqual(line.limits.map(\.near), [false, true])
        XCTAssertEqual(line.limits.map(\.help), ["Resets in 2h 1m", "Resets in 5d 8h"])
        // Without a status line (Codex): the record's fill and allowances; a reset gone by is not said.
        let codex = RecordDisplay.usageLine(RecordUsage(used: 51_000, window: 272_000, limits: [UsageLimit(label: "7d", percent: 8, resetsAt: now - 1)]), meter: nil, now: now)
        XCTAssertEqual(codex.context, "19%")
        XCTAssertEqual(codex.contextHelp, "51k / 272k")
        XCTAssertEqual(codex.limits, [UsageLine.Limit(text: "7d 8%", near: false, help: nil)])
        XCTAssertEqual(RecordDisplay.usageLine(RecordUsage(used: 280_000), meter: nil, now: now).context, "280k")
        XCTAssertTrue(RecordDisplay.usageLine(nil, meter: TerminalMeter(context: nil), now: now).isEmpty)
    }

    func testItIsReadFromTheTerminalItsStreamAndTheRecord() throws {
        let info = try JSONDecoder().decode(TerminalInfo.self, from: Data(#"{"id":"t1","harness":"claude-code","status":"idle","meter":{"context":{"percent":5,"used":53323,"window":1000000},"limits":[{"label":"5h","percent":26,"resetsAt":1795693200000}],"at":3}}"#.utf8))
        XCTAssertEqual(info.meter, TerminalMeter(context: .init(percent: 5, used: 53_323, window: 1_000_000), limits: [UsageLimit(label: "5h", percent: 26, resetsAt: 1_795_693_200_000)]))
        // A Mac from before says nothing of it.
        XCTAssertNil(try JSONDecoder().decode(TerminalInfo.self, from: Data(#"{"id":"t1","status":"idle"}"#.utf8)).meter)
        XCTAssertEqual(TerminalEvent.parse(event: "meter", data: #"{"type":"meter","meter":{"context":null,"limits":[],"at":1}}"#), .meter(TerminalMeter(context: nil)))
        let usage = try JSONDecoder().decode(RecordUsage.self, from: Data(#"{"used":1,"limits":[{"label":"7d","percent":8,"resetsAt":null}]}"#.utf8))
        XCTAssertEqual(usage.limits, [UsageLimit(label: "7d", percent: 8)])
    }

    func testEveryAgentHasItsLogo() {
        for agent in ["claude-code", "codex", "opencode", "pi", "grok", "agy"] {
            let art = AgentLogoArt.art[agent]
            XCTAssertNotNil(art, agent)
            XCTAssertTrue(art!.rows.joined().allSatisfy { $0 == "." || art!.colours[String($0)] != nil }, agent)
        }
    }
}

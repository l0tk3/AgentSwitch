import XCTest
@testable import AgentSwitchKit

final class ModelNameTests: XCTestCase {
    func testModelIdsAreSaidAsPeopleSayThem() {
        XCTAssertEqual(ModelName.display("claude-opus-5-5"), "Opus 5.5")
        XCTAssertEqual(ModelName.display("claude-opus-5-5[1m]"), "Opus 5.5 1M")
        XCTAssertEqual(ModelName.display("claude-sonnet-4-6"), "Sonnet 4.6")
        XCTAssertEqual(ModelName.display("claude-haiku-4-5-20251001"), "Haiku 4.5")
        XCTAssertEqual(ModelName.display("deepseek/deepseek-flash"), "DeepSeek Flash")
        XCTAssertEqual(ModelName.display("gpt-6-luna"), "GPT-6 Luna")
        XCTAssertEqual(ModelName.display("gpt-5.5"), "GPT-5.5")
        XCTAssertEqual(ModelName.harness("claude-code"), "Claude Code")
        XCTAssertEqual(ModelName.harness("opencode"), "OpenCode")
    }
}

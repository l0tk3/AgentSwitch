import AgentSwitchMacCore
import XCTest

/// Settings › Add-Ons for all six agents (docs/profiles-v0.md "Add-Ons", user #567).
final class AddonsTests: XCTestCase {
    func testEveryAgentHasAShortNameAndItsOwnInstallCommand() {
        let ids = ["claude-code", "codex", "opencode", "pi", "grok", "agy"]
        XCTAssertEqual(ids.map(AddonWords.agent), ["Claude", "Codex", "OpenCode", "pi", "Grok", "agy"])
        XCTAssertEqual(AddonWords.example("opencode"), "opencode mcp add sentry -- npx -y @sentry/mcp-server")
        XCTAssertEqual(AddonWords.example("grok"), "grok mcp add sentry -- npx -y @sentry/mcp-server")
        XCTAssertEqual(AddonWords.example("agy"), "agy mcp add sentry -- npx -y @sentry/mcp-server")
    }

    func testTheNewKindsAreFilesWithTitles() {
        XCTAssertEqual(AddonWords.kind("extensions"), "Extensions")
        XCTAssertEqual(AddonWords.kind("workflows"), "Workflows")
        XCTAssertTrue(AddonWords.files.isSuperset(of: ["extensions", "workflows"]))
        XCTAssertFalse(AddonWords.files.contains("mcp"))
    }

    func testAPiListDecodes() throws {
        let json = #"{"agent":"pi","kinds":["skills","prompts","extensions"],"profiles":[{"id":"default","items":[{"kind":"extensions","name":"plan-mode.ts","shared":false}]}]}"#
        let got = try JSONDecoder().decode(ProfileAddons.self, from: Data(json.utf8))
        XCTAssertEqual(got.all(in: ["default"]).map(\.id), ["extensions/plan-mode.ts"])
    }
}

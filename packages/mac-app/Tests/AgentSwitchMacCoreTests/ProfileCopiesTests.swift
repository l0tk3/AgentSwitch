import XCTest
@testable import AgentSwitchMacCore

final class ProfileCopiesTests: XCTestCase {
    func testOptionsFromANodeThatKnowsNeitherPluginsNorTheStatusLine() throws {
        let old = try JSONDecoder().decode(ClaudeProfileCopyOptions.self, from: Data(#"{"skills":["a"],"mcpServers":[],"commands":[],"agents":[],"instructions":true,"preferences":false}"#.utf8))
        XCTAssertEqual(old, ClaudeProfileCopyOptions(skills: ["a"], instructions: true))
        let state = try JSONDecoder().decode(ClaudeProfileCopyState.self, from: Data(#"{"options":{"skills":["a","b"],"plugins":["hud@m"],"statusLine":true},"held":{"skills":["a"],"mcpServers":["mine"]}}"#.utf8))
        XCTAssertEqual(state.options.plugins, ["hud@m"])
        XCTAssertEqual(state.held.all.mcpServers, ["mine"])
        XCTAssertFalse(state.held.all.statusLine)
    }

    func testTheChangeBetweenWhatIsHeldAndWhatIsTicked() throws {
        var held = ClaudeProfileCopies()
        held.skills = ["a", "b"]; held.mcpServers = ["mine"]; held.instructions = true
        var wanted = held
        XCTAssertTrue(wanted.change(from: held).add.isEmpty && wanted.change(from: held).remove.isEmpty)
        wanted.skills = ["b", "c"]; wanted.plugins = ["hud@m"]; wanted.instructions = false; wanted.statusLine = true
        let change = wanted.change(from: held)
        XCTAssertEqual(change.add.skills, ["c"])
        XCTAssertEqual(change.add.plugins, ["hud@m"])
        XCTAssertTrue(change.add.statusLine)
        XCTAssertFalse(change.add.instructions)
        XCTAssertEqual(change.remove.skills, ["a"])
        XCTAssertTrue(change.remove.instructions)
        XCTAssertTrue(change.remove.mcpServers.isEmpty)
        let sent = try JSONSerialization.jsonObject(with: JSONEncoder().encode(change.add)) as? [String: Any]
        XCTAssertEqual(sent?["plugins"] as? [String], ["hud@m"])
        XCTAssertEqual(sent?["statusLine"] as? Bool, true)
    }

    func testAPluginKeyIsItsNameAndItsMarketplace() {
        XCTAssertEqual(PluginKey.parts("claude-hud@claude-hud").name, "claude-hud")
        XCTAssertEqual(PluginKey.parts("codex@openai-codex").market, "openai-codex")
        XCTAssertNil(PluginKey.parts("alone").market)
        XCTAssertEqual(PluginKey.parts("@scope/x@m").name, "@scope/x")
    }
}

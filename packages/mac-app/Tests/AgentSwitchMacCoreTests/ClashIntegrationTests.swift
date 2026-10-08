import XCTest
@testable import AgentSwitchMacCore

/// Clash Integration (docs/clash-v0.md §6): what the service says is read as it is, what is still to do in Clash Verge
/// is said in order, and the settings go back with nothing left out.
final class ClashIntegrationTests: XCTestCase {
    private func view(_ fields: String) throws -> ClashView {
        try JSONDecoder().decode(ClashView.self, from: Data("{\(fields),\"profiles\":[{\"uid\":\"Lbw7BJYzpand\",\"name\":\"mine.yaml\",\"type\":\"local\",\"file\":\"Lbw7BJYzpand.yaml\"}],\"currentProfile\":\"Lbw7BJYzpand\",\"install\":\"clash://install-config?url=x\"}".utf8))
    }

    private let none = "\"settings\":{\"source\":null,\"claude\":{\"nodes\":[],\"mode\":\"auto\"},\"openai\":{\"nodes\":[],\"mode\":\"auto\"},\"direct\":[]}"
    private let chosen = "\"settings\":{\"source\":\"Lbw7BJYzpand\",\"claude\":{\"nodes\":[\"A\",\"B\"],\"mode\":\"manual\",\"picked\":\"B\"},\"openai\":{\"nodes\":[],\"mode\":\"auto\"},\"direct\":[\"5.102.107.254\"]}"

    func testWhatIsStillToDoIsSaidInOrder() throws {
        XCTAssertEqual(try view("\"found\":false,\"running\":false,\"active\":false,\"upToDate\":false,\(none)").todo.count, 1)
        XCTAssertTrue(try view("\"found\":true,\"running\":false,\"active\":false,\"upToDate\":false,\(none)").todo[0].contains("没有在运行"))
        XCTAssertEqual(try view("\"found\":true,\"running\":true,\"tun\":false,\"active\":false,\"upToDate\":false,\(none)").todo.count, 2)
        let waiting = try view("\"found\":true,\"running\":true,\"tun\":true,\"nodes\":[\"A\",\"B\"],\"active\":false,\"upToDate\":false,\(chosen)")
        XCTAssertEqual(waiting.todo, ["在 Clash Verge 里添加并切换到 AgentSwitch 订阅。"])
        XCTAssertEqual(waiting.settings.claude, ClashServiceProxy(nodes: ["A", "B"], mode: "manual", picked: "B"))
        XCTAssertTrue(try view("\"found\":true,\"running\":true,\"tun\":true,\"active\":true,\"upToDate\":false,\(chosen)").todo[0].contains("更新一次"))
        XCTAssertEqual(try view("\"found\":true,\"running\":true,\"tun\":true,\"active\":true,\"upToDate\":true,\(chosen)").todo, [])
    }

    func testSettingsGoBackWhole() throws {
        let sent = try JSONSerialization.jsonObject(with: JSONEncoder().encode(ClashSettings())) as? [String: Any]
        XCTAssertTrue(sent?["source"] is NSNull)   // the service wants the key, null and all
        XCTAssertEqual((sent?["claude"] as? [String: Any])?["mode"] as? String, "auto")
        XCTAssertEqual(sent?["direct"] as? [String], [])
    }
}

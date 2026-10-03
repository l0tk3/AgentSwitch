@testable import AgentSwitchMacCore
import XCTest

final class DispatchJSONTextTests: XCTestCase {
    func testWritesJSONAsTheWebConsoleDoes() throws {
        let raw = #"{"why":"多步构建，\"要\"读输出","target":{"model":"opus","harness":"claude-code"},"plan":5,"confidence":0.86,"steps":[],"pin":null,"ok":true}"#
        let json = try JSONDecoder().decode(DispatchJSON.self, from: Data(raw.utf8))
        XCTAssertEqual(json.prettyText(), """
        {
          "confidence": 0.86,
          "ok": true,
          "pin": null,
          "plan": 5,
          "steps": [],
          "target": {
            "harness": "claude-code",
            "model": "opus"
          },
          "why": "多步构建，\\"要\\"读输出"
        }
        """)
    }

    func testDecisionTextKeepsWhatIsNotJSON() {
        let entry = try? JSONDecoder().decode(DispatchRoutingLogEntry.self, from: Data(#"{"id":1,"decision":"not json"}"#.utf8))
        XCTAssertEqual(entry?.decisionText, "not json")
    }
}

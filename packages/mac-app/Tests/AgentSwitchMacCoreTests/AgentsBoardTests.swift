import XCTest
@testable import AgentSwitchMacCore

/// 设置 › Agents as one thing that can be sent (docs/agents-v0.md §12).
final class AgentsBoardTests: XCTestCase {
    private func board() -> AgentsBoard {
        let stable = AgentInstall(agent: .codex, source: .stable, key: "stable", binary: "/Users/x/.local/bin/codex", command: "codex", location: "/Users/x/.local/bin/codex", version: "0.171.0", bytes: 900)
        let beta = AgentInstall(agent: .codex, source: .beta, key: "beta", binary: "/Users/x/.local/share/agentswitch/cli/codex-beta", command: "codex-beta", location: "/Users/x/.local/share/agentswitch/cli/codex/beta", version: "0.163.0-alpha.4")
        return AgentsBoard(home: "/Users/x", store: "/Users/x/.local/share/agentswitch/cli", storeExists: true,
                           agents: [AgentReport(agent: .codex, installs: [stable, beta], leftovers: AgentLeftovers(versions: ["0.170.0"], paths: ["/Users/x/old"], bytes: 5))],
                           releases: nil, checking: false, use: ["codex": "beta"], applied: ["codex": "/Users/x/.local/bin/codex"], running: true,
                           jobs: ["codex": AgentJob(agent: .codex, row: "beta", source: .beta, version: "0.173.0-alpha.4", phase: .downloading(received: 10, total: 100))],
                           pathNotes: ["note"], uninstallPaths: ["codex": ["/Users/x/.local/bin/codex"]])
    }

    func testABoardComesBackAsItWasSent() throws {
        let sent = board()
        let back = try JSONDecoder().decode(AgentsBoard.self, from: JSONEncoder().encode(sent))
        XCTAssertEqual(back, sent)
        XCTAssertEqual(back.job(.codex)?.phase, .downloading(received: 10, total: 100))
    }

    func testABoardSaysWhatIsInUseAndWhatWaitsForARestart() {
        let b = board()
        XCTAssertEqual(b.inUse(b.agents[0])?.key, "beta")
        // The service was started with the stable one; the beta was chosen since.
        XCTAssertEqual(b.pending, [.codex])
        var stopped = b
        stopped.running = false
        XCTAssertFalse(stopped.needsRestart)
        XCTAssertEqual(b.short("/Users/x/.local/bin"), "~/.local/bin")
        XCTAssertEqual(b.short("/opt/bin"), "/opt/bin")
    }

    func testAnActionIsWrittenAsTheServiceReadsIt() throws {
        let data = try JSONEncoder().encode(AgentsAction(.update, agent: .codex, key: "beta", version: "0.173.0-alpha.4"))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
        XCTAssertEqual(object, ["kind": "update", "agent": "codex", "key": "beta", "version": "0.173.0-alpha.4"])
        XCTAssertEqual(try JSONDecoder().decode(AgentsAction.self, from: Data(#"{"kind":"restart"}"#.utf8)), AgentsAction(.restart))
        // The names the service lets through (api/agentsBoard.ts) are these, to the letter.
        XCTAssertEqual(AgentCLI.allCases.map(\.rawValue), ["claude-code", "codex", "opencode", "pi"])
        XCTAssertEqual(AgentSource.allCases.map(\.rawValue).sorted(), ["app", "beta", "other", "pinned", "stable"])
    }
}

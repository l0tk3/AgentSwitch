import XCTest
@testable import AgentSwitchMacCore

/// A shell among the terminals on the Mac (docs/terminal-v0.md §0, 2026-11-10): offered only where the service says it
/// opens one, started by its own route, named and listed as what it is, and nowhere taken for an agent.
final class ShellTests: XCTestCase {
    func testTheListSaysWhetherTheServiceOpensShells() throws {
        let offered = try JSONDecoder().decode(TerminalList.self, from: Data(#"{"terminals":[{"id":"t1","harness":"shell","cwd":"/Users/u/code/site","name":"Shell","status":"idle","cols":120,"rows":36,"createdAt":1}],"agents":["claude-code"],"shell":true}"#.utf8))
        XCTAssertTrue(offered.shell)
        XCTAssertEqual(offered.terminals.map(\.harness), ["shell"])
        XCTAssertEqual(offered.agents, ["claude-code"], "a shell is not one of the agents")
        // A service that does not say so — an older one, or another node's, which opens none for us — offers none.
        for body in [#"{"terminals":[],"agents":["claude-code"]}"#, #"{"terminals":[],"agents":[],"shell":"yes"}"#] {
            XCTAssertFalse(try JSONDecoder().decode(TerminalList.self, from: Data(body.utf8)).shell, body)
        }
        XCTAssertFalse(TerminalList(terminals: [], agents: []).shell)
    }

    func testAShellIsStartedByItsOwnRouteWithAFolderAndASize() async throws {
        let transport = StubTransport { request in
            request.url?.path == "/terminals/shell" && request.httpMethod == "POST"
                ? (201, #"{"terminal":{"id":"t9","harness":"shell","cwd":"/Users/u/code/site","name":"Shell","status":"idle","cols":90,"rows":24,"createdAt":1}}"#)
                : (404, #"{"error":"not found"}"#)
        }
        let made = try await DaemonClient(port: 4811, transport: transport).createShell(cwd: "~/code/site", cols: 90, rows: 24)
        XCTAssertEqual(made.id, "t9")
        XCTAssertEqual(made.harness, TerminalKind.shell)
        let sent = try XCTUnwrap(transport.requests.first)
        let body = try XCTUnwrap(sent.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] })
        XCTAssertEqual(body["cwd"] as? String, "~/code/site")
        XCTAssertEqual(body["cols"] as? Int, 90)
        XCTAssertEqual(body["rows"] as? Int, 24)
        // Nothing an agent is started with: it has no model, no profile, no way of asking.
        XCTAssertEqual(Set(body.keys), ["cwd", "cols", "rows"])
    }

    func testAShellIsCalledAShellAndIsNoAgent() {
        XCTAssertEqual(TerminalListText.agentName("shell"), "Shell")
        XCTAssertEqual(HarnessName.display("shell"), "Shell")
        XCTAssertFalse(TerminalKind.isAgent("shell"))
        for agent in TerminalListText.agents.map(\.id) { XCTAssertTrue(TerminalKind.isAgent(agent), agent) }
        // The agents to choose between when a terminal is made are as they were; nothing of a shell is gone on with.
        XCTAssertFalse(TerminalListText.agents.contains { $0.id == "shell" })
        XCTAssertFalse(TerminalListText.resumable.contains("shell"))
        XCTAssertFalse(SubagentDisplay.hasRecords("shell"))
    }

    func testTheBarSaysOfAShellOnlyWhatItHas() {
        // The service gives every terminal a way of asking; a shell has none to show.
        let shell = TerminalInfo(id: "t1", harness: "shell", cwd: "/Users/u/code/site", model: "opus", mode: "manual", name: "Shell", status: "idle", cols: 120, rows: 36, createdAt: 1)
        XCTAssertNil(shell.context.mode)
        XCTAssertNil(shell.context.model)
        XCTAssertEqual(shell.context.agent, "shell")
        XCTAssertEqual(shell.context.agent(in: .classic), "Shell")
        XCTAssertEqual(shell.context.size, "On Mac · 120×36")
        let agent = TerminalInfo(id: "t2", harness: "claude-code", cwd: "/Users/u/code/site", model: "opus", mode: "auto", name: "site", status: "idle", cols: 120, rows: 36, createdAt: 1)
        XCTAssertEqual(agent.context.mode, "auto")
        XCTAssertEqual(agent.context.model, "opus")
    }

    func testTheListsFilterOffersShellsAfterTheAgents() {
        let terminals = [
            TerminalInfo(id: "t1", harness: "shell", cwd: "/Users/u/code/site", name: "Shell", status: "idle", createdAt: 1),
            TerminalInfo(id: "t2", harness: "codex", cwd: "/Users/u/code/site", name: "site", status: "idle", createdAt: 2),
            TerminalInfo(id: "t3", harness: "claude-code", cwd: "/Users/u/code/site", name: "site", status: "exited", createdAt: 3),
        ]
        XCTAssertEqual(TerminalListFilter.agents(terminals: terminals, sessions: []), ["claude-code", "codex", "shell"])
        let shells = TerminalListFilter(agent: "shell")
        XCTAssertEqual(terminals.filter(shells.keeps).map(\.id), ["t1"])
        // A running shell is active, as any running terminal is.
        XCTAssertEqual(terminals.filter(TerminalListFilter(active: true).keeps).map(\.id), ["t1", "t2"])
    }
}

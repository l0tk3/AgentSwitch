import XCTest
@testable import AgentSwitchMacCore

/// docs/control-v0.md §1 (approval modes) and §2 (default work dir): models and client routes.
final class WorkDirTests: XCTestCase {
    func testDefaultAsAPath() throws {
        let json = #"{"path":"/Users/me/AgentSwitch","default":"/Users/me/AgentSwitch","problem":null}"#
        let w = try JSONDecoder().decode(WorkDirSettings.self, from: Data(json.utf8))
        XCTAssertEqual(w.path, "/Users/me/AgentSwitch")
        XCTAssertTrue(w.isDefault)
        XCTAssertNil(w.problem)
        XCTAssertEqual(w.defaultToRestore(home: "/Users/me"), "/Users/me/AgentSwitch")
    }

    func testDefaultAsAFlagAndAProblem() throws {
        let json = #"{"path":"/Volumes/Work/tasks","default":false,"problem":"不能写入"}"#
        let w = try JSONDecoder().decode(WorkDirSettings.self, from: Data(json.utf8))
        XCTAssertFalse(w.isDefault)
        XCTAssertNil(w.defaultPath)
        XCTAssertEqual(w.problem, "不能写入")
        XCTAssertEqual(w.defaultToRestore(home: "/Users/me/"), "/Users/me/AgentSwitch")
    }

    func testABlankProblemIsNoProblemAndTrailingSlashesMatch() throws {
        let json = #"{"path":"/Users/me/AgentSwitch/","default":"/Users/me/AgentSwitch","problem":"  "}"#
        let w = try JSONDecoder().decode(WorkDirSettings.self, from: Data(json.utf8))
        XCTAssertNil(w.problem)
        XCTAssertTrue(w.isDefault)
    }
}

final class ControlRoutesTests: XCTestCase {
    func testWorkDirRoutes() async throws {
        let stub = StubTransport { req in
            switch (req.httpMethod ?? "", req.url?.path ?? "") {
            case ("GET", "/settings/workdir"): return (200, #"{"path":"/Users/me/AgentSwitch","default":"/Users/me/AgentSwitch","problem":null}"#)
            case ("PUT", "/settings/workdir"): return (200, #"{"path":"/Users/me/Work","default":"/Users/me/AgentSwitch","problem":null}"#)
            default: return (500, #"{"error":"unexpected"}"#)
            }
        }
        let client = DaemonClient(port: 4811, transport: stub)
        let dir = try await client.workDir()
        XCTAssertTrue(dir.isDefault)
        try await client.saveWorkDir(WorkDirUpdate(path: "/Users/me/Work"))
        let requests = stub.requests
        XCTAssertEqual(requests.map { "\($0.httpMethod!) \($0.url!.path)" },
                       ["GET /settings/workdir", "PUT /settings/workdir"])
        XCTAssertEqual(requests[1].httpBody.map { String(decoding: $0, as: UTF8.self) }, #"{"path":"\/Users\/me\/Work"}"#)
    }

    func testARefusalIsShownInTheDaemonsWords() async {
        let stub = StubTransport { _ in (400, #"{"error":"不能用主目录作为工作目录"}"#) }
        let client = DaemonClient(port: 1, transport: stub)
        do { try await client.saveWorkDir(WorkDirUpdate(path: "/Users/me")); XCTFail() } catch {
            XCTAssertEqual((error as? DaemonError)?.reason, "不能用主目录作为工作目录")
        }
        XCTAssertEqual(DaemonError.unreachable("x").reason, "无法连接服务：x")
        XCTAssertEqual(DaemonError.http(status: 500, message: "boom").reason, "服务返回 500：boom")
    }

    func testAnOlderDaemonWithoutTheRouteIsNotSupported() async {
        let client = DaemonClient(port: 1, transport: StubTransport { _ in (404, "404 Not Found") })
        do { _ = try await client.workDir(); XCTFail() } catch {
            XCTAssertEqual(error as? DaemonError, .notSupported("GET /settings/workdir"))
        }
    }
}

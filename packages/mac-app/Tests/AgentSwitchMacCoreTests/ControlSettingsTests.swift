import XCTest
@testable import AgentSwitchMacCore

/// docs/control-v0.md §1 (approval modes) and §2 (default work dir): models and client routes.
final class ApprovalPolicyTests: XCTestCase {
    private let getJSON = """
    {"policy":{"mode":"scoped","human":["delete","git_push","irreversible"]},
     "categories":[{"id":"delete","title":"删除文件或数据"},{"id":"outside_cwd","title":"写入工作目录以外的文件"},
                   {"id":"git_push","title":"git push / 强制推送"},{"id":"irreversible","title":"支付、发送消息"}]}
    """

    func testGetShapeDecodes() throws {
        let p = try JSONDecoder().decode(ApprovalPolicySettings.self, from: Data(getJSON.utf8))
        XCTAssertEqual(p.mode, .scoped)
        XCTAssertEqual(p.human, ["delete", "git_push", "irreversible"])
        XCTAssertEqual(p.categories.map(\.id), ["delete", "outside_cwd", "git_push", "irreversible"])
        XCTAssertEqual(p.categories[2].title, "git push / 强制推送")
    }

    func testPutAnswerKeepsTheKnownCategories() throws {
        let before = try JSONDecoder().decode(ApprovalPolicySettings.self, from: Data(getJSON.utf8))
        let saved = try JSONDecoder().decode(ApprovalPolicySettings.self, from: Data(#"{"policy":{"mode":"skip","human":["delete"]}}"#.utf8))
        XCTAssertEqual(saved.mode, .skip)
        XCTAssertEqual(saved.categories, [])
        let merged = saved.keepingCategories(of: before)
        XCTAssertEqual(merged.mode, .skip)
        XCTAssertEqual(merged.human, ["delete"])
        XCTAssertEqual(merged.categories, before.categories)
    }

    func testAnUnknownModeIsKeptRaw() throws {
        let p = try JSONDecoder().decode(ApprovalPolicySettings.self, from: Data(#"{"mode":"yolo"}"#.utf8))
        XCTAssertNil(p.mode)
        XCTAssertEqual(p.rawMode, "yolo")
        XCTAssertEqual(p.human, [])
        XCTAssertThrowsError(try JSONDecoder().decode(ApprovalPolicySettings.self, from: Data(#"{"policy":{}}"#.utf8)))
    }

    func testTogglingACategoryKeepsTheDaemonsOrderAndReturnsANewList() throws {
        let p = try JSONDecoder().decode(ApprovalPolicySettings.self, from: Data(getJSON.utf8))
        XCTAssertEqual(p.human(setting: "outside_cwd", on: true), ["delete", "outside_cwd", "git_push", "irreversible"])
        XCTAssertEqual(p.human(setting: "delete", on: false), ["git_push", "irreversible"])
        XCTAssertEqual(p.human(setting: "delete", on: true), ["delete", "git_push", "irreversible"], "no duplicates")
        XCTAssertEqual(p.human, ["delete", "git_push", "irreversible"], "the settings value itself is unchanged")
    }

    func testTheUpdateAlwaysCarriesTheHumanList() throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        let body = String(decoding: try encoder.encode(ApprovalPolicyUpdate(mode: .skip, human: ["delete"])), as: UTF8.self)
        XCTAssertEqual(body, #"{"human":["delete"],"mode":"skip"}"#)
    }

    func testModeWordsFollowTheContract() {
        XCTAssertEqual(ApprovalMode.allCases.map(\.title), ["ask each", "auto", "all auto", "bypass"])
        XCTAssertEqual(ApprovalMode.recommended, .scoped)
        let warning = ApprovalMode.skipWarning
        for phrase in ["禁区不可访问", "本机令牌", "浏览器会话", "只读步骤", "由你回答", "Codex 在沙箱中运行"] {
            XCTAssertTrue(warning.contains(phrase), phrase)
        }
    }
}

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
    func testPolicyAndWorkDirRoutes() async throws {
        let stub = StubTransport { req in
            switch (req.httpMethod ?? "", req.url?.path ?? "") {
            case ("GET", "/approvals/policy"): return (200, #"{"policy":{"mode":"manual","human":[]},"categories":[{"id":"delete","title":"删除"}]}"#)
            case ("PUT", "/approvals/policy"): return (200, #"{"policy":{"mode":"auto","human":["delete"]}}"#)
            case ("GET", "/settings/workdir"): return (200, #"{"path":"/Users/me/AgentSwitch","default":"/Users/me/AgentSwitch","problem":null}"#)
            case ("PUT", "/settings/workdir"): return (200, #"{"path":"/Users/me/Work","default":"/Users/me/AgentSwitch","problem":null}"#)
            default: return (500, #"{"error":"unexpected"}"#)
            }
        }
        let client = DaemonClient(port: 4811, transport: stub)
        let policy = try await client.approvalPolicy()
        XCTAssertEqual(policy.mode, .manual)
        let saved = try await client.saveApprovalPolicy(ApprovalPolicyUpdate(mode: .auto, human: ["delete"]))
        XCTAssertEqual(saved.mode, .auto)
        let dir = try await client.workDir()
        XCTAssertTrue(dir.isDefault)
        try await client.saveWorkDir(WorkDirUpdate(path: "/Users/me/Work"))
        let requests = stub.requests
        XCTAssertEqual(requests.map { "\($0.httpMethod!) \($0.url!.path)" },
                       ["GET /approvals/policy", "PUT /approvals/policy", "GET /settings/workdir", "PUT /settings/workdir"])
        let policyBody = try JSONSerialization.jsonObject(with: requests[1].httpBody!) as? [String: Any]
        XCTAssertEqual(policyBody?["mode"] as? String, "auto")
        XCTAssertEqual(policyBody?["human"] as? [String], ["delete"])
        XCTAssertEqual(requests[3].httpBody.map { String(decoding: $0, as: UTF8.self) }, #"{"path":"\/Users\/me\/Work"}"#)
    }

    func testARefusalIsShownInTheDaemonsWords() async {
        let stub = StubTransport { req in
            req.url?.path == "/settings/workdir" ? (400, #"{"error":"不能用主目录作为工作目录"}"#) : (403, #"{"error":"只能在这台 Mac 上改"}"#)
        }
        let client = DaemonClient(port: 1, transport: stub)
        do { try await client.saveWorkDir(WorkDirUpdate(path: "/Users/me")); XCTFail() } catch {
            XCTAssertEqual((error as? DaemonError)?.reason, "不能用主目录作为工作目录")
        }
        do { _ = try await client.saveApprovalPolicy(ApprovalPolicyUpdate(mode: .skip, human: [])); XCTFail() } catch {
            XCTAssertEqual((error as? DaemonError)?.reason, "只能在这台 Mac 上改")
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

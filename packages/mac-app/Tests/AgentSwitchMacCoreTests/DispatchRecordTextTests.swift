import XCTest
@testable import AgentSwitchMacCore

/// The Dispatch page's shared words (docs/dispatch-v0.md §2): an approval box's head and body, `N attached` under what
/// you said, and a task page's request; and `New Ciphertext`'s request to the gate.
final class DispatchRecordTextTests: XCTestCase {
    private typealias F = DispatchFixture

    func testAnApprovalBoxNamesTheToolAndShowsWhatItRuns() throws {
        let evidence = #"{"command":"xcrun devicectl device install app AgentSwitch.app","description":"安装到手机"}"#
        let text = DispatchApprovalText(try F.approval("a", task: "t", action: "Bash: xcrun devicectl device install app AgentSwitch.app",
                                                       evidence: evidence))
        XCTAssertEqual(text.tool, "Run Command")
        XCTAssertEqual(text.target, "xcrun devicectl device install app AgentSwitch.app")
        XCTAssertEqual(text.about, "安装到手机")
    }

    func testCodexRequestMethodsAndBareActionsAreSaidPlainly() throws {
        XCTAssertEqual(DispatchApprovalText.split("item/commandExecution/requestApproval: npm test").tool, "Bash")
        XCTAssertEqual(DispatchApprovalText.split("applyPatchApproval: src/a.ts").tool, "Edit")
        let bare = DispatchApprovalText(try F.approval("a", task: "t", action: "git push --force", evidence: "not json"))
        XCTAssertEqual(bare.tool, "git push --force")
        XCTAssertEqual(bare.target, "git push --force", "no target: the whole action is the body")
        XCTAssertNil(bare.about)
        XCTAssertEqual(DispatchApprovalText.word("mcp__github__create_pr"), "mcp__github__create_pr")
        XCTAssertEqual(DispatchApprovalText.word("WebFetch"), "Fetch Page")
    }

    func testAttachmentsUnderAMessageAreThoseOfTheTasksItsAnswersCreated() throws {
        let said = try F.message(1, "user", "把 iOS 端打包装到手机上")
        let answer = try F.message(2, "assistant", kind: "task", tasks: ["t1"], replyTo: 1)
        let other = try F.message(3, "assistant", kind: "status", tasks: ["t2"], replyTo: 1)
        let file: [String: Any] = ["name": "a.png", "path": "in/a.png", "size": 1, "type": "image/png"]
        let t1 = try F.task("t1", extra: ["attachments": [file, file]])
        let t2 = try F.task("t2", extra: ["attachments": [file]])
        let messages = [said, answer, other]
        XCTAssertEqual(DispatchRecordLookup.attachments(of: said, messages: messages, tasks: [t1, t2]), 2,
                       "a status answer only talks about t2")
        XCTAssertEqual(DispatchRecordLookup.attachments(of: answer, messages: messages, tasks: [t1, t2]), 0)
    }

    func testATaskPageStartsWithWhatYouSaid() throws {
        let said = try F.message(1, "user", "把 iOS 端打包装到手机上")
        let answer = try F.message(2, "assistant", kind: "task", tasks: ["t1"], replyTo: 1)
        let t1 = try F.task("t1", text: "构建 AgentSwitch.app，装到手机上")
        let elsewhere = try F.task("t9", text: "整理 enc:v1:AAAAAAAAAAAAAAAAAAAA 的报表")
        XCTAssertEqual(DispatchRecordLookup.request(of: t1, messages: [said, answer]), "把 iOS 端打包装到手机上")
        XCTAssertEqual(DispatchRecordLookup.request(of: elsewhere, messages: [said, answer]), "整理 🔒密文 的报表")
    }

    func testASealRequestNeedsANameSitesAndAValue() {
        XCTAssertEqual(GateSealRequest(label: " ", sites: "a.com", value: "x").problem, "缺少名称")
        XCTAssertNotNil(GateSealRequest(label: "-bad", sites: "a.com", value: "x").problem)
        XCTAssertEqual(GateSealRequest(label: "corp/pass", sites: " , ", value: "x").problem, "须填写可使用此密文的站点")
        XCTAssertEqual(GateSealRequest(label: "corp/pass", sites: "a.com", value: "").problem, "缺少值")
        XCTAssertNil(GateSealRequest(label: "corp/pass", sites: "a.com", value: "x").problem)
    }

    func testSitesBecomeHostsOnceEach() {
        let request = GateSealRequest(label: "fin/pass", sites: "https://me@Fin.example.com:8443/login?x，*.example.com fin.example.com:8443",
                                      value: "s3cret")
        XCTAssertEqual(request.hostList, ["fin.example.com:8443", "*.example.com"])
    }

    func testTheBatchCarriesTheValueOnStdinAndTheTokenComesBack() throws {
        let request = GateSealRequest(label: "fin/pass", sites: "fin.example.com", value: "s3cret")
        let entry = try XCTUnwrap((try JSONSerialization.jsonObject(with: request.batchInput()) as? [[String: Any]])?.first)
        XCTAssertEqual(entry["label"] as? String, "fin/pass")
        XCTAssertEqual(entry["hosts"] as? [String], ["fin.example.com"])
        XCTAssertEqual(entry["uses"] as? [String], ["http", "fill"])
        XCTAssertEqual(entry["value"] as? String, "s3cret")
        XCTAssertEqual(try GateSealRequest.token(from: Data(#"[{"label":"fin/pass","token":"enc:v1:abc"}]"#.utf8)), "enc:v1:abc")
        XCTAssertThrowsError(try GateSealRequest.token(from: Data(#"[{"label":"fin/pass","error":"invalid host"}]"#.utf8))) { error in
            XCTAssertEqual(error.localizedDescription, "无法生成密文：invalid host")
        }
        XCTAssertThrowsError(try GateSealRequest.token(from: Data("nope".utf8)))
    }
}

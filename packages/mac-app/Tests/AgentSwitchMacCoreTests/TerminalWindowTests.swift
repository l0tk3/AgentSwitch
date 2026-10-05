import XCTest
@testable import AgentSwitchMacCore

/// A terminal in a window of its own (docs/dispatch-v0.md §1 单独的窗口; docs/terminal-v0.md §1, 2026-10-05): what the
/// window reads of its terminal, the requests it answers, and the words it says.
final class TerminalWindowTests: XCTestCase {
    private static let question = #"{"question":"跳转目标不是同源地址时怎么办？","header":"Redirect","multiSelect":false,"options":[{"label":"回首页","description":"丢掉 next"},{"label":"报错","description":""}]}"#
    private static let several = #"{"question":"哪些页面要改？","header":"Pages","multiSelect":true,"options":[{"label":"登录"},{"label":"注册"}]}"#
    private static let words = #"{"question":"分支叫什么？","header":"","multiSelect":false,"options":[]}"#

    private func questions(_ json: String...) throws -> [TerminalRequest.Question] {
        try JSONDecoder().decode([TerminalRequest.Question].self, from: Data("[\(json.joined(separator: ","))]".utf8))
    }

    // MARK: what the service says

    func testATerminalAsTheServiceListsIt() async throws {
        let json = #"{"terminal":{"id":"t1","harness":"claude-code","cwd":"/Users/me/p","workdir":"/Users/me/p/web","model":"claude-opus-5-5","mode":"auto","name":"修登录页","status":"waiting","cols":92,"rows":27,"exitCode":null,"permissions":[{"id":"r1","tool":"Edit","summary":"Edit: /Users/me/p/web/login.js","input":{},"at":1}],"seq":7}}"#
        let client = DaemonClient(port: 1, transport: StubTransport { _ in (200, json) })
        let info = try await client.terminal(id: "t1")
        XCTAssertEqual(info.workdir, "/Users/me/p/web")
        XCTAssertEqual(info.model, "claude-opus-5-5")
        XCTAssertEqual(info.mode, "auto")
        XCTAssertEqual(info.permissions.map(\.id), ["r1"])
        XCTAssertFalse(info.permissions[0].isQuestion)
        XCTAssertTrue(info.running)
        XCTAssertEqual(info.context.agent, "claude · Opus 5.5")
        XCTAssertEqual(info.context.cols, 92)
    }

    func testATerminalThatSaysLessStillReads() throws {
        let info = try JSONDecoder().decode(TerminalInfo.self, from: Data(#"{"id":"t2","harness":"codex","cwd":"/tmp/x","name":"x","status":"exited","exitCode":1}"#.utf8))
        XCTAssertEqual(info.workdir, "/tmp/x", "no word of where it works: where it started")
        XCTAssertNil(info.model)
        XCTAssertEqual(info.permissions, [])
        XCTAssertFalse(info.running)
    }

    func testTheWindowsEventsOfTheStream() throws {
        XCTAssertEqual(TerminalWindowEvent.decode(event: "status", data: #"{"type":"status","status":"working"}"#), .status("working"))
        XCTAssertEqual(TerminalWindowEvent.decode(event: "name", data: #"{"type":"name","name":"新名字"}"#), .name("新名字"))
        XCTAssertEqual(TerminalWindowEvent.decode(event: "exit", data: #"{"type":"exit","code":2}"#), .exit(code: 2))
        XCTAssertEqual(TerminalWindowEvent.decode(event: "removed", data: #"{"type":"removed"}"#), .removed)
        XCTAssertEqual(TerminalWindowEvent.decode(event: "permission_resolved", data: #"{"type":"permission_resolved","id":"r1","decision":"allow"}"#), .resolved("r1"))
        let asked = TerminalWindowEvent.decode(event: "permission", data: #"{"type":"permission","request":{"id":"r2","tool":"AskUserQuestion","summary":"?","questions":[\#(Self.question)]}}"#)
        guard case .permission(let request)? = asked else { return XCTFail("a request") }
        XCTAssertTrue(request.isQuestion)
        XCTAssertEqual(request.questions[0].options.map(\.label), ["回首页", "报错"])
        XCTAssertEqual(request.questions[0].options[1].description, "")
        let all = TerminalWindowEvent.decode(event: "permissions", data: #"{"type":"permissions","requests":[{"id":"r3","tool":"Bash","summary":"Bash: ls"}]}"#)
        XCTAssertEqual(all, .permissions([TerminalRequest(id: "r3", tool: "Bash", summary: "Bash: ls")]))
        XCTAssertNil(TerminalWindowEvent.decode(event: "output", data: #"{"seq":1,"data":"x"}"#), "the screen's")
        XCTAssertNil(TerminalWindowEvent.decode(event: "permission", data: "not json"))
    }

    func testTheRequestsWaitingFollowTheStream() {
        let a = TerminalRequest(id: "a", tool: "Bash", summary: "Bash: ls"), b = TerminalRequest(id: "b", tool: "Edit", summary: "Edit: f")
        var waiting = TerminalRequests.applying(.permission(a), to: [])
        waiting = TerminalRequests.applying(.permission(b), to: waiting)
        XCTAssertEqual(waiting.map(\.id), ["a", "b"])
        XCTAssertEqual(TerminalRequests.applying(.permission(a), to: waiting).map(\.id), ["a", "b"], "said twice, held once")
        XCTAssertEqual(TerminalRequests.applying(.resolved("a"), to: waiting).map(\.id), ["b"])
        XCTAssertEqual(TerminalRequests.applying(.permissions([b]), to: waiting).map(\.id), ["b"], "on connecting: the whole list, one answered elsewhere goes")
        XCTAssertEqual(TerminalRequests.applying(.status("idle"), to: waiting).map(\.id), ["a", "b"])
        XCTAssertEqual(TerminalRequests.applying(.exit(code: 0), to: waiting), [], "an ended terminal asks nothing")
    }

    // MARK: the card's words

    func testARequestInPlainWords() {
        let edit = TerminalRequestText(TerminalRequest(id: "r", tool: "Edit", summary: "Edit: /Users/me/p/web/login.js"), cwd: "/Users/me/p", home: "/Users/me")
        XCTAssertEqual(edit.tool, "Edit File")
        XCTAssertEqual(edit.detail, "web/login.js", "under the terminal's folder: from there")
        XCTAssertEqual(edit.folder, "~/p")
        let run = TerminalRequestText(TerminalRequest(id: "r", tool: "Bash", summary: "Bash: rm -rf build"), cwd: "/Users/me/p", home: "/Users/me")
        XCTAssertEqual(run.tool, "Run Command")
        XCTAssertEqual(run.detail, "rm -rf build")
        let elsewhere = TerminalRequestText(TerminalRequest(id: "r", tool: "Write", summary: "Write: /Users/me/notes.md"), cwd: "/Users/me/p", home: "/Users/me")
        XCTAssertEqual(elsewhere.detail, "~/notes.md")
        let other = TerminalRequestText(TerminalRequest(id: "r", tool: "mcp__x__y", summary: "does a thing"), cwd: nil, home: "/Users/me")
        XCTAssertEqual(other.tool, "mcp__x__y", "a tool without a word of ours keeps its own")
        XCTAssertEqual(other.detail, "does a thing")
        XCTAssertNil(other.folder)
    }

    func testTheWindowsShortWords() {
        XCTAssertEqual(TerminalWindowText.folder("/Users/me/Projects/AgentSwitch"), "AgentSwitch")
        XCTAssertEqual(TerminalWindowText.folder("/"), "/")
        XCTAssertEqual(TerminalWindowText.git(FolderGit(branch: "main", changed: 31, ahead: 2, behind: 0)), "main ±31 ↑2")
        XCTAssertEqual(TerminalWindowText.git(FolderGit(branch: "dev", changed: 0, ahead: 0, behind: 3)), "dev ↓3")
        XCTAssertEqual(TerminalWindowText.sealed(1), "1 secret sealed")
        XCTAssertEqual(TerminalWindowText.sealed(3), "3 secrets sealed")
        XCTAssertEqual(TerminalWindowText.away("iphone").head, "On iPhone")
        XCTAssertEqual(TerminalWindowText.away("iphone").line, "这个终端正在 iPhone 上使用。")
        XCTAssertEqual(TerminalWindowText.away("somewhere").head, "On Web")
        XCTAssertEqual(TerminalWindowText.title(folder: "AgentSwitch", name: "修登录页"), "AgentSwitch — 修登录页")
        XCTAssertEqual(TerminalWindowText.title(folder: "AgentSwitch", name: "AgentSwitch"), "AgentSwitch", "named after its folder: said once")
    }

    // MARK: answering a question

    func testOneOfSeveralIsOnePickAndOtherTakesItsPlace() throws {
        var form = TerminalAnswers(try questions(Self.question))
        XCTAssertFalse(form.complete)
        form = form.picking(0, "回首页")
        XCTAssertTrue(form.isOn(0, "回首页"))
        form = form.picking(0, "报错")
        XCTAssertEqual(form.picks[0].labels, ["报错"], "one of several: the last one picked")
        form = form.writing(0, "  自己写的  ")
        XCTAssertEqual(form.picks[0].labels, [], "writing in Other takes the pick's place")
        XCTAssertTrue(form.otherOn(0))
        XCTAssertEqual(form.body["跳转目标不是同源地址时怎么办？"], TerminalAnswers.Answer(labels: [], other: "自己写的"))
        form = form.picking(0, "回首页")
        XCTAssertEqual(form.picks[0].other, "", "picking an option clears what was written")
        XCTAssertEqual(form.body["跳转目标不是同源地址时怎么办？"], TerminalAnswers.Answer(labels: ["回首页"], other: nil))
    }

    func testSeveralArePickedAndUnpickedBesideOther() throws {
        var form = TerminalAnswers(try questions(Self.several))
        form = form.picking(0, "登录").picking(0, "注册").picking(0, "登录")
        XCTAssertEqual(form.picks[0].labels, ["注册"])
        form = form.writing(0, "还有首页")
        XCTAssertEqual(form.picks[0].labels, ["注册"], "several: Other goes beside the picks")
        XCTAssertEqual(form.body["哪些页面要改？"], TerminalAnswers.Answer(labels: ["注册"], other: "还有首页"))
    }

    func testEveryQuestionNeedsAnAnswerBeforeItGoes() throws {
        var form = TerminalAnswers(try questions(Self.question, Self.words))
        XCTAssertEqual(form.firstUnanswered, 0)
        form = form.picking(0, "报错")
        XCTAssertFalse(form.complete)
        XCTAssertEqual(form.firstUnanswered, 1)
        form = form.writing(1, "   ")
        XCTAssertFalse(form.complete, "spaces are no answer")
        form = form.writing(1, "fix/login")
        XCTAssertTrue(form.complete)
        XCTAssertEqual(form.picking(9, "x"), form, "no such question: nothing changes")
    }

    func testANumberKeyPicksOrGoesToOther() throws {
        let form = TerminalAnswers(try questions(Self.question))
        XCTAssertEqual(form.key(2, in: 0), .pick("报错"))
        XCTAssertEqual(form.key(3, in: 0), .other, "the number after the last option is Other")
        XCTAssertNil(form.key(4, in: 0))
        XCTAssertNil(form.key(1, in: 5))
    }

    // MARK: the routes

    func testAReplyGoesThroughTheSealerAndSaysHowManyWereSealed() async throws {
        let stub = StubTransport { _ in (200, #"{"ok":true,"sealed":2,"attached":0}"#) }
        let client = DaemonClient(port: 1, transport: stub)
        let sealed = try await client.replyToTerminal(id: "t 1", text: "密码是 hunter2")
        XCTAssertEqual(sealed, 2)
        let request = stub.requests[0]
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path(percentEncoded: true), "/terminals/t%201/input")
        let body = try XCTUnwrap(try JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any])
        XCTAssertEqual(body["text"] as? String, "密码是 hunter2")
        XCTAssertNil(body["seal"], "sealed unless told otherwise: the service's default")
    }

    func testAllowDenyAndAnAnswerGoToTheRequest() async throws {
        let stub = StubTransport { _ in (200, #"{"ok":true,"sealed":1}"#) }
        let client = DaemonClient(port: 1, transport: stub)
        try await client.decideTerminal(id: "t1", request: "r1", allow: false)
        var form = TerminalAnswers(try questions(Self.question))
        form = form.writing(0, "看情况")
        let sealed = try await client.answerTerminal(id: "t1", request: "r2", answers: form.body)
        XCTAssertEqual(sealed, 1)
        XCTAssertEqual(stub.requests.map { $0.url?.path }, ["/terminals/t1/permissions/r1", "/terminals/t1/permissions/r2"])
        let deny = try XCTUnwrap(try JSONSerialization.jsonObject(with: stub.requests[0].httpBody ?? Data()) as? [String: Any])
        XCTAssertEqual(deny["decision"] as? String, "deny")
        XCTAssertNil(deny["answers"])
        let answer = try XCTUnwrap(try JSONSerialization.jsonObject(with: stub.requests[1].httpBody ?? Data()) as? [String: Any])
        XCTAssertEqual(answer["decision"] as? String, "allow")
        let said = try XCTUnwrap((answer["answers"] as? [String: [String: Any]])?["跳转目标不是同源地址时怎么办？"])
        XCTAssertEqual(said["other"] as? String, "看情况")
        XCTAssertEqual(said["labels"] as? [String], [])
    }

    func testARequestAnsweredElsewhereAndATerminalGoneAreNoErrors() async {
        let stub = StubTransport { _ in (404, #"{"error":"no such request (answered already?)"}"#) }
        let client = DaemonClient(port: 1, transport: stub)
        do {
            try await client.decideTerminal(id: "t1", request: "r1", allow: true)
            XCTFail("a 404 is thrown")
        } catch {
            XCTAssertTrue((error as? DaemonError)?.isGone == true)
        }
        XCTAssertFalse(DaemonError.http(status: 503, message: "sealer unavailable").isGone)
        XCTAssertFalse(DaemonError.unreachable("x").isGone)
    }

    func testFoldersGit() async throws {
        let stub = StubTransport { _ in (200, #"{"folders":{"/Users/me/p":{"branch":"main","changed":2,"ahead":0,"behind":1}}}"#) }
        let git = try await DaemonClient(port: 1, transport: stub).folderGit()
        XCTAssertEqual(git["/Users/me/p"], FolderGit(branch: "main", changed: 2, ahead: 0, behind: 1))
    }

    // MARK: the keys

    private func key(_ key: String, code: UInt16 = 0, command: Bool = false, shift: Bool = false, option: Bool = false,
                     editing: Bool = false, marking: Bool = false, inSeal: Bool = false, card: Bool = false) -> ItemWindowKey? {
        ItemWindowKey.action(for: .init(key: key, keyCode: code, command: command, option: option, shift: shift),
                             editing: editing || inSeal, marking: marking, inSeal: inSeal, cardHasKeys: card)
    }

    func testTheWindowsKeysFromTheScreen() {
        XCTAssertEqual(key("w", command: true), .close)
        XCTAssertEqual(key("t", command: true), .newTerminal)
        XCTAssertEqual(key("v", command: true, shift: true), .seal)
        XCTAssertEqual(key("\r", code: 36, command: true), .primary)
        XCTAssertEqual(key("", code: 51, command: true), .deny)
        XCTAssertNil(key("c", command: true), "the screen copies its own selection")
        XCTAssertNil(key("b", command: true), "the main window's list: nothing here")
        XCTAssertNil(key("\r", code: 36), "Return is typed into the terminal")
        XCTAssertNil(key("", code: 53), "and so is Esc")
        XCTAssertNil(key("1"))
        XCTAssertNil(key("w", command: true, option: true))
    }

    func testTheSealedReplysFieldSendsOnReturnAndClosesOnEsc() {
        XCTAssertEqual(key("\r", code: 36, inSeal: true), .send)
        XCTAssertEqual(key("\r", code: 36, shift: true, inSeal: true), .newLine)
        XCTAssertEqual(key("\r", code: 36, command: true, inSeal: true), .send)
        XCTAssertEqual(key("", code: 53, inSeal: true), .closeSeal)
        XCTAssertNil(key("\r", code: 36, marking: true, inSeal: true), "an input method's Return takes its candidate")
        XCTAssertNil(key("", code: 53, marking: true, inSeal: true))
        XCTAssertNil(key("", code: 51, command: true, inSeal: true), "⌘⌫ deletes to the line's start")
        XCTAssertEqual(key("v", command: true, inSeal: true), .edit("paste:"))
        XCTAssertEqual(key("a", command: true, inSeal: true), .edit("selectAll:"))
        XCTAssertEqual(key("z", command: true, shift: true, inSeal: true), .edit("redo:"))
        XCTAssertEqual(key("w", command: true, inSeal: true), .close)
    }

    func testTheQuestionCardTakesNumbersTabAndReturn() {
        XCTAssertEqual(key("2", card: true), .number(2))
        XCTAssertEqual(key("\t", code: 48, card: true), .question(1))
        XCTAssertEqual(key("\t", code: 48, shift: true, card: true), .question(-1))
        XCTAssertEqual(key("\r", code: 36, card: true), .primary)
        XCTAssertEqual(key("", code: 53, card: true), .giveKeysBack)
        XCTAssertEqual(key("x", card: true), .swallow, "not typed into the terminal behind the card")
        XCTAssertEqual(key("0", card: true), .swallow)
        // Writing in Other: the keys are the field's, Return submits, Esc goes back to the card.
        XCTAssertNil(key("2", editing: true, card: true))
        XCTAssertEqual(key("\r", code: 36, editing: true, card: true), .primary)
        XCTAssertEqual(key("", code: 53, editing: true, card: true), .leaveField)
        XCTAssertEqual(key("", code: 53, editing: true), .giveKeysBack, "a field clicked into without the card's keys")
    }

    // MARK: the windows

    func testANewWindowStandsALittleDownAndRightOfTheLast() {
        let screen = CGRect(x: 0, y: 0, width: 1600, height: 1000)
        let first = TerminalWindowPlace.next(after: nil, size: CGSize(width: 900, height: 600), screen: screen, beside: CGRect(x: 100, y: 200, width: 1200, height: 700))
        XCTAssertEqual(first.origin, CGPoint(x: 100 + TerminalWindowPlace.step, y: 200 + 700 - 600 - TerminalWindowPlace.step), "from the main window's top left corner")
        let second = TerminalWindowPlace.next(after: first, size: first.size, screen: screen, beside: nil)
        XCTAssertEqual(second.origin, CGPoint(x: first.minX + TerminalWindowPlace.step, y: first.minY - TerminalWindowPlace.step))
        let low = TerminalWindowPlace.next(after: CGRect(x: 1500, y: 10, width: 900, height: 600), size: CGSize(width: 900, height: 600), screen: screen, beside: nil)
        XCTAssertTrue(screen.contains(low), "run off the screen: back to its top left")
        let alone = TerminalWindowPlace.next(after: nil, size: CGSize(width: 900, height: 600), screen: screen, beside: nil)
        XCTAssertEqual(alone.midX, screen.midX)
    }
}

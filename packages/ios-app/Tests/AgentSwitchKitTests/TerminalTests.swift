import XCTest
@testable import AgentSwitchKit

/// The terminals tab's client side (docs/terminal-v0.md §4): the list, the stream, and what the phone may send.
final class TerminalTests: XCTestCase {
    private let lan = APIEndpoint(host: "192.168.1.5", port: 4713, kind: .lan)

    private func json(_ object: Any) -> Data { try! JSONSerialization.data(withJSONObject: object) }

    func testListDecodesLeniently() throws {
        let list = try JSONDecoder().decode(TerminalList.self, from: json([
            "terminals": [["id": "a1b2c3d4", "harness": "claude-code", "cwd": "/Users/u/p", "name": "发布前检查", "status": "waiting",
                           "createdAt": 1, "lastOutputAt": 2, "permissions": [["id": "p1", "tool": "Bash", "summary": "Bash: rm -rf build", "at": 3]]],
                          ["id": "e5f6", "status": "something-new"]],
            "agents": ["claude-code", "codex"],
            "models": ["claude-code": [["id": "claude-opus-5-5", "name": "Opus 5.5"]]],
        ]))
        XCTAssertEqual(list.terminals.count, 2)
        XCTAssertEqual(list.terminals[0].status, .waiting)
        XCTAssertEqual(list.terminals[0].status.label, "Waiting")
        XCTAssertEqual(list.terminals[0].permissions.first?.detail, "rm -rf build")
        XCTAssertEqual(list.terminals[1].status, .other("something-new"))
        XCTAssertEqual(list.models["claude-code"]?.first?.name, "Opus 5.5")
        XCTAssertEqual(TerminalStatus.working.label, "Busy")
        XCTAssertEqual(list.defaults, [:], "a Mac that predates it")
        XCTAssertFalse(list.models["claude-code"]?.first?.older ?? true)
    }

    /// A question the agent asks (AskUserQuestion, 2026-10-01): its questions come with the request; any other request
    /// and a Mac that predates question cards have none (the permission card then).
    func testAQuestionDecodesWithItsOptions() throws {
        let p = try JSONDecoder().decode(TerminalPermission.self, from: json([
            "id": "p1", "tool": "AskUserQuestion", "summary": "会话存在哪里？", "at": 3, "input": ["questions": []],
            "questions": [["question": "会话存在哪里？", "header": "Store", "multiSelect": false,
                           "options": [["label": "Redis", "description": "多台实例共享"], ["label": "内存"]]],
                          ["question": "记哪些字段？", "options": [["label": "耗时"]], "multiSelect": true]],
        ]))
        XCTAssertTrue(p.isQuestion)
        XCTAssertEqual(p.questions[0], TerminalQuestion(question: "会话存在哪里？", header: "Store",
                                                        options: [.init(label: "Redis", description: "多台实例共享"), .init(label: "内存")]))
        XCTAssertEqual(p.questions[1].header, "")
        XCTAssertTrue(p.questions[1].multiSelect)
        let plain = try JSONDecoder().decode(TerminalPermission.self, from: json(["id": "p2", "tool": "Bash", "summary": "Bash: ls"]))
        XCTAssertFalse(plain.isQuestion)
        let broken = try JSONDecoder().decode(TerminalPermission.self, from: json(["id": "p3", "tool": "AskUserQuestion", "questions": "?"]))
        XCTAssertFalse(broken.isQuestion, "what it cannot read is a permission card, not a failure")
    }

    /// What is picked on a question card: one replaces one, several toggle, Other's words pick it; Submit once all have one.
    func testPicksOnAQuestionCard() {
        var picks = QuestionPicks([
            TerminalQuestion(question: "存哪？", options: [.init(label: "Redis"), .init(label: "内存")]),
            TerminalQuestion(question: "记哪些？", multiSelect: true, options: [.init(label: "id"), .init(label: "耗时"), .init(label: "路径")]),
        ])
        XCTAssertFalse(picks.isComplete)
        picks.pick("Redis", in: 0)
        picks.pick("内存", in: 0)
        XCTAssertFalse(picks.isPicked("Redis", in: 0))
        picks.write("先放文件里", in: 0)
        XCTAssertFalse(picks.isPicked("内存", in: 0), "writing in Other takes the place of the option (one)")
        XCTAssertFalse(picks.isComplete)
        picks.pick("路径", in: 1)
        picks.pick("id", in: 1)
        picks.pick("耗时", in: 1)
        picks.pick("耗时", in: 1)
        picks.write("  trace id ", in: 1)
        XCTAssertTrue(picks.isPicked("路径", in: 1), "beside them (several)")
        XCTAssertTrue(picks.isComplete)
        XCTAssertEqual(picks.answers, ["存哪？": .init(labels: [], other: "先放文件里"),
                                       "记哪些？": .init(labels: ["id", "路径"], other: "trace id")])
        picks.pick("Redis", in: 0)
        XCTAssertEqual(picks.other(in: 0), "", "an option picked (one) clears Other")
        picks.write("   ", in: 1)
        XCTAssertEqual(picks.answers["记哪些？"], .init(labels: ["id", "路径"], other: nil))
    }

    func testAnsweringAQuestionSendsWhatWasPickedByQuestion() async throws {
        let transport = FakeTransport { req, n in
            n == 0 ? (Data(#"{"ok":true,"sealed":1}"#.utf8), httpResponse(req.url))
                   : (Data(#"{"error":"no such request (answered already?)"}"#.utf8), httpResponse(req.url, status: 404))
        }
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")
        let sealed = try await api.answerTerminalQuestion("t1", permissionId: "p1", answers: ["存哪？": .init(labels: ["Redis"], other: nil),
                                                                                               "记哪些？": .init(labels: ["id"], other: "密码 hunter2")])
        XCTAssertEqual(sealed, 1)
        XCTAssertEqual(transport.paths, ["/terminals/t1/permissions/p1"])
        let body = try XCTUnwrap(transport.requests[0].httpBody.flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: Any] })
        XCTAssertEqual(body["decision"] as? String, "allow")
        let answers = try XCTUnwrap(body["answers"] as? [String: [String: Any]])
        XCTAssertEqual(answers["存哪？"]?["labels"] as? [String], ["Redis"])
        XCTAssertNil(answers["存哪？"]?["other"])
        XCTAssertEqual(answers["记哪些？"]?["other"] as? String, "密码 hunter2")
        let late = try await api.answerTerminalQuestion("t1", permissionId: "p1", answers: ["存哪？": .init(labels: ["Redis"], other: nil)])
        XCTAssertNil(late, "answered in the terminal meanwhile: the card just goes")
    }

    /// Sub-agents under their terminal (2026-09-30); a Mac that predates them says none.
    func testATerminalListsItsSubagents() throws {
        let list = try JSONDecoder().decode(TerminalList.self, from: json([
            "terminals": [["id": "a1", "status": "working", "subagents": [
                ["id": "s1", "type": "code-reviewer", "name": "审查改动", "doing": "运行 git diff", "since": 1],
                ["id": "s2", "type": "Explore"]]],
                          ["id": "a2", "status": "idle"]],
            "agents": [], "models": [:],
        ]))
        XCTAssertEqual(list.terminals[0].subagents, [TerminalSubagent(id: "s1", type: "code-reviewer", name: "审查改动", doing: "运行 git diff"),
                                                     TerminalSubagent(id: "s2", type: "Explore", name: "Explore")])
        XCTAssertEqual(list.terminals[1].subagents, [])
    }

    func testModelsAsTheAgentListsThem() throws {
        let list = try JSONDecoder().decode(TerminalList.self, from: json([
            "terminals": [], "agents": ["claude-code"],
            "models": ["claude-code": [["id": "opus", "name": "Opus 5.5", "description": "For complex work"],
                                       ["id": "claude-opus-4-8", "name": "Opus 4.8", "older": true]]],
            "defaults": ["claude-code": "Opus 5.5"],
        ]))
        XCTAssertEqual(list.defaults["claude-code"], "Opus 5.5")
        XCTAssertEqual(list.models["claude-code"]?.map(\.older), [false, true])
        XCTAssertEqual(list.models["claude-code"]?.first?.description, "For complex work")
    }

    func testEventsParseAndUnknownOnesAreSkipped() {
        XCTAssertEqual(TerminalEvent.parse(event: "snapshot", data: #"{"type":"snapshot","seq":7,"cols":80,"rows":24,"data":"hi"}"#),
                       .snapshot(seq: 7, cols: 80, rows: 24, data: "hi"))
        XCTAssertEqual(TerminalEvent.parse(event: "output", data: #"{"type":"output","seq":8,"data":"\u001b[2J"}"#), .output(seq: 8, data: "\u{1b}[2J"))
        XCTAssertEqual(TerminalEvent.parse(event: "status", data: #"{"status":"working"}"#), .status(.working))
        XCTAssertEqual(TerminalEvent.parse(event: "permission", data: #"{"request":{"id":"p1","tool":"Write","summary":"Write: a.txt","input":{}}}"#),
                       .permission(TerminalPermission(id: "p1", tool: "Write", summary: "Write: a.txt")))
        XCTAssertEqual(TerminalEvent.parse(event: "permission_resolved", data: #"{"id":"p1","decision":null}"#), .permissionResolved(id: "p1"))
        XCTAssertEqual(TerminalEvent.parse(event: "permissions", data: #"{"type":"permissions","requests":[{"id":"p2","tool":"Bash","summary":"Bash: ls","input":{}}]}"#),
                       .permissions([TerminalPermission(id: "p2", tool: "Bash", summary: "Bash: ls")]))
        XCTAssertEqual(TerminalEvent.parse(event: "permissions", data: #"{"requests":[]}"#), .permissions([]))
        XCTAssertEqual(TerminalEvent.parse(event: "resize", data: #"{"type":"resize","cols":149,"rows":52,"by":"mac-3f"}"#), .resize(cols: 149, rows: 52, by: "mac-3f"))
        XCTAssertEqual(TerminalEvent.parse(event: "resize", data: #"{"cols":50,"rows":30,"by":null}"#), .resize(cols: 50, rows: 30, by: nil))
        XCTAssertEqual(TerminalEvent.parse(event: "exit", data: #"{"code":null}"#), .exit(code: nil))
        XCTAssertEqual(TerminalEvent.parse(event: "removed", data: "{}"), .removed)
        XCTAssertNil(TerminalEvent.parse(event: "future", data: "{}"))
        XCTAssertNil(TerminalEvent.parse(event: "output", data: "not json"))
    }

    func testResumeStartedExistingOrOpenElsewhere() async throws {
        let replies: [(Int, String)] = [
            (201, #"{"terminal":{"id":"t1","status":"idle"}}"#),
            (200, #"{"terminal":{"id":"t0","status":"working"},"existing":true}"#),
            (409, #"{"error":"会话正在iTerm2中运行","elsewhere":{"app":"iTerm2","pid":42}}"#),
            (403, #"{"error":"跳过权限只能在 Mac 上选择"}"#),
            (422, #"{"error":"会话所在的文件夹 /Users/u/p 已不存在。","folderGone":"/Users/u/p","alike":["/Users/u/Projects/p"],"near":"/Users/u"}"#),
        ]
        let transport = FakeTransport { req, n in (Data(replies[n].1.utf8), httpResponse(req.url, status: replies[n].0)) }
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")
        let body = ResumeTerminalRequest(harness: "claude-code", cwd: "/Users/u/p", agentSessionId: "s-1", mode: "auto")
        guard case .started(let t) = try await api.resumeTerminal(body) else { return XCTFail("not started") }
        XCTAssertEqual(t.id, "t1")
        guard case .existing(let e) = try await api.resumeTerminal(body) else { return XCTFail("not existing") }
        XCTAssertEqual(e.id, "t0")
        let third = try await api.resumeTerminal(body)
        XCTAssertEqual(third, .elsewhere(app: "iTerm2", pid: 42))
        do {
            _ = try await api.resumeTerminal(body)
            XCTFail("403 is an error")
        } catch APIError.http(let status, let message) {
            XCTAssertEqual(status, 403)
            XCTAssertEqual(message, "跳过权限只能在 Mac 上选择")
        }
        // Its folder gone (2026-10-03): where it may be now, and the same request again in a folder picked.
        let gone = try await api.resumeTerminal(body)
        XCTAssertEqual(gone, .folderGone(cwd: "/Users/u/p", alike: ["/Users/u/Projects/p"], near: "/Users/u"))
        XCTAssertEqual(body.continuing(in: "~/Projects/p"), ResumeTerminalRequest(harness: "claude-code", cwd: "~/Projects/p", agentSessionId: "s-1", mode: "auto"))
        XCTAssertEqual(transport.paths.first, "/terminals/resume")
    }

    func testKeysAndInputGoByNameAndThroughTheSealer() async throws {
        let transport = FakeTransport { req, _ in
            let reply = req.url?.path.hasSuffix("/input") == true ? #"{"ok":true,"sealed":1}"# : #"{"ok":true}"#
            return (Data(reply.utf8), httpResponse(req.url))
        }
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")
        try await api.sendTerminalKeys("t1", [.esc, .shiftTab, .ctrlC, .one])
        let result = try await api.sendTerminalInput("t1", text: "密码是 hunter2")
        XCTAssertEqual(result.sealed, 1)
        try await api.decideTerminalPermission("t1", permissionId: "p1", allow: true)
        XCTAssertEqual(transport.paths, ["/terminals/t1/keys", "/terminals/t1/input", "/terminals/t1/permissions/p1"])
        // A tap on a program that tracks the mouse (2026-09-30, user: 手机上的终端只能滚动，点击操作没透传).
        try await api.clickTerminal("t1", col: 4, row: 2)
        let click = try XCTUnwrap(transport.requests.last?.httpBody.flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: [String]] })
        XCTAssertEqual(click["keys"], ["click:4:2"])
        let keys = try XCTUnwrap(transport.requests[0].httpBody.flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: [String]] })
        XCTAssertEqual(keys["keys"], ["esc", "shift-tab", "ctrl-c", "1"])
        let decision = try XCTUnwrap(transport.requests[2].httpBody.flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: String] })
        XCTAssertEqual(decision["decision"], "allow")
        // Answered on the Mac while the phone was away (2026-09-30, user: 手机上再次确认会显示 no such request).
        let answered = FakeTransport { req, _ in (Data(#"{"error":"no such request (answered already?)"}"#.utf8), httpResponse(req.url, status: 404)) }
        let late = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: answered, token: "tok")
        let decided = try await late.decideTerminalPermission("t1", permissionId: "p1", allow: false)
        XCTAssertFalse(decided)
        // never the raw keystroke route
        XCTAssertFalse(transport.paths.contains { $0.hasSuffix("/write") })
    }

    /// 2026-09-30, user: 手机上不能直接发图.
    func testPicturesAreStagedThenPutInTheTerminal() async throws {
        let transport = FakeTransport { req, _ in
            let reply = req.url?.path == "/uploads" ? #"{"files":[{"id":"abc123def456","name":"photo-1.jpg","size":4,"type":"image/jpeg"}]}"#
                : #"{"files":[{"name":"photo-1.jpg","path":"/var/folders/x/T/agentswitch-attach/t1/photo-1.jpg","size":4,"type":"image/jpeg"}]}"#
            return (Data(reply.utf8), httpResponse(req.url))
        }
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")
        let staged = try await api.upload([UploadFile(name: "photo-1.jpg", type: "image/jpeg", data: Data([1, 2, 3, 4]))])
        let files = try await api.attachToTerminal("t1", uploads: staged.map(\.id))
        XCTAssertEqual(files, [AttachedFile(name: "photo-1.jpg", path: "/var/folders/x/T/agentswitch-attach/t1/photo-1.jpg")])
        XCTAssertEqual(transport.paths, ["/uploads", "/terminals/t1/attach"])
        let body = try XCTUnwrap(transport.requests[1].httpBody.flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: [String]] })
        XCTAssertEqual(body["uploads"], ["abc123def456"])
    }

    func testStreamResumesAfterTheLastSeqAndEndsWhenRemoved() async throws {
        let frames = [
            "event: snapshot\ndata: {\"type\":\"snapshot\",\"seq\":5,\"cols\":40,\"rows\":10,\"data\":\"a\"}\n\n",
            "event: output\ndata: {\"type\":\"output\",\"seq\":6,\"data\":\"b\"}\n\n",
        ]
        let transport = FakeTransport(stream: { req, n in
            if n == 0 { return (httpResponse(req.url, contentType: "text/event-stream"), frames.map { Data($0.utf8) }, APIError.transport("dropped")) }
            let replay = "event: output\ndata: {\"type\":\"output\",\"seq\":6,\"data\":\"b\"}\n\nevent: removed\ndata: {\"type\":\"removed\"}\n\n"
            return (httpResponse(req.url, contentType: "text/event-stream"), [Data(replay.utf8)], nil)
        })
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")
        var got: [TerminalEvent] = []
        for try await event in api.terminalEvents("t1", screen: "phone-7c", policy: ReconnectPolicy(initial: .milliseconds(1), maximum: .milliseconds(2))) {
            got.append(event)
        }
        XCTAssertEqual(got, [.snapshot(seq: 5, cols: 40, rows: 10, data: "a"), .output(seq: 6, data: "b"), .removed])
        // Each connection says which screen follows: the size this phone owns goes back when it stops.
        XCTAssertEqual(transport.requests.first?.url?.query, "screen=phone-7c")
        XCTAssertEqual(transport.requests.last?.url?.query, "after=6&screen=phone-7c")
    }

    func testStyleColours() throws {
        let style = try JSONDecoder().decode(TerminalStyle.self, from: json(["theme": [
            "background": "#0c0c0e", "foreground": "#e6e6e6", "selectionBackground": "rgba(1,2,3,0.3)",
            "black": "#000000", "red": "#ff0000", "green": "#00ff00", "yellow": "#ffff00", "blue": "#0000ff", "magenta": "#ff00ff",
            "cyan": "#00ffff", "white": "#ffffff", "brightBlack": "#111111", "brightRed": "#222222", "brightGreen": "#333333",
            "brightYellow": "#444444", "brightBlue": "#555555", "brightMagenta": "#666666", "brightCyan": "#777777", "brightWhite": "#888888",
        ]]))
        XCTAssertEqual(style.background, TerminalStyle.RGB(r: 0x0c, g: 0x0c, b: 0x0e))
        XCTAssertEqual(style.ansi?.count, 16)
        XCTAssertEqual(style.ansi?[1], TerminalStyle.RGB(r: 255, g: 0, b: 0))
        XCTAssertNil(TerminalStyle(theme: ["black": "#000000"]).ansi)
    }
}

/// The terminals tab's directory tree (same rules as the web page's list, packages/daemon/tests/terminalTree.test.ts).
final class TerminalTreeTests: XCTestCase {
    private func term(_ id: String, _ cwd: String, created: Int64, status: TerminalStatus = .idle, session: String? = nil, resumedFrom: String? = nil) -> TerminalInfo {
        TerminalInfo(id: id, harness: "claude-code", cwd: cwd, name: id, status: status, createdAt: created, lastOutputAt: created + 100,
                     agentSessionId: session, resumedFrom: resumedFrom)
    }
    private func session(_ id: String, _ cwd: String, at: Int64 = 1, started: Int64? = nil) -> SessionSummary {
        SessionSummary(harness: "claude-code", id: id, cwd: cwd, title: id, updatedAt: at, startedAt: started)
    }
    /// The tree as `name/` lines, two spaces a level, its own terminals and sessions as `· id`.
    private func lines(_ folders: [TerminalTree.Folder], depth: Int = 0) -> [String] {
        let pad = String(repeating: "  ", count: depth)
        return folders.flatMap { f in
            ["\(pad)\(f.name)/"] + f.terminals.map { "\(pad)  · \($0.id)" } + f.sessions.map { "\(pad)  · \($0.sessionId)" }
                + lines(f.children, depth: depth + 1)
        }
    }
    private let w = "/Users/u/Desktop/WorkSpace"

    // 2026-09-30, user: 目录树顺序应该是固定的，现在会根据活跃状态顺序乱跳.
    func testTheOrderIsFixedFoldersByPathTerminalsAsOpenedSessionsAsBegun() {
        let terminals = [term("t2", "/Users/u/Work/api", created: 20), term("t1", "/Users/u/Code/AgentSwitch", created: 10),
                         term("t3", "/Users/u/Work/api", created: 30)]
        let sessions = [session("s1", "/Users/u/Work/web", at: 999, started: 100), session("s2", "/Users/u/Docs/Notes", at: 500, started: 400),
                        session("s3", "/Users/u/Code/AgentSwitch", at: 50, started: 40), session("s4", "/Users/u/Code/AgentSwitch", at: 9_999, started: 30)]
        let folders = TerminalTree.build(terminals: terminals, sessions: sessions)
        XCTAssertEqual(lines(folders), ["AgentSwitch/", "  · t1", "  · s3", "  · s4", "Notes/", "  · s2",
                                        "Work/", "  api/", "    · t2", "    · t3", "  web/", "    · s1"], "s4 is busy now; it began earlier and stays below")
        XCTAssertFalse(folders[2].holdsOwn)
        XCTAssertEqual(TerminalTree.order(folders).map(\.id), ["t1", "t2", "t3"])
        // Work going on anywhere moves nothing.
        let later = TerminalTree.build(terminals: terminals, sessions: sessions.map { SessionSummary(harness: $0.harness, id: $0.sessionId, cwd: $0.cwd, title: $0.title, updatedAt: $0.updatedAt + 50_000, startedAt: $0.startedAt) })
        XCTAssertEqual(lines(later), lines(folders))
    }

    // 2026-10-03, user: 怎么分别显示了两个worktop.
    func testAFolderWithSessionsOfItsOwnThatHoldsOthersIsOneLine() {
        let folders = TerminalTree.build(terminals: [], sessions: [session("own", "\(w)/Worktop"), session("c1", "\(w)/Worktop/Codex"),
                                                                   session("c2", "\(w)/Worktop/Claude")])
        XCTAssertEqual(lines(folders), ["Worktop/", "  · own", "  Claude/", "    · c2", "  Codex/", "    · c1"])
        XCTAssertTrue(folders[0].holdsOwn)
    }

    // 2026-10-03, user: 有共同的祖父节点时并没能正确显示，比如“靶场”就在 /WorkSpace/Worktop/培训/靶场 下，但是显示起来是独立的.
    func testAFolderSitsInTheNearestFolderAboveItThatTheListShows() {
        let sessions = [session("a1", "\(w)/Projects/AgentSwitch"), session("a2", "\(w)/Projects/AgentSwitch/packages/secret-gate"),
                        session("m1", "\(w)/Projects/MailLab"), session("w1", "\(w)/Worktop"), session("c1", "\(w)/Worktop/Claude"),
                        session("v1", "\(w)/Worktop/Claude/CVP_bypass"), session("x1", "\(w)/Worktop/Codex"), session("r1", "\(w)/Worktop/培训/靶场"),
                        session("d1", "/Users/u/Documents/工作文章/CBwork")]
        XCTAssertEqual(lines(TerminalTree.build(terminals: [], sessions: sessions)), [
            "Projects/", "  AgentSwitch/", "    · a1", "    packages/secret-gate/", "      · a2", "  MailLab/", "    · m1",
            "Worktop/", "  · w1", "  Claude/", "    · c1", "    CVP_bypass/", "      · v1", "  Codex/", "    · x1", "  培训/靶场/", "    · r1",
            "CBwork/", "  · d1",
        ])
    }

    func testAFolderThatOnlyGathersOthersHoldsTheDeeperOnesToo() {
        let folders = TerminalTree.build(terminals: [], sessions: [session("c1", "\(w)/Worktop/Codex"), session("c2", "\(w)/Worktop/Claude"),
                                                                   session("r1", "\(w)/Worktop/培训/靶场")])
        XCTAssertEqual(lines(folders), ["Worktop/", "  Claude/", "    · c2", "  Codex/", "    · c1", "  培训/靶场/", "    · r1"])
        XCTAssertEqual(TerminalTree.flatten(folders).map(\.name), ["Worktop", "Worktop/Claude", "Worktop/Codex", "Worktop/培训/靶场"])
        XCTAssertEqual(folders[0].allSessions.map(\.sessionId), ["c2", "c1", "r1"])
        // Projects that only share a grandparent get no folder over them.
        let apart = TerminalTree.build(terminals: [], sessions: [session("a", "\(w)/Projects/A"), session("b", "\(w)/Projects/B"),
                                                                 session("c", "\(w)/Worktop/C"), session("d", "\(w)/Worktop/D")])
        XCTAssertEqual(apart.map(\.name), ["Projects", "Worktop"])
    }

    func testYourHomeFolderHoldsOnlyWhatSitsDirectlyInIt() {
        let folders = TerminalTree.build(terminals: [], sessions: [session("h", "/Users/u"), session("n", "/Users/u/notes"),
                                                                   session("p", "\(w)/Projects/A"), session("t", "/private/tmp/x/y")])
        XCTAssertEqual(lines(folders), ["y/", "  · t", "~/", "  · h", "  notes/", "    · n", "A/", "  · p"])
    }

    // 2026-10-03 review: two sessions started in ~/Desktop made it hold every project below it.
    func testThePlacesInYourHomeHoldOnlyWhatSitsDirectlyInThem() {
        let folders = TerminalTree.build(terminals: [], sessions: [session("d", "/Users/u/Desktop"), session("a", "\(w)/Projects/A"),
                                                                   session("b", "\(w)/Projects/B"), session("n", "/Users/u/Desktop/notes")])
        XCTAssertEqual(lines(folders), ["Desktop/", "  · d", "  notes/", "    · n", "Projects/", "  A/", "    · a", "  B/", "    · b"])
        XCTAssertEqual(TerminalTree.foldersAbove("/a/b"), ["/a/b", "/a", "/"])
    }

    func testAMalformedFolderEndsAtTheTopAndTheTopOfTheDiskIsASlash() {
        let folders = TerminalTree.build(terminals: [], sessions: [session("r", "foo/bar"), session("s", "foo"), session("t", "/")])
        XCTAssertEqual(lines(folders), ["//", "  · t", "  foo/", "    · s", "    bar/", "      · r"])
        XCTAssertEqual(TerminalTree.slashed(folders[0].name), "/")
        XCTAssertEqual(TerminalTree.tilde("/Users/Shared/Projects/app"), "/Users/Shared/Projects/app")
        XCTAssertEqual(TerminalTree.tilde("/Users/u/Projects/app"), "~/Projects/app")
        // Names repeated at the top, as the web page writes them.
        let repeated = TerminalTree.build(terminals: [], sessions: [session("a", "/Users/u/app"), session("b", "/app")])
        XCTAssertEqual(repeated.map(\.name), ["app", "~/app"])
    }

    /// A new Codex terminal's record, before it says its id, is its own (as the web page reads it).
    func testANewCodexTerminalsRecordIsNotListedAsAnotherSession() {
        let fresh = TerminalInfo(id: "t3", harness: "codex", cwd: "/p/q", name: "t3", status: .idle, createdAt: 1_000, lastOutputAt: 1_000)
        let record = SessionSummary(harness: "codex", id: "019a0000-0000-7000-8000-000000000000", cwd: "/p/q", title: "x", updatedAt: 5, startedAt: 5)
        let other = SessionSummary(harness: "codex", id: "019a0000-0000-7000-8000-000000000001", cwd: "/p/other", title: "y", updatedAt: 5, startedAt: 5)
        let folders = TerminalTree.build(terminals: [fresh], sessions: [record, other])
        XCTAssertEqual(folders.flatMap(\.allSessions).map(\.sessionId), ["019a0000-0000-7000-8000-000000000001"])
    }

    func testASessionARunningTerminalWritesIsNotListedTwice() {
        let open = term("t1", "/p/q", created: 1, session: "s1")
        let ended = term("t2", "/p/q", created: 2, status: .exited, session: "s2")
        let folders = TerminalTree.build(terminals: [open, ended], sessions: [session("s1", "/p/q", at: 5), session("s2", "/p/q", at: 4)])
        XCTAssertEqual(folders[0].sessions.map(\.sessionId), ["s2"], "an ended terminal no longer holds its session")
    }

    func testRepeatedNamesAtTheTopLevelCarryTheirParent() {
        let folders = TerminalTree.build(terminals: [], sessions: [session("a", "/Users/u/x/app", at: 2), session("b", "/Users/u/y/app", at: 1)])
        XCTAssertEqual(folders.map(\.name), ["x/app", "y/app"])
    }

    /// Git after a folder's name (2026-09-30): what is 0 is left out; a folder outside a repository says nothing.
    func testAFolderCarriesItsGit() throws {
        let git = ["/Users/u/x/app": GitSummary(branch: "main", changed: 5, ahead: 2)]
        let folders = TerminalTree.build(terminals: [], sessions: [session("a", "/Users/u/x/app", at: 2), session("b", "/Users/u/y/app", at: 1)], git: git)
        XCTAssertEqual(folders.map { $0.git?.said }, ["main ±5 ↑2", nil])
        XCTAssertEqual(GitSummary(branch: "feat/x", behind: 4).said, "feat/x ↓4")
        let json = #"{"folders":{"/w":{"branch":"main","changed":1,"ahead":0,"behind":3}}}"#
        XCTAssertEqual(try JSONDecoder().decode(FolderGitList.self, from: Data(json.utf8)).folders["/w"], GitSummary(branch: "main", changed: 1, behind: 3))
    }
}

/// Pictures and files in a terminal reply (2026-09-30, user: 图片只能插到消息开头……要和 cc 一样给占位符).
final class TerminalDraftTests: XCTestCase {
    private let lan = APIEndpoint(host: "192.168.1.5", port: 4713, kind: .lan)

    func testPlaceholdersGoWhereTheCaretIsSpacedAsTyped() {
        XCTAssertEqual(TerminalDraft.token(image: true, number: 1), "[Image #1]")
        XCTAssertEqual(TerminalDraft.token(image: false, number: 2), "[File #2]")
        var r = TerminalDraft.insert(["[Image #1]"], into: "看这张哪里不对", at: 3)
        XCTAssertEqual(r.text, "看这张 [Image #1] 哪里不对")
        XCTAssertEqual(r.caret, 15)
        r = TerminalDraft.insert(["[Image #1]", "[File #2]"], into: "", at: nil)
        XCTAssertEqual(r.text, "[Image #1] [File #2] ")
        r = TerminalDraft.insert(["[Image #3]"], into: "a b", at: 1)
        XCTAssertEqual(r.text, "a [Image #3] b", "the space already there is not doubled")
        XCTAssertEqual(TerminalDraft.remove("[Image #1]", from: "看这张 [Image #1] 哪里不对"), "看这张 哪里不对")
    }

    func testTheReplyCarriesWhereEachFileGoes() async throws {
        let transport = FakeTransport { req, _ in (Data(#"{"ok":true,"sealed":0,"attached":1}"#.utf8), httpResponse(req.url)) }
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")
        let result = try await api.sendTerminalInput("t1", text: "看 [Image #1] 这里", sealed: false,
                                                     attachments: [TerminalAttachmentRef(token: "[Image #1]", upload: "abc123def456")])
        XCTAssertEqual(result.attached, 1)
        let body = try XCTUnwrap(transport.requests.first?.httpBody.flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: Any] })
        XCTAssertEqual((body["attachments"] as? [[String: String]])?.first, ["token": "[Image #1]", "upload": "abc123def456"])
        // Without files the body is as before (an older Mac is not asked for what it does not know).
        _ = try await api.sendTerminalInput("t1", text: "hi", sealed: false)
        let plain = try XCTUnwrap(transport.requests.last?.httpBody.flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: Any] })
        XCTAssertNil(plain["attachments"])
    }
}

/// The terminals tab's search (2026-09-30, user: 支持搜索目录名、session 标题、session 内容，手机和电脑都可以搜).
final class TerminalSearchTests: XCTestCase {
    private func session(_ id: String, _ cwd: String, _ title: String) -> SessionSummary {
        SessionSummary(harness: "claude-code", id: id, cwd: cwd, title: title, updatedAt: 1, startedAt: 1)
    }

    private var nodes: [TerminalTree.Folder] {
        let terminal = TerminalInfo(id: "t1", harness: "claude-code", cwd: "/Users/u/Work/api", name: "修复登录超时", status: .working,
                                    createdAt: 1, lastOutputAt: 1, agentSessionId: "c9")
        return TerminalTree.build(terminals: [terminal], sessions: [
            session("s1", "/Users/u/Work/api", "给健康检查加缓存"), session("s2", "/Users/u/Work/web", "表单校验"),
            session("s3", "/Users/u/AgentSwitch", "未读标记"),
        ], git: ["/Users/u/AgentSwitch": GitSummary(branch: "main")])
    }

    func testFoldersByNameWithAllTheyHold() {
        let result = TerminalSearch.run(nodes, query: "agentsw")
        XCTAssertEqual(result.folders.map(\.name), ["AgentSwitch"])
        XCTAssertEqual(result.folders[0].rows.map(\.id), ["s:claude-code/s3"])
        XCTAssertEqual(result.folders[0].git?.branch, "main")
        XCTAssertEqual(result.summary, "// 1 folder")
    }

    func testTitlesAndWordsKeepTheTreeOrder() {
        let said = ["claude-code:c9": "…连接池太小，改成 64。", "claude-code:s2": "校验放在失焦时"]
        let result = TerminalSearch.run(nodes, query: "缓存", said: said)
        XCTAssertEqual(result.folders.map(\.name), ["Work/api", "Work/web"])
        // The terminal by the words of the session it writes; a title that matched carries no line of words.
        XCTAssertEqual(result.folders[0].rows.map(\.id), ["t:t1", "s:claude-code/s1"])
        XCTAssertEqual(result.folders[0].rows.map(\.said), ["…连接池太小，改成 64。", nil])
        XCTAssertEqual(result.folders[0].rows.map(\.titleHit), [false, true])
        XCTAssertEqual(result.summary, "// 1 title · 2 in text")
        XCTAssertTrue(TerminalSearch.run(nodes, query: "没有这个").folders.isEmpty)
        XCTAssertTrue(TerminalSearch.run(nodes, query: "  ").folders.isEmpty)
    }

    /// A folder in another goes by the names of the folders it sits in, and a match on those keeps it.
    func testNestedFoldersAreNamedByTheFoldersTheySitIn() {
        let tree = TerminalTree.build(terminals: [], sessions: [
            session("w", "/Users/u/Worktop", "整理"), session("r", "/Users/u/Worktop/培训/靶场", "靶机"), session("c", "/Users/u/Worktop/Codex", "其他"),
        ])
        let result = TerminalSearch.run(tree, query: "worktop")
        XCTAssertEqual(result.folders.map(\.name), ["Worktop", "Worktop/Codex", "Worktop/培训/靶场"])
        XCTAssertEqual(TerminalSearch.run(tree, query: "靶场").folders.map(\.rows.count), [1])
    }

    func testTheMatchShowsInANarrowRow() {
        XCTAssertEqual(TerminalSearch.near("连接池", in: "…先看了一下配置文件，发现连接池太小"), "…置文件，发现连接池太小")
        XCTAssertEqual(TerminalSearch.near("池", in: "连接池太小"), "连接池太小")
        XCTAssertNotNil(TerminalSearch.match("KEY", in: "a key here"))
    }
}

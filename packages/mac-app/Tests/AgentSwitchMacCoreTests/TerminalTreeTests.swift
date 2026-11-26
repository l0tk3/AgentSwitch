import XCTest
@testable import AgentSwitchMacCore

// The terminal list's directory tree and its search: the iPhone kit's tests of the same rules (its TerminalTests.swift),
// for this package's copy of them (Terminals/TerminalTree.swift, TerminalSearch.swift).

/// The terminals tab's directory tree (same rules as the web page's list, packages/daemon/tests/terminalTree.test.ts).
final class TerminalTreeTests: XCTestCase {
    private func term(_ id: String, _ cwd: String, created: Int64, status: String = "idle", session: String? = nil, resumedFrom: String? = nil) -> TerminalInfo {
        TerminalInfo(id: id, harness: "claude-code", cwd: cwd, name: id, status: status, createdAt: created,
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
    private let w = "/Users/u/Desktop/Code"

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

    // 2026-10-11, user: 这里要加上筛选某个agent的会话 和筛选活跃会话的功能.
    func testTheFilterKeepsOneAgentsRowsAndWhatIsActiveAndNoEmptyFolder() {
        let terminals = [term("t1", "\(w)/A", created: 1), TerminalInfo(id: "t2", harness: "codex", cwd: "\(w)/A", name: "t2", status: "working", createdAt: 2),
                         TerminalInfo(id: "t3", harness: "codex", cwd: "\(w)/B/deep", name: "t3", status: "exited", createdAt: 3)]
        let sessions = [session("s1", "\(w)/A"), SessionSummary(harness: "codex", id: "s2", cwd: "\(w)/B", title: "s2", updatedAt: 1),
                        SessionSummary(harness: "opencode", id: "s3", cwd: "\(w)/C", title: "s3", updatedAt: 1, active: true)]
        let tree = TerminalTree.build(terminals: terminals, sessions: sessions)
        XCTAssertEqual(lines(tree), ["Code/", "  A/", "    · t1", "    · t2", "    · s1", "  B/", "    · s2", "    deep/", "      · t3", "  C/", "    · s3"])
        XCTAssertEqual(TerminalTree.filtered(tree, by: TerminalListFilter()), tree, "no filter: the tree as it is")
        // One agent's: its terminals and its sessions; a folder with nothing of its goes, the folder that gathers the
        // others stays while one of them does.
        XCTAssertEqual(lines(TerminalTree.filtered(tree, by: TerminalListFilter(agent: "codex"))),
                       ["Code/", "  A/", "    · t2", "  B/", "    · s2", "    deep/", "      · t3"])
        // What is active: the terminals that run, the sessions being written now.
        XCTAssertEqual(lines(TerminalTree.filtered(tree, by: TerminalListFilter(active: true))), ["Code/", "  A/", "    · t1", "    · t2", "  C/", "    · s3"])
        XCTAssertEqual(lines(TerminalTree.filtered(tree, by: TerminalListFilter(agent: "codex", active: true))), ["Code/", "  A/", "    · t2"])
        XCTAssertEqual(TerminalTree.filtered(tree, by: TerminalListFilter(agent: "pi")), [])
        // What is recent (2026-11-11): every terminal listed, the sessions written within the last days, and one being
        // written now whatever its time says.
        let day: Int64 = 86_400_000, now = 10 * day
        let aged = TerminalTree.build(terminals: terminals, sessions: [
            SessionSummary(harness: "claude-code", id: "new", cwd: "\(w)/A", title: "new", updatedAt: now - 2 * day),
            SessionSummary(harness: "codex", id: "edge", cwd: "\(w)/B", title: "edge", updatedAt: now - Int64(TerminalListFilter.recentDays) * day),
            SessionSummary(harness: "codex", id: "old", cwd: "\(w)/B", title: "old", updatedAt: now - 4 * day),
            SessionSummary(harness: "opencode", id: "busy", cwd: "\(w)/C", title: "busy", updatedAt: 1, active: true),
            SessionSummary(harness: "opencode", id: "gone", cwd: "\(w)/D", title: "gone", updatedAt: 1)])
        XCTAssertEqual(lines(TerminalTree.filtered(aged, by: TerminalListFilter(recent: true), now: now)),
                       ["Code/", "  A/", "    · t1", "    · t2", "    · new", "  B/", "    · edge", "    deep/", "      · t3", "  C/", "    · busy"])
        XCTAssertEqual(lines(TerminalTree.filtered(aged, by: TerminalListFilter(agent: "codex", recent: true), now: now)),
                       ["Code/", "  A/", "    · t2", "  B/", "    · edge", "    deep/", "      · t3"])
        XCTAssertEqual(lines(TerminalTree.filtered(aged, by: TerminalListFilter(active: true, recent: true), now: now)), ["Code/", "  A/", "    · t1", "    · t2", "  C/", "    · busy"])
        XCTAssertTrue(TerminalListFilter(recent: true).isOn)
        XCTAssertEqual(TerminalListFilter(recent: true).choosing("codex"), TerminalListFilter(agent: "codex", recent: true))
        // The folders that stay keep their names and their places.
        let nested = TerminalTree.filtered(tree, by: TerminalListFilter(agent: "codex")).first?.children.first { $0.name == "B" }
        XCTAssertEqual(nested?.children.map(\.name), ["deep"])

        // The agents offered: those in the list, in the page's order; one alone is nothing to choose between; the one
        // chosen stays offered when nothing of its is left; chosen again, it is taken off.
        XCTAssertEqual(TerminalListFilter.agents(terminals: terminals, sessions: sessions), ["claude-code", "codex", "opencode"])
        XCTAssertEqual(TerminalListFilter.agents(terminals: [terminals[0]], sessions: [sessions[0]]), [])
        XCTAssertEqual(TerminalListFilter.agents(terminals: [terminals[0]], sessions: [], chosen: "pi"), ["claude-code", "pi"])
        XCTAssertEqual(TerminalListFilter(active: true).choosing("codex"), TerminalListFilter(agent: "codex", active: true))
        XCTAssertEqual(TerminalListFilter(agent: "codex", active: true).choosing("codex"), TerminalListFilter(active: true))
        XCTAssertEqual(TerminalListFilter(agent: "codex").choosing("pi"), TerminalListFilter(agent: "pi"))
        XCTAssertFalse(TerminalListFilter().isOn)
    }

    // 2026-10-03, user: 怎么分别显示了两个workbench.
    func testAFolderWithSessionsOfItsOwnThatHoldsOthersIsOneLine() {
        let folders = TerminalTree.build(terminals: [], sessions: [session("own", "\(w)/Workbench"), session("c1", "\(w)/Workbench/Codex"),
                                                                   session("c2", "\(w)/Workbench/Claude")])
        XCTAssertEqual(lines(folders), ["Workbench/", "  · own", "  Claude/", "    · c2", "  Codex/", "    · c1"])
        XCTAssertTrue(folders[0].holdsOwn)
    }

    // 2026-10-03, user: 有共同的祖父节点时并没能正确显示，比如“lab”就在 /Code/Workbench/courses/lab 下，但是显示起来是独立的.
    func testAFolderSitsInTheNearestFolderAboveItThatTheListShows() {
        let sessions = [session("a1", "\(w)/Projects/AgentSwitch"), session("a2", "\(w)/Projects/AgentSwitch/packages/secret-gate"),
                        session("m1", "\(w)/Projects/demo-app"), session("w1", "\(w)/Workbench"), session("c1", "\(w)/Workbench/Claude"),
                        session("v1", "\(w)/Workbench/Claude/scratch"), session("x1", "\(w)/Workbench/Codex"), session("r1", "\(w)/Workbench/courses/lab"),
                        session("d1", "/Users/u/Documents/工作文章/Draft")]
        XCTAssertEqual(lines(TerminalTree.build(terminals: [], sessions: sessions)), [
            "Projects/", "  AgentSwitch/", "    · a1", "    packages/secret-gate/", "      · a2", "  demo-app/", "    · m1",
            "Workbench/", "  · w1", "  Claude/", "    · c1", "    scratch/", "      · v1", "  Codex/", "    · x1", "  courses/lab/", "    · r1",
            "Draft/", "  · d1",
        ])
    }

    func testAFolderThatOnlyGathersOthersHoldsTheDeeperOnesToo() {
        let folders = TerminalTree.build(terminals: [], sessions: [session("c1", "\(w)/Workbench/Codex"), session("c2", "\(w)/Workbench/Claude"),
                                                                   session("r1", "\(w)/Workbench/courses/lab")])
        XCTAssertEqual(lines(folders), ["Workbench/", "  Claude/", "    · c2", "  Codex/", "    · c1", "  courses/lab/", "    · r1"])
        XCTAssertEqual(TerminalTree.flatten(folders).map(\.name), ["Workbench", "Workbench/Claude", "Workbench/Codex", "Workbench/courses/lab"])
        XCTAssertEqual(folders[0].allSessions.map(\.sessionId), ["c2", "c1", "r1"])
        // Projects that only share a grandparent get no folder over them.
        let apart = TerminalTree.build(terminals: [], sessions: [session("a", "\(w)/Projects/A"), session("b", "\(w)/Projects/B"),
                                                                 session("c", "\(w)/Workbench/C"), session("d", "\(w)/Workbench/D")])
        XCTAssertEqual(apart.map(\.name), ["Projects", "Workbench"])
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
        let fresh = TerminalInfo(id: "t3", harness: "codex", cwd: "/p/q", name: "t3", status: "idle", createdAt: 1_000)
        let record = SessionSummary(harness: "codex", id: "019a0000-0000-7000-8000-000000000000", cwd: "/p/q", title: "x", updatedAt: 5, startedAt: 5)
        let other = SessionSummary(harness: "codex", id: "019a0000-0000-7000-8000-000000000001", cwd: "/p/other", title: "y", updatedAt: 5, startedAt: 5)
        let folders = TerminalTree.build(terminals: [fresh], sessions: [record, other])
        XCTAssertEqual(folders.flatMap(\.allSessions).map(\.sessionId), ["019a0000-0000-7000-8000-000000000001"])
    }

    func testASessionARunningTerminalWritesIsNotListedTwice() {
        let open = term("t1", "/p/q", created: 1, session: "s1")
        let ended = term("t2", "/p/q", created: 2, status: "exited", session: "s2")
        let folders = TerminalTree.build(terminals: [open, ended], sessions: [session("s1", "/p/q", at: 5), session("s2", "/p/q", at: 4)])
        XCTAssertEqual(folders[0].sessions.map(\.sessionId), ["s2"], "an ended terminal no longer holds its session")
    }

    func testRepeatedNamesAtTheTopLevelCarryTheirParent() {
        let folders = TerminalTree.build(terminals: [], sessions: [session("a", "/Users/u/x/app", at: 2), session("b", "/Users/u/y/app", at: 1)])
        XCTAssertEqual(folders.map(\.name), ["x/app", "y/app"])
    }

    /// Git after a folder's name (2026-09-30): what is 0 is left out; a folder outside a repository says nothing.
    func testAFolderCarriesItsGit() throws {
        let git = ["/Users/u/x/app": FolderGit(branch: "main", changed: 5, ahead: 2)]
        let folders = TerminalTree.build(terminals: [], sessions: [session("a", "/Users/u/x/app", at: 2), session("b", "/Users/u/y/app", at: 1)], git: git)
        XCTAssertEqual(folders.map { $0.git.map(TerminalWindowText.git) }, ["main ±5 ↑2", nil])
        XCTAssertEqual(TerminalWindowText.git(FolderGit(branch: "feat/x", behind: 4)), "feat/x ↓4")
    }
}

/// The terminals tab's search (2026-09-30, user: 支持搜索目录名、session 标题、session 内容，手机和电脑都可以搜).
final class TerminalSearchTests: XCTestCase {
    private func session(_ id: String, _ cwd: String, _ title: String) -> SessionSummary {
        SessionSummary(harness: "claude-code", id: id, cwd: cwd, title: title, updatedAt: 1, startedAt: 1)
    }

    private var nodes: [TerminalTree.Folder] {
        let terminal = TerminalInfo(id: "t1", harness: "claude-code", cwd: "/Users/u/Work/api", name: "修复登录超时", status: "working",
                                    createdAt: 1, agentSessionId: "c9")
        return TerminalTree.build(terminals: [terminal], sessions: [
            session("s1", "/Users/u/Work/api", "给健康检查加缓存"), session("s2", "/Users/u/Work/web", "表单校验"),
            session("s3", "/Users/u/AgentSwitch", "未读标记"),
        ], git: ["/Users/u/AgentSwitch": FolderGit(branch: "main")])
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
            session("w", "/Users/u/Workbench", "整理"), session("r", "/Users/u/Workbench/courses/lab", "靶机"), session("c", "/Users/u/Workbench/Codex", "其他"),
        ])
        let result = TerminalSearch.run(tree, query: "workbench")
        XCTAssertEqual(result.folders.map(\.name), ["Workbench", "Workbench/Codex", "Workbench/courses/lab"])
        XCTAssertEqual(TerminalSearch.run(tree, query: "lab").folders.map(\.rows.count), [1])
    }

    func testTheMatchShowsInANarrowRow() {
        XCTAssertEqual(TerminalSearch.near("连接池", in: "…先看了一下配置文件，发现连接池太小"), "…置文件，发现连接池太小")
        XCTAssertEqual(TerminalSearch.near("池", in: "连接池太小"), "连接池太小")
        XCTAssertNotNil(TerminalSearch.match("KEY", in: "a key here"))
    }
}

#if DEBUG
import AgentSwitchMacCore
import AppKit
import SwiftUI

/// The native Terminals page for `-designPreview <dir> -designPreviewOnly terminals` (debug builds only): the page as it
/// is built, drawn off screen from made-up work — no service; a few lines are fed to the screens in place of an agent's.
/// In the look in force (`-appearance pixel|classic`), it writes:
/// - `terminals-list`: one pane, the list with terminals at work, waiting and ended, sub-agents, earlier sessions, git;
/// - `terminals-panes`: three panes — the second in focus with a request's card, the third empty;
/// - `terminals-create`, `terminals-create-pane`: the new-terminal panel alone, and in a pane among several;
/// - `terminals-search`: a search with titles and words that matched;
/// - `terminals-sheet`: closing a running terminal asked first;
/// - `terminals-rename`: a name being changed; the list's folders folded around the terminal on screen;
/// - `terminals-closed`: the list put away;
/// - `terminals-record`, `terminals-record-light`, `terminals-record-split-light`, `terminals-record-side-light` (its
///   side asked for: context, tasks, the changed files with one open on its diff): the simple view (docs/simple-view-v0.md
///   §5.2) — a terminal's record in its pane, dark and in the system's light with the list following it, and beside a
///   terminal that stays dark, a request's card at the record's end; the pictures sent with a message small under it,
///   a thought of the agent's said quietly, a command with what it is for opened whole and in colour, and a reply
///   being written with a picture and a file in its floating box.
@MainActor
enum TerminalsPagePreview {
    static let size = NSSize(width: 1235, height: 764)
    private static let home = NSHomeDirectory()
    private static let project = "\(home)/Desktop/WorkSpace/Projects/AgentSwitch"

    static func render(into directory: URL) async throws {
        func file(_ name: String) -> URL { directory.appendingPathComponent("\(name).png") }
        try await shot(to: file("terminals-list")) { _ in }
        try await shot(to: file("terminals-panes")) { model in
            model.split(.right)
            model.select("t2")
            model.split(.bottom)
            model.focus(pane: TerminalPanes.paneShowing(model.layout, "t2")?.id ?? 1, force: true)
            model.focused?.session?.received(event: "permission", data: #"{"request":{"id":"r1","tool":"Bash","summary":"Bash: npm test -- --run tests/login.test.ts"}}"#)
        }
        try await shot(to: file("terminals-create")) { $0.showCreate(folder: project) }
        try await shot(to: file("terminals-create-pane")) { model in
            model.split(.right)
            model.showCreate(folder: project)
            model.createError = "文件夹不存在：~/Desktop/WorkSpace/Projects/Nowhere"
        }
        try await shot(to: file("terminals-search")) { $0.query = "登录" }
        try await shot(to: file("terminals-sheet")) { model in
            Task { _ = await model.ask(TerminalSheet(title: "关闭「修登录页的跳转」？", body: "将结束 Claude Code 进程。会话记录保留，可稍后继续。", confirm: "Close", destructive: true, check: "同时删除会话记录（无法恢复）")) }
        }
        try await shot(to: file("terminals-rename")) { model in
            model.collapsed = ["\(home)/Desktop/WorkSpace/Projects/MailLab"]
            model.startRename("t1")
        }
        try await shot(to: file("terminals-closed")) { $0.sideClosed = true }
        // The simple view (docs/simple-view-v0.md §5.2): the terminal's record in its pane; the system's light, and the
        // list with it; beside a terminal, which stays dark; waiting on a request, its card at the record's end.
        try await shot(to: file("terminals-record")) { model in stageRecord(model, working: true) }
        try await shot(to: file("terminals-record-light"), light: true) { model in stageRecord(model, working: true) }
        try await shot(to: file("terminals-record-split-light"), light: true) { model in
            model.split(.right)
            model.select("t2")
            model.focus(pane: TerminalPanes.paneShowing(model.layout, "t1")?.id ?? 1, force: true)
            stageRecord(model, working: false)
            model.focused?.session?.received(event: "permission", data: #"{"request":{"id":"r1","tool":"Bash","summary":"Bash: git push origin main"}}"#)
        }
        // The side asked for (`Show Side Pane`): the context's fill, the task list and the changed files beside the
        // record, one file open on its diff. The preview's own setting, put back after.
        UserDefaults.standard.set(true, forKey: "terminals.recordSide")
        defer { UserDefaults.standard.removeObject(forKey: "terminals.recordSide") }
        try await shot(to: file("terminals-record-side-light"), light: true) { model in
            model.sideClosed = true
            stageRecord(model, working: true)
            PaneRecord.previewOpenStep = nil
            model.focused?.record.stageChanges(["500": [FileDiff(path: "packages/mac-app/Sources/AgentSwitchMac/Agents/AgentsView.swift", added: 3, removed: 3, hunks: [
                FileDiff.Hunk(header: "@@ -212,7 +212,7 @@", lines: ["     HStack(spacing: 8) {", "-        Button(\"Delete\") { remove(version) }", "+        SettingsDeleteButton { remove(version) }", "             .disabled(version.inUse)", "     }"]),
            ])]], open: ["packages/mac-app/Sources/AgentSwitchMac/Agents/AgentsView.swift"])
        }
    }

    /// Terminal `t1` as its record, with a made-up session.
    private static func stageRecord(_ model: TerminalsModel, working: Bool) {
        model.setSimple(true, pane: TerminalPanes.paneShowing(model.layout, "t1")?.id)
        guard let pane = model.panes.values.first(where: { $0.session?.id == "t1" }), let info = pane.session?.info else { return }
        let ago = { (seconds: Int64) in Int64(Date().timeIntervalSince1970 * 1000) - seconds * 1000 }
        // The pictures sent with the first message, and the reply being written with a file and a picture of its own.
        let source = RecordSource(harness: info.harness, session: info.agentSessionId ?? "preview", client: { DaemonClient(port: 1) })
        RecordPictureStore.shared.stage(source.key("100", 0), picture(wide: true))
        RecordPictureStore.shared.stage(source.key("100", 1), picture(wide: false))
        pane.record.stageDraft("对照 [Image #1] 看，日志在 [File #2] ", files: [("截屏 2026-10-07 14.02.11.png", picture(wide: true)), ("daemon.log", nil)])
        PaneRecord.previewOpenStep = "200/2"
        RecordStepStore.shared.stage("\(source.key("200", 2))/\(printed.count)", RecordStepDetail(text: command, note: "Run the Agents tests and keep the last lines", out: printed))
        pane.record.stage(terminal: info, items: [
            RecordItem(id: "100", kind: .user, at: ago(900), text: "我选了这个 codex 的版本，怎么好像没生效", images: 2),
            // What it thought on the way, a command with what it said it is for, and that command opened: whole, in colour.
            RecordItem(id: "150", kind: .answer, at: ago(895), text: "选的版本存下来了，但服务只在启动时读它。先看页面上哪里提示了要重启。", thinking: true),
            RecordItem(id: "200", kind: .work, at: ago(890), seconds: 72, steps: [
                RecordStep(kind: .read, text: "packages/mac-app/Sources/AgentSwitchMac/Agents/AgentsView.swift"),
                RecordStep(kind: .search, text: "pendingRestart"),
                RecordStep(kind: .run, text: command.replacingOccurrences(of: "\n", with: " ⏎ "), note: "Run the Agents tests and keep the last lines", out: printed),
                RecordStep(kind: .edit, text: "packages/mac-app/Sources/AgentSwitchMac/Agents/AgentsView.swift", added: 12, removed: 1),
                RecordStep(kind: .edit, text: "docs/agents-v0.md", added: 2, removed: 1),
            ]),
            RecordItem(id: "300", kind: .answer, at: ago(815), text: "生效了，只是还没有用上：\n\n- 测试版已装好，`codex-beta` 在命令行里可用。\n- 页面顶部有 `Restart Service…`，但你是在下面那一组里选的，看不到它。\n\n已在 Codex 自己那一组的末尾加上同一条提示，写明服务现在用哪个、重启后改用哪个，见 [docs/agents-v0.md](docs/agents-v0.md) §8。"),
            RecordItem(id: "400", kind: .user, at: ago(300), text: "delete 应该标红才对"),
            RecordItem(id: "500", kind: .work, at: ago(290), seconds: 38, steps: [
                RecordStep(kind: .search, text: "SettingsDeleteButton"),
                RecordStep(kind: .edit, text: "packages/mac-app/Sources/AgentSwitchMac/Agents/AgentsView.swift", added: 3, removed: 3),
            ]),
            RecordItem(id: "550", kind: .answer, at: ago(250), text: "改好了：换成应用里已有的红字删除按钮，禁用时变淡。正在重新构建。"),
        ], plan: [PlanEntry(text: "找出所有用到删除按钮的地方", state: .done), PlanEntry(text: "删除按钮标红", state: .done), PlanEntry(text: "重新构建", state: .doing), PlanEntry(text: "跑测试", state: .todo)],
        usage: RecordUsage(model: "claude-opus-5-5", used: 124_000, window: 200_000, effort: "medium"), mode: "acceptEdits",
        activity: working ? TerminalActivity(tool: "Bash", target: "swift build -c release", note: "Build the release app") : nil, since: working ? Date().addingTimeInterval(-41) : nil)
    }

    private static let command = "cd packages/mac-app && swift test --filter AgentsTests 2>&1 \\\n  | grep -E \"error:|Executed [0-9]+ tests\" | tail -2   # the totals\ngit status --short"
    private static let printed = "\t Executed 41 tests, with 0 failures (0 unexpected) in 0.412 (0.418) seconds\n M packages/mac-app/Sources/AgentSwitchMac/Agents/AgentsView.swift"

    /// A made-up screenshot: a window with a list and a few lines.
    private static func picture(wide: Bool) -> NSImage {
        let size = wide ? NSSize(width: 480, height: 300) : NSSize(width: 220, height: 440)
        return NSImage(size: size, flipped: true) { rect in
            NSColor(srgbRed: 0.93, green: 0.92, blue: 0.89, alpha: 1).setFill()
            rect.fill()
            NSColor(srgbRed: 0.84, green: 0.82, blue: 0.78, alpha: 1).setFill()
            NSRect(x: 0, y: 0, width: wide ? 130 : rect.width, height: wide ? rect.height : 54).fill()
            NSColor(srgbRed: 0.12, green: 0.11, blue: 0.10, alpha: 1).setFill()
            for row in 0..<(wide ? 7 : 11) {
                NSRect(x: wide ? 150 : 18, y: CGFloat(wide ? 30 : 80) + CGFloat(row) * 32, width: CGFloat(wide ? 260 : 150) - CGFloat((row * 37) % 90), height: 9).fill()
            }
            NSColor(srgbRed: 0.85, green: 0.33, blue: 0.16, alpha: 1).setFill()
            NSRect(x: wide ? 150 : 18, y: wide ? 250 : 396, width: 86, height: 22).fill()
            return true
        }
    }

    private static func shot(to file: URL, light: Bool = false, stage: (TerminalsModel) -> Void) async throws {
        let model = TerminalsModel(client: { DaemonClient(port: 1) }, defaults: nil)
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        func session(_ id: String, _ cwd: String, _ title: String, _ harness: String = "claude-code", ago hours: Int64, active: Bool = false) -> SessionSummary {
            SessionSummary(harness: harness, id: id, cwd: cwd, title: title, updatedAt: now - hours * 3_600_000, startedAt: now - hours * 3_600_000 - 1000, active: active)
        }
        let terminals = [
            TerminalInfo(id: "t1", harness: "claude-code", cwd: project, model: "claude-opus-5-5", mode: "auto", name: "修登录页的跳转", status: "working", cols: 104, rows: 33, createdAt: 10,
                         subagents: [TerminalSubagent(id: "a1", type: "Explore", name: "找登录入口", doing: "读 login.js"), TerminalSubagent(id: "a2", type: "general-purpose", name: "跑测试")]),
            TerminalInfo(id: "t2", harness: "codex", cwd: "\(project)/packages/secret-gate", model: "gpt-5.5", mode: "manual", name: "网关的引用过期", status: "waiting", cols: 80, rows: 24, createdAt: 20,
                         permissions: [TerminalRequest(id: "r1", tool: "Bash", summary: "Bash: npm test")]),
            TerminalInfo(id: "t3", harness: "opencode", cwd: "\(home)/Desktop/WorkSpace/Projects/MailLab", name: "解析退信", status: "idle", createdAt: 30),
            TerminalInfo(id: "t4", harness: "claude-code", cwd: "\(home)/Desktop/WorkSpace/Projects/MailLab", name: "旧的导出", status: "exited", createdAt: 5, exitCode: 1),
        ]
        let sessions = [
            session("s1", project, "完成未完成的部分 gate-next", ago: 0, active: true), session("s2", project, "简单看一下项目内容", "codex", ago: 13),
            session("s3", project, "discovery.ts 职责一句话", "opencode", ago: 300), session("s4", project, "登录超时排查", ago: 400), session("s5", project, "给健康检查加缓存", ago: 500),
            session("s6", "\(project)/packages/secret-gate", "Retrieving 6-digit one-time codes", "opencode", ago: 380),
            session("s7", "\(home)/Desktop/WorkSpace/Projects/MailLab", "注意到项目中有一个打开的登录表单", ago: 150),
            session("s8", "\(home)/Desktop/WorkSpace/Worktop", "我要学习计算机基础知识", ago: 1),
            // One Codex session id with three records (the service lists each): three rows.
            session("c1", "\(home)/Desktop/WorkSpace/Worktop", "企业申请需要先获得什么", "codex", ago: 500),
            session("c1", "\(home)/Desktop/WorkSpace/Worktop", "监控核心温度的软件叫什么", "codex", ago: 570),
            session("c1", "\(home)/Desktop/WorkSpace/Worktop", "威胁情报报告里的要点", "codex", ago: 580),
        ]
        let gits = [project: FolderGit(branch: "main", changed: 42, ahead: 2), "\(project)/packages/secret-gate": FolderGit(branch: "main", changed: 5),
                    "\(home)/Desktop/WorkSpace/Projects/MailLab": FolderGit(branch: "main")]
        let five = ["low", "medium", "high", "xhigh", "max"]
        let models = ["claude-code": [TerminalModelOption(id: "opus", name: "Opus 5.5", efforts: five), TerminalModelOption(id: "sonnet", name: "Sonnet 5.5", efforts: five),
                                      TerminalModelOption(id: "opus-4", name: "Opus 4.5", older: true, efforts: ["low", "medium", "high", "max"])]]
        model.stage(terminals: terminals, sessions: sessions, gits: gits, agents: ["claude-code", "codex", "opencode"], models: models, efforts: ["claude-code": five])
        model.area = CGSize(width: size.width - 291, height: size.height)
        let host = NSHostingView(rootView: TerminalsPageView(model: model))
        host.sizingOptions = []
        let window = PreviewWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
        // As the window is dressed: dark, or (a record in the pane in focus) the system's — here the light one.
        window.appearance = NSAppearance(named: light ? .aqua : .darkAqua)
        window.backgroundColor = light ? .dispatchGround : .black
        window.isReleasedWhenClosed = false
        window.contentView = host
        try await DesignPreview.settle()
        model.select("t1")
        stage(model)
        try await DesignPreview.settle()
        // An agent's lines, where a stream would bring them.
        for pane in model.panes.values where pane.session != nil {
            pane.screen.view.feed(text: "\u{1b}[35m✻\u{1b}[0m Welcome back\r\n  \u{1b}[2m\(DisplayPath.short(pane.session?.info?.cwd ?? "", home: home))\u{1b}[0m\r\n\r\n\u{1b}[2m❯\u{1b}[0m 登录后跳回原来的页面，别总回首页\r\n\r\n⏺ 我先看一下登录页现在怎么处理 next 参数。\r\n  \u{1b}[2m⎿ Read packages/daemon/ui/login.js (64 lines)\u{1b}[0m\r\n")
        }
        try await DesignPreview.settle()
        try DesignPreview.write(host, to: file)
        model.stop()
        window.close()
    }
}
#endif

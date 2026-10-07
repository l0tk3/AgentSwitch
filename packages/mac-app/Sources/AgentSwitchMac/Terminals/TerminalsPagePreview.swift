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
/// - `terminals-closed`: the list put away.
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
    }

    private static func shot(to file: URL, stage: (TerminalsModel) -> Void) async throws {
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
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = .black
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

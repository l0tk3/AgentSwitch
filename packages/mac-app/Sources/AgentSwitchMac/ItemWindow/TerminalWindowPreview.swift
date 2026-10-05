#if DEBUG
import AgentSwitchMacCore
import AppKit
import SwiftUI

/// A terminal's own window for `-designPreview <dir> -designPreviewOnly item` (debug builds only): the window as it is
/// built, drawn off screen from made-up work — no service, no stream; lines of text stand in for the terminal's screen.
/// In the look in force (`-appearance pixel|classic`), it writes:
/// - `item-plain`: the terminal at work — the title, the screen, the status line;
/// - `item-approval`: a request to edit a file (`Deny ⌘⌫` / `Allow ⌘↩`), and a second one under it without the keys;
/// - `item-question`: the agent's question with the card's keyboard — one answer picked, the next question in focus;
/// - `item-seal`: Encrypt & Send open over the screen's foot;
/// - `item-away`: the terminal in use on the phone;
/// - `item-notice`: a refusal in a sentence; the terminal has ended (the lock dimmed).
@MainActor
enum TerminalWindowPreview {
    static let size = NSSize(width: 900, height: 600)

    static func render(into directory: URL) async throws {
        func file(_ name: String) -> URL { directory.appendingPathComponent("\(name).png") }
        let git = FolderGit(branch: "main", changed: 31, ahead: 2)
        try await shot(to: file("item-plain")) { $0.stage(grid: [104, 33], git: git) }
        try await shot(status: "waiting", to: file("item-approval")) {
            $0.stage(requests: [
                TerminalRequest(id: "r1", tool: "Edit", summary: "Edit: \(Self.folder)/packages/daemon/ui/login.js"),
                TerminalRequest(id: "r2", tool: "Bash", summary: "Bash: npm test -- --run tests/login.test.ts"),
            ], grid: [104, 33], git: git)
        }
        let ask = TerminalRequest(id: "q1", tool: "AskUserQuestion", summary: "", questions: [
            .init(question: "跳转目标不是同源地址时怎么办？", header: "Redirect", options: [
                .init(label: "回首页", description: "丢掉 next，按现在的做法"), .init(label: "报错", description: "显示“地址不被允许”")]),
            .init(question: "哪些页面要一起改？", header: "Pages", multiSelect: true, options: [.init(label: "登录"), .init(label: "注册"), .init(label: "找回密码")]),
        ])
        try await shot(status: "waiting", to: file("item-question")) {
            $0.stage(requests: [ask], grid: [104, 33], git: git, cardHasKeys: true, forms: ["q1": TerminalAnswers(ask.questions).picking(0, "回首页")])
        }
        try await shot(to: file("item-seal")) { $0.stage(grid: [104, 33], composing: true, draft: "测试账号的密码是 hunter2", git: git) }
        try await shot(to: file("item-away")) { $0.stage(away: "iphone", grid: [50, 30], git: git) }
        try await shot(status: "exited", to: file("item-notice")) { $0.stage(grid: [104, 33], git: git, notice: "terminal t1 has ended") }
    }

    private static let folder = "\(NSHomeDirectory())/Desktop/WorkSpace/Projects/AgentSwitch"

    private static func shot(status: String = "working", to file: URL, stage: (TerminalWindowModel) -> Void) async throws {
        let info = TerminalInfo(id: "t1", harness: "claude-code", cwd: folder, model: "claude-opus-5-5", mode: "auto",
                                name: "修登录页的跳转", status: status, cols: 104, rows: 33)
        let model = TerminalWindowModel(id: "t1", client: { DaemonClient(port: 1) }, info: info)
        stage(model)
        let screen = NSHostingView(rootView: ScreenStandIn(ended: status == "exited"))
        let window = TerminalWindowController.makeWindow(model: model, stage: screen, frame: NSRect(origin: .zero, size: size), as: PreviewWindow.self)
        try await DesignPreview.settle()
        try await DesignPreview.settle()
        try DesignPreview.write(window.contentView?.superview ?? window.contentView!, to: file)
        window.close()
    }
}

/// Lines of an agent's screen, where the native terminal would be.
private struct ScreenStandIn: View {
    let ended: Bool

    private static let lines: [(String, Color)] = [
        ("✻ Welcome back", .signal),
        ("  ~/Desktop/WorkSpace/Projects/AgentSwitch", Color(white: 0.45)),
        ("", .clear),
        ("❯ 登录后跳回原来的页面，别总回首页", Color(white: 0.82)),
        ("", .clear),
        ("⏺ 我先看一下登录页现在怎么处理 next 参数。", Color(white: 0.82)),
        ("  ⎿ Read packages/daemon/ui/login.js (64 lines)", Color(white: 0.45)),
        ("⏺ next 只在同源时才接受，其余丢掉。改 login.js：", Color(white: 0.82)),
        ("  ⎿ Edit packages/daemon/ui/login.js", Color(white: 0.45)),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(Array(Self.lines.enumerated()), id: \.offset) { _, line in
                Text(line.0.isEmpty ? " " : line.0).foregroundStyle(line.1)
            }
            if ended { Text(" \n[exited · code 0]").foregroundStyle(Color(white: 0.45)) }
        }
        .font(.system(size: 12.5, design: .monospaced))
        .padding(.leading, ItemTerminalStage.inset.left)
        .padding(.top, ItemTerminalStage.inset.top + 2)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color.black)
    }
}
#endif

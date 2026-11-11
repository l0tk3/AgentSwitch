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
///   `terminals-create-grok`: with Grok picked;
/// - `terminals-sheet-light`, `terminals-create-light`, `terminals-rename-light`: the question box, the new-terminal
///   panel and a name being changed on the light page; `terminals-pane-was`: an empty pane and the long-titled session
///   it would go on with;
/// - `terminals-search`: a search with titles and words that matched;
/// - `terminals-filter`, `terminals-filter-active`, `terminals-filter-none`: the list with one agent's rows alone, with
///   what is active alone, and with a filter that leaves nothing;
/// - `terminals-sheet`: closing a running terminal asked first;
/// - `terminals-rename`: a name being changed; the list's folders folded around the terminal on screen;
/// - `terminals-closed`: the list put away;
/// - `terminals-record`, `terminals-record-light`, `terminals-record-split-light`, `terminals-record-side-light` (its
///   side asked for: context, tasks, the changed files with one open on its diff): the simple view (docs/simple-view-v0.md
///   §5.2) — a terminal's record in its pane, dark and in the system's light with the list following it, and beside a
///   terminal that stays dark, a request's card at the record's end; the pictures sent with a message small under it,
///   a thought of the agent's said quietly, a command with what it is for opened whole and in colour, and a reply
///   being written with a picture and a file in its floating box.
///   `terminals-record-compact-light`: while it compacts its context. `terminals-record-working-light`: at work with
///   no tool, the word alone. `terminals-record-daybreak-light`: Codex with its Daybreak switch.
/// - `terminals-subagent`, `terminals-subagent-tall`, `terminals-subagent-request`, `terminals-subagent-light`,
///   `terminals-subagent-missing-light`: the sub-agent card (docs/simple-view-v0.md §5.22) — over a terminal's screen
///   while the sub-agent works, the run still going with its latest steps; tall, a run opened whole; at the pane's
///   foot while a request's card floats at its top; over a record in the system's light, the sub-agent ended with
///   what it handed back; and with no record to show.
@MainActor
enum TerminalsPagePreview {
    static let size = NSSize(width: 1235, height: 764)
    private static let home = NSHomeDirectory()
    private static let longSession = "s-long"
    private static let longTitle = "把设置页拆成几个小页面，每页只放一类选项；先列出现在所有的选项和它们各自依赖的状态，再给出拆分方案，方案里要写清每一页的入口、返回方式和键盘操作，图标沿用现有的那一套，不要新画"
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
        // The effort slider by itself (docs/terminal-v0.md §1 思考强度): none chosen (the knob resting hollow on the
        // model's default), a low, a high and the highest level, in the dark and in the light.
        try await sliders(to: file("effort-slider"), light: false)
        try await sliders(to: file("effort-slider-light"), light: true)
        // Every level chosen in turn, at the popover's own width: how one level differs from the next.
        try await sliders(to: file("effort-levels"), light: false, each: true)
        try await shot(to: file("terminals-create")) { $0.showCreate(folder: project) }
        // Where the agent has more than the Mac's own sign-in: a `Profile` row, the one last chosen offered (docs/
        // profiles-v0.md §3.3).
        try await shot(to: file("terminals-create-profile")) { model in
            model.showCreate(folder: project)
            model.profiles = ["claude-code": AgentProfiles(current: "abc123def0", profiles: [
                AgentProfile(id: "default", name: "Default", account: "me@example.com"),
                AgentProfile(id: "abc123def0", name: "cwork1", account: "work@example.com", color: "violet"),
                AgentProfile(id: "abc123def1", name: "side", color: "sand")], creatable: true)]
        }
        try await shot(to: file("terminals-create-pane")) { model in
            model.split(.right)
            model.showCreate(folder: project)
            model.createError = "文件夹不存在：~/Desktop/WorkSpace/Projects/Nowhere"
        }
        // A shell (docs/terminal-v0.md §0, 2026-11-10): picked in the panel — a folder is all it has to choose —, in a
        // pane among several (two rows of two and one), and in the list beside the agents' terminals, with a filter of
        // its own.
        try await shot(to: file("terminals-create-shell")) { model in
            model.showCreate(folder: project)
            model.pickedAgent = TerminalKind.shell
        }
        // Grok picked (2026-11-11): its own models and its own levels, under its own word for them.
        try await shot(to: file("terminals-create-grok")) { model in
            model.showCreate(folder: project)
            model.pickedAgent = "grok"
        }
        try await shot(to: file("terminals-create-shell-pane")) { model in
            model.split(.right)
            model.showCreate(folder: project)
            model.pickedAgent = TerminalKind.shell
        }
        for light in [false, true] {
            try await shot(to: file("terminals-shell\(light ? "-light" : "")"), light: light) { model in
                if light { stageRecord(model, working: false) }
                model.take(TerminalList(terminals: model.terminals + [TerminalInfo(id: "t7", harness: TerminalKind.shell, cwd: project, name: "Shell", status: "idle", cols: 104, rows: 33, createdAt: 60),
                                                                 TerminalInfo(id: "t8", harness: TerminalKind.shell, cwd: project, name: "npm run dev", status: "exited", createdAt: 55, exitCode: 0)],
                                        agents: model.agents, models: model.models, efforts: model.efforts, shell: true))
                model.select("t7")
            }
        }
        try await shot(to: file("terminals-search")) { $0.query = "登录" }
        try await shot(to: file("terminals-filter")) { $0.filter = TerminalListFilter(agent: "claude-code") }
        try await shot(to: file("terminals-filter-active")) { $0.filter = TerminalListFilter(active: true) }
        try await shot(to: file("terminals-filter-recent")) { $0.filter = TerminalListFilter(recent: true) }
        try await shot(to: file("terminals-filter-none")) { $0.filter = TerminalListFilter(agent: "pi", active: true) }
        try await shot(to: file("terminals-sheet")) { model in
            Task { _ = await model.ask(TerminalSheet(title: "关闭「修登录页的跳转」？", body: "将结束 Claude Code 进程。会话记录保留，可稍后继续。", confirm: "Close", destructive: true, check: "同时删除会话记录（无法恢复）")) }
        }
        // A page that is light (a record in the pane in focus): the question box, the new-terminal panel with a folder
        // typed and a name being changed are on the light page's own ground, in its own ink (2026-10-13: they were
        // drawn for a page that was always dark).
        try await shot(to: file("terminals-sheet-light"), light: true) { model in
            stageRecord(model, working: false)
            Task { _ = await model.ask(TerminalSheet(title: "关闭「修登录页的跳转」？", body: "将结束 Claude Code 进程。会话记录保留，可稍后继续。", confirm: "Close", destructive: true, check: "同时删除会话记录（无法恢复）")) }
        }
        try await shot(to: file("terminals-create-light"), light: true) { model in
            stageRecord(model, working: false)
            model.showCreate(folder: project)
        }
        try await shot(to: file("terminals-rename-light"), light: true) { model in
            stageRecord(model, working: false)
            model.startRename("t1")
        }
        // An empty pane that remembers a session whose title is long: its button names it in a few words.
        try await shot(to: file("terminals-pane-was"), long: true) { model in
            let was = PaneSession(harness: "claude-code", session: longSession, title: longTitle)
            model.setLayout(.split(id: 3, dir: .row, ratio: 0.5, a: .pane(TerminalPane(id: 1, term: "t1")), b: .pane(TerminalPane(id: 2, term: nil, was: was))))
            model.syncPanes()
        }
        // The same in a pane as narrow as a pane gets: named in fewer words still.
        try await shot(to: file("terminals-pane-was-narrow"), long: true) { model in
            let was = PaneSession(harness: "claude-code", session: longSession, title: longTitle)
            model.setLayout(.split(id: 3, dir: .row, ratio: 0.68, a: .pane(TerminalPane(id: 1, term: "t1")), b: .pane(TerminalPane(id: 2, term: nil, was: was))))
            model.syncPanes()
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
        // The reply box offering what is typed for (docs/simple-view-v0.md §5.5): commands after a `/`, files after an `@`.
        try await shot(to: file("terminals-record-hints-light"), light: true) { model in
            stageRecord(model, working: false)
            PaneRecord.previewOpenStep = nil
            let range = NSRange(location: 0, length: 3)
            model.focused?.record.stageDraft("/co", files: [])
            model.focused?.record.stageHints([
                ReplyHintRow(kind: .command, title: "compact", detail: "Free up context by summarizing the conversation so far", range: range, typed: "/compact "),
                ReplyHintRow(kind: .command, title: "config", detail: "Open settings", range: range, typed: "/config "),
                ReplyHintRow(kind: .command, title: "context", detail: "Visualize current context usage as a colored grid", range: range, typed: "/context "),
                ReplyHintRow(kind: .command, title: "copy", detail: "Copy Claude's last response to clipboard", range: range, typed: "/copy "),
                ReplyHintRow(kind: .command, title: "code-review", detail: "Review the current diff or a PR for bugs and cleanups", tag: "project", range: range, typed: "/code-review "),
            ], pick: 1)
        }
        try await shot(to: file("terminals-record-files-light"), light: true) { model in
            stageRecord(model, working: false)
            PaneRecord.previewOpenStep = nil
            let range = NSRange(location: 4, length: 5)
            model.focused?.record.stageDraft("看一下 @host", files: [])
            model.focused?.record.stageHints([
                ReplyHintRow(kind: .file, title: "host.ts", detail: "packages/daemon/src/terminals", range: range, typed: "@packages/daemon/src/terminals/host.ts "),
                ReplyHintRow(kind: .file, title: "hostKeys.test.ts", detail: "packages/daemon/tests", range: range, typed: "@packages/daemon/tests/hostKeys.test.ts "),
                ReplyHintRow(kind: .file, title: "PaneStageHost.swift", detail: "packages/mac-app/Sources/AgentSwitchMac/Terminals", range: range, typed: "@packages/mac-app/Sources/AgentSwitchMac/Terminals/PaneStageHost.swift "),
            ])
        }
        // The conversation's text set larger and smaller in 设置 › General: messages, steps, code and the reply box
        // follow; the list beside them does not. The preview's own setting, put back after.
        TextScale.shared.set(3)
        try await shot(to: file("terminals-record-larger-light"), light: true) { model in stageRecord(model, working: true) }
        TextScale.shared.set(-2)
        try await shot(to: file("terminals-record-smaller-light"), light: true) { model in stageRecord(model, working: true) }
        TextScale.shared.set(0)
        // An agent whose model and level a screen cannot set (Codex chooses in a picker of its own): plain words under
        // the reply box, nothing to press.
        try await shot(to: file("terminals-record-codex-light"), light: true) { model in
            model.select("t2")
            stageRecord(model, working: false, terminal: "t2")
            PaneRecord.previewOpenStep = nil
            model.focused?.record.stageDraft("", files: [])
        }
        // What Claude Code offers as the next message, in the empty box.
        try await shot(to: file("terminals-record-suggestion-light"), light: true) { model in
            stageRecord(model, working: false)
            PaneRecord.previewOpenStep = nil
            model.focused?.record.stageDraft("", files: [])
            model.focused?.record.stageSuggestion("跑一遍测试确认")
        }
        // At work with no tool in use: the word alone, no picture before it.
        try await shot(to: file("terminals-record-working-light"), light: true) { model in
            stageRecord(model, working: true, bare: true)
            PaneRecord.previewOpenStep = nil
            model.focused?.record.stageDraft("", files: [])
        }
        // Codex with its Daybreak switch on (docs/simple-view-v0.md §5.8); and on a model Codex lists without a Daybreak
        // program, which its next turn would be refused on.
        try await shot(to: file("terminals-record-daybreak-light"), light: true) { model in
            model.select("t5")
            stageRecord(model, working: false, terminal: "t5", on: "gpt-6-sol")
            PaneRecord.previewOpenStep = nil
            model.focused?.record.stageDraft("", files: [])
        }
        try await shot(to: file("terminals-record-daybreak-clash-light"), light: true) { model in
            model.select("t5")
            stageRecord(model, working: false, terminal: "t5", on: "gpt-6.1-sol")
            PaneRecord.previewOpenStep = nil
            model.focused?.record.stageDraft("", files: [])
        }
        // It compacts its context (docs/simple-view-v0.md §5.7): at work on that, the earlier one a line in the record.
        try await shot(to: file("terminals-record-compact-light"), light: true) { model in
            stageRecord(model, working: true, compacting: true)
            PaneRecord.previewOpenStep = nil
            model.focused?.record.stageDraft("", files: [])
        }
        try await shot(to: file("terminals-record-shell-light"), light: true) { model in
            stageRecord(model, working: false)
            PaneRecord.previewOpenStep = nil
            model.focused?.record.stageDraft("!git status", files: [])
            model.focused?.record.stageHints([], mark: ReplyHints.Mark(sign: "!", word: "Shell", says: "这一行作为命令在它的 shell 里运行，输出进入对话。"))
        }
        // The sub-agent card (docs/simple-view-v0.md §5.22): a small view by the pane's edge with what one of the
        // session's sub-agents is doing — over the terminal's screen while it works, tall with a run opened whole, at
        // the foot while a request's card floats at the top, over a record with the sub-agent ended, and with nothing
        // to show.
        try await shot(to: file("terminals-subagent")) { model in stageSubagent(model, done: false) }
        try await shot(to: file("terminals-subagent-tall")) { model in stageSubagent(model, done: false, tall: true, open: "200") }
        try await shot(to: file("terminals-subagent-request")) { model in
            stageSubagent(model, done: false)
            model.focused?.session?.received(event: "permission", data: #"{"request":{"id":"r1","tool":"Bash","summary":"Bash: npm test -- --run tests/login.test.ts"}}"#)
        }
        try await shot(to: file("terminals-subagent-light"), light: true) { model in
            stageRecord(model, working: true)
            PaneRecord.previewOpenStep = nil
            model.focused?.record.stageDraft("", files: [])
            stageSubagent(model, done: true)
        }
        try await shot(to: file("terminals-subagent-missing-light"), light: true) { model in
            stageRecord(model, working: false)
            PaneRecord.previewOpenStep = nil
            model.focused?.record.stageDraft("", files: [])
            stageSubagent(model, done: false, problem: SubagentDisplay.unsupported)
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
    static func stageRecord(_ model: TerminalsModel, working: Bool, terminal: String = "t1", compacting: Bool = false, bare: Bool = false, on usageModel: String? = nil) {
        model.setSimple(true, pane: TerminalPanes.paneShowing(model.layout, terminal)?.id)
        guard let pane = model.panes.values.first(where: { $0.session?.id == terminal }), let info = pane.session?.info else { return }
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
            RecordItem(id: "300", kind: .answer, at: ago(815), text: "生效了，只是还没有用上：\n\n- 测试版已装好，`codex-beta` 在命令行里可用。\n- 页面顶部有 `Restart Service…`，但你是在下面那一组里选的，看不到它。\n\n已在 Codex 自己那一组的末尾加上同一条提示，写明服务现在用哪个、重启后改用哪个，见 [docs/agents-v0.md](docs/agents-v0.md) §8。",
                       // The files it points at (docs/simple-view-v0.md §5.16): each a chip under its words.
                       files: [RecordFile(path: "/Users/you/code/site/out/agents-versions.xlsx", kind: "workbook"), RecordFile(path: "/Users/you/code/site/docs/agents-v0.md")]),
        ] + (compacting ? [RecordItem(id: "350", kind: .note, at: ago(600), text: "Compacted · 899k → 15k")] : []) + [
            RecordItem(id: "400", kind: .user, at: ago(300), text: "delete 应该标红才对"),
            RecordItem(id: "500", kind: .work, at: ago(290), seconds: 38, steps: [
                RecordStep(kind: .search, text: "SettingsDeleteButton"),
                RecordStep(kind: .edit, text: "packages/mac-app/Sources/AgentSwitchMac/Agents/AgentsView.swift", added: 3, removed: 3),
            ]),
            RecordItem(id: "550", kind: .answer, at: ago(250), text: "改好了：换成应用里已有的红字删除按钮，禁用时变淡。正在重新构建。"),
        ], plan: [PlanEntry(text: "找出所有用到删除按钮的地方", state: .done), PlanEntry(text: "删除按钮标红", state: .done), PlanEntry(text: "重新构建", state: .doing), PlanEntry(text: "跑测试", state: .todo)],
        usage: RecordUsage(model: usageModel ?? "claude-opus-5-5", used: 124_000, window: 200_000, effort: usageModel == nil ? "medium" : "high"), mode: usageModel == nil ? "acceptEdits" : nil,
        activity: compacting ? TerminalActivity(tool: "Compact", target: "") : working && !bare ? TerminalActivity(tool: "Bash", target: "swift build -c release", note: "Build the release app") : nil,
        since: working ? Date().addingTimeInterval(compacting ? -65 : -41) : nil,
        // Thinking, with no tool to name: the count on its own screen, and a message sent a moment ago that it has
        // not taken yet.
        progress: working && bare ? TurnProgress(tokens: 3300) : nil,
        sent: working && bare ? [SentReply(id: "s1", text: "顺便把测试也跑一遍", at: Int64(Date().timeIntervalSince1970 * 1000))] : [])
    }

    /// Terminal `t1`'s sub-agent `a1` in its card, with a made-up record: at work on its second run (`done` false), or
    /// ended with what it handed back. `open`: a run of work opened whole; `problem`: no record, and why.
    static func stageSubagent(_ model: TerminalsModel, done: Bool, tall: Bool = false, open: String? = nil, problem: String? = nil) {
        guard let pane = model.panes.values.first(where: { $0.session?.id == "t1" }) else { return }
        let ago = { (seconds: Int64) in Int64(Date().timeIntervalSince1970 * 1000) - seconds * 1000 }
        pane.toggleSubagent(SubagentTarget(harness: "claude-code", session: "preview", agent: "a1"), name: "找登录入口", type: "Explore")
        guard let card = pane.subagent else { return }
        card.tall = tall
        if let problem { return card.stage(problem: problem) }
        let items = [
            RecordItem(id: "0", kind: .user, at: ago(131), text: "找出登录后的跳转是在哪里决定的：先看 `packages/daemon/ui/login.js` 怎么读 `next` 参数，再看服务端有没有校验它。只读，不要改文件；最后给出文件和行号。"),
            RecordItem(id: "100", kind: .answer, at: ago(128), text: "先看登录页的脚本，再找服务端对 `next` 的处理。"),
            RecordItem(id: "200", kind: .work, at: ago(126), seconds: 64, steps: [
                RecordStep(kind: .read, text: "packages/daemon/ui/login.js"),
                RecordStep(kind: .search, text: "next="),
                RecordStep(kind: .read, text: "packages/daemon/src/api/ui.ts"),
                RecordStep(kind: .run, text: "git log --oneline -5 -- packages/daemon/ui/login.js", note: "See when the redirect was last touched", out: "a41c9e2 login: keep the query on the way back"),
            ]),
            RecordItem(id: "300", kind: .answer, at: ago(60), text: "`login.js` 第 41 行直接用查询里的 `next`，没有检查是不是站内地址。再确认服务端这一侧。"),
            RecordItem(id: "400", kind: .work, at: ago(58), seconds: done ? 52 : 56, steps: [
                RecordStep(kind: .search, text: "redirect("),
                RecordStep(kind: .read, text: "packages/daemon/src/api/localAuth.ts"),
                RecordStep(kind: .read, text: "packages/daemon/src/api/app.ts"),
                RecordStep(kind: .run, text: "rg -n \"next\" packages/daemon/src/api", note: "Every place the server reads next", out: "packages/daemon/src/api/ui.ts:31:  const next = c.req.query(\"next\") ?? \"/ui/\";"),
                RecordStep(kind: .read, text: "packages/daemon/tests/localAuth.test.ts"),
                RecordStep(kind: .agent, text: "核对测试覆盖", agent: "a9"),
            ]),
        ] + (done ? [RecordItem(id: "500", kind: .answer, at: ago(6), text: "**跳转在两处决定**\n\n- `packages/daemon/ui/login.js:41`：登录成功后直接跳到查询里的 `next`，没有检查是不是站内地址。\n- `packages/daemon/src/api/ui.ts:31`：服务端读同一个参数，缺省是 `/ui/`，同样没有校验。\n\n现有测试只覆盖缺省值（`tests/localAuth.test.ts`）。")] : [])
        card.stage(agent: SubagentSummary(id: "a1", type: "Explore", name: "找登录入口", startedAt: ago(131), updatedAt: ago(done ? 6 : 2), done: done), items: items,
                   usage: RecordUsage(model: "claude-haiku-5-5", used: 52_000),
                   // The session's sub-agents in the order they began: one that ended earlier, this one, one more at work.
                   others: [SubagentSummary(id: "a0", type: "Explore", name: "读设计稿", startedAt: ago(900), updatedAt: ago(700), done: true),
                            SubagentSummary(id: "a1", type: "Explore", name: "找登录入口", startedAt: ago(131), updatedAt: ago(2), done: done),
                            SubagentSummary(id: "a2", type: "general-purpose", name: "跑测试", startedAt: ago(120), updatedAt: ago(3))],
                   folds: open.map { [$0: true] } ?? [:])
    }

    private static let command = "cd packages/mac-app && swift test --filter AgentsTests 2>&1 \\\n  | grep -E \"error:|Executed [0-9]+ tests\" | tail -2   # the totals\ngit status --short"
    private static let printed = "\t Executed 41 tests, with 0 failures (0 unexpected) in 0.412 (0.418) seconds\n M packages/mac-app/Sources/AgentSwitchMac/Agents/AgentsView.swift"

    private static func sliders(to file: URL, light: Bool, each: Bool = false) async throws {
        let levels = ["low", "medium", "high", "xhigh", "max"]
        let view = VStack(alignment: .leading, spacing: 22) {
          if each {
            ForEach(levels, id: \.self) { level in EffortPicker(word: "Effort", levels: levels, level: level, choose: { _ in }) }
          } else {
            EffortPicker(word: "Effort", levels: levels, level: nil, fallback: "medium", choose: { _ in }, reset: {})
            EffortPicker(word: "Effort", levels: levels, level: "low", fallback: "medium", choose: { _ in }, reset: {})
            EffortPicker(word: "Effort", levels: levels, level: "xhigh", note: "会记成这个模型的默认；Max 只用于这一次。", choose: { _ in })
            EffortPicker(word: "Effort", levels: levels, level: "max", choose: { _ in })
            EffortPicker(word: "Reasoning", levels: ["minimal", "low", "medium", "high", "xhigh", "ultra"], level: "high", enabled: false, note: "它正在等待回答，回答后再调整。", choose: { _ in })
          }
        }
        .frame(width: each ? 150 : 300)
        .padding(18)
        .background(Look.panel)
        .environment(\.interfaceLook, InterfaceLook.current)
        let host = NSHostingView(rootView: view)
        let size = host.fittingSize
        host.frame = NSRect(origin: .zero, size: size)
        let window = PreviewWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
        window.appearance = NSAppearance(named: light ? .aqua : .darkAqua)
        window.isReleasedWhenClosed = false
        window.contentView = host
        try await DesignPreview.settle()
        try DesignPreview.write(host, to: file)
        window.close()
    }

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

    /// The page's model with the made-up work staged (the Files preview uses it too).
    static func demoModel(long: Bool = false) -> TerminalsModel {
        let model = TerminalsModel(client: { DaemonClient(port: 1) }, defaults: nil)
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        func session(_ id: String, _ cwd: String, _ title: String, _ harness: String = "claude-code", ago hours: Int64, active: Bool = false) -> SessionSummary {
            SessionSummary(harness: harness, id: id, cwd: cwd, title: title, updatedAt: now - hours * 3_600_000, startedAt: now - hours * 3_600_000 - 1000, active: active)
        }
        let terminals = [
            TerminalInfo(id: "t1", harness: "claude-code", cwd: project, model: "claude-opus-5-5", mode: "auto", name: "修登录页的跳转", status: "working", cols: 104, rows: 33, createdAt: 10,
                         subagents: [TerminalSubagent(id: "a1", type: "Explore", name: "找登录入口", doing: "读 login.js"), TerminalSubagent(id: "a2", type: "general-purpose", name: "跑测试")])
                // Under a profile with a proxy of its own (docs/profiles-v0.md §3.2): its lit dot while it runs.
                .under(profile: "cwork1 · Tokyo 203.0.113.9", color: .violet),
            TerminalInfo(id: "t2", harness: "codex", cwd: "\(project)/packages/secret-gate", model: "gpt-5.5", mode: "manual", name: "网关的引用过期", status: "waiting", cols: 80, rows: 24, createdAt: 20,
                         permissions: [TerminalRequest(id: "r1", tool: "Bash", summary: "Bash: npm test")]),
            TerminalInfo(id: "t3", harness: "opencode", cwd: "\(home)/Desktop/WorkSpace/Projects/MailLab", name: "解析退信", status: "idle", createdAt: 30),
            // One that ended keeps no dot: the dot says what runs under the profile now.
            TerminalInfo(id: "t4", harness: "claude-code", cwd: "\(home)/Desktop/WorkSpace/Projects/MailLab", name: "旧的导出", status: "exited", createdAt: 5, exitCode: 1).under(profile: "side", color: .sand),
            TerminalInfo(id: "t5", harness: "codex", cwd: project, model: "gpt-6-sol", mode: "manual", name: "查一处越界读", status: "idle", createdAt: 40, effort: "high", sets: true, daybreak: true),
            TerminalInfo(id: "t6", harness: "claude-code", cwd: project, model: "claude-opus-5-5", mode: "auto", name: "看一遍改动", status: "idle", createdAt: 50).under(profile: "side", color: .sand),
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
        ] + (long ? [session(longSession, project, longTitle, ago: 2)] : [])
        let gits = [project: FolderGit(branch: "main", changed: 42, ahead: 2), "\(project)/packages/secret-gate": FolderGit(branch: "main", changed: 5),
                    "\(home)/Desktop/WorkSpace/Projects/MailLab": FolderGit(branch: "main")]
        let five = ["low", "medium", "high", "xhigh", "max"]
        let grok = ["low", "medium", "high", "xhigh"]
        let models = ["claude-code": [TerminalModelOption(id: "opus", name: "Opus 5.5", efforts: five), TerminalModelOption(id: "sonnet", name: "Sonnet 5.5", efforts: five),
                                      TerminalModelOption(id: "opus-4", name: "Opus 4.5", older: true, efforts: ["low", "medium", "high", "max"])],
                      // Codex's, each with its place under Daybreak (docs/simple-view-v0.md §5.8).
                      "codex": [TerminalModelOption(id: "gpt-6.1-sol", name: "GPT-6.1-Sol", efforts: five, daybreak: "never"), TerminalModelOption(id: "gpt-6-sol", name: "GPT-6-Sol", efforts: five, daybreak: "also"),
                                TerminalModelOption(id: "gpt-6-luna", name: "GPT-6-Luna", efforts: five, daybreak: "also"), TerminalModelOption(id: "gpt-daybreak-blue-latest", name: "Daybreak Blue", efforts: five, daybreak: "only")],
                      // Grok's, as it lists them (the older ones folded away, as the others').
                      "grok": [TerminalModelOption(id: "grok-4.7", name: "Grok 4.7", efforts: grok), TerminalModelOption(id: "grok-4.7-build-fast", name: "Grok 4.7 Fast", efforts: grok),
                               TerminalModelOption(id: "grok-4.6", name: "Grok 4.6", older: true, efforts: grok), TerminalModelOption(id: "grok-4.5", name: "Grok 4.5", older: true, efforts: ["low", "medium", "high"])]]
        // pi is the one that is not installed here: its tile says so.
        model.stage(terminals: terminals, sessions: sessions, gits: gits, agents: ["claude-code", "codex", "opencode", "grok"], models: models, efforts: ["claude-code": five, "grok": grok])
        model.area = CGSize(width: size.width - 291, height: size.height)
        return model
    }

    /// `long`: among the sessions, one whose title is as long as the service gives them (120 characters).
    static func shot(to file: URL, light: Bool = false, long: Bool = false, onScreen: Bool = false, stage: (TerminalsModel) -> Void,
                             then: (@MainActor (TerminalsModel, NSView) async throws -> Void)? = nil) async throws {
        let model = demoModel(long: long)
        let host = NSHostingView(rootView: TerminalsPageView(model: model))
        host.sizingOptions = []
        let window = PreviewWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
        // As the window is dressed: dark, or (a record in the pane in focus) the system's — here the light one.
        window.appearance = NSAppearance(named: light ? .aqua : .darkAqua)
        window.backgroundColor = light ? .dispatchGround : .black
        window.isReleasedWhenClosed = false
        window.contentView = host
        if onScreen { window.setFrameOrigin(NSPoint(x: 40, y: 40)); window.orderBack(nil) }
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
        try await then?(model, host)
        model.stop()
        window.close()
    }
}
#endif

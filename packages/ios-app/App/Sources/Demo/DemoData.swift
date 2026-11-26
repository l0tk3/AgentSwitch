#if DEBUG
import AgentSwitchKit
import Foundation
import UIKit

/// Sample state for looking at the screens without a Mac (`-uiDemo YES`, debug builds only): the Mac's coding
/// sessions and default folder (control-v0), the terminals and what they show, Clash and the proxies.
enum DemoData {
    static let now = Int64(Date().timeIntervalSince1970 * 1000)
    static func ago(_ seconds: Int64) -> Int64 { now - seconds * 1000 }

    private static func decode<T: Decodable>(_ type: T.Type, _ object: Any) -> T {
        try! JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: object))
    }

    // MARK: - control-v0

    static let workdir = WorkdirSetting(path: "/Users/me/AgentSwitch", defaultPath: "/Users/me/AgentSwitch")

    static var sessions: [SessionSummary] {
        let repo = "/Users/me/Projects/AgentSwitch"
        return [
            SessionSummary(harness: "claude-code", id: "c1", cwd: repo, title: "iPhone 端：编码会话列表和未读标记",
                           lastText: "列表按目录分组，进行中的会话 10 秒刷新一次。", updatedAt: ago(20), active: true, branch: "main", model: "claude-opus-5-5"),
            SessionSummary(harness: "codex", id: "x1", cwd: repo, title: "daemon：读取 Codex 的 rollout 文件",
                           lastText: "已读取 session_meta 中的 cwd 和 originator。", updatedAt: ago(1500), origin: "desktop", branch: "main", model: "gpt-6-luna"),
            SessionSummary(harness: "opencode", id: "o1", cwd: "/Users/me/Blog", title: "换主题后的构建报错",
                           lastText: "hexo-renderer-marked 升级到 7.0 后构建成功。", updatedAt: ago(3 * 3600), model: "deepseek/deepseek-flash"),
            SessionSummary(harness: "claude-code", id: "c2", cwd: "/Users/me/Work/api", title: "给健康检查加缓存",
                           lastText: "缓存 30 秒，命中率 92%。", updatedAt: ago(26 * 3600)),
            // Folders inside folders the list shows (docs/terminal-v0.md §1 目录树的层级, 2026-10-03): one in the
            // project, and Sandbox with a session of its own over the folders in it.
            SessionSummary(harness: "claude-code", id: "c3", cwd: repo + "/packages/secret-gate", title: "fill-value 的探针模板",
                           lastText: "探针模板固定在包里。", updatedAt: ago(5 * 3600)),
            SessionSummary(harness: "claude-code", id: "c4", cwd: "/Users/me/Sandbox", title: "整理工作目录",
                           lastText: "做完的项目搬到 Archived。", updatedAt: ago(30 * 3600)),
            SessionSummary(harness: "codex", id: "x2", cwd: "/Users/me/Sandbox/Codex", title: "给脚本加上重试",
                           lastText: "下载失败时指数退避重试三次。", updatedAt: ago(40 * 3600)),
            SessionSummary(harness: "codex", id: "x3", cwd: "/Users/me/Sandbox/练习/小游戏", title: "小游戏的打包脚本",
                           lastText: "打成网页版，本地起服务就能玩。", updatedAt: ago(50 * 3600)),
        ]
    }

    // MARK: - terminal-v0

    /// What `/` offers in the demo terminal.
    static let slashCommands: [SlashCommand] = [
        .init(name: "compact", description: "Clear conversation history but keep a summary in context"),
        .init(name: "config", description: "Open the settings panel"),
        .init(name: "context", description: "Show how the context window is used"),
        .init(name: "cost", description: "Show the cost and duration of this session"),
        .init(name: "clear", description: "Clear conversation history and free up context"),
        .init(name: "commit", description: "Stage and commit the current changes", source: "user"),
    ]

    /// The folders' git, after their names in the tree.
    static let git: [String: GitSummary] = [
        "/Users/me/Projects/AgentSwitch": GitSummary(branch: "main", changed: 5, ahead: 2),
        "/Users/me/Work/api": GitSummary(branch: "feat/health", changed: 3, behind: 4),
    ]

    /// The first terminal's status line said how full its context and the allowances are (docs/simple-view-v0.md §5.25):
    /// the week's near its end.
    private static func meter(_ t: TerminalInfo) -> TerminalInfo {
        guard t.id == "a1b2c3d4", t.harness == "claude-code" else { return t }
        var said = t
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        said.meter = TerminalMeter(context: .init(percent: 28, used: 280_000, window: 1_000_000),
                                   limits: [UsageLimit(label: "5h", percent: 12, resetsAt: now + 7_260_000), UsageLimit(label: "7d", percent: 84, resetsAt: now + 460_800_000)])
        return said
    }

    static var terminalList: TerminalList {
        let repo = "/Users/me/Projects/AgentSwitch"
        let screen = UserDefaults.standard.string(forKey: "uiDemoScreen")
        // `simplebusy`, `simpleprompt`: the simple view while it works, and while it waits on a screen of its own.
        // `simplecompact`: while it compacts its context (docs/simple-view-v0.md §5.7).
        let compact = screen == "simplecompact"
        // `simpledaybreak`: a Codex terminal with its Daybreak switch on (§5.8); `simpledaybreakclash`: on a model that
        // Codex lists without a Daybreak program.
        let clash = screen == "simpledaybreakclash", daybreak = screen == "simpledaybreak" || clash
        let busy = screen == "simplebusy" || compact, prompt = screen == "simpleprompt", idle = daybreak || screen == "simpleidle" || screen == "simpleeffort" || screen == "simplepaste" || screen == "simplestep" || screen == "simplesuggest"
        let five = ["low", "medium", "high", "xhigh", "max"]
        return TerminalList(terminals: ([
            TerminalInfo(id: "a1b2c3d4", harness: daybreak ? "codex" : "claude-code", cwd: repo, model: clash ? "gpt-6.1-sol" : daybreak ? "gpt-6-sol" : "claude-opus-5-5", mode: daybreak ? "manual" : "auto", name: "iPhone 终端标签页",
                         status: busy ? .working : idle ? .idle : .waiting, cols: 52, rows: 30, createdAt: ago(1800), lastOutputAt: ago(20), agentSessionId: "c9",
                         permissions: screen == "terminallink" || busy || prompt || idle ? []
                                      : [screen == "terminalquestion" || screen == "simplequestion" ? question
                                         : TerminalPermission(id: "p1", tool: "Bash", summary: "Bash: swift test --filter TerminalTests")],
                         activity: compact ? TerminalActivity(tool: "Compact", target: "") : busy ? TerminalActivity(tool: "Bash", target: "swift build -c release", note: "Build the release app") : nil,
                         statusSince: busy ? ago(compact ? 65 : 41) : nil,
                         subagents: prompt || idle || compact ? [] : [TerminalSubagent(id: "s1", type: "code-reviewer", name: "审查改动", doing: "运行 git diff"),
                                                   TerminalSubagent(id: "s2", type: "Explore", name: "查终端路由", doing: "读取 src/api/terminals.ts")],
                         suggestion: screen == "simplesuggest" ? "跑一遍测试确认" : nil, daybreak: daybreak ? true : nil, sets: daybreak ? true : nil,
                         // `simplebusy`: the tokens its own screen counts, and a message sent a moment ago that it has not taken yet.
                         progress: screen == "simplebusy" ? TurnProgress(tokens: 3300) : nil,
                         sent: screen == "simplebusy" ? [SentReply(id: "s1", text: "顺便把测试也跑一遍", at: ago(3))] : [],
                         // `terminalprofiles`: under a profile other than the Mac's own (docs/profiles-v0.md §3.2) — its lit dot.
                         profile: screen == "terminalprofiles" ? TerminalProfile(name: "cwork1", color: .violet) : nil),
            TerminalInfo(id: "e5f6a7b8", harness: "codex", cwd: repo, model: "gpt-6-luna", name: "daemon 审计修复", status: .working,
                         createdAt: ago(900), lastOutputAt: ago(2)),
        ] + (screen == "terminalprofiles" ? [
            TerminalInfo(id: "d4e5f6a7", harness: "claude-code", cwd: repo, model: "claude-opus-5-5", name: "看一遍改动", status: .idle,
                         createdAt: ago(600), lastOutputAt: ago(90), profile: TerminalProfile(name: "side", color: .sand)),
        ] : []) + [
            TerminalInfo(id: "c3d4e5f6", harness: "opencode", cwd: "/Users/me/Blog", name: "Blog", status: .idle,
                         createdAt: ago(7200), lastOutputAt: ago(3000)),
        ]).map(meter), agents: ["claude-code", "codex", "opencode"], models: [
            "claude-code": [TerminalModelOption(id: "opus", name: "Opus 5.5", efforts: five), TerminalModelOption(id: "claude-fable-5-1", name: "Fable 5.1", efforts: five),
                            TerminalModelOption(id: "sonnet", name: "Sonnet 5.5", efforts: five), TerminalModelOption(id: "haiku", name: "Haiku 4.5", efforts: []),
                            TerminalModelOption(id: "claude-opus-4-6", name: "Opus 4.6", older: true, efforts: ["low", "medium", "high", "max"])],
            "codex": [TerminalModelOption(id: "gpt-6.1-sol", name: "GPT-6.1-Sol", efforts: five, daybreak: "never"),
                      TerminalModelOption(id: "gpt-6-sol", name: "GPT-6-Sol", efforts: five, daybreak: "also"),
                      TerminalModelOption(id: "gpt-6-luna", name: "GPT-6 Luna", efforts: five, defaultEffort: "medium", daybreak: "also"),
                      TerminalModelOption(id: "gpt-daybreak-blue-latest", name: "Daybreak Blue", efforts: five, daybreak: "only")],
            "opencode": [TerminalModelOption(id: "deepseek/deepseek-flash", name: "DeepSeek Flash", efforts: ["none", "low", "high", "max"])],
        ], defaults: ["claude-code": "Opus 5.5"],
           efforts: ["claude-code": five, "codex": five + ["ultra"], "pi": ["off", "minimal", "low", "medium", "high", "xhigh", "max"]], effortDefaults: ["claude-code": "medium", "codex": "low"])
    }

    /// The agent asking (AskUserQuestion, terminal-v0 §3 "选择题"): `-uiDemoScreen terminalquestion`.
    static let question = TerminalPermission(id: "p2", tool: "AskUserQuestion", summary: "会话存在哪里？ · 慢日志记哪些字段？", questions: [
        TerminalQuestion(question: "会话存在哪里？", header: "Store", options: [.init(label: "Redis", description: "多台实例共享，重启不丢"),
                                                                        .init(label: "内存", description: "最快，但重启后全部失效")]),
        TerminalQuestion(question: "慢日志记哪些字段？", header: "Logs", multiSelect: true,
                         options: [.init(label: "用户 id"), .init(label: "耗时"), .init(label: "请求路径", description: "带查询参数时去掉参数")]),
    ])

    /// A Claude Code screen as a snapshot draws it (escape sequences, CR LF).
    static let terminalScreen: String = {
        let dim = "\u{1b}[2m", off = "\u{1b}[0m", orange = "\u{1b}[38;5;209m", green = "\u{1b}[32m", bold = "\u{1b}[1m", cyan = "\u{1b}[36m"
        let lines = [
            "\(orange)✻\(off) \(bold)Claude Code\(off) \(dim)· Opus 5.5\(off)",
            "\(dim)  ~/Projects/AgentSwitch\(off)",
            "",
            "\(dim)>\(off) 给 iPhone 加终端标签页，列表按目录树排",
            "",
            "\(green)⏺\(off) 先看服务端的终端接口和手机能用的路由。",
            "",
            "\(green)⏺\(off) \(bold)Read\(off)(packages/daemon/src/api/terminals.ts)",
            "  \(dim)⎿  Read 301 lines\(off)",
            "",
            "\(green)⏺\(off) \(bold)Write\(off)(Sources/AgentSwitchKit/API/TerminalRoutes.swift)",
            "  \(dim)⎿  Wrote 132 lines\(off)",
            "",
            "\(green)⏺\(off) 接口和事件流写好了，跑一下测试。",
            "",
            "\(cyan)⏺\(off) \(bold)Bash\(off)(swift test --filter TerminalTests)",
            "  \(dim)⎿  Waiting for permission…\(off)",
        ]
        // `-uiDemoScreen terminallink`: an address the agent cut at its width and a path of the Mac's, to tap and hold
        // (terminal-v0 §1 iPhone 链接).
        let links = [
            "",
            "\(green)⏺\(off) 分屏的说明见这一页，也可以直接打开预览：",
            "  https://code.claude.com/docs/en/agent-teams.md#choo",
            "  se-a-display-mode",
            "  ~/Projects/AgentSwitch/docs/desi",
            "  gn/concepts/split.html",
        ]
        let withLinks = ["terminallink", "terminalpath"].contains(UserDefaults.standard.string(forKey: "uiDemoScreen"))
        return (withLinks ? Array(lines.dropLast(3)) + links : lines).joined(separator: "\r\n")
    }()

    /// A command opened whole: as it was written, and all it printed.
    static let stepDetail = RecordStepDetail(
        text: "cd packages/mac-app && swift test --filter AgentsTests 2>&1 \\\n  | grep -E \"error:|Executed [0-9]+ tests\" | tail -2   # the totals\ngit status --short",
        note: "Run the Agents tests and keep the last lines",
        out: "\t Executed 41 tests, with 0 failures (0 unexpected) in 0.412 (0.418) seconds\n M packages/mac-app/Sources/AgentSwitchMac/Agents/AgentsView.swift")

    /// A clipboard of the check's own with one made-up picture on it: what the reply box's Paste is tried against, so
    /// nothing of the phone's (or, in the simulator, the Mac's) clipboard is read or written.
    static let pasteBoard: UIPasteboard = {
        let board = UIPasteboard.withUniqueName()
        if let data = picture(0), let image = UIImage(data: data) { board.image = image }
        return board
    }()

    /// A made-up screenshot sent with a message: a window with a few lines, wide or tall.
    static func picture(_ n: Int) -> Data? {
        let wide = n % 2 == 0
        let size = wide ? CGSize(width: 480, height: 300) : CGSize(width: 220, height: 440)
        return UIGraphicsImageRenderer(size: size).pngData { context in
            UIColor(red: 0.93, green: 0.92, blue: 0.89, alpha: 1).setFill()
            context.fill(CGRect(origin: .zero, size: size))
            UIColor(red: 0.84, green: 0.82, blue: 0.78, alpha: 1).setFill()
            context.fill(CGRect(x: 0, y: 0, width: wide ? 130 : size.width, height: wide ? size.height : 54))
            UIColor(red: 0.12, green: 0.11, blue: 0.10, alpha: 1).setFill()
            for row in 0..<(wide ? 7 : 11) {
                context.fill(CGRect(x: wide ? 150 : 18, y: CGFloat(wide ? 30 : 80) + CGFloat(row) * 32, width: CGFloat(wide ? 260 : 150) - CGFloat((row * 37) % 90), height: 9))
            }
            UIColor(red: 0.85, green: 0.33, blue: 0.16, alpha: 1).setFill()
            context.fill(CGRect(x: wide ? 150 : 18, y: wide ? 250 : 396, width: 86, height: 22))
        }
    }

    /// A session's record for the simple view (docs/simple-view-v0.md §2): what was said, two runs of work, a message
    /// typed while it worked; its task list and how full its context is.
    static func sessionRecord(harness: String, id: String) -> SessionRecord {
        let summary = decode(SessionSummary.self, ["harness": harness, "id": id, "cwd": "/Users/me/Projects/AgentSwitch", "title": "iPhone 终端标签页",
                                                   "lastText": "", "updatedAt": ago(20), "startedAt": ago(1800), "active": true, "model": "claude-opus-5-5", "branch": "main"])
        let compact = UserDefaults.standard.string(forKey: "uiDemoScreen") == "simplecompact"
        let demo = UserDefaults.standard.string(forKey: "uiDemoScreen")
        let daybreak = demo == "simpledaybreak" || demo == "simpledaybreakclash"
        let codexModel = demo == "simpledaybreakclash" ? "gpt-6.1-sol" : "gpt-6-sol"
        let busy = UserDefaults.standard.string(forKey: "uiDemoScreen") == "simplebusy"
        var items: [RecordItem] = [
            RecordItem(id: "100", kind: .user, at: ago(900), text: "我选了这个 codex 的版本，怎么好像没生效", images: 2),
            // What it thought on the way, where it wrote that down.
            RecordItem(id: "150", kind: .answer, at: ago(895), text: "选的版本存下来了，但服务只在启动时读它。先看页面上哪里提示了要重启。", thinking: true),
            RecordItem(id: "200", kind: .work, at: ago(890), seconds: 72, steps: [
                RecordStep(kind: .read, text: "packages/mac-app/Sources/AgentSwitchMac/Agents/AgentsView.swift"),
                RecordStep(kind: .read, text: "docs/design/agents-page.png", images: 1),
                RecordStep(kind: .search, text: "pendingRestart"),
                RecordStep(kind: .run, text: "cd packages/mac-app && swift test --filter AgentsTests 2>&1 ⏎ | grep -E \"error:|Executed [0-9]+ tests\" | tail -2 ⏎ git status --short",
                           note: "Run the Agents tests and keep the last lines", out: "Executed 41 tests, with 0 failures (0 unexpected) in 0.412 seconds"),
                RecordStep(kind: .edit, text: "packages/mac-app/Sources/AgentSwitchMac/Agents/AgentsView.swift", added: 12, removed: 1),
                RecordStep(kind: .edit, text: "docs/agents-v0.md", added: 2, removed: 1),
            ]),
            RecordItem(id: "300", kind: .answer, at: ago(815), text: """
                生效了，只是还没有用上：

                - 测试版已装好，`codex-beta` 在命令行里可用。
                - 页面顶部有 `Restart Service…`，但你是在下面那一组里选的，看不到它。

                已在 Codex 自己那一组的末尾加上同一条提示，写明服务现在用哪个、重启后改用哪个，见 [docs/agents-v0.md](docs/agents-v0.md) §8。
                """, files: [RecordFile(path: "/Users/you/code/site/out/agents-versions.xlsx", kind: "workbook"), RecordFile(path: "/Users/you/code/site/docs/agents-v0.md")]),
            RecordItem(id: "400", kind: .user, at: ago(300), text: "delete 应该标红才对"),
            RecordItem(id: "500", kind: .work, at: ago(290), seconds: busy ? 0 : 38, steps: [
                RecordStep(kind: .search, text: "SettingsDeleteButton"),
                RecordStep(kind: .edit, text: "packages/mac-app/Sources/AgentSwitchMac/Agents/AgentsView.swift", added: 3, removed: 3),
            ]),
        ]
        if busy {
            items.insert(RecordItem(id: "450", kind: .answer, at: ago(250), text: "改好了：换成应用里已有的红字删除按钮，禁用时变淡。正在重新构建。"), at: 5)
            items.append(RecordItem(id: "600", kind: .user, at: ago(5), text: "顺便把确认框的文案也看一下", queued: true))
        } else {
            items.append(RecordItem(id: "550", kind: .answer, at: ago(250), text: "改好了：换成应用里已有的红字删除按钮，禁用时变淡。接下来跑一遍测试确认。"))
        }
        // An earlier compaction, a line in the record.
        if compact { items.append(RecordItem(id: "560", kind: .note, at: ago(200), text: "Compacted · 899k → 15k")) }
        // The first run of work alone, so a step opened on its picture is in view.
        if UserDefaults.standard.string(forKey: "uiDemoScreen") == "simplestep" { items = Array(items.prefix(3)) }
        return SessionRecord(session: summary, items: items, more: true, cursor: 100, rev: "demo",
                             plan: [PlanEntry(text: "找出所有用到删除按钮的地方", state: .done), PlanEntry(text: "删除按钮标红", state: .done),
                                    PlanEntry(text: "重新构建", state: .doing), PlanEntry(text: "跑测试", state: .todo)],
                             usage: RecordUsage(model: daybreak ? codexModel : "claude-opus-5-5", used: 124_000, window: 200_000, effort: "medium"), mode: daybreak ? nil : "acceptEdits")
    }

    /// What a run of work changed (the simple view's Changes).
    static let changes: [FileDiff] = [
        FileDiff(path: "packages/mac-app/Sources/AgentSwitchMac/Agents/AgentsView.swift", added: 3, removed: 3, hunks: [
            FileDiff.Hunk(header: "@@ -212,7 +212,7 @@", lines: [
                "             Spacer()", "-            Button(\"Delete\", role: .destructive) { confirm = row }", "+            SettingsDeleteButton(\"Delete\") { confirm = row }",
                "+                .disabled(row.locked || busy)", "-                .disabled(row.locked)", "-                .controlSize(.small)", "+                .help(row.locked ? AgentText.locked : \"\")", "         }",
            ]),
        ]),
        FileDiff(path: "docs/agents-v0.md", added: 2, removed: 1, hunks: [
            FileDiff.Hunk(header: "@@ -88,3 +88,4 @@", lines: [" ## 8. 界面", "-删除用系统的破坏性按钮。", "+删除用设置页自己的红字按钮（`SettingsDeleteButton`），", "+禁用时变淡。"]),
        ]),
    ]

    /// The last route choice as the Mac details page shows it: the LAN answered, Tailscale timed out.
    static var routeReport: [ProbeReport] {
        [
            ProbeReport(endpoint: APIEndpoint(host: "192.168.1.5", port: 4713, kind: .bonjour), outcome: .ok, seconds: 0.3),
            ProbeReport(endpoint: APIEndpoint(host: "192.168.31.20", port: 4713, kind: .lan), outcome: nil, seconds: 0),
            ProbeReport(endpoint: APIEndpoint(host: "100.101.102.103", port: 4713, kind: .tailnet), outcome: .unreachable("请求超时。"), seconds: 4.0),
        ]
    }

    // MARK: proxies (docs/clash-v0.md §9, docs/profiles-v0.md §4.2, docs/browser-v0.md §7.6)

    private static var clashObject: [String: Any] {
        ["found": true, "running": true, "version": "v1.19.31", "mode": "rule", "tun": true,
         "source": ["kind": "link", "name": "Mine", "host": "sub.example.net", "updatedAt": ago(5400), "nodes": 42,
                    "providers": [], "traffic": ["used": 13_207_024_435.0, "total": 107_374_182_400.0, "expire": 1_793_456_000_000.0]],
         "together": true,
         "subscriptions": [["id": "0", "kind": "link", "name": "Mine", "host": "sub.example.net", "updatedAt": ago(5400), "nodes": 7, "providers": [], "hours": 24,
                            "traffic": ["used": 13_207_024_435.0, "total": 107_374_182_400.0, "expire": 1_793_456_000_000.0]],
                           ["id": "3f9a12c0", "kind": "file", "name": "spare.yaml", "updatedAt": ago(260_000), "nodes": 4, "providers": [], "hours": 0]],
         "table": [["name": "🇯🇵 日本家宽-01", "sub": "0", "type": "vless", "off": false], ["name": "🇯🇵 日本家宽-02", "sub": "0", "type": "vless", "off": false],
                   ["name": "🇯🇵 日本-03", "sub": "0", "type": "trojan", "off": false], ["name": "🇺🇸 美国家宽-01", "sub": "0", "type": "vless", "off": false],
                   ["name": "🇺🇸 美国-02", "sub": "0", "type": "vless", "off": false], ["name": "🇸🇬 新加坡-01", "sub": "0", "type": "ss", "off": false],
                   ["name": "🇸🇬 新加坡-02", "sub": "0", "type": "ss", "off": false], ["name": "🇬🇧 英国-01", "sub": "3f9a12c0", "type": "hysteria2", "off": false],
                   ["name": "🇩🇪 德国-01", "sub": "3f9a12c0", "type": "hysteria2", "off": false], ["name": "🇰🇷 韩国-01", "sub": "3f9a12c0", "type": "ss", "off": false],
                   ["name": "🇯🇵 日本-03 · spare.yaml", "sub": "3f9a12c0", "type": "ss", "off": true]],
         "nodes": ["🇯🇵 日本家宽-01", "🇯🇵 日本家宽-02", "🇯🇵 日本-03", "🇺🇸 美国家宽-01", "🇺🇸 美国-02", "🇸🇬 新加坡-01", "🇸🇬 新加坡-02", "🇬🇧 英国-01", "🇩🇪 德国-01", "🇰🇷 韩国-01"],
         "profiles": [["uid": "Lbw7BJYzpand", "name": "mine.yaml", "type": "local"], ["uid": "Ro3yUVdr9kT1", "name": "Other", "type": "remote"]],
         "settings": ["claude": ["nodes": ["🇯🇵 日本家宽-01", "🇯🇵 日本家宽-02", "🇺🇸 美国家宽-01"]], "openai": ["nodes": ["🇺🇸 美国家宽-01", "🇸🇬 新加坡-01"]],
                      "grok": ["nodes": ["🇺🇸 美国-02"]], "agy": ["nodes": ["🇯🇵 日本-03"]],
                      "direct": ["5.102.107.254"], "autoUpdateHours": 24,
                      "templates": ["domestic": ["on": true, "rules": NSNull()], "block": ["on": false, "rules": NSNull()]], "renameDefault": false, "dns": ["on": false, "text": NSNull()]],
         "services": ["claude": ["group": "Claude", "auto": "Claude自动选择", "live": true, "now": "Claude自动选择", "autoNow": "🇯🇵 日本家宽-01", "missing": []],
                      "openai": ["group": "OpenAI", "auto": "OpenAI自动选择", "live": true, "now": "🇸🇬 新加坡-01", "autoNow": "🇺🇸 美国家宽-01", "missing": []],
                      "grok": ["group": "Grok", "auto": "Grok自动选择", "live": true, "now": "Grok自动选择", "autoNow": "🇺🇸 美国-02", "missing": []],
                      "agy": ["group": "Antigravity", "auto": "Antigravity自动选择", "live": true, "now": "Antigravity自动选择", "autoNow": "🇯🇵 日本-03", "missing": []]],
         "templates": ["domestic": ["on": true, "custom": false, "count": 169], "block": ["on": false, "custom": false, "count": 27]],
         "defaultGroup": "节点选择", "dns": ["on": false, "custom": false, "overridden": false], "active": true, "upToDate": true, "install": "", "fetchedAt": ago(1800)]
    }

    static var clash: ClashView { decode(ClashView.self, clashObject) }

    /// The same page after a setting was changed here (no Mac to keep it).
    static func clash(with settings: ClashSettings) -> ClashView {
        var object = clashObject
        if let data = try? JSONEncoder().encode(settings), let kept = try? JSONSerialization.jsonObject(with: data) { object["settings"] = kept }
        return decode(ClashView.self, object)
    }

    static let clashDelays: [ClashService: [String: Int?]] = [
        .claude: ["🇯🇵 日本家宽-01": 96, "🇯🇵 日本家宽-02": 142, "🇺🇸 美国家宽-01": 428, "🇯🇵 日本-03": 118, "🇺🇸 美国-02": nil, "🇸🇬 新加坡-01": 187],
        .openai: ["🇺🇸 美国家宽-01": 402, "🇸🇬 新加坡-01": 187],
        .grok: ["🇺🇸 美国-02": 398],
        .agy: ["🇯🇵 日本-03": 118],
    ]

    static var clashChecked: [ClashCheckRow] {
        decode([ClashCheckRow].self, [
            ["id": "claude", "title": "Claude", "host": "claude.ai", "expect": ["kind": "group", "group": "Claude"],
             "observed": ["outcome": "proxied", "rule": "RuleSet as-claude", "path": ["Claude", "Claude自动选择", "🇯🇵 日本家宽-01"], "exit": ["ip": "126.36.1.2", "loc": "JP"], "ms": 362], "ok": true],
            ["id": "openai", "title": "OpenAI", "host": "chatgpt.com", "expect": ["kind": "group", "group": "OpenAI"],
             "observed": ["outcome": "proxied", "rule": "RuleSet as-openai", "path": ["OpenAI", "🇸🇬 新加坡-01"], "exit": ["ip": "8.219.4.7", "loc": "SG"], "ms": 418], "ok": true],
            ["id": "grok", "title": "Grok", "host": "grok.com", "expect": ["kind": "group", "group": "Grok"],
             "observed": ["outcome": "proxied", "rule": "RuleSet as-grok", "path": ["Grok", "Grok自动选择", "🇺🇸 美国-02"], "exit": ["ip": "64.7.198.20", "loc": "US"], "ms": 398], "ok": true],
            ["id": "agy", "title": "Antigravity", "host": "antigravity.google", "expect": ["kind": "group", "group": "Antigravity"],
             "observed": ["outcome": "proxied", "rule": "RuleSet as-agy", "path": ["Antigravity", "Antigravity自动选择", "🇯🇵 日本-03"], "exit": ["ip": "126.36.1.2", "loc": "JP"], "ms": 118], "ok": true],
            ["id": "domestic", "title": "Domestic", "host": "www.baidu.com", "expect": ["kind": "direct"],
             "observed": ["outcome": "direct", "rule": "RuleSet as-domestic", "path": ["DIRECT"], "ms": 41], "ok": true],
        ])
    }

    static let clashRules = "DOMAIN-SUFFIX,cn\nDOMAIN-SUFFIX,baidu.com\nDOMAIN-SUFFIX,qq.com\nDOMAIN-KEYWORD,alipay\nPROCESS-NAME,WeChat\nGEOIP,CN\nIP-CIDR,192.168.0.0/16"

    static var proxyProfiles: [String: ProfileChoices] {
        ["claude-code": ProfileChoices(current: "abc123def0", profiles: [
            ProfileChoice(id: "default", name: "Default", account: "me@example.com"),
            ProfileChoice(id: "abc123def0", name: "cwork1", account: "work@example.com", color: .violet,
                          proxy: ProxySetting(server: "http://proxy.example.net:8080", username: "cwork", sealed: true), exit: ProxyExit(ip: "203.0.113.9", place: "Tokyo")),
            ProfileChoice(id: "abc123def1", name: "side", color: .mint),
        ])]
    }

    static var proxies: ProxiesOverview {
        ProxiesOverview(clash: clash, browser: BrowserProxyState(fingerprint: "macOS · Firefox 156"), profiles: proxyProfiles)
    }

    /// A proxy form's state: the profile's own, or the shared browser going direct.
    static func proxyState(_ target: ProxyTarget) -> BrowserProxyState {
        switch target {
        case .browser: return BrowserProxyState(fingerprint: "macOS · Firefox 156")
        case .profile(_, let profile): return BrowserProxyState(proxy: profile.proxy, exit: profile.exit.map { .found($0) })
        }
    }

    /// Where 设置 opens for a demo screen.
    static func settingsPath(_ screen: String?) -> [SettingsRoute] {
        switch screen {
        case "clash", "clashservice", "clashrules", "clashcheck", "clashnodes", "clashtext", "clashsource", "clashsubscription", "clashallnodes": return [.clash]
        case "proxybrowser": return [.proxy(.browser)]
        case "proxyprofile": return proxies.owned.first.map { [.proxy(.profile(agent: $0.agent, profile: $0.profile))] } ?? []
        case "mac", "offlinemac": return [.mac]
        case "sessions": return [.sessions]
        case "transcript", "transcriptfiles": return sessions.first.map { [.sessions, .session($0)] } ?? [.sessions]
        default: return []
        }
    }
}
#endif

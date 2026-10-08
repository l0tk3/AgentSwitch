#if DEBUG
import AgentSwitchKit
import Foundation
import UIKit

/// Sample state for looking at the screens without a Mac (`-uiDemo YES`, debug builds only): a conversation with a task
/// running, one waiting for an answer, one finished and not opened yet, one gone quiet for a quarter of an hour and one
/// stopped by a restart; their threads and the pending question; the Mac's coding sessions, its permission mode and
/// default folder (control-v0).
enum DemoData {
    static let now = Int64(Date().timeIntervalSince1970 * 1000)
    static func ago(_ seconds: Int64) -> Int64 { now - seconds * 1000 }

    private static func decode<T: Decodable>(_ type: T.Type, _ object: Any) -> T {
        try! JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: object))
    }

    static var threads: [AgentThread] {
        decode([AgentThread].self, [
            ["id": "th1", "title": "AgentSwitch 最近的改动", "cwd": "/Users/me/Projects/AgentSwitch", "status": "open", "createdAt": ago(900), "updatedAt": ago(60), "expiresAt": NSNull(), "lastActivity": ago(10), "taskCount": 1],
            ["id": "th2", "title": "财务平台登录", "cwd": "/tmp/w2", "status": "open", "createdAt": ago(1800), "updatedAt": ago(120), "expiresAt": NSNull(), "lastActivity": ago(120), "taskCount": 1],
            ["id": "th3", "title": "整理下载目录", "cwd": "/tmp/w3", "status": "open", "createdAt": ago(4000), "updatedAt": ago(3000), "expiresAt": NSNull(), "lastActivity": ago(3000), "taskCount": 1],
            ["id": "th4", "title": "博客构建报错", "cwd": "/Users/me/Blog", "status": "open", "createdAt": ago(2500), "updatedAt": ago(1080), "expiresAt": NSNull(), "lastActivity": ago(1080), "taskCount": 1],
            ["id": "th5", "title": "周报数据", "cwd": "/Users/me/AgentSwitch/2026-09-27-t6", "status": "open", "createdAt": ago(9000), "updatedAt": ago(7000), "expiresAt": NSNull(), "lastActivity": ago(7000), "taskCount": 1],
            ["id": "th6", "title": "明天的天气", "cwd": NSNull(), "status": "open", "createdAt": ago(20000), "updatedAt": ago(19000), "expiresAt": NSNull(), "lastActivity": ago(19000), "taskCount": 1],
        ])
    }

    static var tasks: [AgentTask] {
        decode([AgentTask].self, [
            ["id": "t3", "createdAt": ago(3600), "updatedAt": ago(3000), "status": "done", "task": "整理一下下载目录，重复的文件放一起", "threadId": "th3",
             "harness": "opencode", "model": "deepseek/deepseek-flash", "result": "## 整理结果\n- 共 42 个文件，已按类型分入 6 个文件夹\n- 7 个重复文件已移入“重复”\n- 未删除任何文件",
             "speech": "下载目录已整理完成，共四十二个文件，其中七个重复文件已移入“重复”文件夹。", "spoken": "下载目录已整理完成。"],
            ["id": "t2", "createdAt": ago(1500), "updatedAt": ago(120), "status": "waiting_approval", "task": "登录财务平台，汇总首页的待办", "threadId": "th2",
             "harness": "claude-code", "model": "claude-sonnet-4-6"],
            ["id": "t1", "createdAt": ago(95), "updatedAt": ago(10), "status": "running", "task": "总结一下 AgentSwitch 最近的改动", "threadId": "th1",
             "harness": "claude-code", "model": "claude-opus-5-5", "spoken": "正在读取提交记录"],
            ["id": "t4", "createdAt": ago(2500), "updatedAt": ago(1080), "status": "running", "task": "博客换主题后构建报错了，看看怎么回事", "threadId": "th4",
             "harness": "codex", "model": "gpt-6-luna"],
            ["id": "t6", "createdAt": ago(9000), "updatedAt": ago(7000), "status": "blocked", "blockCause": "interrupted", "task": "把这周的周报数据汇总成表格",
             "threadId": "th5", "harness": "claude-code", "model": "claude-sonnet-4-6", "acknowledgedAt": ago(6900),
             "error": "服务重启时任务仍在进行，执行进度无法确认。"],
            ["id": "t5", "createdAt": ago(20000), "updatedAt": ago(19000), "status": "done", "task": "明天杭州的天气怎么样", "threadId": "th6",
             "harness": "claude-code", "model": "claude-sonnet-4-6", "result": "明天多云转小雨，气温 18 至 24 度。", "acknowledgedAt": ago(18000)],
        ])
    }

    static var approvals: [Approval] {
        let evidence = #"{"source":"executor","questions":[{"id":"code","header":"验证码","text":"短信验证码是多少？","secret":true}]}"#
        return decode([Approval].self, [["id": "ap1", "taskId": "t2", "createdAt": ago(120), "kind": "question", "action": "短信验证码是多少？",
                                         "evidence": evidence, "status": "pending", "resolvedAt": NSNull(), "answer": NSNull()]])
    }

    /// Each task's process, as the detail page shows it.
    static var events: [String: [TaskEvent]] {
        var seq = 0
        func e(_ task: String, _ type: String, _ payload: [String: Any], _ ts: Int64) -> [String: Any] {
            seq += 1
            return ["taskId": task, "seq": seq, "ts": ts, "type": type, "payload": payload]
        }
        func call(_ task: String, _ tool: String, _ input: [String: Any], _ ts: Int64, id: String? = nil) -> [String: Any] {
            e(task, "tool_call", ["tool": tool, "id": id ?? "tu\(seq + 1)", "input": input], ts)
        }
        let all = decode([TaskEvent].self, [
            e("t1", "step", ["action": "intake", "sealingMs": 820], ago(95)),
            e("t1", "routed", ["verdict": ["ok": true, "harness": "claude-code", "model": "claude-opus-5-5"], "source": "model"], ago(94)),
            e("t1", "dispatched", ["harness": "claude-code", "model": "claude-opus-5-5"], ago(93)),
            call("t1", "Bash", ["command": "git log --oneline -n 30", "description": "最近 30 个提交"], ago(80), id: "tu1"),
            e("t1", "tool_result", ["id": "tu1", "ok": true, "output": "749fdca docs: Live Activity, local API token\naa761fa feat: local API token; tasks may use the Mac's folders\n0413725 feat(ios-app): Live Activity and Dynamic Island"], ago(79)),
            call("t1", "Read", ["file_path": "/Users/me/Projects/AgentSwitch/docs/assistant-v0.md"], ago(70)),
            e("t1", "text", ["text": "最近 30 个提交集中在三个方面：本机 API 的令牌鉴权、任务使用 Mac 上的目录、只读步骤运行只读命令。"], ago(40)),
            call("t1", "Read", ["file_path": "/Users/me/Projects/AgentSwitch/packages/daemon/src/api/localAuth.ts"], ago(36)),
            call("t1", "Read", ["file_path": "/Users/me/Projects/AgentSwitch/packages/daemon/src/api/cwdPolicy.ts"], ago(32)),
            call("t1", "Grep", ["pattern": "readOnly", "path": "packages/daemon/src"], ago(27)),
            call("t1", "Read", ["file_path": "/Users/me/Projects/AgentSwitch/packages/daemon/src/executors/readOnly.ts"], ago(22)),
            call("t1", "Bash", ["command": "git show --stat HEAD~1"], ago(16)),
            call("t1", "Bash", ["command": "git show --stat HEAD~2"], ago(10)),
            e("t2", "dispatched", ["harness": "claude-code", "model": "claude-sonnet-4-6"], ago(1500)),
            call("t2", "mcp__playwright__browser_navigate", ["url": "https://finance.example.com/login"], ago(1400), id: "tu2"),
            e("t2", "tool_result", ["id": "tu2", "ok": true, "output": "Page URL: https://finance.example.com/login\nPage Title: 登录"], ago(1399)),
            e("t2", "text", ["text": "登录页要求输入短信验证码。"], ago(125)),
            e("t2", "approval_request", ["kind": "question", "source": "executor", "questions": [["text": "短信验证码是多少？"]]], ago(120)),
            e("t3", "dispatched", ["harness": "opencode", "model": "deepseek/deepseek-flash"], ago(3600)),
            call("t3", "bash", ["command": "ls -la ~/Downloads | wc -l"], ago(3590)),
            call("t3", "bash", ["command": "shasum ~/Downloads/* | sort"], ago(3570)),
            call("t3", "read", ["filePath": "/Users/me/Downloads/清单.txt"], ago(3560)),
            e("t3", "text", ["text": "42 个文件中有 7 个重复，将按类型分入 6 个文件夹。"], ago(3540)),
            call("t3", "bash", ["command": "mkdir -p ~/Downloads/{文档,图片,安装包,压缩包,表格,重复}"], ago(3520)),
            call("t3", "bash", ["command": "mv ~/Downloads/*.pdf ~/Downloads/文档/"], ago(3500)),
            e("t3", "done", ["result": "共 42 个文件，7 个重复文件已移入“重复”。"], ago(3467)),
            e("t4", "dispatched", ["harness": "codex", "model": "gpt-6-luna"], ago(2480)),
            call("t4", "commandExecution", ["command": "/bin/zsh -lc 'npm run build'"], ago(2400)),
            e("t4", "text", ["text": "构建在 hexo-renderer 步骤停止响应，无输出。"], ago(1100)),
            call("t4", "commandExecution", ["command": "/bin/zsh -lc 'npm ls hexo-renderer-marked'"], ago(1080)),
            e("t6", "dispatched", ["harness": "claude-code", "model": "claude-sonnet-4-6"], ago(8900)),
            call("t6", "Read", ["file_path": "/Users/me/Documents/周报/第39周.xlsx"], ago(8800)),
            e("t6", "blocked", ["cause": "interrupted", "error": "服务重启时任务仍在进行，执行进度无法确认。"], ago(7000)),
        ])
        return Dictionary(grouping: all, by: \.taskId)
    }

    static var messages: [AssistantMessage] {
        func m(_ seq: Int, _ role: String, _ text: String, kind: String, tasks: [String] = [], ts: Int64) -> [String: Any] {
            ["seq": seq, "ts": ts, "role": role, "text": text, "kind": kind, "taskIds": tasks, "clientId": NSNull(), "replyTo": NSNull()]
        }
        return decode([AssistantMessage].self, [
            m(1, "user", "整理一下下载目录，重复的文件放一起", kind: "message", ts: ago(3610)),
            m(2, "assistant", "已交给 DeepSeek Flash 整理下载目录。", kind: "task", tasks: ["t3"], ts: ago(3605)),
            m(3, "assistant", "「整理下载目录」已完成：共四十二个文件，其中七个重复文件已移入“重复”文件夹。", kind: "notice", tasks: ["t3"], ts: ago(2990)),
            m(9, "user", "注视感知功能的英文叫什么", kind: "message", ts: ago(50)),
            m(10, "assistant", "Attention Aware Features，位于 设置 › 面容 ID 与密码。", kind: "reply", ts: ago(48)),
            m(4, "user", "登录财务平台，汇总首页的待办", kind: "message", ts: ago(1510)),
            m(5, "assistant", "已交给 Sonnet 4.6，通过浏览器登录财务平台。", kind: "task", tasks: ["t2"], ts: ago(1505)),
            m(6, "assistant", "「财务平台登录」等你回答：短信验证码是多少？", kind: "waiting", tasks: ["t2"], ts: ago(115)),
            m(11, "user", "明天杭州的天气怎么样", kind: "message", ts: ago(20010)),
            m(12, "assistant", "已交给 Sonnet 4.6 查询天气。", kind: "task", tasks: ["t5"], ts: ago(20005)),
            m(13, "user", "把这周的周报数据汇总成表格", kind: "message", ts: ago(9010)),
            m(14, "assistant", "已交给 Sonnet 4.6 汇总周报数据。", kind: "task", tasks: ["t6"], ts: ago(9005)),
            m(15, "user", "博客换主题后构建报错了，看看怎么回事", kind: "message", ts: ago(2510)),
            m(16, "assistant", "已交给 GPT-6 Luna，在 ~/Blog 中检查构建。", kind: "task", tasks: ["t4"], ts: ago(2505)),
            m(7, "user", "总结一下 AgentSwitch 最近的改动", kind: "message", ts: ago(100)),
            m(8, "assistant", "已交给 Opus 5.5，在 AgentSwitch 仓库中查看提交记录。", kind: "task", tasks: ["t1"], ts: ago(96)),
        ])
    }

    // MARK: - control-v0

    static let policy = ApprovalPolicyInfo(policy: ApprovalPolicy(mode: .skip))
    static let workdir = WorkdirSetting(path: "/Users/me/AgentSwitch", defaultPath: "/Users/me/AgentSwitch")
    static let searchQuery = "目录"

    static var sessions: [SessionSummary] {
        let repo = "/Users/me/Desktop/WorkSpace/Projects/AgentSwitch"
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
            // project, and Worktop with a session of its own over the folders in it.
            SessionSummary(harness: "claude-code", id: "c3", cwd: repo + "/packages/secret-gate", title: "fill-value 的探针模板",
                           lastText: "探针模板固定在包里。", updatedAt: ago(5 * 3600)),
            SessionSummary(harness: "claude-code", id: "c4", cwd: "/Users/me/Desktop/WorkSpace/Worktop", title: "整理工作目录",
                           lastText: "做完的项目搬到 Archived。", updatedAt: ago(30 * 3600)),
            SessionSummary(harness: "codex", id: "x2", cwd: "/Users/me/Desktop/WorkSpace/Worktop/Codex", title: "给脚本加上重试",
                           lastText: "下载失败时指数退避重试三次。", updatedAt: ago(40 * 3600)),
            SessionSummary(harness: "codex", id: "x3", cwd: "/Users/me/Desktop/WorkSpace/Worktop/培训/靶场", title: "靶场环境搭建",
                           lastText: "docker compose 起三台靶机。", updatedAt: ago(50 * 3600)),
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
        "/Users/me/Desktop/WorkSpace/Projects/AgentSwitch": GitSummary(branch: "main", changed: 5, ahead: 2),
        "/Users/me/Work/api": GitSummary(branch: "feat/health", changed: 3, behind: 4),
    ]

    static var terminalList: TerminalList {
        let repo = "/Users/me/Desktop/WorkSpace/Projects/AgentSwitch"
        let screen = UserDefaults.standard.string(forKey: "uiDemoScreen")
        // `simplebusy`, `simpleprompt`: the simple view while it works, and while it waits on a screen of its own.
        // `simplecompact`: while it compacts its context (docs/simple-view-v0.md §5.7).
        let compact = screen == "simplecompact"
        // `simpledaybreak`: a Codex terminal with its Daybreak switch on (§5.8); `simpledaybreakclash`: on a model that
        // Codex lists without a Daybreak program.
        let clash = screen == "simpledaybreakclash", daybreak = screen == "simpledaybreak" || clash
        let busy = screen == "simplebusy" || compact, prompt = screen == "simpleprompt", idle = daybreak || screen == "simpleidle" || screen == "simpleeffort" || screen == "simplepaste" || screen == "simplestep" || screen == "simplesuggest"
        let five = ["low", "medium", "high", "xhigh", "max"]
        return TerminalList(terminals: [
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
                         sent: screen == "simplebusy" ? [SentReply(id: "s1", text: "顺便把测试也跑一遍", at: ago(3))] : []),
            TerminalInfo(id: "e5f6a7b8", harness: "codex", cwd: repo, model: "gpt-6-luna", name: "daemon 审计修复", status: .working,
                         createdAt: ago(900), lastOutputAt: ago(2)),
            TerminalInfo(id: "c3d4e5f6", harness: "opencode", cwd: "/Users/me/Blog", name: "Blog", status: .idle,
                         createdAt: ago(7200), lastOutputAt: ago(3000)),
        ], agents: ["claude-code", "codex", "opencode"], models: [
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
            "\(dim)  ~/Desktop/WorkSpace/Projects/AgentSwitch\(off)",
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
            "  ~/Desktop/WorkSpace/Projects/AgentSwitch/docs/desi",
            "  gn/concepts/split.html",
        ]
        let withLinks = UserDefaults.standard.string(forKey: "uiDemoScreen") == "terminallink"
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
        let summary = decode(SessionSummary.self, ["harness": harness, "id": id, "cwd": "/Users/me/Desktop/WorkSpace/Projects/AgentSwitch", "title": "iPhone 终端标签页",
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
                """),
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

    /// 设置 › 用量, mirroring a real reading (2026-09-27): Claude Code 20 % of 5 h and 82 % of 7 d, Codex Pro 8 % of 7 d
    /// (no 5 h window), the DeepSeek balance for OpenCode; read a minute and a half ago, resets still ahead.
    static var quota: [QuotaReading] {
        let s = now / 1000
        return decode([QuotaReading].self, [
            ["harness": "codex", "fetchedAt": ago(90), "remaining": 0.92, "source": "codex app-server account/rateLimits/read", "error": NSNull(),
             "detail": ["planType": "pro", "windows": [["label": "7d", "usedPercent": 8, "resetsAt": s + 571_921]]]],
            ["harness": "opencode", "fetchedAt": ago(92), "remaining": 1, "source": "deepseek /user/balance", "error": NSNull(),
             "detail": ["is_available": true, "balances": [["currency": "CNY", "total": "96.23", "granted": "0.00", "topped_up": "96.23"]]]],
            ["harness": "claude-code", "fetchedAt": ago(92), "remaining": 0.18, "source": "claude rate_limit_event (subscription windows)", "error": NSNull(),
             "detail": ["windows": [["label": "5h", "usedPercent": 20, "resetsAt": s + 14_551], ["label": "7d", "usedPercent": 82, "resetsAt": s + 3_151]],
                        "windowsAgeMs": 155_743]],
        ])
    }

    /// The last route choice as the Mac details page shows it: the LAN answered, Tailscale timed out.
    static var routeReport: [ProbeReport] {
        [
            ProbeReport(endpoint: APIEndpoint(host: "192.168.1.5", port: 4713, kind: .bonjour), outcome: .ok, seconds: 0.3),
            ProbeReport(endpoint: APIEndpoint(host: "192.168.31.20", port: 4713, kind: .lan), outcome: nil, seconds: 0),
            ProbeReport(endpoint: APIEndpoint(host: "100.101.102.103", port: 4713, kind: .tailnet), outcome: .unreachable("请求超时。"), seconds: 4.0),
        ]
    }

    /// Where 设置 opens for a demo screen.
    static func settingsPath(_ screen: String?) -> [SettingsRoute] {
        switch screen {
        case "mac", "offlinemac": return [.mac]
        case "tasks", "search": return [.tasks]
        case "sessions": return [.sessions]
        case "transcript": return sessions.first.map { [.sessions, .session($0)] } ?? [.sessions]
        default: return []
        }
    }
}
#endif

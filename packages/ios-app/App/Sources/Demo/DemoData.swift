#if DEBUG
import AgentSwitchKit
import Foundation

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
        return TerminalList(terminals: [
            TerminalInfo(id: "a1b2c3d4", harness: "claude-code", cwd: repo, model: "claude-opus-5-5", mode: "auto", name: "iPhone 终端标签页",
                         status: .waiting, cols: 52, rows: 30, createdAt: ago(1800), lastOutputAt: ago(20), agentSessionId: "c9",
                         permissions: [UserDefaults.standard.string(forKey: "uiDemoScreen") == "terminalquestion" ? question
                                       : TerminalPermission(id: "p1", tool: "Bash", summary: "Bash: swift test --filter TerminalTests")],
                         subagents: [TerminalSubagent(id: "s1", type: "code-reviewer", name: "审查改动", doing: "运行 git diff"),
                                     TerminalSubagent(id: "s2", type: "Explore", name: "查终端路由", doing: "读取 src/api/terminals.ts")]),
            TerminalInfo(id: "e5f6a7b8", harness: "codex", cwd: repo, model: "gpt-6-luna", name: "daemon 审计修复", status: .working,
                         createdAt: ago(900), lastOutputAt: ago(2)),
            TerminalInfo(id: "c3d4e5f6", harness: "opencode", cwd: "/Users/me/Blog", name: "Blog", status: .idle,
                         createdAt: ago(7200), lastOutputAt: ago(3000)),
        ], agents: ["claude-code", "codex", "opencode"], models: [
            "claude-code": [TerminalModelOption(id: "opus", name: "Opus 5.5"), TerminalModelOption(id: "claude-fable-5-1", name: "Fable 5.1"),
                            TerminalModelOption(id: "sonnet", name: "Sonnet 5.5"), TerminalModelOption(id: "claude-opus-4-8", name: "Opus 4.8", older: true)],
            "codex": [TerminalModelOption(id: "gpt-6-luna", name: "GPT-6 Luna")],
            "opencode": [TerminalModelOption(id: "deepseek/deepseek-flash", name: "DeepSeek Flash")],
        ])
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
        return lines.joined(separator: "\r\n")
    }()

    static func sessionMessages(_ session: SessionSummary) -> [SessionMessage] {
        let base = session.updatedAt
        func m(_ role: SessionMessage.Role, _ text: String, _ secondsBefore: Int64, tool: String? = nil) -> SessionMessage {
            SessionMessage(role: role, text: text, ts: base - secondsBefore * 1000, tool: tool)
        }
        return [
            m(.user, "给 iPhone 端加一个编码会话列表：按目录分组，进行中的要标出来。", 600),
            m(.assistant, "查看现有的设置页和 Kit 中的 API 模型，然后添加 GET /sessions 的解码和列表页。", 590),
            m(.tool, "App/Sources/Settings/SettingsView.swift", 580, tool: "Read"),
            m(.tool, "Sources/AgentSwitchKit/API/AgentSwitchAPI.swift", 575, tool: "Read"),
            m(.tool, "swift test", 400, tool: "Bash"),
            m(.assistant, "测试全部通过。列表按目录分组，最近有活动的目录排在前面；进行中的会话前有主色圆点。", 380),
            m(.user, "进行中的多久刷新一次？", 120),
            m(.assistant, "列表中有进行中的会话时每 10 秒刷新一次；否则仅在打开和下拉时刷新。", 20),
        ]
    }

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

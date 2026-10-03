#if DEBUG
import AgentSwitchMacCore
import Foundation

/// `-designPreview`: the Dispatch group's pages drawn from made-up data (the demo page's, `mac-window.html`), without
/// a daemon. Reads answer at once; writes answer as the daemon would and change nothing. What only the Dispatch page
/// asks for is not here (`notSupported`).
struct DispatchSettingsDemo: DispatchService {
    /// The window's environment with this service.
    static var environment: DispatchSettingsEnvironment { DispatchSettingsEnvironment(service: DispatchSettingsDemo()) }

    // MARK: Context

    static let contextText = """
    # 站点与账号
    - 财务平台 https://fin.example.com
      账号 finance@me.com
      密码 enc:v1:QWxhZGRpbjpvcGVuc2VzYW1lQWxhZGRpbjpvcGVu

    # 偏好
    - AgentSwitch 用 claude-code
    - 下载整理这类用便宜模型
    """

    func context() async throws -> DispatchTextDocument { DispatchTextDocument(path: "~/.agentswitch/CONTEXT.md", text: Self.contextText) }

    func contextExample() async throws -> String { "# 站点与账号\n- \n\n# 环境限制\n- \n\n# 偏好\n- " }

    func saveContext(_ text: String) async throws -> DispatchSaveResult {
        DispatchSaveResult(warnings: ["- 测试环境 token ghp_x8Q2… （无法确定所属站点）"],
                           sealed: [DispatchSealedField(label: "财务平台", field: "密码", hosts: ["fin.example.com"])])
    }

    func memory() async throws -> DispatchTextDocument {
        DispatchTextDocument(path: "~/.agentswitch/MEMORY.md", text: "- 手机装包用 install-device.sh（任务 1e04b10a）\n- Codex 在 ChatGPT.app 里（任务 9c21e0f3）")
    }

    func saveMemory(_ text: String) async throws -> DispatchSaveResult { DispatchSaveResult() }

    func platformMemory() async throws -> [DispatchPlatformMemory] {
        let soon = Self.ms(Date().addingTimeInterval(20 * 86_400)), later = Self.ms(Date().addingTimeInterval(4 * 86_400))
        return try Self.decode([
            ["id": "pm1", "origin": "https://dev.apple.com", "key": "install", "text": "装到手机前先确认手机已解锁、和 Mac 在同一网络",
             "kind": "operation", "status": "verified", "source": ["taskId": "1e04b10a77", "eventSeq": 41, "quote": "设备未解锁，安装失败"],
             "updatedAt": Self.ms(Date()), "expiresAt": soon],
            ["id": "pm2", "origin": "https://fin.example.com", "key": "otp", "text": "财务平台的验证码走短信，需要询问用户",
             "kind": "incident", "status": "observed", "source": ["taskId": "9c21e0f3aa", "eventSeq": 12, "quote": "请输入短信验证码"],
             "updatedAt": Self.ms(Date()), "expiresAt": later],
        ])
    }

    func deletePlatformMemory(id: String) async throws {}

    // MARK: Extensions

    func mcpServers() async throws -> [DispatchMCPServer] {
        [DispatchMCPServer(name: "github", kind: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"],
                           env: ["GITHUB_PERSONAL_ACCESS_TOKEN": "enc:v1:QWxhZGRpbjpvcGVuc2VzYW1lQWxhZGRpbjpvcGVu"],
                           harnesses: ["claude-code", "codex"], note: "仓库、issue 与 PR"),
         DispatchMCPServer(name: "linear", kind: "http", url: "https://mcp.linear.app/sse", harnesses: ["claude-code"], approval: "allow"),
         DispatchMCPServer(name: "sqlite-local", kind: "stdio", command: "uvx", args: ["mcp-server-sqlite", "--db", "~/data/app.db"],
                           enabled: false)]
    }

    func saveMCPServer(_ server: DispatchMCPServer) async throws -> DispatchMCPServer { server }
    func deleteMCPServer(name: String) async throws {}

    static var skillList: [[String: Any]] {
        [
        ["name": "release-notes", "description": "从 git log 写发布说明", "path": "~/.agentswitch/skills/release-notes", "files": 2,
         "enabled": true, "harnesses": ["claude-code", "codex"]],
        ["name": "deploy-checklist", "description": "发布前逐项检查构建、签名与版本号", "path": "~/.agentswitch/skills/deploy-checklist",
         "files": 0, "enabled": false, "harnesses": ["claude-code", "codex", "opencode"]],
        ]
    }

    func skills() async throws -> [DispatchSkill] { try Self.decode(Self.skillList) }

    func skill(name: String) async throws -> DispatchSkillDetail {
        var object = Self.skillList.first { $0["name"] as? String == name } ?? Self.skillList[0]
        object["content"] = "---\nname: release-notes\ndescription: 从 git log 写发布说明\n---\n\n# Release notes\n\n1. 读取上一个 tag 之后的提交（git log --oneline v1.4.0..HEAD）。\n2. 按 feat / fix / perf 分组，每条一句话。\n3. 写入 CHANGELOG.md 顶部，不改动已有条目。\n"
        return try Self.decode(object)
    }

    func saveSkill(name: String, _ update: DispatchSkillUpdate) async throws -> DispatchSkill { try await skills()[0] }
    func deleteSkill(name: String) async throws {}

    func discoverSkills() async throws -> [DispatchDiscoveredSkill] {
        try Self.decode([
            ["name": "pdf-tools", "description": "拆分、合并、加水印", "path": "/Users/me/.claude/skills/pdf-tools", "source": "~/.claude/skills", "installed": false],
            ["name": "ios-release", "description": "TestFlight 上传与版本号递增", "path": "/Users/me/.codex/skills/ios-release", "source": "~/.codex/skills", "installed": false],
            ["name": "release-notes", "description": "从 git log 写发布说明", "path": "/Users/me/.claude/skills/release-notes", "source": "~/.claude/skills", "installed": true],
        ])
    }

    func importSkill(path: String) async throws -> DispatchSkill { try await skills()[0] }

    // MARK: Log

    func routingLog(limit: Int) async throws -> [DispatchRoutingLogEntry] {
        let now = Date()
        func at(_ minutes: Double) -> Int64 { Self.ms(now.addingTimeInterval(-minutes * 60)) }
        let decision = #"{"harness":"claude-code","model":"opus-5.5","plan":"multi","purpose":"do","reason":"多步构建，需要读取 Xcode 输出","confidence":0.86,"kind":"code-multifile","action":"redispatch"}"#
        return try Self.decode([
            ["id": 4, "ts": at(12), "taskId": "t4", "cwd": "/Users/me/Downloads", "source": "router", "harness": "opencode", "model": "deepseek-flash",
             "decision": #"{"harness":"opencode","model":"deepseek-flash","reason":"按项目偏好：下载整理交给便宜的模型","confidence":0.9}"#,
             "notes": "", "routerMs": 1840, "outcome": "done"],
            ["id": 3, "ts": at(50), "taskId": "t1", "cwd": "/Users/me/Projects/AgentSwitch", "source": "router", "harness": "claude-code",
             "model": "opus-5.5", "decision": decision, "notes": "", "routerMs": 2310, "outcome": "done"],
            ["id": 2, "ts": at(61), "taskId": "t3", "cwd": "/Users/me/AgentSwitch/2026-10-02", "source": "router",
             "decision": #"{"action":"clarify","question":"要登录哪个财务账号？","reason":"凭据不明确"}"#, "notes": "router asks the user a question first",
             "routerMs": 1200],
            ["id": 1, "ts": at(26 * 60), "taskId": "t2", "cwd": "/Users/me/Projects/AgentSwitch", "source": "pin", "harness": "codex",
             "model": "gpt-6-luna", "notes": "", "routerMs": 0, "outcome": "failed:refusal"],
        ])
    }

    func tasks(limit: Int) async throws -> [DispatchTask] {
        let now = Self.ms(Date())
        return [DispatchTask(id: "t1", createdAt: now - 3_000_000, updatedAt: now - 2_000_000, status: .done, task: "构建 AgentSwitch.app，装到手机上", threadId: "th1"),
                DispatchTask(id: "t2", createdAt: now - 93_600_000, updatedAt: now - 93_000_000, status: .failed, task: "清理旧构建", threadId: "th2"),
                DispatchTask(id: "t3", createdAt: now - 3_660_000, updatedAt: now - 3_600_000, status: .waitingApproval, task: "导出本月的财务报表", threadId: "th4"),
                DispatchTask(id: "t4", createdAt: now - 720_000, updatedAt: now - 300_000, status: .running, task: "整理下载目录里的重复文件", threadId: "th3")]
    }

    // MARK: History

    func search(query: String, limit: Int) async throws -> [DispatchSearchResult] {
        let now = Self.ms(Date())
        return [DispatchSearchResult(taskId: "t1", title: "构建 AgentSwitch.app，装到手机上", snippet: "…xcodebuild -scheme ⟦\(query)⟧ 完成，已安装到 iPhone 17 Pro…",
                                     status: .done, updatedAt: now - 2_000_000),
                DispatchSearchResult(taskId: "t2", title: "清理旧构建", snippet: "build/ 里有 3.2 GB 旧产物，其中 ⟦\(query)⟧.app 的归档…",
                                     status: .failed, updatedAt: now - 93_000_000)]
    }

    func threads(_ filter: DispatchThreadFilter, limit: Int) async throws -> [DispatchThread] {
        let now = Self.ms(Date())
        if filter == .archived {
            return [DispatchThread(id: "th9", createdAt: now, updatedAt: now - 172_800_000, title: "周报", status: "archived",
                                   expiresAt: now + 432_000_000, taskCount: 3)]
        }
        return [DispatchThread(id: "th1", createdAt: now, updatedAt: now - 20_000, title: "发布 AgentSwitch", taskCount: 4),
                DispatchThread(id: "th2", createdAt: now, updatedAt: now - 40_000, title: "清理磁盘", taskCount: 2),
                DispatchThread(id: "th3", createdAt: now, updatedAt: now - 3_700_000, title: "整理下载", taskCount: 1),
                DispatchThread(id: "th4", createdAt: now, updatedAt: now - 90_000_000, title: "财务", taskCount: 2)]
    }

    func thread(id: String) async throws -> DispatchThreadDetail {
        let topic = try await threads(.open).first { $0.id == id } ?? DispatchThread(id: id, createdAt: 0, updatedAt: 0)
        return DispatchThreadDetail(thread: topic, tasks: try await tasks(limit: 50).filter { $0.threadId == id })
    }

    func renameThread(id: String, title: String?) async throws -> DispatchThread { try await thread(id: id).thread }
    func archiveThread(id: String) async throws -> DispatchThread { try await thread(id: id).thread }
    func reopenThread(id: String) async throws -> DispatchThread { try await thread(id: id).thread }
    func deleteThread(id: String) async throws {}
    func clearHistory() async throws {}

    // MARK: only the Dispatch page asks for these

    func messages(last count: Int) async throws -> [DispatchMessage] { [] }
    func messages(after seq: Int) async throws -> [DispatchMessage] { [] }
    func send(_ message: DispatchNewMessage) async throws -> DispatchAssistantReply { throw Self.unsupported }
    func deleteEntry(seq: Int) async throws { throw Self.unsupported }
    func task(id: String) async throws -> DispatchTaskDetail { throw Self.unsupported }
    func approvals() async throws -> [DispatchApproval] { [] }
    func decide(taskId: String, approvalId: String, decision: DispatchApprovalDecision) async throws { throw Self.unsupported }
    func answer(taskId: String, approvalId: String, answers: [String: [String]]) async throws { throw Self.unsupported }
    func cancel(taskId: String) async throws -> DispatchTask { throw Self.unsupported }
    func handoff(taskId: String, to target: DispatchTarget?) async throws -> DispatchTask { throw Self.unsupported }
    func retry(_ task: DispatchTask) async throws -> DispatchTask { throw Self.unsupported }
    func rate(taskId: String, rating: Int?) async throws { throw Self.unsupported }
    func acknowledge(taskId: String) async throws -> Int64? { nil }
    func deleteTask(id: String) async throws { throw Self.unsupported }
    func taskFiles(taskId: String) async throws -> [DispatchTaskFile] { [] }
    func downloadTaskFile(taskId: String, path: String, to destination: URL) async throws -> URL { throw Self.unsupported }
    func taskEvents(taskId: String, after: Int64) -> AsyncThrowingStream<DispatchTaskEvent, Error> { AsyncThrowingStream { $0.finish() } }
    func upload(_ files: [DispatchUploadFile]) async throws -> [DispatchStagedUpload] { throw Self.unsupported }
    func targets() async throws -> DispatchTargets { throw Self.unsupported }

    // MARK: plumbing

    private static let unsupported = DaemonError.notSupported("design preview")

    private static func ms(_ date: Date) -> Int64 { Int64(date.timeIntervalSince1970 * 1000) }

    /// The daemon's JSON for a shape that only decodes (no memberwise init in Core).
    private static func decode<T: Decodable>(_ object: Any) throws -> T {
        try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: object))
    }
}
#endif

#if DEBUG
import AgentSwitchMacCore
import Foundation

/// A made-up Mac for the Dispatch page in `-designPreview` (MainWindowPreview.swift), the work of the demo page
/// `docs/design/implemented/mac-window.html`: yesterday a finance download that failed; today a date asked and answered
/// (`▸ Read Aloud`), duplicate downloads sorted with two files back, an old build being cleaned by Codex that asks
/// whether to delete, and a build on Claude Code at step 3 of 5 waiting for an install to be allowed. Reads answer from
/// the data; writes are accepted and change nothing. Times are relative to now.
struct DispatchDemoService: DispatchService {
    let data: DispatchDemoData

    init(now: Date = Date()) { data = DispatchDemoData(now: now) }

    // MARK: the conversation

    func messages(last count: Int) async throws -> [DispatchMessage] { Array(data.messages.suffix(count)) }
    func messages(after seq: Int) async throws -> [DispatchMessage] { data.messages.filter { $0.seq > seq } }

    func send(_ message: DispatchNewMessage) async throws -> DispatchAssistantReply {
        let ts = Int64(Date().timeIntervalSince1970 * 1000)
        let seq = (data.messages.last?.seq ?? 0) + 1
        return DispatchAssistantReply(user: DispatchMessage(seq: seq, ts: ts, role: .user, text: message.text, kind: .message, clientId: message.clientId),
                                      assistant: DispatchMessage(seq: seq + 1, ts: ts, role: .assistant, text: "演示数据，未发送。", kind: .reply, replyTo: seq))
    }

    func deleteEntry(seq: Int) async throws {}

    // MARK: tasks

    func tasks(limit: Int) async throws -> [DispatchTask] { Array(data.tasks.sorted { $0.createdAt > $1.createdAt }.prefix(limit)) }

    func task(id: String) async throws -> DispatchTaskDetail {
        guard let task = data.tasks.first(where: { $0.id == id }) else { throw DaemonError.http(status: 404, message: "任务不存在。") }
        return DispatchTaskDetail(task: task, approvals: data.approvals.filter { $0.taskId == id })
    }

    func approvals() async throws -> [DispatchApproval] { data.approvals }
    func decide(taskId: String, approvalId: String, decision: DispatchApprovalDecision) async throws {}
    func answer(taskId: String, approvalId: String, answers: [String: [String]]) async throws {}
    func cancel(taskId: String) async throws -> DispatchTask { try await task(id: taskId).task }
    func handoff(taskId: String, to target: DispatchTarget?) async throws -> DispatchTask { try await task(id: taskId).task }
    func retry(_ task: DispatchTask) async throws -> DispatchTask { task }
    func rate(taskId: String, rating: Int?) async throws {}
    @discardableResult func acknowledge(taskId: String) async throws -> Int64? { nil }
    func deleteTask(id: String) async throws {}
    func taskFiles(taskId: String) async throws -> [DispatchTaskFile] { data.files[taskId] ?? [] }

    @discardableResult func downloadTaskFile(taskId: String, path: String, to destination: URL) async throws -> URL {
        try Data("演示文件 \(path)\n".utf8).write(to: destination, options: .atomic)
        return destination
    }

    /// Replays the task's events; an active task's stream then stays open, as the daemon's does.
    func taskEvents(taskId: String, after: Int64) -> AsyncThrowingStream<DispatchTaskEvent, Error> {
        let events = (data.events[taskId] ?? []).filter { $0.seq > after }
        let open = data.tasks.first { $0.id == taskId }?.status.isActive ?? false
        return AsyncThrowingStream { continuation in
            for event in events { continuation.yield(event) }
            if !open { continuation.finish() }
        }
    }

    // MARK: topics

    func threads(_ filter: DispatchThreadFilter, limit: Int) async throws -> [DispatchThread] { data.threads }

    func thread(id: String) async throws -> DispatchThreadDetail {
        guard let thread = data.threads.first(where: { $0.id == id }) else { throw DaemonError.http(status: 404, message: "话题不存在。") }
        return DispatchThreadDetail(thread: thread, tasks: data.tasks.filter { $0.threadId == id }.sorted { $0.createdAt < $1.createdAt })
    }

    func renameThread(id: String, title: String?) async throws -> DispatchThread { try await thread(id: id).thread }
    func archiveThread(id: String) async throws -> DispatchThread { try await thread(id: id).thread }
    func reopenThread(id: String) async throws -> DispatchThread { try await thread(id: id).thread }
    func deleteThread(id: String) async throws {}

    // MARK: the input

    func upload(_ files: [DispatchUploadFile]) async throws -> [DispatchStagedUpload] {
        files.enumerated().map { DispatchStagedUpload(id: "up\($0.offset)", name: $0.element.name, size: Int64($0.element.data.count), type: $0.element.type) }
    }

    func targets() async throws -> DispatchTargets { data.targets }

    // MARK: the settings group (not part of this page's demo)

    func context() async throws -> DispatchTextDocument { throw Self.notHere }
    func contextExample() async throws -> String { "" }
    func saveContext(_ text: String) async throws -> DispatchSaveResult { throw Self.notHere }
    func memory() async throws -> DispatchTextDocument { throw Self.notHere }
    func saveMemory(_ text: String) async throws -> DispatchSaveResult { throw Self.notHere }
    func platformMemory() async throws -> [DispatchPlatformMemory] { [] }
    func deletePlatformMemory(id: String) async throws {}
    func mcpServers() async throws -> [DispatchMCPServer] { [] }
    func saveMCPServer(_ server: DispatchMCPServer) async throws -> DispatchMCPServer { server }
    func deleteMCPServer(name: String) async throws {}
    func skills() async throws -> [DispatchSkill] { [] }
    func skill(name: String) async throws -> DispatchSkillDetail { throw Self.notHere }
    func saveSkill(name: String, _ update: DispatchSkillUpdate) async throws -> DispatchSkill { throw Self.notHere }
    func deleteSkill(name: String) async throws {}
    func discoverSkills() async throws -> [DispatchDiscoveredSkill] { [] }
    func importSkill(path: String) async throws -> DispatchSkill { throw Self.notHere }
    func routingLog(limit: Int) async throws -> [DispatchRoutingLogEntry] { [] }
    func search(query: String, limit: Int) async throws -> [DispatchSearchResult] { [] }
    func clearHistory() async throws {}

    private static let notHere = DaemonError.notSupported("demo")
}

/// The demo's work, as mac-window.html has it.
struct DispatchDemoData: Sendable {
    let messages: [DispatchMessage]
    let tasks: [DispatchTask]
    let approvals: [DispatchApproval]
    let threads: [DispatchThread]
    let events: [String: [DispatchTaskEvent]]
    let files: [String: [DispatchTaskFile]]
    let targets: DispatchTargets

    /// The file of the sorted downloads already on this Mac (its solid mark).
    static let downloaded = (task: "t3", file: DispatchTaskFile(path: "out/report.md", size: 4_096, isDeliverable: true))

    init(now: Date) {
        let calendar = Calendar.current
        let ms = { (date: Date) in Int64(date.timeIntervalSince1970 * 1000) }
        let start = calendar.startOfDay(for: now)
        // Today's lines a few minutes ago, never before midnight.
        let today = { (seconds: TimeInterval) in ms(max(now.addingTimeInterval(-seconds), start.addingTimeInterval(60))) }
        let yesterday = ms(calendar.date(byAdding: .day, value: -1, to: start)!.addingTimeInterval(18 * 3600 + 20 * 60))
        let home = NSHomeDirectory()

        let weekday = ["日", "一", "二", "三", "四", "五", "六"][calendar.component(.weekday, from: now) - 1]
        let date = "今天是 \(calendar.component(.month, from: now)) 月 \(calendar.component(.day, from: now)) 日，星期\(weekday)。"
        func said(_ seq: Int, _ ts: Int64, _ text: String) -> DispatchMessage {
            DispatchMessage(seq: seq, ts: ts, role: .user, text: text, kind: .message)
        }
        func answered(_ seq: Int, _ ts: Int64, _ text: String, kind: DispatchMessage.Kind = .task, tasks: [String] = []) -> DispatchMessage {
            DispatchMessage(seq: seq, ts: ts + 2_000, role: .assistant, text: text, kind: kind, taskIds: tasks, replyTo: seq - 1)
        }
        let finance = yesterday, date1 = today(40 * 60), code = today(36 * 60), sort = today(32 * 60), clean = today(5 * 60 + 3)
        let build = today(134 + 3)
        messages = [
            said(1, finance, "登录财务平台，把本月的对账单下载下来"),
            answered(2, finance, "交给 Claude Code，需要浏览器和财务平台的凭据。", tasks: ["t4"]),
            said(3, date1, "今天几号"),
            answered(4, date1, date, kind: .reply),
            // Code in what you typed and in the answer (2026-10-03, the demo's `跑一下这两条`).
            said(5, code, "跑一下这两条，把输出贴回来：\n```\ngit status --short\nnpm test -- --reporter=dot --silent --run tests/markdownUi.test.ts tests/api.test.ts\n```"),
            answered(6, code, "交给 Codex，在 `~/Projects/AgentSwitch` 里运行。", tasks: ["t5"]),
            said(7, sort, "整理下载目录里的重复文件"),
            answered(8, sort, "交给 OpenCode，用 DeepSeek Flash。", tasks: ["t3"]),
            said(9, clean, "build 目录太大了，清理一下旧构建"),
            answered(10, clean, "交给 Codex 清理。", tasks: ["t2"]),
            said(11, build, "把 iOS 端打包装到手机上"),
            answered(12, build, "交给 Claude Code，在 ~/Projects/AgentSwitch 里构建并安装。", tasks: ["t1"]),
        ]

        let screenshot = DispatchAttachment(name: "screenshot.png", path: "in/screenshot.png", size: 182_000, type: "image/png")
        tasks = [
            DispatchTask(id: "t4", createdAt: finance + 3_000, updatedAt: finance + 65_000, status: .failed, task: "登录财务平台下载本月对账单",
                         needsBrowser: true, ephemeral: true, harness: "claude-code", model: "claude-sonnet-5-5",
                         error: "凭据网关的代理连不上（gate proxy unreachable），没有登录。", acknowledgedAt: finance + 70_000),
            DispatchTask(id: "t5", createdAt: code + 3_000, updatedAt: code + 68_000, status: .done, task: "运行 git status 与测试",
                         cwd: home + "/Projects/AgentSwitch", harness: "codex", model: "gpt-6-luna",
                         result: "两条都已运行，工作区干净，测试全部通过。\n```text\n Test Files  2 passed (2)\n      Tests  31 passed (31)\n   Duration  1.12s\n```\n`git status --short` 没有输出。",
                         acknowledgedAt: code + 70_000),
            DispatchTask(id: "t3", createdAt: sort + 3_000, updatedAt: sort + 193_000, status: .done, task: "整理下载目录里的重复文件",
                         cwd: home + "/Downloads", harness: "opencode", model: "deepseek-flash",
                         result: "一共 42 个文件，重复的 9 个放进了“重复”文件夹，清单在 report.md。", acknowledgedAt: sort + 200_000),
            DispatchTask(id: "t2", createdAt: ms(now) - 300_000, updatedAt: ms(now) - 20_000, status: .waitingApproval, task: "清理旧构建",
                         cwd: home + "/Projects/AgentSwitch", parentId: "t0", threadId: "th2", harness: "codex", model: "gpt-6-luna"),
            DispatchTask(id: "t1", createdAt: ms(now) - 134_000, updatedAt: ms(now) - 6_000, status: .running,
                         task: "构建 AgentSwitch.app，装到手机上", cwd: home + "/Projects/AgentSwitch", parentId: "t0",
                         attachments: [screenshot], threadId: "th1", harness: "claude-code", model: "claude-opus-5-5"),
        ]

        let install = "xcrun devicectl device install app --device 00008150-… AgentSwitch.app"
        approvals = [
            DispatchApproval(id: "a2", taskId: "t2", createdAt: ms(now) - 20_000, kind: .question, action: "build/ 里有 3.2 GB 旧产物，要删掉吗？",
                             evidence: #"{"source":"executor","questions":[{"id":"q1","header":"清理","text":"build/ 里有 3.2 GB 旧产物，要删掉吗？","options":[{"label":"Keep"},{"label":"Delete"}]}]}"#),
            DispatchApproval(id: "a1", taskId: "t1", createdAt: ms(now) - 6_000, kind: .approval, action: "Bash: " + install,
                             evidence: #"{"command":"\#(install)","description":"安装到手机"}"#),
        ]

        threads = [
            DispatchThread(id: "th1", createdAt: ms(now) - 3_600_000, updatedAt: ms(now) - 6_000, title: "发布 AgentSwitch",
                           summary: DispatchThreadSummary(goal: "把 AgentSwitch 打包并装到手机上。", progress: "测试已通过，正在构建。"),
                           lastTarget: DispatchTarget(harness: "claude-code", model: "claude-opus-5-5"), lastActivity: ms(now) - 6_000, taskCount: 2),
            DispatchThread(id: "th2", createdAt: ms(now) - 300_000, updatedAt: ms(now) - 20_000, title: "清理磁盘",
                           lastTarget: DispatchTarget(harness: "codex", model: "gpt-6-luna"), lastActivity: ms(now) - 20_000, taskCount: 1),
        ]

        let begin = ms(now) - 130_000
        func event(_ seq: Int64, _ at: Int64, _ type: String, _ payload: [String: DispatchJSON]) -> DispatchTaskEvent {
            DispatchTaskEvent(taskId: "t1", seq: seq, ts: begin + at, type: type, payload: .object(payload))
        }
        func step(_ n: Int) -> [String: DispatchJSON] {
            ["n": .number(Double(n)), "action": .string("dispatch"),
             "target": .object(["harness": .string("claude-code"), "model": .string("claude-opus-5-5")])]
        }
        func call(_ id: String, _ tool: String, _ input: [String: DispatchJSON]) -> [String: DispatchJSON] {
            ["tool": .string(tool), "id": .string(id), "input": .object(input)]
        }
        events = ["t1": [
            event(1, 0, "step", ["n": .number(0), "action": .string("intake")]),
            event(2, 1_000, "step", step(1)),
            event(3, 2_000, "dispatched", ["harness": .string("claude-code"), "model": .string("claude-opus-5-5")]),
            event(4, 6_000, "tool_call", call("c4", "Read", ["file_path": .string("packages/ios-app/project.yml")])),
            event(5, 6_100, "tool_result", ["id": .string("c4"), "ok": .bool(true), "output": .string("name: AgentSwitch\noptions:\n  bundleIdPrefix: dev.agentswitch")]),
            event(6, 9_000, "text", ["text": .string("工程配置无误，先运行测试。")]),
            event(7, 10_000, "step", step(2)),
            event(8, 11_000, "tool_call", call("c8", "Bash", ["command": .string("npm test"), "description": .string("运行测试")])),
            event(9, 69_000, "tool_result", ["id": .string("c8"), "ok": .bool(true), "output": .string("Test Files  135 passed (135)\n     Tests  1196 passed (1196)")]),
            event(10, 72_000, "text", ["text": .string("测试通过，开始构建。")]),
            event(11, 73_000, "step", step(3)),
            event(12, 76_000, "tool_call", call("c12", "Bash", ["command": .string("xcodebuild -scheme AgentSwitch")])),
            event(13, 128_000, "approval_request", ["kind": .string("approval"), "action": .string("Bash: " + install)]),
        ]]

        files = ["t3": [Self.downloaded.file,
                        DispatchTaskFile(path: "out/dupes.txt", size: 1_240, isDeliverable: true)]]

        let catalog = #"""
        {"harnesses":{"claude-code":{"models":{"claude-opus-5-5":{},"claude-sonnet-5-5":{}}},"codex":{"models":{"gpt-6-luna":{}}},
         "opencode":{"models":{"deepseek-flash":{}}}},"router":{"harness":"claude-code","model":"claude-sonnet-5-5"},"quota":{}}
        """#
        targets = try! JSONDecoder().decode(DispatchTargets.self, from: Data(catalog.utf8))
    }
}
#endif

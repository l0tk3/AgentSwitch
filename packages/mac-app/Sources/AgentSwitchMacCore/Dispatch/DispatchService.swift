import Foundation

/// Everything the Dispatch page and the settings window's Dispatch group ask of a Mac (docs/dispatch-v0.md §2, §3).
/// The views depend on this protocol only: `DaemonClient` (this Mac's local API, local token) conforms today; a remote
/// Mac (pinned TLS, device token) can conform later without the views changing (§6). Paths in the comments are the
/// daemon's routes (packages/daemon/src/api).
public protocol DispatchService: Sendable {
    // MARK: the conversation (assistant-v0 §1.1)

    /// `GET /assistant?last=`: the newest `count` messages, oldest first (the first load).
    func messages(last count: Int) async throws -> [DispatchMessage]
    /// `GET /assistant?after=`: what came after `seq` (each poll).
    func messages(after seq: Int) async throws -> [DispatchMessage]
    /// `POST /assistant`: the input box. Sent once; a resend after a lost reply uses the same client id.
    func send(_ message: DispatchNewMessage) async throws -> DispatchAssistantReply
    /// `DELETE /assistant/:seq`: one entry from any of its lines, with the tasks its answers created (409 while one runs).
    func deleteEntry(seq: Int) async throws

    // MARK: tasks

    /// `GET /tasks?limit=`: the newest tasks, newest first.
    func tasks(limit: Int) async throws -> [DispatchTask]
    /// `GET /tasks/:id`: the task and its pending approvals.
    func task(id: String) async throws -> DispatchTaskDetail
    /// `GET /approvals`: every pending approval and question.
    func approvals() async throws -> [DispatchApproval]
    /// `POST /tasks/:id/approve {approval_id, decision}`.
    func decide(taskId: String, approvalId: String, decision: DispatchApprovalDecision) async throws
    /// `POST /tasks/:id/answer {approval_id, answers}`: answers by question id (DispatchQuestionForm.answers).
    func answer(taskId: String, approvalId: String, answers: [String: [String]]) async throws
    /// `POST /tasks/:id/cancel`: the task as it is now.
    func cancel(taskId: String) async throws -> DispatchTask
    /// `POST /tasks/:id/handoff {to?}`: a follow-up in the same topic on another executor (`nil`: the router picks one,
    /// leaving out the current executor); returns the new task.
    func handoff(taskId: String, to target: DispatchTarget?) async throws -> DispatchTask
    /// `[ Retry ]`: the daemon has no retry route; this is a handoff pinned to the task's own executor (any executor
    /// when it never ran), so the same request runs again as a follow-up. Returns the new task.
    func retry(_ task: DispatchTask) async throws -> DispatchTask
    /// `POST /tasks/:id/rate {rating}`: 1 useful, -1 not useful, nil clears.
    func rate(taskId: String, rating: Int?) async throws
    /// `POST /tasks/:id/ack`: opened, no longer unread; the time the Mac recorded.
    @discardableResult func acknowledge(taskId: String) async throws -> Int64?
    /// `DELETE /tasks/:id` (409 while it runs).
    func deleteTask(id: String) async throws
    /// `GET /tasks/:id/files`.
    func taskFiles(taskId: String) async throws -> [DispatchTaskFile]
    /// `GET /tasks/:id/files/<path>` written to `destination` (replaced if there); returns `destination`.
    @discardableResult func downloadTaskFile(taskId: String, path: String, to destination: URL) async throws -> URL
    /// `GET /tasks/:id/events?after=` (SSE): replays what came after `after`, then follows; reconnects from the last
    /// event it delivered; ends after done, partial, blocked, failed or cancelled, or at once for an ended task.
    func taskEvents(taskId: String, after: Int64) -> AsyncThrowingStream<DispatchTaskEvent, Error>

    // MARK: topics (threads-v0)

    /// `GET /threads?status=&limit=`.
    func threads(_ filter: DispatchThreadFilter, limit: Int) async throws -> [DispatchThread]
    /// `GET /threads/:id`: the topic, its summary and its tasks.
    func thread(id: String) async throws -> DispatchThreadDetail
    /// `PATCH /threads/:id {title}`: rename; nil goes back to the summarizer's title.
    func renameThread(id: String, title: String?) async throws -> DispatchThread
    /// `POST /threads/:id/archive` (409 while a task in it runs; deleted 7 days later unless reopened).
    func archiveThread(id: String) async throws -> DispatchThread
    /// `POST /threads/:id/reopen`.
    func reopenThread(id: String) async throws -> DispatchThread
    /// `DELETE /threads/:id`: the topic with its tasks (409 while one runs).
    func deleteThread(id: String) async throws

    // MARK: the input box

    /// `POST /uploads` (multipart, sent once): ids for `DispatchNewMessage.attachments`.
    func upload(_ files: [DispatchUploadFile]) async throws -> [DispatchStagedUpload]
    /// `GET /targets`: the catalog behind `Pin Model` and `Hand to ▾` (DispatchTargets.pinOptions).
    func targets() async throws -> DispatchTargets

    // MARK: the settings group (docs/dispatch-v0.md §3)

    /// `GET /context`: context.md.
    func context() async throws -> DispatchTextDocument
    /// `GET /context/example`.
    func contextExample() async throws -> String
    /// `PUT /context {text}`: sealed like a task (may wait for the sealer), linted; what was sealed comes back.
    func saveContext(_ text: String) async throws -> DispatchSaveResult
    /// `GET /memory`: memory.md.
    func memory() async throws -> DispatchTextDocument
    /// `PUT /memory {text}`: linted.
    func saveMemory(_ text: String) async throws -> DispatchSaveResult
    /// `GET /platform-memory`: platform experience, one record per site observation.
    func platformMemory() async throws -> [DispatchPlatformMemory]
    /// `DELETE /platform-memory/:id`.
    func deletePlatformMemory(id: String) async throws
    /// `GET /mcp`.
    func mcpServers() async throws -> [DispatchMCPServer]
    /// `PUT /mcp/:name`: add or replace (a toggle is `server.toggled()`).
    func saveMCPServer(_ server: DispatchMCPServer) async throws -> DispatchMCPServer
    /// `DELETE /mcp/:name`.
    func deleteMCPServer(name: String) async throws
    /// `GET /skills`.
    func skills() async throws -> [DispatchSkill]
    /// `GET /skills/:name`: with its SKILL.md.
    func skill(name: String) async throws -> DispatchSkillDetail
    /// `PUT /skills/:name`: create or change (content, switch, harnesses).
    func saveSkill(name: String, _ update: DispatchSkillUpdate) async throws -> DispatchSkill
    /// `DELETE /skills/:name`.
    func deleteSkill(name: String) async throws
    /// `GET /skills/discover`: skills in the user's own agent folders.
    func discoverSkills() async throws -> [DispatchDiscoveredSkill]
    /// `POST /skills/import {path}`.
    func importSkill(path: String) async throws -> DispatchSkill
    /// `GET /routing/log?limit=`: the router's decisions, newest first.
    func routingLog(limit: Int) async throws -> [DispatchRoutingLogEntry]
    /// `GET /search?q=&limit=`: tasks and their results (control-v0 §4).
    func search(query: String, limit: Int) async throws -> [DispatchSearchResult]
    /// `DELETE /history`: every topic, task and conversation line (409 while a task runs; then nothing is deleted).
    func clearHistory() async throws
}

/// The page's defaults (the phone's, app-v0 §5).
public enum DispatchDefaults {
    /// Lists and the conversation are polled this often while the window is visible (docs/dispatch-v0.md §2).
    public static let pollInterval: Duration = .seconds(6)
    /// How many of the newest tasks the list asks for.
    public static let taskListLimit = 50
    /// The conversation's first load.
    public static let firstMessages = 60
    public static let threadListLimit = 50
    public static let archivedThreadListLimit = 100
    public static let routingLogLimit = 50
    public static let searchLimit = 30
}

extension DispatchService {
    public func tasks() async throws -> [DispatchTask] { try await tasks(limit: DispatchDefaults.taskListLimit) }
    public func threads(_ filter: DispatchThreadFilter = .open) async throws -> [DispatchThread] {
        try await threads(filter, limit: filter == .archived ? DispatchDefaults.archivedThreadListLimit : DispatchDefaults.threadListLimit)
    }
    public func routingLog() async throws -> [DispatchRoutingLogEntry] { try await routingLog(limit: DispatchDefaults.routingLogLimit) }
    public func search(query: String) async throws -> [DispatchSearchResult] { try await search(query: query, limit: DispatchDefaults.searchLimit) }
    public func taskEvents(taskId: String) -> AsyncThrowingStream<DispatchTaskEvent, Error> { taskEvents(taskId: taskId, after: 0) }
}

extension DispatchTask {
    /// The executor `[ Retry ]` pins (DispatchService.retry): where it ran, else its pin, else nil (the router picks).
    public var retryTarget: DispatchTarget? {
        guard let harness, let model else { return pin }
        return DispatchTarget(harness: harness, model: model)
    }
}

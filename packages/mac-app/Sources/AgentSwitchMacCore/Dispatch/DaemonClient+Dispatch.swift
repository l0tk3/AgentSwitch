import Foundation

/// How long each kind of Dispatch call may take. Set on every request: an explicit `URLRequest.timeoutInterval` wins over
/// the session's (URLSessionTransport's 5 s), so a slow but healthy answer is not taken for a failure and resent.
public enum DispatchTimeouts {
    /// Reads and quick writes (the phone's and the web console's 15 s).
    public static let request: TimeInterval = 15
    /// `POST /assistant`: the message is sealed, answered by the assistant and may create a task first.
    public static let assistant: TimeInterval = 90
    /// Writes that pass the sealer (`PUT /context`, `POST /tasks/:id/answer`, the console's 120 s).
    public static let sealing: TimeInterval = 120
    /// Uploads and downloads (up to 100 MB).
    public static let transfer: TimeInterval = 180
    /// Deletes that cascade (the console's 30 s).
    public static let delete: TimeInterval = 30
}

/// The Dispatch routes on this Mac's local API (127.0.0.1, local token; docs/dispatch-v0.md §2). Every route here is
/// reachable on the local listener (api/localAuth.ts: Bearer token; api/localGuard.ts: JSON bodies, multipart only for
/// `POST /uploads`).
extension DaemonClient: DispatchService {
    // MARK: the conversation

    public func messages(last count: Int) async throws -> [DispatchMessage] {
        try await get(DispatchMessageList.self, "/assistant?last=\(count)").messages
    }

    public func messages(after seq: Int) async throws -> [DispatchMessage] {
        try await get(DispatchMessageList.self, "/assistant?after=\(seq)").messages
    }

    public func send(_ message: DispatchNewMessage) async throws -> DispatchAssistantReply {
        try await write(DispatchAssistantReply.self, "POST", "/assistant", message, timeout: DispatchTimeouts.assistant)
    }

    public func deleteEntry(seq: Int) async throws {
        _ = try await dispatchCall("DELETE", "/assistant/\(seq)", timeout: DispatchTimeouts.delete)
    }

    // MARK: tasks

    public func tasks(limit: Int) async throws -> [DispatchTask] {
        try await get([DispatchTask].self, "/tasks?limit=\(limit)")
    }

    public func task(id: String) async throws -> DispatchTaskDetail {
        try await get(DispatchTaskDetail.self, "/tasks/\(Self.segment(id))")
    }

    public func approvals() async throws -> [DispatchApproval] {
        try await get([DispatchApproval].self, "/approvals")
    }

    public func decide(taskId: String, approvalId: String, decision: DispatchApprovalDecision) async throws {
        struct Body: Encodable { let approval_id: String; let decision: DispatchApprovalDecision }
        _ = try await dispatchCall("POST", "/tasks/\(Self.segment(taskId))/approve", json: Body(approval_id: approvalId, decision: decision))
    }

    public func answer(taskId: String, approvalId: String, answers: [String: [String]]) async throws {
        struct Body: Encodable { let approval_id: String; let answers: [String: [String]] }
        _ = try await dispatchCall("POST", "/tasks/\(Self.segment(taskId))/answer", json: Body(approval_id: approvalId, answers: answers),
                                   timeout: DispatchTimeouts.sealing)
    }

    public func cancel(taskId: String) async throws -> DispatchTask {
        try await write(DispatchTask.self, "POST", "/tasks/\(Self.segment(taskId))/cancel", DispatchEmptyBody())
    }

    public func handoff(taskId: String, to target: DispatchTarget?) async throws -> DispatchTask {
        struct Body: Encodable { let to: DispatchTarget? }
        return try await write(DispatchTask.self, "POST", "/tasks/\(Self.segment(taskId))/handoff", Body(to: target))
    }

    public func retry(_ task: DispatchTask) async throws -> DispatchTask {
        try await handoff(taskId: task.id, to: task.retryTarget)
    }

    public func rate(taskId: String, rating: Int?) async throws {
        _ = try await dispatchCall("POST", "/tasks/\(Self.segment(taskId))/rate", json: DispatchNullable(key: "rating", value: rating))
    }

    @discardableResult
    public func acknowledge(taskId: String) async throws -> Int64? {
        try await write(DispatchAckReply.self, "POST", "/tasks/\(Self.segment(taskId))/ack", DispatchEmptyBody()).acknowledgedAt
    }

    public func deleteTask(id: String) async throws {
        _ = try await dispatchCall("DELETE", "/tasks/\(Self.segment(id))", timeout: DispatchTimeouts.delete)
    }

    public func taskFiles(taskId: String) async throws -> [DispatchTaskFile] {
        try await get(DispatchTaskFileList.self, "/tasks/\(Self.segment(taskId))/files").taskFiles
    }

    @discardableResult
    public func downloadTaskFile(taskId: String, path: String, to destination: URL) async throws -> URL {
        let segments = path.split(separator: "/").map { Self.segment(String($0)) }.joined(separator: "/")
        let route = "/tasks/\(Self.segment(taskId))/files/\(segments)"
        let data: Data
        do {
            data = try await dispatchCall("GET", route, accept: "*/*", timeout: DispatchTimeouts.transfer)
        } catch DaemonError.notSupported(_) {
            // The route exists; a plain 404 here means the file is gone (or was never one of the task's own).
            throw DaemonError.http(status: 404, message: "文件不存在或已删除")
        }
        do {
            try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: destination, options: .atomic)
        } catch {
            throw DaemonError.decoding("无法保存文件：\(error.localizedDescription)")
        }
        // Never left on disk without the quarantine mark.
        do {
            try DispatchQuarantine.mark(destination)
        } catch {
            try? FileManager.default.removeItem(at: destination)
            throw DaemonError.decoding("无法为下载的文件添加隔离标记：\(error.localizedDescription)")
        }
        return destination
    }

    // MARK: topics

    public func threads(_ filter: DispatchThreadFilter, limit: Int) async throws -> [DispatchThread] {
        let status = filter == .all ? "" : "status=\(filter.rawValue)&"
        return try await get([DispatchThread].self, "/threads?\(status)limit=\(limit)")
    }

    public func thread(id: String) async throws -> DispatchThreadDetail {
        try await get(DispatchThreadDetail.self, "/threads/\(Self.segment(id))")
    }

    public func renameThread(id: String, title: String?) async throws -> DispatchThread {
        let title = title?.trimmingCharacters(in: .whitespacesAndNewlines)
        return try await write(DispatchThread.self, "PATCH", "/threads/\(Self.segment(id))",
                               DispatchNullable(key: "title", value: title?.isEmpty == true ? nil : title))
    }

    public func archiveThread(id: String) async throws -> DispatchThread {
        try await write(DispatchThread.self, "POST", "/threads/\(Self.segment(id))/archive", DispatchEmptyBody())
    }

    public func reopenThread(id: String) async throws -> DispatchThread {
        try await write(DispatchThread.self, "POST", "/threads/\(Self.segment(id))/reopen", DispatchEmptyBody())
    }

    public func deleteThread(id: String) async throws {
        _ = try await dispatchCall("DELETE", "/threads/\(Self.segment(id))", timeout: DispatchTimeouts.delete)
    }

    // MARK: the input box

    public func upload(_ files: [DispatchUploadFile]) async throws -> [DispatchStagedUpload] {
        let boundary = "agentswitch-\(UUID().uuidString)"
        let data = try await dispatchCall("POST", "/uploads", body: DispatchMultipart.body(files, boundary: boundary),
                                          contentType: "multipart/form-data; boundary=\(boundary)", timeout: DispatchTimeouts.transfer)
        return try decode(DispatchStagedUploads.self, data).files
    }

    public func targets() async throws -> DispatchTargets {
        try await get(DispatchTargets.self, "/targets")
    }

    // MARK: the settings group

    public func context() async throws -> DispatchTextDocument {
        try await get(DispatchTextDocument.self, "/context")
    }

    public func contextExample() async throws -> String {
        try await get(DispatchTextDocument.self, "/context/example").text
    }

    public func saveContext(_ text: String) async throws -> DispatchSaveResult {
        try await write(DispatchSaveResult.self, "PUT", "/context", ["text": text], timeout: DispatchTimeouts.sealing)
    }

    public func memory() async throws -> DispatchTextDocument {
        try await get(DispatchTextDocument.self, "/memory")
    }

    public func saveMemory(_ text: String) async throws -> DispatchSaveResult {
        try await write(DispatchSaveResult.self, "PUT", "/memory", ["text": text])
    }

    public func platformMemory() async throws -> [DispatchPlatformMemory] {
        try await get(DispatchPlatformMemoryList.self, "/platform-memory").records
    }

    public func deletePlatformMemory(id: String) async throws {
        _ = try await dispatchCall("DELETE", "/platform-memory/\(Self.segment(id))")
    }

    public func mcpServers() async throws -> [DispatchMCPServer] {
        try await get([DispatchMCPServer].self, "/mcp")
    }

    public func saveMCPServer(_ server: DispatchMCPServer) async throws -> DispatchMCPServer {
        try await write(DispatchMCPServer.self, "PUT", "/mcp/\(Self.segment(server.name))", server)
    }

    public func deleteMCPServer(name: String) async throws {
        _ = try await dispatchCall("DELETE", "/mcp/\(Self.segment(name))")
    }

    public func skills() async throws -> [DispatchSkill] {
        try await get([DispatchSkill].self, "/skills")
    }

    public func skill(name: String) async throws -> DispatchSkillDetail {
        try await get(DispatchSkillDetail.self, "/skills/\(Self.segment(name))")
    }

    public func saveSkill(name: String, _ update: DispatchSkillUpdate) async throws -> DispatchSkill {
        try await write(DispatchSkill.self, "PUT", "/skills/\(Self.segment(name))", update)
    }

    public func deleteSkill(name: String) async throws {
        _ = try await dispatchCall("DELETE", "/skills/\(Self.segment(name))")
    }

    public func discoverSkills() async throws -> [DispatchDiscoveredSkill] {
        try await get([DispatchDiscoveredSkill].self, "/skills/discover")
    }

    public func importSkill(path: String) async throws -> DispatchSkill {
        try await write(DispatchSkill.self, "POST", "/skills/import", ["path": path])
    }

    public func routingLog(limit: Int) async throws -> [DispatchRoutingLogEntry] {
        try await get([DispatchRoutingLogEntry].self, "/routing/log?limit=\(limit)")
    }

    public func search(query: String, limit: Int) async throws -> [DispatchSearchResult] {
        let q = String(query.prefix(200))
        guard !q.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
        return try await get(DispatchSearchResults.self, "/search?q=\(Self.segment(q))&limit=\(limit)").results
    }

    public func clearHistory() async throws {
        _ = try await dispatchCall("DELETE", "/history", timeout: DispatchTimeouts.delete)
    }

    // MARK: plumbing

    private func get<T: Decodable>(_ type: T.Type, _ path: String) async throws -> T {
        try decode(T.self, try await dispatchCall("GET", path))
    }

    private func write<T: Decodable, B: Encodable>(_ type: T.Type, _ method: String, _ path: String, _ body: B,
                                                   timeout: TimeInterval = DispatchTimeouts.request) async throws -> T {
        try decode(T.self, try await dispatchCall(method, path, json: body, timeout: timeout))
    }

    func dispatchCall<B: Encodable>(_ method: String, _ path: String, json body: B,
                                    timeout: TimeInterval = DispatchTimeouts.request) async throws -> Data {
        let data: Data
        do { data = try JSONEncoder().encode(body) } catch { throw DaemonError.decoding("request body: \(error)") }
        return try await dispatchCall(method, path, body: data, timeout: timeout)
    }

    /// One request, sent once (never retried: a POST must not create twice), with the local token and its own timeout;
    /// errors as `call` reports them, a cancelled call as CancellationError.
    func dispatchCall(_ method: String, _ path: String, body: Data? = nil, contentType: String = "application/json",
                      accept: String = "application/json", timeout: TimeInterval = DispatchTimeouts.request) async throws -> Data {
        let request = try dispatchRequest(method, path, body: body, contentType: contentType, accept: accept, timeout: timeout)
        let data: Data, response: HTTPURLResponse
        do {
            (data, response) = try await transport.send(request)
        } catch {
            throw dispatchTransportError(error)
        }
        return try Self.dispatchCheck(data, response, route: "\(method) \(path)")
    }

    func dispatchRequest(_ method: String, _ path: String, body: Data? = nil, contentType: String = "application/json",
                         accept: String = "application/json", timeout: TimeInterval = DispatchTimeouts.request) throws -> URLRequest {
        guard URL(string: baseURL.absoluteString + path) != nil else { throw DaemonError.unreachable("无效路径 \(path)") }
        var request = request(method, path)
        request.timeoutInterval = timeout
        request.setValue(accept, forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = body
            request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        }
        return request
    }

    /// A failure before any answer: a cancelled call stays a cancellation; anything else means the service is not there.
    func dispatchTransportError(_ error: Error) -> Error {
        if error is DaemonError || error is CancellationError { return error }
        if let urlError = error as? URLError, urlError.code == .cancelled { return CancellationError() }
        return DaemonError.unreachable("\(baseURL.host() ?? "127.0.0.1"):\(baseURL.port ?? 0) \(error.localizedDescription)")
    }

    /// 2xx passes; a plain-text 404 is a route this daemon lacks; anything else carries the daemon's `{error}`.
    static func dispatchCheck(_ data: Data, _ response: HTTPURLResponse, route: String) throws -> Data {
        switch response.statusCode {
        case 200..<300: return data
        case 404 where jsonError(data) == nil: throw DaemonError.notSupported(route)
        default: throw DaemonError.http(status: response.statusCode, message: errorMessage(data))
        }
    }
}

/// `{}`: a POST that carries nothing (sent as JSON, which the local guard accepts).
struct DispatchEmptyBody: Encodable {}

/// `{key: value}` with an explicit `null` for nil (`rating: null` clears a rating, `title: null` a topic's own title).
struct DispatchNullable<Value: Encodable>: Encodable {
    let key: String
    let value: Value?

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: AnyKey.self)
        try c.encode(value, forKey: AnyKey(key))
    }
}

/// `POST /tasks/:id/ack`: the time the daemon recorded, at the top level or in `task`.
struct DispatchAckReply: Decodable {
    let acknowledgedAt: Int64?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        let nested = c.first(DispatchJSON.self, "task")?["acknowledgedAt"]?.number.map { Int64($0) }
        acknowledgedAt = c.first(Int64.self, "acknowledgedAt") ?? nested
    }
}

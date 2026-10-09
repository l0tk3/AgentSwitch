import Foundation

/// Client for the daemon's remote API (app-v0 §2). Every call goes through the pinned transport to whatever endpoint the
/// provider selects; a network failure is reported back so the next call re-selects. GETs are retried once on a fresh
/// endpoint; POST, PUT and DELETE never (a task must not be created twice, a delete must not be reported twice).
public struct AgentSwitchAPI: Sendable {
    public let endpoints: any EndpointProviding
    public let transport: any HTTPTransport
    public let token: String?
    public var requestTimeout: TimeInterval = 15
    /// Which browser the browser routes are asked of (docs/profiles-v0.md §5.4): nil, the shared one; else a profile's
    /// own, by its key (`forBrowser`).
    public internal(set) var browserKey: String?
    /// `POST /tasks` answers only after the sealer (up to 30 s on the Mac) has run; give it room so a slow answer is
    /// not taken for a failure and the task sent twice.
    public static let createTaskTimeout: TimeInterval = 60
    /// Up to 100 MB of attachments over a phone connection.
    public static let uploadTimeout: TimeInterval = 180
    /// A message is sealed, answered by the assistant and may create a task before the reply comes back.
    public static let assistantTimeout: TimeInterval = 90

    public init(endpoints: any EndpointProviding, transport: any HTTPTransport, token: String?) {
        self.endpoints = endpoints
        self.transport = transport
        self.token = token
    }

    // MARK: - routes

    public func health() async throws -> Health { try await get(["healthz"]) }
    public func me() async throws -> Me { try await get(["me"]) }
    public func addresses() async throws -> MacAddresses { try await get(["addresses"]) }
    public func gatePubkey() async throws -> GatePubkey { try await get(["gate", "pubkey"]) }

    /// How many of the newest tasks the list asks for.
    public static let taskListLimit = 50

    public func tasks(limit: Int = taskListLimit) async throws -> [AgentTask] {
        try await get(["tasks"], query: [URLQueryItem(name: "limit", value: String(limit))])
    }

    public func task(_ id: String) async throws -> TaskDetail { try await get(["tasks", id]) }

    public func createTask(_ body: NewTaskRequest) async throws -> AgentTask {
        try await send("POST", ["tasks"], body: body, timeout: Self.createTaskTimeout)
    }

    public func approve(taskId: String, approvalId: String, decision: ApprovalDecision) async throws {
        let _: OKReply = try await post(["tasks", taskId, "approve"], body: ApproveRequest(approvalId: approvalId, decision: decision))
    }

    public func answer(taskId: String, approvalId: String, answers: [String: [String]]) async throws {
        let _: OKReply = try await post(["tasks", taskId, "answer"], body: AnswerRequest(approvalId: approvalId, answers: answers))
    }

    public func cancel(taskId: String) async throws -> AgentTask { try await post(["tasks", taskId, "cancel"], body: EmptyBody()) }

    /// Hands the task to another executor; returns the follow-up task that continues it.
    public func handoff(taskId: String, to target: TargetRef? = nil) async throws -> AgentTask {
        try await post(["tasks", taskId, "handoff"], body: HandoffRequest(to: target))
    }

    public func approvals() async throws -> [Approval] { try await get(["approvals"]) }
    public func threads(limit: Int = 50) async throws -> [AgentThread] {
        try await get(["threads"], query: [URLQueryItem(name: "limit", value: String(limit))])
    }
    public func thread(_ id: String) async throws -> ThreadDetail { try await get(["threads", id]) }
    public func quota() async throws -> [QuotaReading] { try await get(["quota"]) }
    public func refreshQuota() async throws -> [QuotaReading] { try await post(["quota", "refresh"], body: EmptyBody()) }
    public func targets() async throws -> Targets { try await get(["targets"]) }

    /// CONTEXT.md on the Mac (app-v0 §2): read, the daemon's example, and save. A save is sealed like a task (so it
    /// may wait for the sealer too) and returns the lint's warnings and what was sealed.
    public func context() async throws -> ContextDocument { try await get(["context"]) }
    public func contextExample() async throws -> String { (try await get(["context", "example"]) as ContextExample).text }
    public func saveContext(_ text: String) async throws -> ContextSaveResult {
        try await send("PUT", ["context"], body: SaveContextRequest(text: text), timeout: Self.createTaskTimeout)
    }

    /// The input box (assistant-v0 §1.1): sent once; a resend after a lost reply uses the same client id.
    public func sendMessage(_ message: NewMessage) async throws -> AssistantReply {
        try await send("POST", ["assistant"], body: message, timeout: Self.assistantTimeout)
    }

    public func assistantMessages(after seq: Int) async throws -> [AssistantMessage] {
        (try await get(["assistant"], query: [URLQueryItem(name: "after", value: String(seq))]) as AssistantMessages).messages
    }

    /// The newest `count` messages, oldest first: the first load of the conversation.
    public func assistantMessages(last count: Int) async throws -> [AssistantMessage] {
        (try await get(["assistant"], query: [URLQueryItem(name: "last", value: String(count))]) as AssistantMessages).messages
    }

    /// Deletes one entry of the home screen from any of its lines (threads-v0 手动删除): a message with its answers and
    /// the tasks they created, or a line on its own. 409 while such a task still runs.
    public func deleteEntry(_ seq: Int) async throws {
        let _: OKReply = try await perform("DELETE", ["assistant", String(seq)], query: [], body: nil)
    }

    /// Deletes all history: every topic, task and conversation line. 409 while a task runs; then nothing is deleted.
    public func clearHistory() async throws {
        let _: OKReply = try await perform("DELETE", ["history"], query: [], body: nil)
    }

    /// Stages files for a task (multipart, sent once); pass the ids as `NewTaskRequest.attachments`.
    public func upload(_ files: [UploadFile]) async throws -> [StagedUpload] {
        let boundary = "agentswitch-\(UUID().uuidString)"
        let reply: StagedUploads = try await perform("POST", ["uploads"], query: [], body: Multipart.body(files, boundary: boundary),
                                                     timeout: Self.uploadTimeout, contentType: "multipart/form-data; boundary=\(boundary)")
        return reply.files
    }

    /// A task's attachments and deliverables (`GET /tasks/:id/files`).
    public func taskFiles(_ taskId: String) async throws -> [TaskFile] {
        (try await get(["tasks", taskId, "files"]) as TaskFileList).taskFiles
    }

    /// One file's bytes; `path` as `taskFiles` lists it (each segment is encoded on its own).
    public func download(taskId: String, path: String) async throws -> Data {
        try await bytes(["tasks", taskId, "files"] + path.split(separator: "/").map(String.init))
    }

    /// A picture the user sent with a message of a session (docs/simple-view-v0.md §4, §5.1): the `n`-th of the record's
    /// item `item`, as the agent kept it. 404 from a Mac from before this route, for an agent read coarsely, or when
    /// the agent kept only where the file was and it is no longer there.
    public func sessionImage(harness: String, id: String, item: String, n: Int) async throws -> Data {
        try await bytes(["sessions", harness, id, "images", item, String(n)])
    }

    /// A picture a step brought back (a picture file it read, a screenshot a tool took): the `k`-th of the `n`-th step
    /// of the run of work `work`. 404 from a Mac from before this route.
    public func sessionStepImage(harness: String, id: String, work: String, n: Int, k: Int) async throws -> Data {
        try await bytes(["sessions", harness, id, "steps", work, String(n), "images", String(k)])
    }

    /// The `n`-th step of the run of work `work` of a session, whole (docs/simple-view-v0.md §4). Nil when the Mac has
    /// none (an older Mac, an agent read coarsely): the record's own line stays.
    public func sessionStep(harness: String, id: String, work: String, n: Int) async throws -> RecordStepDetail? {
        do {
            return try await get(["sessions", harness, id, "steps", work, String(n)])
        } catch APIError.http(status: 404, message: _) {
            return nil
        }
    }

    /// A file's bytes as they are.
    func bytes(_ segments: [String]) async throws -> Data {
        let endpoint = try await endpoints.endpoint()
        do {
            let (data, response) = try await transport.send(request("GET", endpoint, segments, query: [], body: nil, accept: "*/*", timeout: Self.uploadTimeout))
            try Self.check(data, response)
            return data
        } catch let error as APIError {
            if error.isNetworkFailure { await endpoints.reportFailure(endpoint) }
            throw error
        }
    }

    /// Cascading deletes with the Mac's semantics: a running task (or a thread with one) is refused with 409.
    public func deleteTask(_ id: String) async throws {
        let _: OKReply = try await perform("DELETE", ["tasks", id], query: [], body: nil)
    }

    public func deleteThread(_ id: String) async throws {
        let _: OKReply = try await perform("DELETE", ["threads", id], query: [], body: nil)
    }

    /// A newer AgentSwitch.app staged on the Mac, if any, and the last switch's outcome.
    public func appUpdate() async throws -> AppUpdateInfo { try await get(["update"]) }

    /// The user's go-ahead: the Mac app quits, swaps in the new version and restarts (the previous one comes back if
    /// the new one does not start). The connection drops meanwhile; the assistant reports the outcome.
    public func installUpdate() async throws {
        let _: InstallRequested = try await send("POST", ["update", "install"], body: [String: String]())
    }

    // MARK: - plumbing

    func get<T: Decodable>(_ path: [String], query: [URLQueryItem] = []) async throws -> T {
        do {
            return try await perform("GET", path, query: query, body: nil)
        } catch APIError.transport {
            return try await perform("GET", path, query: query, body: nil)
        }
    }

    func post<T: Decodable, B: Encodable>(_ path: [String], body: B) async throws -> T {
        try await send("POST", path, body: body)
    }

    /// A JSON write, sent once.
    func send<T: Decodable, B: Encodable>(_ method: String, _ path: [String], body: B, timeout: TimeInterval? = nil) async throws -> T {
        let data: Data
        do { data = try JSONEncoder().encode(body) } catch { throw APIError.decoding("request body: \(error)") }
        return try await perform(method, path, query: [], body: data, timeout: timeout)
    }

    func request(_ method: String, _ endpoint: APIEndpoint, _ path: [String], query: [URLQueryItem], body: Data?,
                 accept: String = "application/json", timeout: TimeInterval? = nil, contentType: String = "application/json") -> URLRequest {
        var req = URLRequest(url: endpoint.url(path, query: query), cachePolicy: .reloadIgnoringLocalCacheData,
                             timeoutInterval: timeout ?? requestTimeout)
        req.httpMethod = method
        req.setValue(accept, forHTTPHeaderField: "Accept")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            req.httpBody = body
            req.setValue(contentType, forHTTPHeaderField: "Content-Type")
        }
        return req
    }

    func perform<T: Decodable>(_ method: String, _ path: [String], query: [URLQueryItem], body: Data?,
                                       timeout: TimeInterval? = nil, contentType: String = "application/json") async throws -> T {
        let endpoint = try await endpoints.endpoint()
        let (data, response): (Data, HTTPURLResponse)
        do {
            (data, response) = try await transport.send(request(method, endpoint, path, query: query, body: body, timeout: timeout, contentType: contentType))
        } catch let error as APIError {
            if error.isNetworkFailure { await endpoints.reportFailure(endpoint) }
            throw error
        }
        return try Self.decode(data, response)
    }

    static func decode<T: Decodable>(_ data: Data, _ response: HTTPURLResponse) throws -> T {
        try check(data, response)
        do { return try JSONDecoder().decode(T.self, from: data) } catch { throw APIError.decoding(String(describing: error)) }
    }

    /// 2xx passes; 401 is `.unauthorized`; anything else carries the daemon's `{error}` text.
    static func check(_ data: Data, _ response: HTTPURLResponse) throws {
        switch response.statusCode {
        case 200..<300: return
        case 401: throw APIError.unauthorized
        default:
            let message = (try? JSONDecoder().decode(ErrorReply.self, from: data))?.error ?? ""
            throw APIError.http(status: response.statusCode, message: message)
        }
    }
}

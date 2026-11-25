import Foundation

/// Client for the daemon's remote API (app-v0 §2). Every call goes through the pinned transport to whatever endpoint the
/// provider selects; a network failure is reported back so the next call re-selects. GETs are retried once on a fresh
/// endpoint; POST, PUT and DELETE never (a write must not be made twice, a delete must not be reported twice).
public struct AgentSwitchAPI: Sendable {
    public let endpoints: any EndpointProviding
    public let transport: any HTTPTransport
    public let token: String?
    public var requestTimeout: TimeInterval = 15
    /// Which browser the browser routes are asked of (docs/profiles-v0.md §5.4): nil, the shared one; else a profile's
    /// own, by its key (`forBrowser`).
    public internal(set) var browserKey: String?
    /// A write the Mac may seal before it answers (up to 30 s there); room so a slow answer is not taken for a failure
    /// and the write sent twice.
    public static let createTaskTimeout: TimeInterval = 60
    /// Up to 100 MB of attachments over a phone connection.
    public static let uploadTimeout: TimeInterval = 180

    public init(endpoints: any EndpointProviding, transport: any HTTPTransport, token: String?) {
        self.endpoints = endpoints
        self.transport = transport
        self.token = token
    }

    // MARK: - routes

    public func health() async throws -> Health { try await get(["healthz"]) }
    public func me() async throws -> Me { try await get(["me"]) }
    public func addresses() async throws -> MacAddresses { try await get(["addresses"]) }
    /// Stages files on the Mac (multipart, sent once); a reply or a room's message names them by the ids.
    public func upload(_ files: [UploadFile]) async throws -> [StagedUpload] {
        let boundary = "agentswitch-\(UUID().uuidString)"
        let reply: StagedUploads = try await perform("POST", ["uploads"], query: [], body: Multipart.body(files, boundary: boundary),
                                                     timeout: Self.uploadTimeout, contentType: "multipart/form-data; boundary=\(boundary)")
        return reply.files
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

    /// A newer AgentSwitch.app staged on the Mac, if any, and the last switch's outcome.
    public func appUpdate() async throws -> AppUpdateInfo { try await get(["update"]) }

    /// The user's go-ahead: the Mac app quits, swaps in the new version and restarts (the previous one comes back if
    /// the new one does not start). The connection drops meanwhile; `appUpdate` says how it went.
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

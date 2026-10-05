import Foundation

public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public struct URLSessionTransport: HTTPTransport {
    /// The one session every client shares unless it is given a transport of its own. The app makes a client each time
    /// it needs one (AppModel.client), several a second: a session each meant a new connection for every request.
    public static let shared = URLSessionTransport()

    private let session: URLSession

    public init(timeout: TimeInterval = 5) {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = timeout
        config.connectionProxyDictionary = [:]   // loopback only; never through a system proxy
        session = URLSession(configuration: config)
    }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw DaemonError.unreachable("非 HTTP 响应") }
        return (data, http)
    }
}

public enum DaemonError: LocalizedError, Equatable, Sendable {
    case unreachable(String)
    case http(status: Int, message: String)
    /// 404 on a management route: the bundled daemon predates it (or remote mode is off).
    case notSupported(String)
    case decoding(String)

    public var errorDescription: String? {
        switch self {
        case .unreachable(let why): return "无法连接服务：\(why)"
        case .http(let status, let message): return "服务返回 \(status)：\(message)"
        case .notSupported(let path): return "服务不支持 \(path)（404）：内置服务版本较旧，或 iPhone 连接已关闭。"
        case .decoding(let why): return "无法解析服务的响应：\(why)"
        }
    }

    /// A refused request (400, 403, 409) in the daemon's own words, without the status; anything else as described.
    public var reason: String {
        if case .http(let status, let message) = self, (400..<500).contains(status) { return message }
        return errorDescription ?? ""
    }
}

/// What the service answered with, and the version to ask with next time (its `ETag`; nil when it names none).
public struct Versioned<Value: Sendable>: Sendable {
    public let value: Value
    public let version: String?

    public init(value: Value, version: String?) {
        self.value = value
        self.version = version
    }
}

/// Client of the daemon's loopback listener: the management routes only the Mac app uses (app-v0 §2).
public struct DaemonClient: Sendable {
    public let baseURL: URL
    /// Internal (not private) for the Dispatch routes' multipart, download and event-stream requests (Dispatch/).
    let transport: HTTPTransport
    /// The local API's token (daemon api/localAuth.ts): `$AGENTSWITCH_HOME/local-token`, written by the daemon on
    /// start-up. Read on every call, so a client made before the daemon's first start still gets it.
    private let tokenFile: URL?

    public init(port: Int, transport: HTTPTransport = URLSessionTransport.shared, tokenFile: URL? = nil) {
        baseURL = URL(string: "http://127.0.0.1:\(port)")!
        self.transport = transport
        self.tokenFile = tokenFile
    }

    public static let tokenFileName = "local-token"

    /// A one-time link that opens the web console signed in (valid for a minute, used once; never the token itself).
    /// `next`: the console page to land on (a `/ui/…` path; the daemon ignores anything else), e.g. the terminal page.
    public func consoleLink(next: String? = nil) async throws -> URL {
        struct Link: Decodable { let path: String }
        let query = next.flatMap { $0.addingPercentEncoding(withAllowedCharacters: .alphanumerics) }.map { "?next=\($0)" } ?? ""
        let link = try decode(Link.self, try await call("POST", "/local/console-link" + query, body: Data("{}".utf8)))
        guard let url = URL(string: baseURL.absoluteString + link.path) else { throw DaemonError.decoding("console link \(link.path)") }
        return url
    }

    public func health() async throws -> Health {
        try decode(Health.self, try await call("GET", "/healthz"))
    }

    /// `POST /pairing`: a one-time code (8 Crockford base32, 5 minutes, one use).
    public func createPairing() async throws -> Pairing {
        try decode(Pairing.self, try await call("POST", "/pairing", body: Data("{}".utf8)))
    }

    public func devices() async throws -> [Device] {
        let data = try await call("GET", "/devices")
        do { return try Device.decodeList(data) } catch { throw DaemonError.decoding(String(describing: error)) }
    }

    public func revokeDevice(id: String) async throws {
        let escaped = id.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_.~"))) ?? id
        _ = try await call("DELETE", "/devices/\(escaped)")
    }

    public func remoteInfo() async throws -> RemoteInfo {
        try decode(RemoteInfo.self, try await call("GET", "/remote/info"))
    }

    public func modelSettings() async throws -> ModelSettings {
        try decode(ModelSettings.self, try await call("GET", "/settings/models"))
    }

    public func saveModelSettings(_ update: ModelSettingsUpdate) async throws -> ModelSettingsSaveResult {
        let body = try JSONEncoder().encode(update)
        return try decode(ModelSettingsSaveResult.self, try await call("PUT", "/settings/models", body: body))
    }

    /// `GET /approvals/policy`: the mode, the categories kept for the user, and every category with its title.
    public func approvalPolicy() async throws -> ApprovalPolicySettings {
        try decode(ApprovalPolicySettings.self, try await call("GET", "/approvals/policy"))
    }

    /// `PUT /approvals/policy` (local only): applies to approvals from now on, no restart. The answer has no categories.
    public func saveApprovalPolicy(_ update: ApprovalPolicyUpdate) async throws -> ApprovalPolicySettings {
        let body = try JSONEncoder().encode(update)
        return try decode(ApprovalPolicySettings.self, try await call("PUT", "/approvals/policy", body: body))
    }

    /// `GET /settings/workdir` (control-v0 §2).
    public func workDir() async throws -> WorkDirSettings {
        try decode(WorkDirSettings.self, try await call("GET", "/settings/workdir"))
    }

    /// `PUT /settings/workdir {path}` (local only): the daemon checks the folder and creates it; a 400 says why not.
    public func saveWorkDir(_ update: WorkDirUpdate) async throws {
        _ = try await call("PUT", "/settings/workdir", body: try JSONEncoder().encode(update))
    }

    /// `GET /quota`: the daemon's cached readings (it reads again once they are a minute old). `refresh`: read every
    /// provider now (`?refresh=1`).
    public func quota(refresh: Bool = false) async throws -> [QuotaReading] {
        let data = try await call("GET", refresh ? "/quota?refresh=1" : "/quota")
        do { return try QuotaReading.decodeList(data) } catch { throw DaemonError.decoding(String(describing: error)) }
    }

    // MARK: the Live Activity (assistant-v0 §4)

    /// `GET /live`: what the menu bar's Live Activity shows.
    public func live() async throws -> LiveSnapshot {
        try decode(LiveSnapshot.self, try await call("GET", "/live"))
    }

    /// Allow or deny what a row waits for: a terminal's permission request (`POST /terminals/:id/permissions/:pid`) or
    /// a task's approval (`POST /tasks/:id/approve`).
    public func decide(_ row: LiveSnapshot.Row, allow: Bool) async throws {
        guard case .decide(let id, _, _, _)? = row.ask else { return }
        let decision = allow ? "allow" : "deny"
        switch row.kind {
        case .terminal:
            _ = try await call("POST", "/terminals/\(Self.segment(row.id))/permissions/\(Self.segment(id))",
                               body: try JSONEncoder().encode(["decision": decision]))
        case .task:
            _ = try await call("POST", "/tasks/\(Self.segment(row.id))/approve",
                               body: try JSONEncoder().encode(["approval_id": id, "decision": decision]))
        }
    }

    /// Answer a task's question with one of its options (`POST /tasks/:id/answer`).
    public func answer(_ row: LiveSnapshot.Row, option: String) async throws {
        guard case .question(let id, let questionId, _, _, true)? = row.ask else { return }
        struct Body: Encodable { let approval_id: String; let answers: [String: [String]] }
        _ = try await call("POST", "/tasks/\(Self.segment(row.id))/answer",
                           body: try JSONEncoder().encode(Body(approval_id: id, answers: [questionId: [option]])))
    }

    static func segment(_ id: String) -> String {
        id.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_.~"))) ?? id
    }

    // MARK: plumbing

    /// A request to `path` with the local token (read afresh: the daemon may have written it since).
    func request(_ method: String, _ path: String) -> URLRequest {
        var request = URLRequest(url: URL(string: baseURL.absoluteString + path) ?? baseURL)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let tokenFile, let token = try? String(contentsOf: tokenFile, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines), !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    func call(_ method: String, _ path: String, body: Data? = nil) async throws -> Data {
        guard URL(string: baseURL.absoluteString + path) != nil else { throw DaemonError.unreachable("无效路径 \(path)") }
        var request = request(method, path)
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await answer(to: request)
        return try DaemonClient.body(data, response, of: "\(method) \(path)")
    }

    /// `GET path`, unless the service still has the list under `version` (`If-None-Match`): nil then, a 304 with
    /// nothing sent. A service that names no version answers whole each time.
    func callUnlessUnchanged(_ path: String, version: String?) async throws -> Versioned<Data>? {
        guard URL(string: baseURL.absoluteString + path) != nil else { throw DaemonError.unreachable("无效路径 \(path)") }
        var request = request("GET", path)
        // The service decides; nothing kept by the session answers in its place.
        request.cachePolicy = .reloadIgnoringLocalCacheData
        if let version { request.setValue(version, forHTTPHeaderField: "If-None-Match") }
        let (data, response) = try await answer(to: request)
        if response.statusCode == 304 { return nil }
        return Versioned(value: try DaemonClient.body(data, response, of: "GET \(path)"), version: response.value(forHTTPHeaderField: "ETag"))
    }

    private func answer(to request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            return try await transport.send(request)
        } catch let error as DaemonError {
            throw error
        } catch {
            throw DaemonError.unreachable("\(baseURL.host() ?? "127.0.0.1"):\(baseURL.port ?? 0) \(error.localizedDescription)")
        }
    }

    private static func body(_ data: Data, _ response: HTTPURLResponse, of what: String) throws -> Data {
        switch response.statusCode {
        case 200..<300: return data
        case 404 where DaemonClient.jsonError(data) == nil: throw DaemonError.notSupported(what)
        default: throw DaemonError.http(status: response.statusCode, message: DaemonClient.errorMessage(data))
        }
    }

    /// The daemon answers errors as `{error: string | issues}`; a route that does not exist gets Hono's plain-text 404.
    static func jsonError(_ data: Data) -> Any? {
        (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"]
    }

    static func errorMessage(_ data: Data) -> String {
        if let error = jsonError(data) {
            if let text = error as? String { return text }
            if let json = try? JSONSerialization.data(withJSONObject: error), let text = String(data: json, encoding: .utf8) { return text }
        }
        let text = String(decoding: data.prefix(300), as: UTF8.self)
        return text.isEmpty ? emptyErrorMessage : text
    }

    /// `errorMessage` of an answer without a body.
    static let emptyErrorMessage = "（无内容）"

    func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        do { return try JSONDecoder().decode(T.self, from: data) } catch {
            throw DaemonError.decoding(String(describing: error))
        }
    }
}

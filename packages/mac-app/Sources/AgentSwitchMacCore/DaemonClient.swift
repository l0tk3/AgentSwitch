import Foundation

public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public struct URLSessionTransport: HTTPTransport {
    private let session: URLSession

    public init(timeout: TimeInterval = 5) {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = timeout
        config.connectionProxyDictionary = [:]   // loopback only; never through a system proxy
        session = URLSession(configuration: config)
    }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw DaemonError.unreachable("不是 HTTP 响应") }
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
        case .unreachable(let why): return "连不上守护进程：\(why)"
        case .http(let status, let message): return "守护进程返回 \(status)：\(message)"
        case .notSupported(let path): return "守护进程不支持 \(path)（404）。内置 daemon 需要更新，或远程模式没有打开。"
        case .decoding(let why): return "守护进程的回应无法解析：\(why)"
        }
    }
}

/// Client of the daemon's loopback listener: the management routes only the Mac app uses (app-v0 §2).
public struct DaemonClient: Sendable {
    public let baseURL: URL
    private let transport: HTTPTransport

    public init(port: Int, transport: HTTPTransport = URLSessionTransport()) {
        baseURL = URL(string: "http://127.0.0.1:\(port)")!
        self.transport = transport
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

    /// Folders a phone task may run in (assistant-v0 §5); each with why it cannot be used now, if so.
    public func projects() async throws -> [ProjectEntry] {
        try decode(ProjectList.self, try await call("GET", "/projects")).projects
    }

    /// Replaces the list; the daemon checks every folder against its cwd rules and refuses the whole list otherwise.
    public func saveProjects(_ projects: [ProjectEntry]) async throws -> [ProjectEntry] {
        let body = try JSONEncoder().encode(ProjectList(projects: projects.map { ProjectEntry(name: $0.name, path: $0.path) }))
        return try decode(ProjectList.self, try await call("PUT", "/projects", body: body)).projects
    }

    // MARK: plumbing

    private func call(_ method: String, _ path: String, body: Data? = nil) async throws -> Data {
        guard let url = URL(string: baseURL.absoluteString + path) else { throw DaemonError.unreachable("无效路径 \(path)") }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let data: Data, response: HTTPURLResponse
        do {
            (data, response) = try await transport.send(request)
        } catch let error as DaemonError {
            throw error
        } catch {
            throw DaemonError.unreachable("\(baseURL.host() ?? "127.0.0.1"):\(baseURL.port ?? 0) \(error.localizedDescription)")
        }
        switch response.statusCode {
        case 200..<300: return data
        case 404 where DaemonClient.jsonError(data) == nil: throw DaemonError.notSupported("\(method) \(path)")
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
        return text.isEmpty ? "（无内容）" : text
    }

    private func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        do { return try JSONDecoder().decode(T.self, from: data) } catch {
            throw DaemonError.decoding(String(describing: error))
        }
    }
}

import Foundation

/// How long each kind of call may take. Set on every request: an explicit `URLRequest.timeoutInterval` wins over the
/// session's (URLSessionTransport's 5 s), so a slow but healthy answer is not taken for a failure and resent.
public enum DispatchTimeouts {
    /// Reads and quick writes (the phone's and the web console's 15 s).
    public static let request: TimeInterval = 15
    /// Uploads and downloads (up to 100 MB).
    public static let transfer: TimeInterval = 180
}

/// Requests sent once, each with its own timeout (the browser's routes, the files', uploads, the streams'), on this
/// Mac's local API (127.0.0.1, local token; api/localAuth.ts: Bearer token; api/localGuard.ts: JSON bodies, multipart
/// only for `POST /uploads`).
extension DaemonClient {
    /// `POST /uploads`: files staged on the service (a picture pasted into a terminal's reply, files dropped on one).
    public func upload(_ files: [DispatchUploadFile]) async throws -> [DispatchStagedUpload] {
        let boundary = "agentswitch-\(UUID().uuidString)"
        let data = try await dispatchCall("POST", "/uploads", body: DispatchMultipart.body(files, boundary: boundary),
                                          contentType: "multipart/form-data; boundary=\(boundary)", timeout: DispatchTimeouts.transfer)
        return try decode(DispatchStagedUploads.self, data).files
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

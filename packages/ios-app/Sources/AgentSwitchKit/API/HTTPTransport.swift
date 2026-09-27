import Foundation

public enum APIError: Error, Equatable, LocalizedError {
    /// The device token is missing, wrong or revoked (401).
    case unauthorized
    /// The server's certificate is not the one paired; `seen` is its actual fingerprint.
    case pinMismatch(seen: String?)
    /// No saved address answered.
    case unreachable
    case http(status: Int, message: String)
    case transport(String)
    case decoding(String)

    public var errorDescription: String? {
        switch self {
        case .unauthorized: return "设备令牌无效或已在 Mac 上吊销，请重新配对"
        case .pinMismatch: return "服务器证书与配对时不一致，已拒绝连接"
        case .unreachable: return "无法连接 Mac（局域网与 Tailscale 地址均无响应）"
        case .http(let status, let message): return message.isEmpty ? "请求失败（HTTP \(status)）" : message
        case .transport(let message): return "网络错误：\(message)"
        case .decoding(let message): return "无法解析服务器回复：\(message)"
        }
    }

    /// Worth re-selecting the endpoint and retrying: the network, not the server, failed.
    public var isNetworkFailure: Bool {
        if case .transport = self { return true }
        return self == .unreachable
    }
}

/// The only way AgentSwitchKit talks HTTP, so the client, the prober and the event stream are testable with fakes.
public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
    /// Response head, then the body as it arrives, in chunks of any size.
    func stream(_ request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, Error>)
}

/// URLSession with every connection pinned to the paired certificate fingerprint. One per paired Mac; it serves all of
/// that Mac's addresses because the pin does not depend on the host name.
public final class PinnedSessionTransport: HTTPTransport {
    private let session: URLSession
    private let delegate: PinnedTrustDelegate

    public init(fingerprint: String, configuration: URLSessionConfiguration = PinnedSessionTransport.defaultConfiguration()) {
        delegate = PinnedTrustDelegate(fingerprint: fingerprint)
        session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
    }

    deinit { session.invalidateAndCancel() }

    /// Ephemeral: no cookies, no URL cache, no credential storage.
    public static func defaultConfiguration() -> URLSessionConfiguration {
        let config = URLSessionConfiguration.ephemeral
        // Every request carries its own timeout (15 s, 60 s for task creation, the stream's idle limit); the session's
        // default only must not cut the longer ones short.
        config.timeoutIntervalForRequest = 300
        config.waitsForConnectivity = false
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.urlCache = nil
        config.httpCookieStorage = nil
        config.urlCredentialStorage = nil
        return config
    }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw APIError.transport("not an HTTP response") }
            return (data, http)
        } catch {
            throw mapped(error, request: request)
        }
    }

    public func stream(_ request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, Error>) {
        let session = self.session
        let (body, sink) = AsyncThrowingStream<Data, Error>.makeStream()
        let reader = LockedBox<Task<Void, Never>?>(nil)
        let head = LockedBox<CheckedContinuation<HTTPURLResponse, Error>?>(nil)
        let response: HTTPURLResponse = try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (cont: CheckedContinuation<HTTPURLResponse, Error>) in
                head.withLock { $0 = cont }
                let task = Task {
                    let resumeHead: @Sendable (Result<HTTPURLResponse, Error>) -> Void = { result in
                        head.withLock { pending in pending?.resume(with: result); pending = nil }
                    }
                    do {
                        let (bytes, response) = try await session.bytes(for: request)
                        guard let http = response as? HTTPURLResponse else { throw APIError.transport("not an HTTP response") }
                        resumeHead(.success(http))
                        var chunk = Data()
                        for try await byte in bytes {
                            chunk.append(byte)
                            if byte == 0x0A || chunk.count >= 4096 {
                                sink.yield(chunk)
                                chunk.removeAll(keepingCapacity: true)
                            }
                        }
                        if !chunk.isEmpty { sink.yield(chunk) }
                        sink.finish()
                    } catch {
                        let error = self.mapped(error, request: request)
                        resumeHead(.failure(error))
                        sink.finish(throwing: error)
                    }
                }
                reader.withLock { $0 = task }
            }
        } onCancel: {
            reader.withLock { $0?.cancel() }
        }
        sink.onTermination = { _ in reader.withLock { $0?.cancel() } }
        return (response, body)
    }

    /// A cancelled handshake after a pin mismatch becomes `.pinMismatch`; other URL errors become `.transport`.
    private func mapped(_ error: Error, request: URLRequest) -> Error {
        if error is APIError || error is CancellationError { return error }
        if let host = request.url?.host(percentEncoded: false), let seen = delegate.takeMismatch(host: host) {
            return APIError.pinMismatch(seen: seen.isEmpty ? nil : seen)
        }
        if let urlError = error as? URLError {
            if urlError.code == .cancelled, Task.isCancelled { return CancellationError() }
            return APIError.transport(urlError.localizedDescription)
        }
        return APIError.transport(error.localizedDescription)
    }
}

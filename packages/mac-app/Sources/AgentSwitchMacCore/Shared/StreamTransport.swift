import Foundation
import os

// What the service's streams share (a terminal's record, the browser's events and picture), ported from the iPhone Kit
// (API/TaskEventStream.swift) onto DaemonClient's local API (Bearer local token): the transport that hands a body over
// as it arrives, the reconnect timing, the idle limit.

/// A transport that hands over a response body as it arrives. DaemonClient streams through its own transport when that
/// conforms (tests, a future remote Mac), else through `URLSessionStreamTransport.shared`.
public protocol DispatchStreamingTransport: Sendable {
    /// The response head, then the body in chunks of any size.
    func stream(_ request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, Error>)
}

/// Reconnect timing: exponential from `initial` to `maximum`, reset once an event arrives.
public struct DispatchReconnectPolicy: Sendable {
    public let initial: Duration
    public let maximum: Duration
    /// Idle limit for one connection. The daemon sends `: ping` every 10 s (SSE_HEARTBEAT_MS), so 30 s without a byte
    /// means a dead connection (the service restarted, the Mac slept), not a quiet task.
    public let idleTimeout: TimeInterval

    public init(initial: Duration = .seconds(1), maximum: Duration = .seconds(15), idleTimeout: TimeInterval = 30) {
        self.initial = initial
        self.maximum = maximum
        self.idleTimeout = idleTimeout
    }

    public static let standard = DispatchReconnectPolicy()

    public func delay(afterFailures n: Int) -> Duration {
        guard n > 0 else { return .zero }
        var d = initial
        for _ in 1..<n where d < maximum { d = d * 2 }
        return min(d, maximum)
    }
}

/// URLSession's byte stream, loopback only (never through a system proxy), cut into chunks at line ends.
public struct URLSessionStreamTransport: DispatchStreamingTransport {
    private let session: URLSession

    public static let shared = URLSessionStreamTransport()

    /// How many streams may be open to the service at once. A URL session opens at most 6 connections to one host
    /// unless told otherwise, and every stream here goes to the same one — the local service, another node's through it
    /// too — and holds its connection for as long as it is followed: a pane's record, a live task, a browser tab. The
    /// seventh waited for a connection that never came free and gave up after its idle limit, again and again, so a
    /// pane's record stood still and the reply just sent from it was nowhere to be seen (2026-11-10, user: 简略模式我
    /// 刚才发的消息被吃掉了; measured with a session of its own against a server that never ends its answers: six
    /// streams answered at once, three more timed out after 30 s, and a plain request on the same session after 10).
    public static let maxConnections = 256

    /// The session's set-up: loopback only, no cache, as many connections as there are streams.
    public static func configuration() -> URLSessionConfiguration {
        let config = URLSessionConfiguration.ephemeral
        config.connectionProxyDictionary = [:]
        config.timeoutIntervalForResource = 7 * 24 * 3600
        config.urlCache = nil
        config.httpMaximumConnectionsPerHost = maxConnections
        return config
    }

    public init() {
        session = URLSession(configuration: Self.configuration())
    }

    public func stream(_ request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, Error>) {
        let session = self.session
        let (body, sink) = AsyncThrowingStream<Data, Error>.makeStream()
        let reader = DispatchLock<Task<Void, Never>?>(nil)
        let head = DispatchLock<CheckedContinuation<HTTPURLResponse, Error>?>(nil)
        let response: HTTPURLResponse = try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (cont: CheckedContinuation<HTTPURLResponse, Error>) in
                head.withLock { $0 = cont }
                let task = Task {
                    let resumeHead: @Sendable (Result<HTTPURLResponse, Error>) -> Void = { result in
                        head.withLock { pending in pending?.resume(with: result); pending = nil }
                    }
                    do {
                        let (bytes, response) = try await session.bytes(for: request)
                        guard let http = response as? HTTPURLResponse else { throw DaemonError.unreachable("非 HTTP 响应") }
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
                        let error = Self.mapped(error)
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

    static func mapped(_ error: Error) -> Error {
        if error is DaemonError || error is CancellationError { return error }
        if let urlError = error as? URLError, urlError.code == .cancelled { return CancellationError() }
        return DaemonError.unreachable(error.localizedDescription)
    }
}

extension DaemonError {
    /// Worth reconnecting: the connection, not the service's answer, failed.
    var isNetworkFailure: Bool {
        if case .unreachable = self { return true }
        return false
    }
}

extension DaemonClient {
    static let idleMessage = "事件流 30 秒无数据，已重新连接"

    /// The body, failing with a network error once `limit` passes without a byte: a half-open connection can sit there
    /// without URLSession noticing.
    static func idleGuarded(_ body: AsyncThrowingStream<Data, Error>, limit: Duration) -> AsyncThrowingStream<Data, Error> {
        let (out, sink) = AsyncThrowingStream<Data, Error>.makeStream()
        let clock = ContinuousClock()
        let heard = DispatchLock(clock.now)
        let reader = Task {
            do {
                for try await chunk in body {
                    let now = clock.now
                    heard.withLock { $0 = now }
                    sink.yield(chunk)
                }
                sink.finish()
            } catch {
                sink.finish(throwing: error)
            }
        }
        let watchdog = Task {
            while !Task.isCancelled {
                let deadline = heard.value.advanced(by: limit)
                if clock.now >= deadline {
                    sink.finish(throwing: DaemonError.unreachable(idleMessage))
                    reader.cancel()
                    return
                }
                try? await Task.sleep(until: deadline, clock: clock)
            }
        }
        sink.onTermination = { _ in
            reader.cancel()
            watchdog.cancel()
        }
        return out
    }
}

/// A value behind an unfair lock, for a stream's reader and watchdog (they run on different tasks).
final class DispatchLock<Value: Sendable>: Sendable {
    private let lock: OSAllocatedUnfairLock<Value>

    init(_ value: Value) { lock = OSAllocatedUnfairLock(initialState: value) }

    func withLock<R: Sendable>(_ body: @Sendable (inout Value) -> R) -> R { lock.withLock(body) }

    var value: Value { lock.withLock { $0 } }
}

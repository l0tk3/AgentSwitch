import Foundation

// A task's live events (`GET /tasks/:id/events`, SSE), ported from the iPhone Kit (API/TaskEventStream.swift) onto
// DaemonClient's local API (Bearer local token). The Mac's SSEParser reads the frames; each `data` is a TaskEvent.

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

    public init() {
        let config = URLSessionConfiguration.ephemeral
        config.connectionProxyDictionary = [:]
        config.timeoutIntervalForResource = 7 * 24 * 3600
        config.urlCache = nil
        session = URLSession(configuration: config)
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
    public func taskEvents(taskId: String, after: Int64) -> AsyncThrowingStream<DispatchTaskEvent, Error> {
        taskEvents(taskId: taskId, after: after, policy: .standard)
    }

    /// The stream with its own reconnect timing (tests use a fast one). Replays everything after `after`, then follows;
    /// on a dropped connection it reconnects from the last seq it delivered, so nothing is missed or repeated. Ends after
    /// a terminal event, or when the task is already over; throws on an answer that is not a stream (401, 404).
    public func taskEvents(taskId: String, after: Int64, policy: DispatchReconnectPolicy) -> AsyncThrowingStream<DispatchTaskEvent, Error> {
        let streamer = (transport as? DispatchStreamingTransport) ?? URLSessionStreamTransport.shared
        let client = self
        let (stream, sink) = AsyncThrowingStream<DispatchTaskEvent, Error>.makeStream()
        let worker = Task {
            var last = after
            var failures = 0
            while !Task.isCancelled {
                do {
                    switch try await client.followEvents(taskId: taskId, after: last, policy: policy, streamer: streamer,
                                                         deliver: { sink.yield($0) }) {
                    case .ended:
                        sink.finish()
                        return
                    case .dropped(let seq, let delivered):
                        last = seq
                        failures = delivered ? 0 : failures + 1
                    }
                } catch is CancellationError {
                    break
                } catch let error as DaemonError where error.isNetworkFailure {
                    failures += 1
                } catch {
                    sink.finish(throwing: error)
                    return
                }
                try? await Task.sleep(for: policy.delay(afterFailures: max(failures, 1)))
            }
            sink.finish()
        }
        sink.onTermination = { _ in worker.cancel() }
        return stream
    }

    enum DispatchFollowResult: Equatable {
        /// A terminal event arrived or the task was already over.
        case ended(lastSeq: Int64)
        /// The connection closed early; resume from `lastSeq`.
        case dropped(lastSeq: Int64, delivered: Bool)
    }

    /// One connection's worth of the stream.
    func followEvents(taskId: String, after: Int64, policy: DispatchReconnectPolicy, streamer: DispatchStreamingTransport,
                      deliver: (DispatchTaskEvent) -> Void) async throws -> DispatchFollowResult {
        let route = "/tasks/\(Self.segment(taskId))/events"
        let request = try dispatchRequest("GET", route + "?after=\(after)", accept: "text/event-stream", timeout: policy.idleTimeout)
        var last = after
        var delivered = false
        do {
            let (response, body) = try await streamer.stream(request)
            if !(200..<300).contains(response.statusCode) {
                var data = Data()
                for try await chunk in body where data.count < 64 * 1024 { data.append(chunk) }
                _ = try Self.dispatchCheck(data, response, route: "GET \(route)")
            }
            var parser = SSEParser()
            for try await chunk in Self.idleGuarded(body, limit: .milliseconds(Int64(policy.idleTimeout * 1000))) {
                for message in parser.feed(chunk) {
                    guard let event = Self.taskEvent(from: message.data, taskId: taskId), event.seq > last else { continue }
                    last = event.seq
                    delivered = true
                    deliver(event)
                    if event.endsStream { return .ended(lastSeq: last) }
                }
            }
        } catch {
            let mapped = dispatchTransportError(error)
            if let failure = mapped as? DaemonError, failure.isNetworkFailure, delivered { return .dropped(lastSeq: last, delivered: true) }
            throw mapped
        }
        // The daemon also closes right after the replay when the task is already over.
        if try await task(id: taskId).task.status.isTerminal { return .ended(lastSeq: last) }
        return .dropped(lastSeq: last, delivered: delivered)
    }

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

    /// The SSE `data` is the TaskEvent JSON; a frame that does not decode (or is another task's) is skipped rather than
    /// ending the stream.
    static func taskEvent(from data: String, taskId: String) -> DispatchTaskEvent? {
        guard let event = try? JSONDecoder().decode(DispatchTaskEvent.self, from: Data(data.utf8)), event.taskId == taskId else { return nil }
        return event
    }
}

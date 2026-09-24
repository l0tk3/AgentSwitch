import Foundation

/// Reconnect timing for the event stream: exponential from `initial` to `maximum`, reset after any event arrives.
public struct ReconnectPolicy: Sendable {
    public let initial: Duration
    public let maximum: Duration
    /// Idle limit for one connection. The daemon sends a comment every 10 s (SSE_HEARTBEAT_MS), so silence this long
    /// means a dead connection, not a quiet task.
    public let idleTimeout: TimeInterval

    public init(initial: Duration = .seconds(1), maximum: Duration = .seconds(15), idleTimeout: TimeInterval = 45) {
        self.initial = initial
        self.maximum = maximum
        self.idleTimeout = idleTimeout
    }

    public static let standard = ReconnectPolicy()

    public func delay(afterFailures n: Int) -> Duration {
        guard n > 0 else { return .zero }
        var d = initial
        for _ in 1..<n where d < maximum { d = d * 2 }
        return min(d, maximum)
    }
}

extension AgentSwitchAPI {
    /// Live events of one task: `GET /tasks/:id/events?after=<seq>` (SSE, one event per engine event, `id` = seq).
    /// Replays everything after `after`, then follows. On a dropped connection it reconnects from the last seq it
    /// delivered, so nothing is missed or repeated. Ends after a terminal event (done, partial, blocked, failed,
    /// cancelled) or when the task is already terminal; throws on 401/404.
    public func events(taskId: String, after: Int64 = 0, policy: ReconnectPolicy = .standard) -> AsyncThrowingStream<TaskEvent, Error> {
        let (stream, sink) = AsyncThrowingStream<TaskEvent, Error>.makeStream()
        let worker = Task {
            var last = after
            var failures = 0
            while !Task.isCancelled {
                do {
                    switch try await followOnce(taskId: taskId, after: last, policy: policy, deliver: { ev in sink.yield(ev) }) {
                    case .ended:
                        sink.finish()
                        return
                    case .dropped(let seq, let delivered):
                        last = seq
                        failures = delivered ? 0 : failures + 1
                    }
                } catch is CancellationError {
                    break
                } catch let error as APIError where error.isNetworkFailure {
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

    enum FollowResult: Equatable {
        /// A terminal event arrived or the task was already over.
        case ended(lastSeq: Int64)
        /// The connection closed early; resume from `lastSeq`.
        case dropped(lastSeq: Int64, delivered: Bool)
    }

    /// One connection's worth of the stream.
    func followOnce(taskId: String, after: Int64, policy: ReconnectPolicy, deliver: (TaskEvent) -> Void) async throws -> FollowResult {
        let endpoint = try await endpoints.endpoint()
        let query = [URLQueryItem(name: "after", value: String(after))]
        let req = request("GET", endpoint, ["tasks", taskId, "events"], query: query, body: nil,
                          accept: "text/event-stream", timeout: policy.idleTimeout)
        var last = after
        var delivered = false
        do {
            let (response, body) = try await transport.stream(req)
            if !(200..<300).contains(response.statusCode) {
                var data = Data()
                for try await chunk in body where data.count < 64 * 1024 { data.append(chunk) }
                try AgentSwitchAPI.check(data, response)
            }
            var parser = SSEParser()
            for try await chunk in body {
                for message in parser.feed(chunk) {
                    guard let event = Self.taskEvent(from: message, taskId: taskId), event.seq > last else { continue }
                    last = event.seq
                    delivered = true
                    deliver(event)
                    if event.endsStream { return .ended(lastSeq: last) }
                }
            }
        } catch let error as APIError where error.isNetworkFailure {
            await endpoints.reportFailure(endpoint)
            if delivered { return .dropped(lastSeq: last, delivered: true) }
            throw error
        }
        // The daemon also closes right after the replay when the task is already over.
        if try await task(taskId).task.status.isTerminal { return .ended(lastSeq: last) }
        return .dropped(lastSeq: last, delivered: delivered)
    }

    /// The SSE `data` is the TaskEvent JSON; a frame that does not decode is skipped rather than ending the stream.
    static func taskEvent(from message: SSEMessage, taskId: String) -> TaskEvent? {
        guard let data = message.data.data(using: .utf8),
              let event = try? JSONDecoder().decode(TaskEvent.self, from: data), event.taskId == taskId else { return nil }
        return event
    }
}

import Foundation

/// Reconnect timing for an event stream (a terminal's, a browser tab's): exponential from `initial` to `maximum`, reset after any event arrives.
public struct ReconnectPolicy: Sendable {
    public let initial: Duration
    public let maximum: Duration
    /// Idle limit for one connection. The daemon sends `: ping` every 10 s (SSE_HEARTBEAT_MS), so 30 s without a byte
    /// means a half-open connection (control-v0 §5: the phone changed networks and nothing said so), not a quiet agent.
    public let idleTimeout: TimeInterval

    public init(initial: Duration = .seconds(1), maximum: Duration = .seconds(15), idleTimeout: TimeInterval = 30) {
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
    /// The body, failing with a network error once `limit` passes without a byte. The request's own timeout is not
    /// enough on its own: a half-open TCP connection can sit there without URLSession noticing.
    static func idleGuarded(_ body: AsyncThrowingStream<Data, Error>, limit: Duration) -> AsyncThrowingStream<Data, Error> {
        let (out, sink) = AsyncThrowingStream<Data, Error>.makeStream()
        let clock = ContinuousClock()
        let heard = LockedBox(clock.now)
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
                    sink.finish(throwing: APIError.transport(idleMessage))
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

    static let idleMessage = "事件流 30 秒无数据，已重新连接"
}

import Foundation

/// What the connection line says (control-v0 §5), from the state and how the attempts went: 连接中 → 重连中 →
/// 无法连接（第 N 次）→ 未找到 Mac → 配对已失效. "Cannot connect" alone said nothing about whether it was a blip or the
/// Mac being gone for good.
public enum ConnectionPhase: Sendable, Equatable {
    case connected(APIEndpoint)
    /// The first connection since the app started.
    case connecting
    /// Connected before; looking for a way back, nothing failed yet.
    case reconnecting
    /// `attempt` selections in a row found no address that answers.
    case failing(attempt: Int)
    /// Failing for `ConnectionProgress.lostAfter` or longer.
    case lost
    /// The Mac refused the device token: pair again.
    case unpaired
    case certificateChanged

    public var text: String {
        switch self {
        case .connected(let endpoint): return "Connected · \(endpoint.kind.lineTitle)"
        case .connecting: return "Connecting"
        case .reconnecting: return "Reconnecting"
        case .failing(let n): return "Unreachable · Try \(n)"
        case .lost: return "Mac Not Found"
        case .unpaired: return "Unpaired"
        case .certificateChanged: return "Certificate Changed · Refused"
        }
    }

    /// Still trying on its own, no action needed yet.
    public var isTransient: Bool {
        switch self {
        case .connecting, .reconnecting: return true
        default: return false
        }
    }

    /// A 重试 makes sense (the phone keeps retrying anyway).
    public var canRetry: Bool {
        switch self {
        case .failing, .lost: return true
        default: return false
        }
    }
}

/// The history the phase needs, updated on every state change (a new copy each time).
public struct ConnectionProgress: Sendable, Equatable {
    /// About six minutes of failures: long enough that the Mac is off, asleep or out of reach, not a network blip.
    public static let lostAfter: TimeInterval = 6 * 60

    public let everConnected: Bool
    /// Failed selections since the last connection.
    public let failures: Int
    public let failingSince: Date?

    public init(everConnected: Bool = false, failures: Int = 0, failingSince: Date? = nil) {
        self.everConnected = everConnected
        self.failures = failures
        self.failingSince = failingSince
    }

    public func after(_ state: ConnectionState, at now: Date = Date()) -> ConnectionProgress {
        switch state {
        case .connected:
            return ConnectionProgress(everConnected: true)
        case .unreachable:
            return ConnectionProgress(everConnected: everConnected, failures: failures + 1, failingSince: failingSince ?? now)
        case .idle, .selecting, .unauthorized, .pinMismatch:
            return self
        }
    }

    public func phase(_ state: ConnectionState, now: Date = Date()) -> ConnectionPhase {
        switch state {
        case .connected(let endpoint): return .connected(endpoint)
        case .unauthorized: return .unpaired
        case .pinMismatch: return .certificateChanged
        case .idle, .selecting, .unreachable:
            guard failures > 0 else { return everConnected ? .reconnecting : .connecting }
            if let since = failingSince, now.timeIntervalSince(since) >= Self.lostAfter { return .lost }
            return .failing(attempt: failures)
        }
    }
}

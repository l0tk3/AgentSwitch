import Foundation

/// A network path as far as re-selection cares: when this changes, the best address may have changed too.
public struct NetworkPathSnapshot: Sendable, Hashable {
    public let satisfied: Bool
    public let interfaces: [String]   // "wifi:en0", "cellular:pdp_ip0", "other:utun4"…

    public init(satisfied: Bool, interfaces: [String]) {
        self.satisfied = satisfied
        self.interfaces = interfaces
    }
}

/// Network path changes (NWPathMonitor in the app, a scripted stream in tests).
public protocol PathMonitoring: Sendable {
    func changes() -> AsyncStream<NetworkPathSnapshot>
}

public enum ConnectionState: Sendable, Equatable {
    case idle
    case selecting
    case connected(APIEndpoint)
    /// The Mac rejected the device token: pair again.
    case unauthorized
    /// Something answered with a different certificate.
    case pinMismatch(seen: String?)
    case unreachable

    public var endpoint: APIEndpoint? {
        if case .connected(let e) = self { return e }
        return nil
    }
}

/// Owns "which address do we use now" for one paired Mac. Selection runs on first use, after a reported failure and
/// whenever the network path changes; concurrent callers share one selection.
public actor ConnectionManager: EndpointProviding {
    private let book: any ServerAddressBook
    private let token: String?
    private let discovery: (any ServiceDiscovery)?
    private let prober: any EndpointProber
    private let discoveryTimeout: Duration
    private let settleDelay: Duration

    private var state: ConnectionState = .idle
    private var inflight: Task<ConnectionState, Never>?
    private var monitor: Task<Void, Never>?
    private var observers: [UUID: AsyncStream<ConnectionState>.Continuation] = [:]

    public init(book: any ServerAddressBook, token: String?, discovery: (any ServiceDiscovery)?, prober: any EndpointProber,
                discoveryTimeout: Duration = .milliseconds(1500), settleDelay: Duration = .milliseconds(500)) {
        self.book = book
        self.token = token
        self.discovery = discovery
        self.prober = prober
        self.discoveryTimeout = discoveryTimeout
        self.settleDelay = settleDelay
    }

    public var current: ConnectionState { state }

    /// State changes, starting with the current one.
    public func states() -> AsyncStream<ConnectionState> {
        let id = UUID()
        let (stream, continuation) = AsyncStream<ConnectionState>.makeStream(bufferingPolicy: .bufferingNewest(8))
        continuation.yield(state)
        observers[id] = continuation
        continuation.onTermination = { _ in Task { await self.removeObserver(id) } }
        return stream
    }

    public func endpoint() async throws -> APIEndpoint {
        if let endpoint = state.endpoint { return endpoint }
        switch await reselect() {
        case .connected(let endpoint): return endpoint
        case .unauthorized: throw APIError.unauthorized
        case .pinMismatch(let seen): throw APIError.pinMismatch(seen: seen)
        case .idle, .selecting, .unreachable: throw APIError.unreachable
        }
    }

    public func reportFailure(_ endpoint: APIEndpoint) {
        if state.endpoint == endpoint { set(.idle) }
    }

    /// Runs a selection (or joins the one in progress).
    @discardableResult
    public func reselect() async -> ConnectionState {
        if let inflight { return await inflight.value }
        set(.selecting)
        let (book, token, discovery, prober, timeout) = (self.book, self.token, self.discovery, self.prober, self.discoveryTimeout)
        let task = Task<ConnectionState, Never> {
            let found = await discovery?.discover(timeout: timeout) ?? []
            let candidates = EndpointSelector.candidates(for: book, discovered: found)
            switch await EndpointSelector.select(from: candidates, token: token, prober: prober) {
            case .selected(let endpoint): return .connected(endpoint)
            case .unauthorized: return .unauthorized
            case .pinMismatch(let seen): return .pinMismatch(seen: seen)
            case .unreachable: return .unreachable
            }
        }
        inflight = task
        let result = await task.value
        inflight = nil
        set(result)
        return result
    }

    /// Re-selects whenever the path changes (the first snapshot is the starting point, not a change).
    public func startMonitoring(_ paths: any PathMonitoring) {
        monitor?.cancel()
        let delay = settleDelay
        monitor = Task { [weak self] in
            var last: NetworkPathSnapshot?
            for await snapshot in paths.changes() {
                defer { last = snapshot }
                guard let previous = last, previous != snapshot else { continue }
                try? await Task.sleep(for: delay)
                guard !Task.isCancelled else { return }
                await self?.reselect()
            }
        }
    }

    public func stop() {
        monitor?.cancel()
        monitor = nil
        inflight?.cancel()
        for continuation in observers.values { continuation.finish() }
        observers.removeAll()
    }

    private func set(_ new: ConnectionState) {
        guard new != state else { return }
        state = new
        for continuation in observers.values { continuation.yield(new) }
    }

    private func removeObserver(_ id: UUID) {
        observers.removeValue(forKey: id)
    }
}

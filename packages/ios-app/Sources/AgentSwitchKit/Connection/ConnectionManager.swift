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
/// whenever the network path changes; concurrent callers share one selection. When no address answers it tries again
/// on its own, backing off to `retry.maximum` and never giving up (control-v0 §5: a Mac that sleeps for an hour must
/// be found again without the user doing anything); meanwhile callers fail at once instead of each starting a
/// selection of their own.
public actor ConnectionManager: EndpointProviding {
    private var book: any ServerAddressBook
    private let token: String?
    private let discovery: (any ServiceDiscovery)?
    private let prober: any EndpointProber
    private let discoveryTimeout: Duration
    private let settleDelay: Duration
    private let retry: ReconnectPolicy

    private var state: ConnectionState = .idle
    private var inflight: Task<ConnectionState, Never>?
    private var monitor: Task<Void, Never>?
    /// The next automatic selection while unreachable; `failures` drives its delay.
    private var retryTask: Task<Void, Never>?
    private var failures = 0
    /// After `stop()` nothing starts again (a selection that was running when it stopped schedules no retry).
    private var stopped = false
    private var observers: [UUID: AsyncStream<ConnectionState>.Continuation] = [:]
    /// The last selection: when it ended and how each address fared (settings › Mac shows it).
    public private(set) var lastReport: (at: Date, reports: [ProbeReport])?

    /// Retry delays while unreachable: 2 s doubling to 30 s, then every 30 s for as long as it takes.
    public static let standardRetry = ReconnectPolicy(initial: .seconds(2), maximum: .seconds(30))

    public init(book: any ServerAddressBook, token: String?, discovery: (any ServiceDiscovery)?, prober: any EndpointProber,
                discoveryTimeout: Duration = .milliseconds(1500), settleDelay: Duration = .milliseconds(500),
                retry: ReconnectPolicy = ConnectionManager.standardRetry) {
        self.book = book
        self.token = token
        self.discovery = discovery
        self.prober = prober
        self.discoveryTimeout = discoveryTimeout
        self.settleDelay = settleDelay
        self.retry = retry
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
        // The automatic retry owns the next attempt; a poll or a stream asking now would only pile selections up.
        if state == .unreachable, retryTask != nil { throw APIError.unreachable }
        switch await reselect() {
        case .connected(let endpoint): return endpoint
        case .unauthorized: throw APIError.unauthorized
        case .pinMismatch(let seen): throw APIError.pinMismatch(seen: seen)
        case .idle, .selecting, .unreachable: throw APIError.unreachable
        }
    }

    private func record(_ reports: [ProbeReport]) {
        lastReport = (Date(), reports)
    }

    /// New addresses for the same Mac (it told us where it is now); the next selection uses them.
    public func update(book: any ServerAddressBook) {
        self.book = book
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
            let (selection, reports) = await EndpointSelector.selectReporting(from: candidates, token: token, prober: prober)
            await self.record(reports)
            switch selection {
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
        scheduleRetry(after: result)
        return result
    }

    /// Back in the foreground (control-v0 §5): the address that worked before the phone slept may be gone (another
    /// Wi-Fi, Tailscale switched off) while the state still says connected. A short `/healthz` on it; a new selection
    /// when it does not answer, or when there was no address to check. A revoked pairing stays as it is.
    @discardableResult
    public func verify() async -> ConnectionState {
        if state == .unauthorized { return state }
        guard let endpoint = state.endpoint else { return await reselect() }
        guard await prober.probe(endpoint, token: nil) != .ok else { return state }
        if state.endpoint == endpoint { set(.idle) }
        return await reselect()
    }

    private func scheduleRetry(after result: ConnectionState) {
        retryTask?.cancel()
        retryTask = nil
        guard result == .unreachable, !stopped else {
            failures = 0
            return
        }
        failures += 1
        let delay = retry.delay(afterFailures: failures)
        retryTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            await self?.retryNow()
        }
    }

    private func retryNow() async {
        retryTask = nil
        guard state == .unreachable else { return }
        await reselect()
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
        stopped = true
        monitor?.cancel()
        monitor = nil
        retryTask?.cancel()
        retryTask = nil
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

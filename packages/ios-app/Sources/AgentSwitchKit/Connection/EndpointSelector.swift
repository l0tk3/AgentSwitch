import Foundation

/// A `_agentswitch._tcp` service seen on the local network, already resolved to an address.
public struct DiscoveredService: Sendable, Hashable {
    public let name: String
    /// TXT `fp`: the first 16 hex digits of the certificate fingerprint.
    public let fingerprintPrefix: String?
    public let host: String
    public let port: Int

    public init(name: String, fingerprintPrefix: String?, host: String, port: Int) {
        self.name = name
        self.fingerprintPrefix = fingerprintPrefix
        self.host = host
        self.port = port
    }
}

/// Finds AgentSwitch Macs on the local network (Bonjour in the app, canned results in tests).
public protocol ServiceDiscovery: Sendable {
    func discover(timeout: Duration) async -> [DiscoveredService]
}

public enum ProbeOutcome: Sendable, Equatable {
    case ok
    /// `/healthz` answered but `/me` said 401: the device was revoked.
    case unauthorized
    case pinMismatch(seen: String?)
    case unreachable(String)
}

/// Checks one endpoint: `/healthz`, then (with a token) `/me`.
public protocol EndpointProber: Sendable {
    func probe(_ endpoint: APIEndpoint, token: String?) async -> ProbeOutcome
}

/// How one address fared in the last selection, for "why can't it connect" (2026-09-26: over Tailscale the phone
/// reached the Mac in Safari but the app did not connect, and nothing said why).
public struct ProbeReport: Sendable, Equatable {
    public let endpoint: APIEndpoint
    /// nil: not waited for, a better-ranked address answered first.
    public let outcome: ProbeOutcome?
    public let seconds: Double

    public init(endpoint: APIEndpoint, outcome: ProbeOutcome?, seconds: Double) {
        self.endpoint = endpoint
        self.outcome = outcome
        self.seconds = seconds
    }
}

public enum SelectionResult: Sendable, Equatable {
    case selected(APIEndpoint)
    case unauthorized
    case pinMismatch(seen: String?)
    case unreachable
}

/// Address choice (app-v0 §5): Bonjour services whose TXT `fp` matches the pinned fingerprint's prefix, then the LAN
/// addresses from pairing, then the Tailscale ones. All candidates are probed at once; the first in that order that
/// answers wins.
public enum EndpointSelector {
    public static let fingerprintPrefixLength = 16

    public static func candidates(for book: any ServerAddressBook, discovered: [DiscoveredService]) -> [APIEndpoint] {
        let prefix = String(book.fingerprint.prefix(fingerprintPrefixLength)).lowercased()
        let bonjour = discovered
            .filter { $0.fingerprintPrefix?.lowercased() == prefix && HostAddress.isValid($0.host) && (1...65535).contains($0.port) }
            .map { APIEndpoint(host: $0.host, port: $0.port, kind: .bonjour) }
        let lan = book.lan.map { APIEndpoint(host: $0, port: book.port, kind: .lan) }
        let tailnet = book.tailnet.map { APIEndpoint(host: $0, port: book.port, kind: .tailnet) }
        var seen = Set<String>()
        return (bonjour + lan + tailnet).filter { seen.insert($0.authority.lowercased()).inserted }
    }

    public static func select(from candidates: [APIEndpoint], token: String?, prober: any EndpointProber) async -> SelectionResult {
        await selectReporting(from: candidates, token: token, prober: prober).result
    }

    /// The selection and how every address fared (the seconds each took to answer or fail).
    public static func selectReporting(from candidates: [APIEndpoint], token: String?, prober: any EndpointProber) async
        -> (result: SelectionResult, reports: [ProbeReport]) {
        let clock = ContinuousClock()
        let start = clock.now
        let finished = await withTaskGroup(of: (Int, ProbeOutcome, Double).self) { group in
            for (i, endpoint) in candidates.enumerated() {
                group.addTask {
                    let outcome = await prober.probe(endpoint, token: token)
                    let elapsed = clock.now - start
                    return (i, outcome, Double(elapsed.components.seconds) + Double(elapsed.components.attoseconds) / 1e18)
                }
            }
            var results = [(ProbeOutcome, Double)?](repeating: nil, count: candidates.count)
            for await (i, outcome, seconds) in group {
                results[i] = (outcome, seconds)
                // Stop early once every better-ranked candidate has failed and this one answered.
                if let first = results.firstIndex(where: { $0 == nil || $0?.0 == .ok }), results[first]?.0 == .ok {
                    group.cancelAll()
                    break
                }
            }
            return results
        }
        let outcomes = finished.map { $0?.0 ?? .unreachable("not needed") }
        let reports = candidates.enumerated().map { i, endpoint in
            ProbeReport(endpoint: endpoint, outcome: finished[i]?.0, seconds: finished[i]?.1 ?? 0)
        }
        return (decide(candidates: candidates, outcomes: outcomes), reports)
    }

    /// Best reachable endpoint in preference order; otherwise the most telling failure.
    static func decide(candidates: [APIEndpoint], outcomes: [ProbeOutcome]) -> SelectionResult {
        if let i = outcomes.firstIndex(of: .ok) { return .selected(candidates[i]) }
        if outcomes.contains(.unauthorized) { return .unauthorized }
        for case .pinMismatch(let seen) in outcomes { return .pinMismatch(seen: seen) }
        return .unreachable
    }
}

/// The real prober: short-timeout requests through the pinned transport.
public struct HTTPEndpointProber: EndpointProber {
    public let transport: any HTTPTransport
    public let timeout: TimeInterval

    public init(transport: any HTTPTransport, timeout: TimeInterval = 4) {
        self.transport = transport
        self.timeout = timeout
    }

    public func probe(_ endpoint: APIEndpoint, token: String?) async -> ProbeOutcome {
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(endpoint), transport: transport, token: token)
        do {
            var health = api.request("GET", endpoint, ["healthz"], query: [], body: nil, timeout: timeout)
            health.setValue(nil, forHTTPHeaderField: "Authorization")
            let (data, response) = try await transport.send(health)
            let reply: Health = try AgentSwitchAPI.decode(data, response)
            guard reply.ok else { return .unreachable("服务状态异常") }
            guard token != nil else { return .ok }
            let (meData, meResponse) = try await transport.send(api.request("GET", endpoint, ["me"], query: [], body: nil, timeout: timeout))
            try AgentSwitchAPI.check(meData, meResponse)
            return .ok
        } catch APIError.unauthorized {
            return .unauthorized
        } catch APIError.pinMismatch(let seen) {
            return .pinMismatch(seen: seen)
        } catch {
            return .unreachable(error.localizedDescription)
        }
    }
}

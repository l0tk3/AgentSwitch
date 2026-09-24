import Foundation
import Network

/// Browses `_agentswitch._tcp` for a while, then resolves every service that advertises an `fp` to an IPv4 address.
/// Needs NSLocalNetworkUsageDescription and NSBonjourServices in the app's Info.plist.
public struct BonjourDiscovery: ServiceDiscovery {
    public static let serviceType = "_agentswitch._tcp"
    public let resolveTimeout: Duration

    public init(resolveTimeout: Duration = .seconds(2)) {
        self.resolveTimeout = resolveTimeout
    }

    public func discover(timeout: Duration) async -> [DiscoveredService] {
        let found = await browse(for: timeout)
        return await withTaskGroup(of: DiscoveredService?.self) { group in
            for (endpoint, name, fp) in found {
                group.addTask { await resolve(endpoint, name: name, fingerprintPrefix: fp) }
            }
            var services: [DiscoveredService] = []
            for await service in group { if let service { services.append(service) } }
            return services.sorted { $0.name < $1.name }
        }
    }

    private func browse(for timeout: Duration) async -> [(NWEndpoint, String, String?)] {
        let browser = NWBrowser(for: .bonjourWithTXTRecord(type: Self.serviceType, domain: nil), using: .tcp)
        let results = LockedBox<[BrowsedService]>([])
        browser.browseResultsChangedHandler = { latest, _ in
            let services = latest.compactMap(BrowsedService.init)
            results.withLock { $0 = services }
        }
        browser.start(queue: DispatchQueue(label: "agentswitch.bonjour.browse"))
        try? await Task.sleep(for: timeout)
        browser.cancel()
        return results.value.map { ($0.endpoint, $0.name, $0.fingerprintPrefix) }
    }

    /// Opens a TCP connection only long enough to learn the address it reached; IPv4 so the URL needs no zone id.
    private func resolve(_ endpoint: NWEndpoint, name: String, fingerprintPrefix: String?) async -> DiscoveredService? {
        let params = NWParameters.tcp
        if let ip = params.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options { ip.version = .v4 }
        let connection = NWConnection(to: endpoint, using: params)
        let outcome = LockedBox<ResolveOutcome>(.pending)
        let resolved: DiscoveredService? = await withCheckedContinuation { cont in
            let finish: @Sendable (DiscoveredService?) -> Void = { service in
                let first = outcome.withLock { state -> Bool in
                    guard case .pending = state else { return false }
                    state = .done
                    return true
                }
                if first { cont.resume(returning: service) }
            }
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    if case .hostPort(let host, let port)? = connection.currentPath?.remoteEndpoint {
                        finish(DiscoveredService(name: name, fingerprintPrefix: fingerprintPrefix,
                                                 host: Self.hostString(host), port: Int(port.rawValue)))
                    } else {
                        finish(nil)
                    }
                case .failed, .cancelled: finish(nil)
                default: break
                }
            }
            connection.start(queue: DispatchQueue(label: "agentswitch.bonjour.resolve"))
            let limit = resolveTimeout
            Task {
                try? await Task.sleep(for: limit)
                finish(nil)
            }
        }
        connection.cancel()
        return resolved
    }

    static func hostString(_ host: NWEndpoint.Host) -> String {
        switch host {
        case .ipv4(let a): return "\(a)"
        case .ipv6(let a): return "\(a)".components(separatedBy: "%").first ?? "\(a)"
        case .name(let n, _): return n
        @unknown default: return "\(host)"
        }
    }

    private enum ResolveOutcome: Sendable { case pending, done }

    private struct BrowsedService: Sendable {
        let endpoint: NWEndpoint
        let name: String
        let fingerprintPrefix: String?

        init?(_ result: NWBrowser.Result) {
            guard case .service(let name, _, _, _) = result.endpoint else { return nil }
            var fp: String?
            if case .bonjour(let txt) = result.metadata { fp = txt["fp"] }
            self.endpoint = result.endpoint
            self.name = name
            self.fingerprintPrefix = fp
        }
    }
}

/// NWPathMonitor as a stream of snapshots.
public struct NetworkPathMonitor: PathMonitoring {
    public init() {}

    public func changes() -> AsyncStream<NetworkPathSnapshot> {
        let (stream, continuation) = AsyncStream<NetworkPathSnapshot>.makeStream(bufferingPolicy: .bufferingNewest(1))
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { path in continuation.yield(Self.snapshot(path)) }
        monitor.start(queue: DispatchQueue(label: "agentswitch.path"))
        continuation.onTermination = { _ in monitor.cancel() }
        return stream
    }

    static func snapshot(_ path: NWPath) -> NetworkPathSnapshot {
        let interfaces = path.availableInterfaces.map { iface -> String in
            let type: String
            switch iface.type {
            case .wifi: type = "wifi"
            case .cellular: type = "cellular"
            case .wiredEthernet: type = "wired"
            case .loopback: type = "loopback"
            default: type = "other"
            }
            return "\(type):\(iface.name)"
        }
        return NetworkPathSnapshot(satisfied: path.status == .satisfied, interfaces: interfaces.sorted())
    }
}

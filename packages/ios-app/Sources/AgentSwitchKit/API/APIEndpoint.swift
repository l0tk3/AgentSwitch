import Foundation

/// How an address was learned, in the order endpoint selection prefers them.
public enum EndpointKind: String, Codable, Sendable, CaseIterable {
    case bonjour, lan, tailnet

    public var title: String {
        switch self {
        case .bonjour: return "LAN (Bonjour)"
        case .lan: return "LAN"
        case .tailnet: return "Tailscale"
        }
    }

    /// The line without how it was found: "局域网" or "Tailscale" (the connection state, "已连接（局域网）").
    public var lineTitle: String {
        switch self {
        case .bonjour, .lan: return "LAN"
        case .tailnet: return "Tailscale"
        }
    }
}

/// One way to reach the Mac's remote listener.
public struct APIEndpoint: Codable, Sendable, Hashable {
    public let host: String
    public let port: Int
    public let kind: EndpointKind

    public init(host: String, port: Int, kind: EndpointKind) {
        self.host = host
        self.port = port
        self.kind = kind
    }

    public var authority: String { "\(HostAddress.urlHost(host)):\(port)" }
    public var baseURL: URL { URL(string: "https://\(authority)")! }

    /// `path` is already split into segments; each is percent-encoded so an id can never change the route.
    public func url(_ segments: [String], query: [URLQueryItem] = []) -> URL {
        var comps = URLComponents()
        comps.scheme = "https"
        comps.percentEncodedHost = HostAddress.urlHost(host)
        comps.port = port
        comps.percentEncodedPath = "/" + segments.map(Self.encodeSegment).joined(separator: "/")
        if !query.isEmpty { comps.queryItems = query }
        return comps.url!
    }

    static func encodeSegment(_ s: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/;?#%")
        return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
    }
}

/// Supplies the endpoint to use and hears about failures, so a broken path is re-selected. ConnectionManager in the
/// app; a fixed endpoint in tests.
public protocol EndpointProviding: Sendable {
    func endpoint() async throws -> APIEndpoint
    func reportFailure(_ endpoint: APIEndpoint) async
}

/// Always the same endpoint (pairing, tests).
public struct FixedEndpoint: EndpointProviding {
    public let value: APIEndpoint

    public init(_ value: APIEndpoint) { self.value = value }

    public func endpoint() async throws -> APIEndpoint { value }
    public func reportFailure(_ endpoint: APIEndpoint) async {}
}

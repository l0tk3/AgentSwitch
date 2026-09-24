import Foundation
import XCTest
@testable import AgentSwitchKit

enum Fixture {
    static func data(_ name: String) throws -> Data {
        let url = try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: nil, subdirectory: "Fixtures"), "missing fixture \(name)")
        return try Data(contentsOf: url)
    }

    static func decode<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
        try JSONDecoder().decode(T.self, from: data(name))
    }
}

func httpResponse(_ url: URL?, status: Int = 200, contentType: String = "application/json") -> HTTPURLResponse {
    HTTPURLResponse(url: url ?? URL(string: "https://x")!, statusCode: status, httpVersion: "HTTP/1.1",
                    headerFields: ["Content-Type": contentType])!
}

func json(_ object: Any) -> Data {
    (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data()
}

/// Scripted HTTP: a handler per call, every request recorded.
final class FakeTransport: HTTPTransport, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest, Int) async throws -> (Data, HTTPURLResponse)
    typealias StreamHandler = @Sendable (URLRequest, Int) async throws -> (HTTPURLResponse, [Data], Error?)

    private let log = LockedBox<[URLRequest]>([])
    private let streamCount = LockedBox<Int>(0)
    private let handler: Handler
    private let streamHandler: StreamHandler?

    static let okHandler: Handler = { req, _ in (Data("{}".utf8), httpResponse(req.url)) }

    init(handler: @escaping Handler = FakeTransport.okHandler) {
        self.handler = handler
        self.streamHandler = nil
    }

    init(stream: @escaping StreamHandler, handler: @escaping Handler = FakeTransport.okHandler) {
        self.handler = handler
        self.streamHandler = stream
    }

    var requests: [URLRequest] { log.value }
    var paths: [String] { requests.map { $0.url?.path ?? "" } }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let n = log.withLock { $0.append(request); return $0.count - 1 }
        return try await handler(request, n)
    }

    func stream(_ request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, Error>) {
        log.withLock { $0.append(request) }
        let n = streamCount.withLock { $0 += 1; return $0 - 1 }
        guard let streamHandler else { throw APIError.transport("no stream handler") }
        let (response, chunks, failure) = try await streamHandler(request, n)
        let (body, sink) = AsyncThrowingStream<Data, Error>.makeStream()
        for chunk in chunks { sink.yield(chunk) }
        sink.finish(throwing: failure)
        return (response, body)
    }
}

/// Canned Bonjour results.
struct FakeDiscovery: ServiceDiscovery {
    let services: [DiscoveredService]
    func discover(timeout: Duration) async -> [DiscoveredService] { services }
}

/// Probe outcomes by host, with a call counter and optional per-host delay.
final class FakeProber: EndpointProber, @unchecked Sendable {
    private let outcomes: LockedBox<[String: ProbeOutcome]>
    private let delays: [String: Duration]
    private let calls = LockedBox<[String]>([])

    init(_ outcomes: [String: ProbeOutcome], delays: [String: Duration] = [:]) {
        self.outcomes = LockedBox(outcomes)
        self.delays = delays
    }

    var probed: [String] { calls.value }

    func set(_ host: String, _ outcome: ProbeOutcome) { outcomes.withLock { $0[host] = outcome } }

    func probe(_ endpoint: APIEndpoint, token: String?) async -> ProbeOutcome {
        calls.withLock { $0.append(endpoint.host) }
        if let delay = delays[endpoint.host] { try? await Task.sleep(for: delay) }
        if Task.isCancelled { return .unreachable("cancelled") }
        return outcomes.value[endpoint.host] ?? .unreachable("no route")
    }
}

extension PairingPayload {
    static let sampleKey = Base64URL.encode(Data(repeating: 7, count: 32))

    static func sample(gate: GateKey? = GateKey(publicKey: PairingPayload.sampleKey, keypair: "default")) -> PairingPayload {
        PairingPayload(name: "Mac mini", port: 4713, fp: String(repeating: "ab", count: 32), code: "7K3M-9QZX",
                       lan: ["192.168.1.5"], tailnet: ["100.101.102.103", "mac.tail1234.ts.net"],
                       bonjour: "AgentSwitch on Mac mini", gate: gate)
    }
}

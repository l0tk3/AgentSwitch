import XCTest
@testable import AgentSwitchKit

final class EndpointSelectorTests: XCTestCase {
    private let book = PairingPayload.sample()
    private var prefix: String { String(book.fp.prefix(16)) }

    func testOrderBonjourThenLanThenTailnet() {
        let found = [
            DiscoveredService(name: "AgentSwitch on Other", fingerprintPrefix: "0000000000000000", host: "192.168.1.9", port: 4713),
            DiscoveredService(name: "AgentSwitch on Mac mini", fingerprintPrefix: prefix.uppercased(), host: "192.168.1.77", port: 4800),
            DiscoveredService(name: "no txt", fingerprintPrefix: nil, host: "192.168.1.10", port: 4713),
        ]
        let c = EndpointSelector.candidates(for: book, discovered: found)
        XCTAssertEqual(c.map(\.kind), [.bonjour, .lan, .tailnet, .tailnet])
        XCTAssertEqual(c.map(\.authority), ["192.168.1.77:4800", "192.168.1.5:4713", "100.101.102.103:4713", "mac.tail1234.ts.net:4713"])
    }

    func testDuplicateAddressKeepsTheBetterKind() {
        let found = [DiscoveredService(name: "m", fingerprintPrefix: prefix, host: "192.168.1.5", port: 4713)]
        let c = EndpointSelector.candidates(for: book, discovered: found)
        XCTAssertEqual(c.filter { $0.host == "192.168.1.5" }.map(\.kind), [.bonjour])
    }

    func testPrefersEarlierCandidateEvenIfSlower() async {
        let prober = FakeProber(["192.168.1.5": .ok, "100.101.102.103": .ok], delays: ["192.168.1.5": .milliseconds(80)])
        let c = EndpointSelector.candidates(for: book, discovered: [])
        let result = await EndpointSelector.select(from: c, token: "t", prober: prober)
        XCTAssertEqual(result, .selected(APIEndpoint(host: "192.168.1.5", port: 4713, kind: .lan)))
    }

    func testFallsBackToTailnet() async {
        let prober = FakeProber(["mac.tail1234.ts.net": .ok])
        let result = await EndpointSelector.select(from: EndpointSelector.candidates(for: book, discovered: []), token: nil, prober: prober)
        XCTAssertEqual(result, .selected(APIEndpoint(host: "mac.tail1234.ts.net", port: 4713, kind: .tailnet)))
    }

    func testFailureReasons() {
        let c = EndpointSelector.candidates(for: book, discovered: [])
        XCTAssertEqual(EndpointSelector.decide(candidates: c, outcomes: [.unreachable("x"), .unauthorized, .pinMismatch(seen: "ff"), .unreachable("y")]), .unauthorized)
        XCTAssertEqual(EndpointSelector.decide(candidates: c, outcomes: [.unreachable("x"), .pinMismatch(seen: "ff"), .unreachable("y"), .unreachable("z")]), .pinMismatch(seen: "ff"))
        XCTAssertEqual(EndpointSelector.decide(candidates: [], outcomes: []), .unreachable)
    }
}

/// Path changes on demand.
final class ScriptedPaths: PathMonitoring, @unchecked Sendable {
    private let pair = AsyncStream<NetworkPathSnapshot>.makeStream()
    func changes() -> AsyncStream<NetworkPathSnapshot> { pair.stream }
    func emit(_ s: NetworkPathSnapshot) { pair.continuation.yield(s) }
}

final class ConnectionManagerTests: XCTestCase {
    private let book = PairingPayload.sample()

    func testSelectsOnceForConcurrentCallers() async throws {
        let prober = FakeProber(["192.168.1.5": .ok], delays: ["192.168.1.5": .milliseconds(50)])
        let manager = ConnectionManager(book: book, token: "t", discovery: nil, prober: prober)
        async let a = manager.endpoint()
        async let b = manager.endpoint()
        let (ea, eb) = try await (a, b)
        XCTAssertEqual(ea, eb)
        XCTAssertEqual(prober.probed.filter { $0 == "192.168.1.5" }.count, 1)
        let again = try await manager.endpoint()
        XCTAssertEqual(again.host, "192.168.1.5")
        XCTAssertEqual(prober.probed.filter { $0 == "192.168.1.5" }.count, 1, "cached until a failure")
    }

    func testFailureTriggersReselection() async throws {
        let prober = FakeProber(["192.168.1.5": .ok, "100.101.102.103": .ok])
        let manager = ConnectionManager(book: book, token: "t", discovery: nil, prober: prober)
        let first = try await manager.endpoint()
        XCTAssertEqual(first.kind, .lan)
        prober.set("192.168.1.5", .unreachable("left home"))
        await manager.reportFailure(first)
        let second = try await manager.endpoint()
        XCTAssertEqual(second.host, "100.101.102.103")
    }

    func testRevokedTokenSurfacesAsUnauthorized() async {
        let manager = ConnectionManager(book: book, token: "t", discovery: nil, prober: FakeProber(["192.168.1.5": .unauthorized]))
        do {
            _ = try await manager.endpoint()
            XCTFail("expected unauthorized")
        } catch {
            XCTAssertEqual(error as? APIError, .unauthorized)
        }
        let state = await manager.current
        XCTAssertEqual(state, .unauthorized)
    }

    func testPathChangeReselects() async throws {
        let prober = FakeProber(["192.168.1.5": .ok, "100.101.102.103": .ok])
        let manager = ConnectionManager(book: book, token: "t", discovery: nil, prober: prober, settleDelay: .milliseconds(10))
        _ = try await manager.endpoint()
        let paths = ScriptedPaths()
        await manager.startMonitoring(paths)
        var states = await manager.states().makeAsyncIterator()
        _ = await states.next()  // current: connected(lan)

        prober.set("192.168.1.5", .unreachable("cellular now"))
        paths.emit(NetworkPathSnapshot(satisfied: true, interfaces: ["wifi:en0"]))   // baseline, no reselect
        paths.emit(NetworkPathSnapshot(satisfied: true, interfaces: ["cellular:pdp_ip0"]))
        var seen: [ConnectionState] = []
        while let s = await states.next() {
            seen.append(s)
            if s.endpoint != nil { break }
        }
        XCTAssertEqual(seen.last, .connected(APIEndpoint(host: "100.101.102.103", port: 4713, kind: .tailnet)))
        XCTAssertTrue(seen.contains(.selecting))
        await manager.stop()
    }

    func testBonjourServiceWinsWhenFingerprintMatches() async throws {
        let prefix = String(book.fp.prefix(16))
        let discovery = FakeDiscovery(services: [DiscoveredService(name: "AgentSwitch on Mac mini", fingerprintPrefix: prefix, host: "192.168.1.77", port: 4713)])
        let prober = FakeProber(["192.168.1.77": .ok, "192.168.1.5": .ok])
        let manager = ConnectionManager(book: book, token: "t", discovery: discovery, prober: prober)
        let endpoint = try await manager.endpoint()
        XCTAssertEqual(endpoint, APIEndpoint(host: "192.168.1.77", port: 4713, kind: .bonjour))
    }
}

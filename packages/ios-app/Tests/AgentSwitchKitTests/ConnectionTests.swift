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

    /// Settings › Mac lists every address with what came of it (2026-09-26: the app gave no reason over Tailscale).
    func testTheSelectionReportsEveryAddress() async {
        let book = PairingPayload.sample()
        let prober = FakeProber(["192.168.1.5": .unreachable("请求超时。"), "100.101.102.103": .ok])
        let candidates = EndpointSelector.candidates(for: book, discovered: [])
        let (result, reports) = await EndpointSelector.selectReporting(from: candidates, token: "t", prober: prober)
        XCTAssertEqual(result, .selected(APIEndpoint(host: "100.101.102.103", port: 4713, kind: .tailnet)))
        XCTAssertEqual(reports.map(\.endpoint), candidates)
        XCTAssertEqual(reports.first?.outcome, .unreachable("请求超时。"))
        XCTAssertEqual(reports.first { $0.endpoint.host == "100.101.102.103" }?.outcome, .ok)
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

    /// 2026-09-26: a phone paired while the Mac had no Tailscale address could not connect on mobile data. Once
    /// connected it takes the Mac's current addresses; the next selection off the LAN finds the Tailscale one.
    func testAddressesLearnedLaterAreUsedOffTheLan() async throws {
        let saved = ServerProfile(name: "Mac", port: 4713, fingerprint: String(repeating: "ab", count: 32), lan: ["192.168.1.5"], tailnet: [],
                                  bonjour: "AgentSwitch on Mac", gate: nil, deviceId: "d", pairedAt: Date())
        let prober = FakeProber(["192.168.1.5": .ok, "100.101.102.103": .ok])
        let manager = ConnectionManager(book: saved, token: "t", discovery: nil, prober: prober)
        let home = try await manager.endpoint()
        XCTAssertEqual(home.kind, .lan)
        let learned = try XCTUnwrap(saved.updated(with: MacAddresses(lan: ["192.168.1.5"], tailnet: ["100.101.102.103", "mac.tail1234.ts.net"])))
        XCTAssertEqual(learned.tailnet, ["100.101.102.103", "mac.tail1234.ts.net"])
        await manager.update(book: learned)
        prober.set("192.168.1.5", .unreachable("mobile data"))
        await manager.reportFailure(home)
        let away = try await manager.endpoint()
        XCTAssertEqual(away, APIEndpoint(host: "100.101.102.103", port: 4713, kind: .tailnet))
    }

    func testAnEmptyKindKeepsTheSavedAddressesAndNothingNewChangesNothing() {
        let saved = ServerProfile(name: "Mac", port: 4713, fingerprint: String(repeating: "ab", count: 32), lan: ["192.168.1.5"], tailnet: ["100.101.102.103"],
                                  bonjour: "b", gate: nil, deviceId: "d", pairedAt: Date())
        XCTAssertNil(saved.updated(with: MacAddresses(lan: ["192.168.1.5"], tailnet: [])), "Tailscale off for a moment keeps the saved address")
        XCTAssertNil(saved.updated(with: MacAddresses(lan: [], tailnet: ["100.101.102.103"])))
        XCTAssertEqual(saved.updated(with: MacAddresses(lan: ["192.168.1.20", "bad host!"], tailnet: []))?.lan, ["192.168.1.20", "192.168.1.5"],
                       "the new address first, the one before kept behind it; what is no address dropped")
    }

    /// 2026-10-07: a Mac that moves between networks has another address on each, and the phone kept only the last
    /// one it was told. It keeps the earlier ones too, so the Mac is found where it has been before without Bonjour
    /// or Tailscale to tell the phone again.
    func testAMacThatMovesBetweenNetworksIsFoundOnEitherOne() async throws {
        let fp = String(repeating: "ab", count: 32)
        let home = ServerProfile(name: "Mac", port: 4713, fingerprint: fp, lan: ["192.168.31.137"], tailnet: ["100.77.168.100"],
                                 bonjour: "b", gate: nil, deviceId: "d", pairedAt: Date())
        // At the office, reached over Tailscale: the phone is told the address there.
        let office = try XCTUnwrap(home.updated(with: MacAddresses(lan: ["10.38.120.101"], tailnet: ["100.77.168.100"])))
        XCTAssertEqual(office.lan, ["10.38.120.101", "192.168.31.137"])
        XCTAssertEqual(office.tailnet, ["100.77.168.100"])
        // Told the same again: nothing to save. Back home: the order turns, nothing is lost.
        XCTAssertNil(office.updated(with: MacAddresses(lan: ["10.38.120.101"], tailnet: ["100.77.168.100"])))
        let back = try XCTUnwrap(office.updated(with: MacAddresses(lan: ["192.168.31.137"], tailnet: [])))
        XCTAssertEqual(back.lan, ["192.168.31.137", "10.38.120.101"])
        // On both at once (two interfaces): both first, in the Mac's order.
        XCTAssertNil(back.updated(with: MacAddresses(lan: ["192.168.31.137", "10.38.120.101"], tailnet: [])))
        XCTAssertEqual(back.updated(with: MacAddresses(lan: ["10.38.120.101", "192.168.31.137"], tailnet: []))?.lan, ["10.38.120.101", "192.168.31.137"])

        // The next morning at the office, no Bonjour on that network and Tailscale off: the address from yesterday answers.
        let prober = FakeProber(["10.38.120.101": .ok])
        let manager = ConnectionManager(book: back, token: "t", discovery: nil, prober: prober)
        let found = try await manager.endpoint()
        XCTAssertEqual(found, APIEndpoint(host: "10.38.120.101", port: 4713, kind: .lan))

        // Only so many are kept, the newest first.
        var many = home
        for i in 1...12 { many = try XCTUnwrap(many.updated(with: MacAddresses(lan: ["10.0.\(i).2"], tailnet: []))) }
        XCTAssertEqual(many.lan.count, ServerProfile.rememberedLAN)
        XCTAssertEqual(many.lan.first, "10.0.12.2")
        XCTAssertEqual(many.lan.last, "10.0.5.2")
        XCTAssertFalse(many.lan.contains("192.168.31.137"), "the oldest go")
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

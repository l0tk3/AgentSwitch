import XCTest
@testable import AgentSwitchKit

/// Counts failure reports and hands out endpoints in turn.
final class RotatingEndpoints: EndpointProviding, @unchecked Sendable {
    private let list: [APIEndpoint]
    private let index = LockedBox<Int>(0)
    private let reports = LockedBox<[APIEndpoint]>([])

    init(_ list: [APIEndpoint]) { self.list = list }

    var failures: [APIEndpoint] { reports.value }

    func endpoint() async throws -> APIEndpoint { list[min(index.value, list.count - 1)] }
    func reportFailure(_ endpoint: APIEndpoint) async {
        reports.withLock { $0.append(endpoint) }
        index.withLock { $0 += 1 }
    }
}

final class APIClientTests: XCTestCase {
    /// One session carries everything said to a Mac, its streams too, and iOS gives a host four connections unless
    /// told otherwise: with four streams followed, nothing else got through (2026-11-10).
    func testTheSessionMayHoldMoreConnectionsThanStreamsAreFollowed() {
        XCTAssertGreaterThanOrEqual(PinnedSessionTransport.defaultConfiguration().httpMaximumConnectionsPerHost, 32)
    }

    private let lan = APIEndpoint(host: "192.168.1.5", port: 4713, kind: .lan)
    private let tailnet = APIEndpoint(host: "fd7a:115c:a1e0::5", port: 4713, kind: .tailnet)

    func testRequestShape() async throws {
        let transport = FakeTransport { req, _ in (json(["token": "asv:1:abc"]), httpResponse(req.url)) }
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")
        let token = try await api.vaultSeal("p@ss word")
        XCTAssertEqual(token, "asv:1:abc")
        let req = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(req.url?.absoluteString, "https://192.168.1.5:4713/vault/seal")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let body = try XCTUnwrap(req.httpBody.flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: String] })
        XCTAssertEqual(body, ["value": "p@ss word"])
    }

    func testASealedWriteWaitsLongerThanTheSealer() {
        XCTAssertGreaterThan(AgentSwitchAPI.createTaskTimeout, 30, "the Mac may take 30 s to seal before it answers")
    }

    func testDeletesAreDeleteRequestsAndNeverResent() async throws {
        let transport = FakeTransport { req, n in
            if n == 0 { return (json(["ok": true]), httpResponse(req.url)) }
            if n == 1 { return (json(["error": "session is open in a terminal"]), httpResponse(req.url, status: 409)) }
            throw APIError.transport("timed out")
        }
        let endpoints = RotatingEndpoints([lan, tailnet])
        let api = AgentSwitchAPI(endpoints: endpoints, transport: transport, token: "tok")
        try await api.deleteSession(harness: "codex", id: "s1")
        do { try await api.deleteSession(harness: "codex", id: "s2"); XCTFail("expected 409") } catch {
            XCTAssertEqual(error as? APIError, .http(status: 409, message: "session is open in a terminal"), "the Mac's own words")
        }
        do { try await api.deleteSession(harness: "codex", id: "s3"); XCTFail("expected transport error") } catch {
            XCTAssertEqual(error as? APIError, .transport("timed out"))
        }
        XCTAssertEqual(transport.requests.map { "\($0.httpMethod ?? "") \($0.url?.path ?? "")" },
                       ["DELETE /sessions/codex/s1", "DELETE /sessions/codex/s2", "DELETE /sessions/codex/s3"], "a DELETE is sent once, like a POST")
        XCTAssertNil(transport.requests[0].httpBody)
    }

    func testIdsArePathSegmentsNotRoutes() {
        let url = tailnet.url(["terminals", "a/../b?x#y", "stream"], query: [URLQueryItem(name: "after", value: "12")])
        XCTAssertEqual(url.absoluteString, "https://[fd7a:115c:a1e0::5]:4713/terminals/a%2F..%2Fb%3Fx%23y/stream?after=12")
    }

    func testUnauthorized() async {
        let transport = FakeTransport { req, _ in (json(["error": "unauthorized"]), httpResponse(req.url, status: 401)) }
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "revoked")
        do { _ = try await api.me(); XCTFail() } catch { XCTAssertEqual(error as? APIError, .unauthorized) }
    }

    func testGetRetriesOnceOnANewEndpointButPostDoesNot() async throws {
        let transport = FakeTransport { req, _ in
            if req.url?.host(percentEncoded: false) == "192.168.1.5" { throw APIError.transport("timed out") }
            return (json(["id": "d1"]), httpResponse(req.url))
        }
        let endpoints = RotatingEndpoints([lan, tailnet])
        let api = AgentSwitchAPI(endpoints: endpoints, transport: transport, token: "tok")
        let me = try await api.me()
        XCTAssertEqual(me.deviceId, "d1")
        XCTAssertEqual(endpoints.failures, [lan])

        let endpoints2 = RotatingEndpoints([lan, tailnet])
        let api2 = AgentSwitchAPI(endpoints: endpoints2, transport: transport, token: "tok")
        do { _ = try await api2.vaultSeal("x"); XCTFail() } catch {
            XCTAssertEqual(error as? APIError, .transport("timed out"))
        }
        XCTAssertEqual(transport.requests.filter { $0.httpMethod == "POST" }.count, 1, "no automatic resend of a POST")
    }
}

final class ReconnectPolicyTests: XCTestCase {
    func testBackoff() {
        let p = ReconnectPolicy(initial: .seconds(1), maximum: .seconds(15))
        XCTAssertEqual((1...6).map { p.delay(afterFailures: $0) }, [.seconds(1), .seconds(2), .seconds(4), .seconds(8), .seconds(15), .seconds(15)])
    }
}

import XCTest
@testable import AgentSwitchMacCore

/// Another node's replacement settings from this Mac (2026-11-28, user #89-#91): the same routes through the node, a
/// word sealed by that node before it is sent, and a node too old for them said so.
final class RedactionRemoteTests: XCTestCase {
    private static let word = #"{"word":{"id":"w1","value":"PROBE-WORD","restore":true,"addedAt":0},"warning":null}"#

    func testOnThisMacTheWordGoesAsItIs() async throws {
        let transport = StubTransport { _ in (201, Self.word) }
        let here = DaemonClient(port: 4711, transport: transport)
        _ = try await here.addRedactWord("PROBE-WORD", replace: "P1", regex: true)
        XCTAssertEqual(transport.requests.map { "\($0.httpMethod ?? "") \($0.url!.path)" }, ["POST /redaction/words"])
        let body = try JSONSerialization.jsonObject(with: transport.requests[0].httpBody!) as! [String: Any]
        XCTAssertEqual(body["value"] as? String, "PROBE-WORD")
        XCTAssertNil(body["sealed"])
        XCTAssertEqual(body["replace"] as? String, "P1")
        XCTAssertEqual(body["regex"] as? Bool, true)
    }

    func testOnAnotherNodeTheWordIsSealedByThatNodeAndOnlyTheCiphertextIsSent() async throws {
        let transport = StubTransport { request in
            request.url!.path.hasSuffix("/vault/seal") ? (200, #"{"token":"asv:1:SEALED"}"#) : (201, Self.word)
        }
        let there = DaemonClient(port: 4711, transport: transport).onNode("mini")
        _ = try await there.addRedactWord("PROBE-WORD", replace: nil)
        _ = try await there.addRedactWord("PROBE-WORD", replace: nil, room: "r1")
        XCTAssertEqual(transport.requests.map { "\($0.httpMethod ?? "") \($0.url!.path)" }, [
            "POST /nodes/mini/vault/seal", "POST /nodes/mini/redaction/words",
            "POST /nodes/mini/vault/seal", "POST /nodes/mini/rooms/r1/redaction/words",
        ])
        for i in [1, 3] {
            let body = try JSONSerialization.jsonObject(with: transport.requests[i].httpBody!) as! [String: Any]
            XCTAssertEqual(body["sealed"] as? String, "asv:1:SEALED")
            XCTAssertNil(body["value"], "the word itself is not in the request")
            XCTAssertNil(body["replace"])
        }
    }

    func testTheOtherCallsGoThroughTheNode() async throws {
        let state = #"{"settings":{"enabled":true,"username":true,"host":false,"log":false,"keepDays":3,"hosts":[]},"words":[],"gateway":true,"logDir":"/x"}"#
        let transport = StubTransport { request in
            switch request.httpMethod! {
            case "GET": return (200, state)
            case "PATCH": return (200, #"{"settings":{"enabled":false,"username":true,"host":false,"log":false,"keepDays":3,"hosts":[]}}"#)
            default: return (200, "{}")
            }
        }
        let there = DaemonClient(port: 4711, transport: transport).onNode("mini")
        let read = try await there.redaction()
        XCTAssertTrue(read.settings.enabled)
        let set = try await there.setRedaction(Data(#"{"enabled":false}"#.utf8))
        XCTAssertFalse(set.enabled)
        try await there.removeRedactWord("w1")
        XCTAssertEqual(transport.requests.map { "\($0.httpMethod ?? "") \($0.url!.path)" }, [
            "GET /nodes/mini/redaction", "PATCH /nodes/mini/redaction/settings", "DELETE /nodes/mini/redaction/words/w1"])
    }

    func testANodeTooOldForTheRoutesIsSaidSo() async {
        let there = DaemonClient(port: 4711, transport: StubTransport { _ in (404, "404 Not Found") }).onNode("mini")
        do {
            _ = try await there.redaction()
            XCTFail("a 404 is no answer")
        } catch {
            XCTAssertEqual(RedactionRemote.problem(error), RedactionRemote.tooOld)
        }
        // What an older node's remote listener really answers: a 404 with its own JSON.
        let old = DaemonClient(port: 4711, transport: StubTransport { _ in (404, #"{"error":"not found"}"#) }).onNode("mini")
        do {
            _ = try await old.redaction()
            XCTFail("a 404 is no answer")
        } catch {
            XCTAssertEqual(RedactionRemote.problem(error), RedactionRemote.tooOld)
        }
        XCTAssertNil(RedactionRemote.problem(DaemonError.http(status: 400, message: "too short")), "a refusal says its own words")
        XCTAssertNil(RedactionRemote.problem(DaemonError.http(status: 404, message: "没有这个房间。")), "a room that is not there is not an old node")
    }
}

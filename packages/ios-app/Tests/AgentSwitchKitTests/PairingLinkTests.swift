import XCTest
@testable import AgentSwitchKit

final class PairingLinkTests: XCTestCase {
    private func link(_ object: [String: Any]) -> String {
        "agentswitch://pair?p=" + Base64URL.encode(json(object))
    }

    private var docExample: [String: Any] {
        ["v": 1, "name": "Mac mini", "port": 4713, "fp": String(repeating: "AB", count: 32), "code": "7k3m-9qzx",
         "lan": ["192.168.1.5"], "tailnet": ["100.101.102.103", "mac.tail1234.ts.net"],
         "bonjour": "AgentSwitch on Mac mini", "gate": ["publicKey": PairingPayload.sampleKey, "keypair": "default"]]
    }

    func testParsesTheDocExampleAndNormalizes() throws {
        let p = try PairingLink.parse(link(docExample))
        XCTAssertEqual(p.name, "Mac mini")
        XCTAssertEqual(p.port, 4713)
        XCTAssertEqual(p.fp, String(repeating: "ab", count: 32))
        XCTAssertEqual(p.code, "7K3M-9QZX")
        XCTAssertEqual(p.tailnet, ["100.101.102.103", "mac.tail1234.ts.net"])
    }

    func testCodeDecodesLikeTheDaemon() {
        XCTAssertEqual(PairingLink.normalizeCode("7k3m 9qzo"), "7K3M-9QZ0")
        XCTAssertEqual(PairingLink.normalizeCode("IL00-0000"), "1100-0000")
        XCTAssertNil(PairingLink.normalizeCode("UUUU-UUUU"))
    }

    func testFindsTheLinkInsidePastedText() throws {
        let text = "在手机上打开：\n\(link(docExample))  （5 分钟内有效）"
        XCTAssertEqual(try PairingLink.parse(text).name, "Mac mini")
    }

    func testRoundTripThroughMake() throws {
        let p = PairingPayload.sample()
        XCTAssertEqual(try PairingLink.parse(PairingLink.make(p)), p)
    }

    /// A Mac may still put its old gate key in the link: there or not, whatever it holds, the link reads the same.
    func testTheOldGateKeyIsNotRead() throws {
        let with = try PairingLink.parse(link(docExample))
        var noGate = docExample
        noGate.removeValue(forKey: "gate")
        XCTAssertEqual(try PairingLink.parse(link(noGate)), with)
        var nullGate = docExample
        nullGate["gate"] = NSNull()
        XCTAssertEqual(try PairingLink.parse(link(nullGate)), with)
        var oddGate = docExample
        oddGate["gate"] = ["publicKey": "AAAA"]
        XCTAssertEqual(try PairingLink.parse(link(oddGate)), with)
    }

    func testRejections() {
        let cases: [(String, PairingLinkError)] = [
            ("https://example.com/pair?p=x", .notALink),
            ("agentswitch://other?p=x", .notALink),
            ("agentswitch://pair", .missingPayload),
            ("agentswitch://pair?p=***", .badEncoding),
            ("agentswitch://pair?p=" + Base64URL.encode(Data("not json".utf8)), .badJSON),
        ]
        for (text, error) in cases {
            XCTAssertThrowsError(try PairingLink.parse(text), text) { XCTAssertEqual($0 as? PairingLinkError, error, text) }
        }
        func rejects(_ key: String, _ value: Any, _ expected: PairingLinkError) {
            var obj = docExample
            obj[key] = value
            XCTAssertThrowsError(try PairingLink.parse(link(obj)), key) { XCTAssertEqual($0 as? PairingLinkError, expected, key) }
        }
        rejects("v", 2, .unsupportedVersion(2))
        rejects("fp", "abcd", .invalidField("fp"))
        rejects("fp", String(repeating: "zz", count: 32), .invalidField("fp"))
        rejects("code", "ABCD-EFGU", .invalidField("code"))
        rejects("code", "ABC", .invalidField("code"))
        rejects("code", "ABCD-EFG!", .invalidField("code"))
        rejects("port", 0, .invalidField("port"))
        rejects("name", "  ", .invalidField("name"))
        rejects("lan", ["192.168.1.5/evil?x"], .invalidField("lan"))
        rejects("tailnet", ["host name"], .invalidField("tailnet"))
    }

    func testAddressKinds() {
        XCTAssertTrue(HostAddress.isIPv4("100.101.102.103"))
        XCTAssertTrue(HostAddress.isIPv6("fd7a:115c:a1e0::1"))
        XCTAssertTrue(HostAddress.isDNSName("mac.tail1234.ts.net"))
        XCTAssertFalse(HostAddress.isValid("a/b"))
        XCTAssertFalse(HostAddress.isValid("-a.com"))
        XCTAssertEqual(HostAddress.urlHost("fd7a:115c:a1e0::1"), "[fd7a:115c:a1e0::1]")
    }

    func testProfileFromPayload() {
        let profile = ServerProfile(payload: .sample(), deviceId: "dev1")
        XCTAssertEqual(profile.tokenAccount, profile.fingerprint)
        XCTAssertEqual(profile.deviceId, "dev1")
        XCTAssertEqual(ServerProfile.grouped("abcdef012345"), "abcd ef01 2345")
    }
}

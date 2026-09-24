import XCTest
@testable import AgentSwitchKit

/// Cases mirror packages/secret-gate/tests (policy.py behaviour); CrossLanguageTests checks the same tables against the
/// real Python code when the gate venv is present.
final class GatePolicyTests: XCTestCase {
    func testLabels() {
        for ok in ["a", "site-a/pass", "A.b_c-d/e", "9", String(repeating: "x", count: 64)] {
            XCTAssertTrue(GatePolicy.isValidLabel(ok), ok)
        }
        for bad in ["", "-a", "/a", ".a", "a b", "a:b", "ä", String(repeating: "x", count: 65), "abc\n"] {
            XCTAssertFalse(GatePolicy.isValidLabel(bad), bad)
        }
    }

    func testHostNormalization() throws {
        let cases: [(String, String)] = [
            ("Site.Example.COM", "site.example.com"),
            ("  example.com.  ", "example.com"),
            ("example.com:8001", "example.com:8001"),
            ("example.com.:0443", "example.com:443"),
            ("*.Example.com", "*.example.com"),
            ("192.168.1.5", "192.168.1.5"),
            ("localhost:65535", "localhost:65535"),
            ("*.com", "*.com"),
        ]
        for (input, expected) in cases {
            XCTAssertEqual(try GatePolicy.normalizeHost(input), expected, input)
        }
        for bad in ["", "exa mple.com", "example.com:", ":443", "example.com:0", "example.com:65536", "a:b:1",
                    "-bad.com", "bad-.com", "*", "*.", "a..b", "a.*.b", "under_score.com", "https://x.com", "例子.com", "x.com:٤٤٣"] {
            XCTAssertThrowsError(try GatePolicy.normalizeHost(bad), bad)
        }
    }

    func testHostMatches() {
        XCTAssertTrue(GatePolicy.hostMatches(pattern: "example.com", host: "example.com:8443"))
        XCTAssertTrue(GatePolicy.hostMatches(pattern: "example.com:8443", host: "example.com:8443"))
        XCTAssertFalse(GatePolicy.hostMatches(pattern: "example.com:8443", host: "example.com"))
        XCTAssertTrue(GatePolicy.hostMatches(pattern: "*.example.com", host: "a.example.com"))
        XCTAssertFalse(GatePolicy.hostMatches(pattern: "*.example.com", host: "example.com"))
        XCTAssertFalse(GatePolicy.hostMatches(pattern: "*.example.com", host: "badexample.com"))
    }

    func testBase32() {
        for ok in ["JBSWY3DPEHPK3PXP", "jbswy3dpehpk3pxp", "JBSW Y3DP EHPK 3PXP", "MZXW6YQ", "MZXW6===", "MY", ""] {
            XCTAssertTrue(GatePolicy.isBase32(ok), ok)
        }
        for bad in ["JBSWY3DPEHPK3PX1", "A", "ABC", "ABCDEF", "MZ=XW6YQ", "MZXW6YQ=====", "密钥"] {
            XCTAssertFalse(GatePolicy.isBase32(bad), bad)
        }
    }
}

final class SecretPayloadTests: XCTestCase {
    func testJSONMatchesPythonToJSON() throws {
        let p = try SecretPayload.make(value: "pw-fake-1234", hosts: ["A.example.com", "*.b.com:8443"], uses: [.http, .exec], label: "site-a/pass")
        XCTAssertEqual(p.jsonText, #"{"v":"pw-fake-1234","host":["a.example.com","*.b.com:8443"],"use":["exec","http"],"label":"site-a/pass","kind":"secret","seed_import_hosts":[]}"#)
    }

    func testEnsureASCIIEscaping() throws {
        let value = "q\"b\\s/\n\r\t\u{08}\u{0C}\u{01}\u{7F}é中😀"
        let p = try SecretPayload.make(value: value, hosts: [], uses: [.fill], label: "x")
        XCTAssertEqual(p.jsonText, #"{"v":"q\"b\\s/\n\r\t\b\f\u0001\u007f\u00e9\u4e2d\ud83d\ude00","host":[],"use":["fill"],"label":"x","kind":"secret","seed_import_hosts":[]}"#)
        let decoded = try JSONSerialization.jsonObject(with: p.jsonData) as? [String: Any]
        XCTAssertEqual(decoded?["v"] as? String, value)
    }

    func testValidationMirrorsCreate() {
        XCTAssertThrowsError(try SecretPayload.make(value: "", hosts: [], uses: [.http], label: "a")) { XCTAssertEqual($0 as? GatePolicyError, .emptyValue) }
        XCTAssertThrowsError(try SecretPayload.make(value: "v", hosts: [], uses: [], label: "a")) { XCTAssertEqual($0 as? GatePolicyError, .emptyUses) }
        XCTAssertThrowsError(try SecretPayload.make(value: "v", hosts: [], uses: [.http], label: "-a"))
        XCTAssertThrowsError(try SecretPayload.make(value: "v", hosts: ["bad host"], uses: [.http], label: "a"))
        XCTAssertThrowsError(try SecretPayload.make(value: "not base32!", hosts: [], uses: [.otp], label: "a", kind: .totp)) {
            XCTAssertEqual($0 as? GatePolicyError, .totpNotBase32)
        }
    }

    func testSeedImportGrants() throws {
        let p = try SecretPayload.make(value: "JBSWY3DPEHPK3PXP", hosts: ["*.corp.example"], uses: [.otp], label: "t",
                                       kind: .totp, seedImportHosts: ["vpn.corp.example:443", "VPN.corp.example:443"])
        XCTAssertEqual(p.seedImportHosts, ["vpn.corp.example:443"])
        XCTAssertThrowsError(try SecretPayload.make(value: "pw", hosts: ["a.com"], uses: [.http], label: "t", seedImportHosts: ["a.com"])) {
            XCTAssertEqual($0 as? GatePolicyError, .seedImportNeedsTotp)
        }
        XCTAssertThrowsError(try SecretPayload.make(value: "JBSWY3DP", hosts: ["a.com"], uses: [.otp], label: "t", kind: .totp, seedImportHosts: ["b.com"]))
        XCTAssertThrowsError(try SecretPayload.make(value: "JBSWY3DP", hosts: ["*.a.com"], uses: [.otp], label: "t", kind: .totp, seedImportHosts: ["*.a.com"]))
    }
}

final class SecretDraftTests: XCTestCase {
    func testSitesBecomeHosts() {
        let d = SecretDraft(label: "core", sites: "https://user@core.example:8600/login?x, core.example:8600 | *.b.com，c.com", value: "v")
        XCTAssertEqual(d.siteList.count, 4)
        XCTAssertEqual(d.hostList, ["core.example:8600", "*.b.com", "c.com"])
        let clean = SecretDraft(label: "core", sites: "https://core.example:8600/login, *.b.com", value: "v")
        XCTAssertEqual(clean.hostList, ["core.example:8600", "*.b.com"])
        XCTAssertNil(clean.problem)
        XCTAssertEqual(clean.effectiveNote, "core → core.example:8600, *.b.com")
    }

    func testProblems() {
        XCTAssertEqual(SecretDraft(label: "", value: "v").problem, "缺少 label")
        XCTAssertEqual(SecretDraft(label: "a", value: "").problem, "缺少值")
        XCTAssertEqual(SecretDraft(label: "a", sites: "", value: "v").problem, "http / fill 用途需要站点")
        XCTAssertEqual(SecretDraft(label: "a", sites: "a.com", uses: [.otp], value: "v").problem, "otp 用途只对 TOTP 有效")
        XCTAssertNotNil(SecretDraft(label: "a", sites: "a.com", kind: .totp, uses: [.otp], value: "xyz!").problem)
        XCTAssertNil(SecretDraft(label: "a", sites: "", kind: .totp, uses: [.otp], value: "JBSWY3DPEHPK3PXP").problem)
    }
}

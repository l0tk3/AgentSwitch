import XCTest
@testable import SecretGateCore

final class CSVImportTests: XCTestCase {
    func testThreeAndFourFieldLines() {
        let text = """
        # comment
        portal-a/pass, portal-a.com|login.portal-a.com, Hunter2-Fake
        portal-a/totp, , totp, JBSWY3DPEHPK3PXP

        api/key, api.example.org, secret, sk-fake,with,commas
        """
        let entries = CSVImport.parse(text)
        XCTAssertEqual(entries.count, 3)
        XCTAssertEqual(entries[0].label, "portal-a/pass")
        XCTAssertEqual(entries[0].hostList, ["portal-a.com", "login.portal-a.com"])
        XCTAssertEqual(entries[0].kind, .secret)
        XCTAssertEqual(entries[0].uses, [.http])
        XCTAssertEqual(entries[1].kind, .totp)
        XCTAssertEqual(entries[1].uses, [.otp])
        XCTAssertEqual(entries[1].value, "JBSWY3DPEHPK3PXP")
        XCTAssertEqual(entries[2].value, "sk-fake,with,commas")
    }

    func testTooFewFieldsIgnored() {
        XCTAssertTrue(CSVImport.parse("only,two").isEmpty)
    }
}

final class TokenEntryTests: XCTestCase {
    func testProblems() {
        XCTAssertEqual(TokenEntry().problem, "缺少 label")
        XCTAssertEqual(TokenEntry(label: "a", value: "v").problem, "http 用途需要 host")
        XCTAssertEqual(TokenEntry(label: "a", kind: .secret, uses: [.otp], value: "v").problem, "otp 用途只对 TOTP 有效")
        XCTAssertNil(TokenEntry(label: "a", hosts: "h.example.com", value: "v").problem)
        XCTAssertNil(TokenEntry(label: "a", kind: .totp, uses: [.otp], value: "JBSWY3DPEHPK3PXP").problem)
    }

    func testBatchObjectShapeMatchesCLI() throws {
        let e = TokenEntry(label: "x/y", hosts: "a.com, b.com", kind: .totp, uses: [.http, .otp], value: "S")
        let obj = e.batchObject
        XCTAssertEqual(obj["label"] as? String, "x/y")
        XCTAssertEqual(obj["hosts"] as? [String], ["a.com", "b.com"])
        XCTAssertEqual(obj["kind"] as? String, "totp")
        XCTAssertEqual(obj["uses"] as? [String], ["http", "otp"])
        XCTAssertEqual(obj["value"] as? String, "S")
        XCTAssertNoThrow(try JSONSerialization.data(withJSONObject: [obj]))
    }

    func testHostPortsSurviveSplitting() {
        let e = TokenEntry(label: "a", hosts: "10.0.0.5:8001, 10.0.0.5:8002 *.example.com:9000", value: "v")
        XCTAssertEqual(e.hostList, ["10.0.0.5:8001", "10.0.0.5:8002", "*.example.com:9000"])
        XCTAssertNil(e.problem)
    }

    func testWithIsImmutable() {
        let a = TokenEntry(label: "a", value: "v")
        let b = a.with(label: "b")
        XCTAssertEqual(a.label, "a")
        XCTAssertEqual(b.label, "b")
        XCTAssertEqual(a.id, b.id)
    }
}

final class ResultDecodingTests: XCTestCase {
    func testDecodesMixedResults() throws {
        let json = #"[{"label":"a","token":"enc:v1:abc"},{"label":"b","error":"invalid host"}]"#
        let results = try JSONDecoder().decode([TokenResult].self, from: Data(json.utf8))
        XCTAssertEqual(results.count, 2)
        XCTAssertTrue(results[0].ok)
        XCTAssertFalse(results[1].ok)
        XCTAssertEqual(results[1].error, "invalid host")
    }
}

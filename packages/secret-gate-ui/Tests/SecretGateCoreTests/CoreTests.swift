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

final class MintedRowTests: XCTestCase {
    func testJoinPairsByLabelInOrderAndKeepsNoteAndAccount() {
        let a = TokenEntry(label: "finance/pass", hosts: "core.internal.example:8600", value: "v", note: "财务系统", account: "lotke")
        let b = TokenEntry(label: "mail/totp", hosts: "core.internal.example:8400", kind: .totp, uses: [.otp, .http], value: "S", note: "邮件")
        let rows = MintedRow.join(entries: [a, b], results: [
            TokenResult(label: "mail/totp", token: "enc:v1:TTT", error: nil),
            TokenResult(label: "finance/pass", token: nil, error: "invalid host"),
        ])
        XCTAssertEqual(rows.map(\.label), ["finance/pass", "mail/totp"])
        XCTAssertEqual(rows[0].error, "invalid host")
        XCTAssertNil(rows[0].contextEntry)
        XCTAssertEqual(rows[1].token, "enc:v1:TTT")
        XCTAssertEqual(rows[1].note, "邮件")
        XCTAssertEqual(rows[0].account, "lotke")
    }

    func testContextEntryShape() {
        let pw = MintedRow(entry: TokenEntry(label: "finance/pass", hosts: "a.example:8600, b.example", value: "v", note: "财务系统", account: "lotke"),
                           result: TokenResult(label: "finance/pass", token: "enc:v1:AAA", error: nil))
        XCTAssertEqual(pw.contextEntry, "- 财务系统（finance/pass）：a.example:8600, b.example\n  账号 lotke\n  密码 enc:v1:AAA")
        let totp = MintedRow(entry: TokenEntry(label: "mail/totp", hosts: "m.example", kind: .totp, uses: [.otp], value: "S"),
                             result: TokenResult(label: "mail/totp", token: "enc:v1:TTT", error: nil))
        XCTAssertEqual(totp.contextEntry, "- mail/totp：m.example\n  2FA enc:v1:TTT（用 secret_otp 取码）")
        XCTAssertEqual(pw.exportObject["account"] as? String, "lotke")
        XCTAssertNil(pw.exportObject["value"])
    }

    func testWithKeepsNoteAndAccount() {
        let e = TokenEntry(label: "a", note: "n", account: "u")
        XCTAssertEqual(e.with(value: "x").note, "n")
        XCTAssertEqual(e.with(value: "x").account, "u")
        XCTAssertEqual(e.with(note: "m").account, "u")
    }
}

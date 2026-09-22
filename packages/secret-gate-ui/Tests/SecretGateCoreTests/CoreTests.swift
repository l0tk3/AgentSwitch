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
        let a = TokenEntry(label: "finance/pass", hosts: "core.internal.example:8600", value: "v", note: "财务系统", account: "lotke", encryptAccount: false)
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
        let pw = MintedRow(entry: TokenEntry(label: "finance/pass", hosts: "a.example:8600, b.example", value: "v", note: "财务系统", account: "lotke", encryptAccount: false),
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

final class EncryptedAccountTests: XCTestCase {
    func testAccountEntryOnlyWhenRequestedAndPresent() {
        let e = TokenEntry(label: "fin/pass", hosts: "a.example", value: "v", account: "lotke")
        XCTAssertEqual(e.accountEntry?.label, "fin/pass/user")
        XCTAssertEqual(e.accountEntry?.value, "lotke")
        XCTAssertEqual(e.accountEntry?.hostList, ["a.example"])
        XCTAssertEqual(e.accountEntry?.uses, [.http])
        XCTAssertNil(e.with(encryptAccount: false).accountEntry)
        XCTAssertNil(e.with(account: "").accountEntry)
        XCTAssertNil(TokenEntry(label: "t", kind: .totp, uses: [.otp], value: "S", account: "x").accountEntry)   // no host: nothing to bind to
    }

    func testJoinFoldsTheCompanionIntoItsRowAndPrintsCiphertext() {
        let e = TokenEntry(label: "fin/pass", hosts: "a.example", value: "v", note: "财务", account: "lotke")
        let rows = MintedRow.join(entries: [e], results: [
            TokenResult(label: "fin/pass/user", token: "enc:v1:UUU", error: nil),
            TokenResult(label: "fin/pass", token: "enc:v1:PPP", error: nil),
        ])
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].accountToken, "enc:v1:UUU")
        XCTAssertEqual(rows[0].contextEntry, "- 财务（fin/pass）：a.example\n  账号 enc:v1:UUU（密文，用 secret_fill 填）\n  密码 enc:v1:PPP")
        XCTAssertFalse(rows[0].contextEntry!.contains("lotke"))
        XCTAssertEqual(rows[0].exportObject["account"] as? String, "enc:v1:UUU")
        XCTAssertEqual(rows[0].exportObject["account_encrypted"] as? Bool, true)
    }

    func testCompanionFailureIsReportedOnTheRow() {
        let e = TokenEntry(label: "fin/pass", hosts: "a.example", value: "v", account: "lotke")
        let rows = MintedRow.join(entries: [e], results: [
            TokenResult(label: "fin/pass", token: "enc:v1:PPP", error: nil),
            TokenResult(label: "fin/pass/user", token: nil, error: "boom"),
        ])
        XCTAssertTrue(rows[0].ok)
        XCTAssertEqual(rows[0].error, "账号密文失败：boom")
        XCTAssertEqual(rows[0].contextEntry, "- fin/pass：a.example\n  账号 lotke\n  密码 enc:v1:PPP")   // falls back to plaintext, visibly
    }
}

final class RowStoreTests: XCTestCase {
    func testRoundTripKeepsEverythingButTheValue() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("sgui-\(UUID().uuidString)")
        let store = RowStore(url: dir.appendingPathComponent("rows.json"))
        let a = TokenEntry(label: "fin/pass", hosts: "a.example:8600", kind: .secret, uses: [.http, .exec], value: "SECRET", note: "财务", account: "lotke", encryptAccount: false)
        let b = TokenEntry(label: "mail/totp", hosts: "", kind: .totp, uses: [.otp], value: "S", note: "邮件")
        XCTAssertNil(store.save([a, b]))
        let text = try String(contentsOf: store.url, encoding: .utf8)
        XCTAssertFalse(text.contains("SECRET"))
        let back = store.load()
        XCTAssertEqual(back.map(\.id), [a.id, b.id])
        XCTAssertEqual(back[0].label, "fin/pass")
        XCTAssertEqual(back[0].uses, [.http, .exec])
        XCTAssertEqual(back[0].note, "财务")
        XCTAssertEqual(back[0].account, "lotke")
        XCTAssertFalse(back[0].encryptAccount)
        XCTAssertEqual(back[0].value, "")
        XCTAssertEqual(back[1].kind, .totp)
        XCTAssertTrue(RowStore(url: dir.appendingPathComponent("missing.json")).load().isEmpty)
    }
}

final class RowsExchangeTests: XCTestCase {
    func testExportThenParseRoundTripsEveryField() {
        let a = TokenEntry(label: "fin/pass", hosts: "a.example:8600, b.example", kind: .secret, uses: [.http, .exec], value: "p,w", note: "财务", account: "lotke", encryptAccount: false)
        let b = TokenEntry(label: "mail/totp", hosts: "", kind: .totp, uses: [.otp], value: "S", note: "邮件")
        let text = RowsExchange.export([a, b])
        XCTAssertTrue(text.hasPrefix("["))
        XCTAssertTrue(text.contains("\"value\" : \"p,w\""))
        let back = RowsExchange.parse(text)
        XCTAssertEqual(back.count, 2)
        XCTAssertEqual(back[0].label, "fin/pass")
        XCTAssertEqual(back[0].hostList, ["a.example:8600", "b.example"])
        XCTAssertEqual(back[0].uses, [.http, .exec])
        XCTAssertEqual(back[0].value, "p,w")
        XCTAssertEqual(back[0].note, "财务")
        XCTAssertEqual(back[0].account, "lotke")
        XCTAssertFalse(back[0].encryptAccount)
        XCTAssertEqual(back[1].kind, .totp)
        XCTAssertTrue(back[1].encryptAccount)
        XCTAssertNil(back[0].problem)
    }

    func testParseStillAcceptsCSVAndRejectsJunk() {
        XCTAssertEqual(RowsExchange.parse("x/pass, x.example, v").first?.label, "x/pass")
        XCTAssertTrue(RowsExchange.parse("[not json").isEmpty)
        XCTAssertTrue(RowsExchange.parse("").isEmpty)
    }
}

final class SiteURLTests: XCTestCase {
    func testHostOfStripsSchemePathAndCredentials() {
        XCTAssertEqual(TokenEntry.hostOf("https://core.internal.example:8600/login?next=1#x"), "core.internal.example:8600")
        XCTAssertEqual(TokenEntry.hostOf("http://alice@mail.example/"), "mail.example")
        XCTAssertEqual(TokenEntry.hostOf("10.0.0.5:8001"), "10.0.0.5:8001")
        XCTAssertEqual(TokenEntry.hostOf("*.example.com"), "*.example.com")
    }

    func testTokenBindsHostsButEntryKeepsURLs() {
        let e = TokenEntry(label: "fin/pass", hosts: "https://core.example:8600/login, http://core.example:8600", value: "v", note: "财务", encryptAccount: false)
        XCTAssertEqual(e.hostList, ["core.example:8600"])                       // one binding, scheme-agnostic, deduplicated
        XCTAssertEqual(e.siteList, ["https://core.example:8600/login", "http://core.example:8600"])
        XCTAssertNil(e.problem)
        let row = MintedRow(entry: e, result: TokenResult(label: "fin/pass", token: "enc:v1:AAA", error: nil))
        XCTAssertEqual(row.contextEntry, "- 财务（fin/pass）：https://core.example:8600/login, http://core.example:8600\n  密码 enc:v1:AAA")
        XCTAssertEqual(row.exportObject["hosts"] as? [String], ["core.example:8600"])
        XCTAssertEqual(row.exportObject["sites"] as? [String], e.siteList)
        XCTAssertEqual(e.batchObject["hosts"] as? [String], ["core.example:8600"])   // the CLI never sees a scheme
    }
}

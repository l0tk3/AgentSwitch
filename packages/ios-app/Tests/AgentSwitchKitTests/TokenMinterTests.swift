import Sodium
import XCTest
@testable import AgentSwitchKit

final class TokenMinterTests: XCTestCase {
    func testSealedTokenOpensToThePayload() throws {
        let sodium = Sodium()
        let pair = try XCTUnwrap(sodium.box.keyPair())
        let minter = try TokenMinter(publicKeyBase64URL: Base64URL.encode(pair.publicKey))
        let payload = try SecretPayload.make(value: "pw-fake-1234", hosts: ["a.example.com"], uses: [.http], label: "a/pass")
        let token = try minter.mint(payload)

        XCTAssertTrue(token.hasPrefix("enc:v1:"))
        XCTAssertFalse(token.contains("="), "no padding")
        XCTAssertTrue(TokenMinter.looksLikeToken(token))
        let sealed = try XCTUnwrap(Base64URL.decode(String(token.dropFirst(7))))
        XCTAssertEqual(sealed.count, 48 + payload.sealedData.count, "crypto_box_seal: 32-byte ephemeral key + 16-byte MAC")
        let opened = try XCTUnwrap(sodium.box.open(anonymousCipherText: [UInt8](sealed), recipientPublicKey: pair.publicKey, recipientSecretKey: pair.secretKey))
        XCTAssertEqual(Data(opened), payload.sealedData)
        XCTAssertEqual(try JSONSerialization.jsonObject(with: Data(opened)) as? [String: AnyHashable],
                       try JSONSerialization.jsonObject(with: payload.jsonData) as? [String: AnyHashable], "a JSON reader takes the padding as is")
    }

    /// gate-simple-v0 §3.4: values of 1...200 characters give ciphertexts in 64-byte steps, each opening to its payload.
    func testCiphertextLengthComesInSixtyFourByteSteps() throws {
        let sodium = Sodium()
        let pair = try XCTUnwrap(sodium.box.keyPair())
        let minter = try TokenMinter(publicKey: pair.publicKey)
        var lengths = Set<Int>()
        for n in 1...200 {
            // `otp` has no length floor, so the short values can be minted too (the length rule is tested on its own).
            let payload = try SecretPayload.make(value: String(repeating: "x", count: n), hosts: ["a.example.com"], uses: [.otp], label: "a/pass", kind: .secret)
            let sealed = try XCTUnwrap(Base64URL.decode(String(try minter.mint(payload).dropFirst(7))))
            XCTAssertEqual((sealed.count - 48) % 64, 0, "value of \(n)")
            lengths.insert(sealed.count)
            let opened = try XCTUnwrap(sodium.box.open(anonymousCipherText: [UInt8](sealed), recipientPublicKey: pair.publicKey, recipientSecretKey: pair.secretKey))
            var text = String(decoding: opened, as: UTF8.self)
            while text.hasSuffix(" ") { text.removeLast() }
            XCTAssertEqual(Data(text.utf8), payload.jsonData)
        }
        XCTAssertEqual(lengths.count, 4, "200 lengths collapse into four sizes")
    }

    func testPaddingIsExact() throws {
        let short = try SecretPayload.make(value: "12345678", hosts: [], uses: [.exec], label: "x")
        XCTAssertEqual(short.sealedData.count % 64, 0)
        XCTAssertEqual(short.sealedData.prefix(short.jsonData.count), short.jsonData)
        XCTAssertTrue(short.sealedData.dropFirst(short.jsonData.count).allSatisfy { $0 == 0x20 })
        // A JSON already a multiple of 64 bytes gets nothing added.
        let base = try SecretPayload.make(value: "12345678", hosts: [], uses: [.exec], label: "x").jsonData.count
        let exact = try SecretPayload.make(value: String(repeating: "y", count: 8 + (64 - base % 64) % 64), hosts: [], uses: [.exec], label: "x")
        XCTAssertEqual(exact.jsonData.count % 64, 0)
        XCTAssertEqual(exact.sealedData, exact.jsonData)
    }

    func testEveryTokenIsFresh() throws {
        let minter = try TokenMinter(publicKey: [UInt8](repeating: 9, count: 32))
        let payload = try SecretPayload.make(value: "v-fresh-1", hosts: [], uses: [.fill], label: "x")
        XCTAssertNotEqual(try minter.mint(payload), try minter.mint(payload))
    }

    func testRejectsBadKeys() {
        XCTAssertThrowsError(try TokenMinter(publicKeyBase64URL: "short")) { XCTAssertEqual($0 as? TokenError, .badPublicKey) }
        XCTAssertThrowsError(try TokenMinter(publicKeyBase64URL: "not+base64/url"))
        XCTAssertThrowsError(try TokenMinter(publicKey: [UInt8](repeating: 1, count: 31)))
    }

    func testLooksLikeToken() {
        XCTAssertFalse(TokenMinter.looksLikeToken("enc:v1:short"))
        XCTAssertFalse(TokenMinter.looksLikeToken("enc:v2:AAAAAAAAAAAAAAAAAAAA"))
        XCTAssertTrue(TokenMinter.looksLikeToken("enc:v1:AAAAAAAAAAAAAAAAAAAA"))
    }

    func testBase64URL() {
        let bytes = Data([0xfb, 0xff, 0xfe, 0x00, 0x10])
        XCTAssertEqual(Base64URL.encode(bytes), "-__-ABA")
        XCTAssertEqual(Base64URL.decode("-__-ABA"), bytes)
        XCTAssertEqual(Base64URL.decode("-__-ABA="), bytes)
        XCTAssertNil(Base64URL.decode("+//+ABA="))
        XCTAssertNil(Base64URL.decode("-__-ABA==="))
    }
}

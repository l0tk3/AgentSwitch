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
        XCTAssertEqual(sealed.count, 48 + payload.jsonData.count, "crypto_box_seal: 32-byte ephemeral key + 16-byte MAC")
        let opened = try XCTUnwrap(sodium.box.open(anonymousCipherText: [UInt8](sealed), recipientPublicKey: pair.publicKey, recipientSecretKey: pair.secretKey))
        XCTAssertEqual(Data(opened), payload.jsonData)
    }

    func testEveryTokenIsFresh() throws {
        let minter = try TokenMinter(publicKey: [UInt8](repeating: 9, count: 32))
        let payload = try SecretPayload.make(value: "v", hosts: [], uses: [.fill], label: "x")
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

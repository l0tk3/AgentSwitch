import Security
import XCTest
@testable import AgentSwitchKit

final class LocalStoreTests: XCTestCase {
    func testProfileAndCiphertextsRoundTrip() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("as-store-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = LocalStore(directory: dir)
        XCTAssertNil(try store.loadProfile())
        XCTAssertEqual(try store.loadCiphertexts(), [])

        let profile = ServerProfile(payload: .sample(), deviceId: "dev1", gate: nil, pairedAt: Date(timeIntervalSince1970: 1_790_000_000))
        try store.saveProfile(profile)
        XCTAssertEqual(try store.loadProfile(), profile)

        let saved = [SavedCiphertext(token: "enc:v1:" + String(repeating: "A", count: 40), note: "公司 VPN", createdAt: Date(timeIntervalSince1970: 1_790_000_000))]
        try store.saveCiphertexts(saved)
        XCTAssertEqual(try store.loadCiphertexts(), saved)
        let onDisk = try String(contentsOf: dir.appendingPathComponent("ciphertexts.json"), encoding: .utf8)
        XCTAssertEqual(Set(try XCTUnwrap(JSONSerialization.jsonObject(with: Data(onDisk.utf8)) as? [[String: Any]]).first!.keys),
                       ["id", "token", "note", "createdAt"], "ciphertext and note only")

        try store.deleteProfile()
        XCTAssertNil(try store.loadProfile())
        XCTAssertEqual(saved[0].shortToken, "enc:v1:AAAAAAAA…AAAAAA")
    }

    func testVaults() throws {
        let vault = MemoryTokenVault()
        try vault.save("tok", account: "fp")
        XCTAssertEqual(try vault.load(account: "fp"), "tok")
        try vault.delete(account: "fp")
        XCTAssertNil(try vault.load(account: "fp"))

        let query = KeychainTokenVault().baseQuery(account: "fp")
        XCTAssertEqual(query[kSecAttrService as String] as? String, "com.agentswitch.ios.device-token")
        XCTAssertEqual(query[kSecAttrAccount as String] as? String, "fp")
        XCTAssertEqual(query[kSecUseDataProtectionKeychain as String] as? Bool, true)
    }
}

final class PairingServiceTests: XCTestCase {
    private func transport(pairStatus: Int = 200, gateKey: String? = nil) -> FakeTransport {
        FakeTransport { req, _ in
            switch req.url?.path {
            case "/healthz": return (json(["ok": true]), httpResponse(req.url))
            case "/pair":
                if pairStatus != 200 { return (json(["error": "invalid code"]), httpResponse(req.url, status: pairStatus)) }
                return (json(["deviceId": "dev-9", "token": "tok-9"]), httpResponse(req.url))
            case "/gate/pubkey":
                return (json(["publicKey": gateKey ?? "", "keypair": "work"]), httpResponse(req.url))
            default: return (json(["error": "not found"]), httpResponse(req.url, status: 404))
            }
        }
    }

    func testPairsOverTheFirstReachableAddress() async throws {
        let t = transport()
        let outcome = try await PairingService(transport: t, discovery: nil).pair(.sample(), deviceName: "我的 iPhone")
        XCTAssertEqual(outcome.token, "tok-9")
        XCTAssertEqual(outcome.profile.deviceId, "dev-9")
        XCTAssertEqual(outcome.profile.gate?.keypair, "default")
        XCTAssertEqual(outcome.endpoint.kind, .lan)
        let pair = try XCTUnwrap(t.requests.first { $0.url?.path == "/pair" })
        XCTAssertNil(pair.value(forHTTPHeaderField: "Authorization"))
        let body = try XCTUnwrap(pair.httpBody.flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: String] })
        XCTAssertEqual(body, ["code": "7K3M-9QZX", "name": "我的 iPhone", "platform": "ios"])
        XCTAssertFalse(t.paths.contains("/gate/pubkey"), "the QR code already had the key")
    }

    func testFetchesTheGateKeyWhenTheQRCodeHadNone() async throws {
        let t = transport(gateKey: PairingPayload.sampleKey)
        let outcome = try await PairingService(transport: t, discovery: nil).pair(.sample(gate: nil), deviceName: "")
        XCTAssertEqual(outcome.profile.gate, GateKey(publicKey: PairingPayload.sampleKey, keypair: "work"))
        let pubkey = try XCTUnwrap(t.requests.first { $0.url?.path == "/gate/pubkey" })
        XCTAssertEqual(pubkey.value(forHTTPHeaderField: "Authorization"), "Bearer tok-9")
    }

    func testRejectedCode() async {
        do {
            _ = try await PairingService(transport: transport(pairStatus: 401), discovery: nil).pair(.sample(), deviceName: "x")
            XCTFail()
        } catch {
            XCTAssertEqual(error as? PairingError, .codeRejected)
        }
    }

    func testRateLimited() async {
        let t = FakeTransport(handler: { req, _ in
            req.url?.path == "/pair" ? (json(["error": "too many pairing attempts; wait a minute"]), httpResponse(req.url, status: 429))
                : (json(["ok": true]), httpResponse(req.url))
        })
        do {
            _ = try await PairingService(transport: t, discovery: nil).pair(.sample(), deviceName: String(repeating: "长", count: 80))
            XCTFail()
        } catch {
            XCTAssertEqual(error as? PairingError, .rateLimited)
        }
        let body = t.requests.first { $0.url?.path == "/pair" }?.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: String] }
        XCTAssertEqual(body?["name"]?.count, 64)
    }

    func testUnreachable() async {
        let t = FakeTransport(handler: { _, _ in throw APIError.transport("offline") })
        do {
            _ = try await PairingService(transport: t, discovery: nil).pair(.sample(), deviceName: "x")
            XCTFail()
        } catch {
            XCTAssertEqual(error as? PairingError, .unreachable)
        }
    }
}

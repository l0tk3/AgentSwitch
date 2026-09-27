import Security
import XCTest
@testable import AgentSwitchKit

final class LocalStoreTests: XCTestCase {
    func testMacsAndCiphertextsRoundTrip() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("as-store-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = LocalStore(directory: dir)
        XCTAssertTrue(try store.loadMacs().isEmpty)
        XCTAssertEqual(try store.loadCiphertexts(), [])

        let profile = ServerProfile(payload: .sample(), deviceId: "dev1", gate: nil, pairedAt: Date(timeIntervalSince1970: 1_790_000_000))
        let other = Self.profile(fp: "cd", name: "MacBook")
        let macs = PairedMacs().adding(profile).adding(other)
        try store.saveMacs(macs)
        XCTAssertEqual(try store.loadMacs(), macs)
        XCTAssertEqual(try store.loadMacs().current, other)

        let saved = [SavedCiphertext(token: "enc:v1:" + String(repeating: "A", count: 40), note: "公司 VPN", createdAt: Date(timeIntervalSince1970: 1_790_000_000)),
                     SavedCiphertext(token: "enc:v1:" + String(repeating: "B", count: 40), note: "家里 NAS", createdAt: Date(timeIntervalSince1970: 1_790_000_000), mac: other.fingerprint)]
        try store.saveCiphertexts(saved)
        XCTAssertEqual(try store.loadCiphertexts(), saved)
        let onDisk = try String(contentsOf: dir.appendingPathComponent("ciphertexts.json"), encoding: .utf8)
        let rows = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(onDisk.utf8)) as? [[String: Any]])
        XCTAssertEqual(Set(rows[0].keys), ["id", "token", "note", "createdAt"], "ciphertext and note only")
        XCTAssertEqual(Set(rows[1].keys), ["id", "token", "note", "createdAt", "mac"], "plus the Mac it was made for")

        try store.saveMacs(PairedMacs())
        XCTAssertTrue(try store.loadMacs().isEmpty)
        XCTAssertEqual(saved[0].shortToken, "enc:v1:AAAAAAAA…AAAAAA")
    }

    /// A phone updated from the one-Mac version keeps its pairing: `server.json` becomes a one-Mac `macs.json`.
    func testMigratesTheSingleProfile() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("as-store-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let profile = ServerProfile(payload: .sample(), deviceId: "dev1", gate: nil, pairedAt: Date(timeIntervalSince1970: 1_790_000_000))
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let legacy = dir.appendingPathComponent("server.json")
        try encoder.encode(profile).write(to: legacy)

        let store = LocalStore(directory: dir)
        let macs = try store.loadMacs()
        XCTAssertEqual(macs.servers, [profile])
        XCTAssertEqual(macs.current, profile)
        XCTAssertFalse(FileManager.default.fileExists(atPath: legacy.path))
        XCTAssertEqual(try store.loadMacs(), macs)
    }

    func testPairedMacs() {
        let a = Self.profile(fp: "aa", name: "Mac mini")
        let b = Self.profile(fp: "bb", name: "MacBook")
        var macs = PairedMacs().adding(a)
        XCTAssertEqual(macs.current, a)
        macs = macs.adding(b)
        XCTAssertEqual(macs.servers, [a, b])
        XCTAssertEqual(macs.current, b, "a new pairing becomes the current Mac")

        let renewed = Self.profile(fp: "aa", name: "Mac mini", deviceId: "dev2")
        macs = macs.adding(renewed)
        XCTAssertEqual(macs.servers, [renewed, b], "pairing the same Mac again replaces it in place")
        XCTAssertEqual(macs.current, renewed)

        macs = macs.activating(b.fingerprint)
        XCTAssertEqual(macs.current, b)
        XCTAssertEqual(macs.activating("zz"), macs, "unknown Macs change nothing")

        let moved = b.updated(with: MacAddresses(lan: ["10.0.0.9"], tailnet: []))!
        XCTAssertEqual(macs.updating(moved).current, moved)
        XCTAssertEqual(macs.updating(Self.profile(fp: "zz", name: "?")), macs)

        XCTAssertEqual(macs.removing(a.fingerprint).current, b, "removing another Mac keeps the current one")
        macs = macs.removing(b.fingerprint)
        XCTAssertEqual(macs.current, renewed, "removing the current Mac moves to the first left")
        macs = macs.removing(a.fingerprint)
        XCTAssertTrue(macs.isEmpty)
        XCTAssertNil(macs.current)
        XCTAssertEqual(PairedMacs(servers: [a], active: "gone").current, a, "a stale current Mac falls back to the first")
    }

    func testCiphertextsFollowTheirMac() {
        let untagged = SavedCiphertext(token: "enc:v1:A", note: "")
        let mine = SavedCiphertext(token: "enc:v1:B", note: "", mac: "aa")
        let other = SavedCiphertext(token: "enc:v1:C", note: "", mac: "bb")
        let orphan = SavedCiphertext(token: "enc:v1:D", note: "", mac: "gone")
        let paired = ["aa", "bb"]
        XCTAssertEqual([untagged, mine, other, orphan].filter { $0.usable(with: "aa", paired: paired) }, [untagged, mine, orphan])
        XCTAssertEqual([untagged, mine, other, orphan].filter { $0.usable(with: "bb", paired: paired) }, [untagged, other, orphan])
    }

    private static func profile(fp: String, name: String, deviceId: String = "dev1") -> ServerProfile {
        ServerProfile(name: name, port: 4713, fingerprint: String(repeating: fp, count: 32), lan: ["192.168.1.5"], tailnet: [],
                      bonjour: "AgentSwitch on \(name)", gate: nil, deviceId: deviceId, pairedAt: Date(timeIntervalSince1970: 1_790_000_000))
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

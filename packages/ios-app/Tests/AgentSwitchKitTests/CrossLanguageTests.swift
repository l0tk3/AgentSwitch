#if os(macOS)
import Sodium
import XCTest
@testable import AgentSwitchKit

/// Swift-minted tokens opened by the real Python gate (app-v0 §3, §7). Opt-in: `AGENTSWITCH_GATE_CROSSCHECK=1`
/// (scripts/crypto-crosscheck.sh sets it). Uses a throw-away SECRET_GATE_HOME, never ~/.secret-gate, and never prints
/// a secret value: the gate's `check` shows metadata only, and payload bytes are compared by SHA-256 inside Python.
final class CrossLanguageTests: XCTestCase {
    private var home: URL!
    private var gate: String!
    private var python: String!

    override func setUpWithError() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["AGENTSWITCH_GATE_CROSSCHECK"] == "1",
                          "set AGENTSWITCH_GATE_CROSSCHECK=1 (or run scripts/crypto-crosscheck.sh)")
        let venv = Proc.packageRoot.deletingLastPathComponent().appendingPathComponent("secret-gate/.venv/bin")
        gate = ProcessInfo.processInfo.environment["SECRET_GATE_BIN"] ?? venv.appendingPathComponent("secret-gate").path
        python = venv.appendingPathComponent("python").path
        guard FileManager.default.isExecutableFile(atPath: gate), FileManager.default.isExecutableFile(atPath: python) else {
            throw XCTSkip("secret-gate venv not found at \(venv.path)")
        }
        home = try Proc.temporaryDirectory("as-gate-crosscheck")
        let realHome = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".secret-gate").standardizedFileURL.path
        precondition(home.standardizedFileURL.path != realHome && !home.path.hasPrefix(realHome), "must never touch ~/.secret-gate")
    }

    override func tearDownWithError() throws {
        if let home { try? FileManager.default.removeItem(at: home) }
    }

    private var env: [String: String] { ["SECRET_GATE_HOME": home.path] }

    private func newKeypair() throws -> String {
        let r = try Proc.run(gate, ["keys", "--json", "new", "default", "--use"], env: env)
        XCTAssertEqual(r.status, 0, r.stderr)
        let rows = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(r.stdout.utf8)) as? [[String: Any]])
        return try XCTUnwrap(rows.first { $0["name"] as? String == "default" }?["public"] as? String)
    }

    /// `secret-gate check`: `label: x` / `kind: y` / `hosts: ['a', 'b']` / `uses: ['http']`.
    private func check(_ token: String) throws -> [String: String]? {
        let r = try Proc.run(gate, ["check", token], env: env)
        guard r.status == 0 else { return nil }
        var fields: [String: String] = [:]
        for line in r.stdout.split(separator: "\n") {
            guard let colon = line.firstIndex(of: ":") else { continue }
            fields[String(line[..<colon])] = String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
        }
        return fields
    }

    private func pyList(_ items: [String]) -> String { "[" + items.map { "'\($0)'" }.joined(separator: ", ") + "]" }

    func testGateOpensSwiftTokens() throws {
        let minter = try TokenMinter(publicKeyBase64URL: try newKeypair())
        let payloads = [
            try SecretPayload.make(value: "pw-fake-1234", hosts: ["A.example.com", "*.b.example:8443"], uses: [.http], label: "site-a/pass"),
            try SecretPayload.make(value: "JBSW Y3DP EHPK 3PXP", hosts: ["*.corp.example"], uses: [.otp, .fill], label: "corp/totp",
                                   kind: .totp, seedImportHosts: ["vpn.corp.example:443"]),
            try SecretPayload.make(value: "\"quote\" \\ 中文 😀 \u{7F}\n", hosts: ["192.168.1.5:8000"], uses: [.exec, .http, .fill], label: "U.1_x-y"),
        ]
        for payload in payloads {
            let token = try minter.mint(payload)
            let fields = try XCTUnwrap(try check(token), "gate could not open \(payload.label)")
            XCTAssertEqual(fields["label"], payload.label)
            XCTAssertEqual(fields["kind"], payload.kind.rawValue)
            XCTAssertEqual(fields["hosts"], pyList(payload.hosts))
            XCTAssertEqual(fields["uses"], pyList(payload.uses.map(\.rawValue)))
            XCTAssertTrue(try payloadBytesMatch(token: token, payload: payload), "plaintext bytes differ from Python's to_json for \(payload.label)")
        }
    }

    func testGateRejectsTamperedAndForeignTokens() throws {
        let minter = try TokenMinter(publicKeyBase64URL: try newKeypair())
        let payload = try SecretPayload.make(value: "pw-fake-1", hosts: ["a.example.com"], uses: [.http], label: "a")
        var token = Array(try minter.mint(payload))
        token[20] = token[20] == "A" ? "B" : "A"
        XCTAssertNil(try check(String(token)))
        let foreign = try TokenMinter(publicKey: try XCTUnwrap(Sodium().box.keyPair()).publicKey)
        XCTAssertNil(try check(try foreign.mint(payload)))
    }

    /// gate-simple-v0 §3.4: Swift-minted tokens for values of 1...200 characters all open in the gate (its own
    /// `open_token`) to the same payload, and their sealed lengths come in 64-byte steps, the same as Python's own
    /// `make_token` for the same payloads. Prints lengths and booleans only.
    func testPaddedLengthsAgreeWithPython() throws {
        let minter = try TokenMinter(publicKeyBase64URL: try newKeypair())
        var tokens: [String] = []
        for n in 1...200 {
            // Short values with `otp` (no floor), the rest as website passwords: the floor is tested below.
            let value = String(repeating: "p", count: n)
            let payload = n < GatePolicy.minSealLength
                ? try SecretPayload.make(value: value, hosts: ["a.example.com"], uses: [.otp], label: "a/pass")
                : try SecretPayload.make(value: value, hosts: ["a.example.com"], uses: [.http, .fill], label: "a/pass")
            tokens.append(try minter.mint(payload))
        }
        let script = """
        import json, sys
        from secret_gate.keystore import gate_home, load_private_key
        from secret_gate.crypto import b64url_decode, generate_keypair
        from secret_gate.tokens import open_token, make_token
        key = load_private_key(gate_home())
        other = generate_keypair()
        rows = []
        for n, tok in enumerate(json.load(sys.stdin)["tokens"], start=1):
            p = open_token(key, tok)
            mine = len(b64url_decode(make_token(other.public, p)[7:]))
            rows.append({"ok": p.value == "p" * n, "swift": len(b64url_decode(tok[7:])), "python": mine})
        print(json.dumps(rows))
        """
        let r = try Proc.run(python, ["-c", script], env: env, stdin: json(["tokens": tokens]))
        XCTAssertEqual(r.status, 0, r.stderr)
        let rows = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(r.stdout.utf8)) as? [[String: Any]])
        XCTAssertEqual(rows.count, 200)
        for (i, row) in rows.enumerated() {
            XCTAssertEqual(row["ok"] as? Bool, true, "value of \(i + 1) characters")
            let swift = try XCTUnwrap(row["swift"] as? Int)
            XCTAssertEqual(swift, row["python"] as? Int, "value of \(i + 1) characters")
            XCTAssertEqual((swift - 48) % 64, 0, "value of \(i + 1) characters")
        }
    }

    /// The same values through `secret-gate enc` and SecretPayload.make: both refuse under 8 characters for http, fill
    /// and exec, both take an `otp` seed, and both say so in the same words.
    func testSealLengthFloorAgreesWithPython() throws {
        _ = try newKeypair()
        let cases: [(String, [SecretUse], SecretKind)] = [("1234567", [.http, .fill], .secret), ("12345678", [.http, .fill], .secret),
                                                           ("密码密码密码密", [.exec], .secret), ("MZXW6YQ", [.otp], .totp)]
        let batch = cases.map { ["label": "a", "hosts": ["a.example.com"], "uses": $0.1.map(\.rawValue), "kind": $0.2.rawValue, "value": $0.0] as [String: Any] }
        let r = try Proc.run(gate, ["enc", "--batch"], env: env, stdin: json(batch))
        let rows = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(r.stdout.utf8)) as? [[String: Any]])
        for (i, c) in cases.enumerated() {
            let swift = Result { try SecretPayload.make(value: c.0, hosts: ["a.example.com"], uses: Set(c.1), label: "a", kind: c.2) }
            switch swift {
            case .success: XCTAssertNotNil(rows[i]["token"], c.0)
            case .failure(let error): XCTAssertEqual(rows[i]["error"] as? String, error.localizedDescription, c.0)
            }
        }
    }

    /// Decrypts with the gate's own code and compares SHA-256 of the plaintext with Swift's bytes and with Python's
    /// canonical `sealed_plaintext()` (`to_json()` padded); prints only booleans.
    private func payloadBytesMatch(token: String, payload: SecretPayload) throws -> Bool {
        let script = """
        import hashlib, json, sys
        from secret_gate.keystore import gate_home, load_private_key
        from secret_gate.crypto import decrypt, b64url_decode
        from secret_gate.policy import SecretPayload
        from secret_gate.tokens import sealed_plaintext
        req = json.load(sys.stdin)
        plain = decrypt(load_private_key(gate_home()), b64url_decode(req["token"][len("enc:v1:"):]))
        canon = sealed_plaintext(SecretPayload.from_json(plain))
        digest = hashlib.sha256(plain).hexdigest()
        print(json.dumps({"swift": digest == req["sha256"], "canonical": hashlib.sha256(canon).hexdigest() == digest}))
        """
        let digest = CertificatePin.fingerprint(ofDER: payload.sealedData)  // SHA-256 hex
        let r = try Proc.run(python, ["-c", script], env: env, stdin: json(["token": token, "sha256": digest]))
        XCTAssertEqual(r.status, 0, "python helper failed")
        let verdict = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(r.stdout.utf8)) as? [String: Bool])
        return verdict["swift"] == true && verdict["canonical"] == true
    }

    /// The same host / label / base32 tables through policy.py and GatePolicy: Swift must never accept what Python
    /// rejects, and must normalize identically where both accept.
    func testPolicyAgreesWithPython() throws {
        let hosts = ["Site.Example.COM", " example.com. ", "example.com:8001", "example.com.:0443", "*.Example.com", "*.com",
                     "192.168.1.5", "", "exa mple.com", "example.com:", ":443", "example.com:0", "example.com:65536", "a:b:1",
                     "-bad.com", "bad-.com", "*", "a..b", "a.*.b", "under_score.com", "https://x.com", "例子.com", "x.y.z:1"]
        let labels = ["a", "site-a/pass", "A.b_c-d/e", "-a", "/a", "a b", "a:b", "ä", String(repeating: "x", count: 64), String(repeating: "x", count: 65)]
        let base32 = ["JBSWY3DPEHPK3PXP", "jbswy3dpehpk3pxp", "JBSW Y3DP", "MZXW6YQ", "MZXW6===", "MY", "A", "ABC", "ABCDEF", "MZ=XW6YQ", "JBSWY3DPEHPK3PX1"]
        let script = """
        import json, sys
        from secret_gate.policy import normalize_host, _validate_base32
        from secret_gate.constants import LABEL_PATTERN
        req = json.load(sys.stdin)
        def host(h):
            try: return normalize_host(h)
            except Exception: return None
        def b32(v):
            try: _validate_base32(v); return True
            except Exception: return False
        print(json.dumps({"hosts": [host(h) for h in req["hosts"]], "labels": [bool(LABEL_PATTERN.match(l)) for l in req["labels"]],
                          "base32": [b32(v) for v in req["base32"]]}))
        """
        let r = try Proc.run(python, ["-c", script], env: env, stdin: json(["hosts": hosts, "labels": labels, "base32": base32]))
        XCTAssertEqual(r.status, 0, r.stderr)
        let py = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(r.stdout.utf8)) as? [String: [Any]])
        for (i, h) in hosts.enumerated() {
            XCTAssertEqual(try? GatePolicy.normalizeHost(h), py["hosts"]?[i] as? String, "host \(h)")
        }
        for (i, l) in labels.enumerated() {
            XCTAssertEqual(GatePolicy.isValidLabel(l), py["labels"]?[i] as? Bool, "label \(l)")
        }
        for (i, v) in base32.enumerated() {
            XCTAssertEqual(GatePolicy.isBase32(v), py["base32"]?[i] as? Bool, "base32 \(v)")
        }
    }
}
#endif

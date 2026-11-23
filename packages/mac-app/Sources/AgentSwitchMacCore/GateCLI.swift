import CryptoKit
import Foundation
import Security

/// The gate's one keypair as `secret-gate keys --json` reports it (gate-simple-v0 §1: one key, no legacy keys). The CLI
/// prints a one-row array, or `[]` before the first `keygen`. `keys.json` names the public key `publicKey`; both
/// spellings are read. `created` is shown when a CLI reports it; older rows may still carry `legacy`, which is ignored.
public struct Keypair: Codable, Equatable, Identifiable, Sendable {
    public let name: String
    public let `public`: String
    public let current: Bool
    /// ISO 8601, when the CLI reports it.
    public let created: String?

    public var id: String { name }

    public init(name: String, public: String, current: Bool = true, created: String? = nil) {
        self.name = name
        self.public = `public`
        self.current = current
        self.created = created
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        name = try c.require(String.self, "name")
        `public` = try c.require(String.self, "public", "publicKey", "public_key")
        current = c.first(Bool.self, "current") ?? false
        created = c.first(String.self, "created", "createdAt", "created_at").flatMap { $0.isEmpty ? nil : $0 }
    }

    /// `created` as `2026-11-23 14:05` in the local time zone; nil when absent or unreadable.
    public var createdText: String? {
        guard let created, let date = ISO8601DateFormatter().date(from: created) else { return nil }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd HH:mm"
        return f.string(from: date)
    }
}

/// Key rotation (gate-simple-v0 §1): a new keypair replaces the old one, whose ciphertexts stop working. The same words
/// before both paths: `system rotate-key` with the service, `keygen --force` without it.
public enum GateKeyRotation {
    public static let warning = "轮换后将生成新的密钥对，旧私钥随即删除。已有的密文全部无法再解密，需要用新公钥重新封装；iPhone 与调度模型之后使用新公钥加密。此操作无法撤销。"
}

/// The two logs of the service (`logs tail --name`), shown by 通用 › gate.log in service mode.
public enum GateLogName: String, CaseIterable, Sendable, Identifiable {
    case proxy, rpc

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .proxy: return "代理"
        case .rpc: return "本机接口"
        }
    }
}

/// The few calls of the bundled `secret-gate` CLI the app needs (same contract as packages/secret-gate-ui):
/// `keys --json` (the one keypair), `keygen [--force]` without the service, and for the system service
/// `system status --json` and `logs tail`. The private key is never read. In service mode the environment carries
/// `SECRET_GATE_PUBLIC`, and the CLI answers from keys.json and gate.sock; rotation there is `system rotate-key` as
/// root (GateServiceOperation.rotateKey).
public struct GateCLI: Sendable {
    public let executable: URL
    public let environment: [String: String]
    public static let timeout: TimeInterval = 30
    public static let statusTimeout: TimeInterval = 15
    /// `logs.tail` serves at most 500 lines (gate-service-v0 §3.2).
    public static let maxLogLines = 500

    public init(executable: URL, environment: [String: String]) {
        self.executable = executable
        self.environment = environment
    }

    public func listKeys() async throws -> [Keypair] {
        try decode(try await run(["keys", "--json"]))
    }

    /// No service: `keygen`, or `keygen --force` to replace the key (ciphertexts sealed for the old one stop working).
    /// Answers the fresh list.
    public func keygen(force: Bool = false) async throws -> [Keypair] {
        _ = try await run(["keygen"] + (force ? ["--force"] : []))
        return try await listKeys()
    }

    /// `system status --json`, no root needed. Never throws: an older CLI or a failure is part of the answer.
    public func systemStatus() async -> GateServiceStatusOutcome {
        guard FileManager.default.isExecutableFile(atPath: executable.path) else {
            return .failed("未找到内置 secret-gate：\(executable.path)")
        }
        do {
            let result = try await ProcessRunner.run(executable, ["system", "status", "--json"], environment: environment,
                                                     timeout: GateCLI.statusTimeout)
            return GateServiceStatusOutcome.interpret(result)
        } catch {
            return .failed(error.localizedDescription)
        }
    }

    /// `logs tail --name proxy|rpc --lines N`, answered by the service over gate.sock: plain text, or `{"text": …}`.
    public func tailLog(_ name: GateLogName, lines: Int = 300) async throws -> String {
        let count = min(max(lines, 1), GateCLI.maxLogLines)
        return GateCLI.logText(try await run(["logs", "tail", "--name", name.rawValue, "--lines", String(count)]))
    }

    static func logText(_ data: Data) -> String {
        if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let text = object["text"] as? String {
            return text
        }
        return String(decoding: data, as: UTF8.self)
    }

    /// First run: `keygen` when the gate home has no key yet.
    public func ensureKeypair() async throws -> (keys: [Keypair], created: Bool) {
        let keys = try await listKeys()
        if !keys.isEmpty { return (keys, false) }
        return (try await keygen(), true)
    }

    func run(_ args: [String]) async throws -> Data {
        guard FileManager.default.isExecutableFile(atPath: executable.path) else {
            throw CommandError("未找到内置 secret-gate：\(executable.path)")
        }
        let result = try await ProcessRunner.run(executable, args, environment: environment, timeout: GateCLI.timeout)
        guard result.ok else {
            let text = result.stderrText.trimmingCharacters(in: .whitespacesAndNewlines)
            throw CommandError(result.timedOut ? "secret-gate 超时" : (text.isEmpty ? "secret-gate 退出码 \(result.status)" : text))
        }
        return result.stdout
    }

    private func decode(_ data: Data) throws -> [Keypair] {
        do { return try JSONDecoder().decode([Keypair].self, from: data) } catch {
            throw CommandError("无法解析 secret-gate 的输出：\(error.localizedDescription)")
        }
    }
}

/// The mitmproxy CA as harnesses see it: `~/.secret-gate/ca.pem`, a copy of `~/.mitmproxy/mitmproxy-ca-cert.pem`.
/// The app copies it (what `secret-gate install-ca` does first) but only trusts it in the keychain on request.
public enum GateCA {
    public enum CopyResult: String, Sendable, Equatable {
        case sourceMissing   // the proxy has not run yet
        case copied
        case upToDate
        case replaced        // a different CA was there: harness configs must follow the proxy's CA
    }

    public static func derFromPEM(_ pem: String) -> Data? {
        let lines = pem.components(separatedBy: .newlines)
        guard let start = lines.firstIndex(where: { $0.hasPrefix("-----BEGIN CERTIFICATE-----") }),
              let end = lines[start...].firstIndex(where: { $0.hasPrefix("-----END CERTIFICATE-----") }) else { return nil }
        return Data(base64Encoded: lines[(start + 1)..<end].joined())
    }

    public static func ensureCopy(from source: URL, to target: URL, fileManager: FileManager = .default) throws -> CopyResult {
        guard let sourcePEM = try? String(contentsOf: source, encoding: .utf8), let sourceDER = derFromPEM(sourcePEM) else {
            return .sourceMissing
        }
        let existing = (try? String(contentsOf: target, encoding: .utf8)).flatMap(derFromPEM)
        if existing == sourceDER { return .upToDate }
        try fileManager.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true,
                                        attributes: [.posixPermissions: 0o700])
        let tmp = target.deletingLastPathComponent().appendingPathComponent(".ca.pem.\(getpid())")
        try Data(sourcePEM.utf8).write(to: tmp)
        try fileManager.setAttributes([.posixPermissions: 0o644], ofItemAtPath: tmp.path)
        _ = try? fileManager.removeItem(at: target)
        try fileManager.moveItem(at: tmp, to: target)
        return existing == nil ? .copied : .replaced
    }

    /// Whether this user's trust settings make the certificate a trusted root (SecTrust, basic X.509 policy).
    public static func isTrusted(_ pemURL: URL) -> Bool {
        guard let pem = try? String(contentsOf: pemURL, encoding: .utf8), let der = derFromPEM(pem),
              let cert = SecCertificateCreateWithData(nil, der as CFData) else { return false }
        var trust: SecTrust?
        guard SecTrustCreateWithCertificates(cert, SecPolicyCreateBasicX509(), &trust) == errSecSuccess, let trust else { return false }
        return SecTrustEvaluateWithError(trust, nil)
    }

    static let security = URL(fileURLWithPath: "/usr/bin/security")

    static func loginKeychain(_ userHome: URL) -> String {
        userHome.appendingPathComponent("Library/Keychains/login.keychain-db").path
    }

    /// The keychain step of `secret-gate install-ca`, run only when the user clicks (macOS asks for the password).
    public static func trustCommand(ca: URL, userHome: URL) -> (URL, [String]) {
        (security, ["add-trusted-cert", "-r", "trustRoot", "-k", loginKeychain(userHome), ca.path])
    }

    /// Undoing `trustCommand` for the certificate in `pem`: its user trust settings, then the certificate itself (by
    /// SHA-1, what `security delete-certificate -Z` takes). Only on the user's click; macOS asks for the password.
    public static func untrustCommands(pem: URL, userHome: URL) -> [(URL, [String])] {
        guard let text = try? String(contentsOf: pem, encoding: .utf8), let der = derFromPEM(text) else { return [] }
        return [(security, ["remove-trusted-cert", pem.path]),
                (security, ["delete-certificate", "-Z", sha1Hex(der), loginKeychain(userHome)])]
    }

    public static func sha1Hex(_ der: Data) -> String {
        Insecure.SHA1.hash(data: der).map { String(format: "%02X", $0) }.joined()
    }

    /// The same certificate in both files (compared as DER).
    public static func sameCertificate(_ a: URL, _ b: URL) -> Bool {
        guard let x = (try? String(contentsOf: a, encoding: .utf8)).flatMap(derFromPEM),
              let y = (try? String(contentsOf: b, encoding: .utf8)).flatMap(derFromPEM) else { return false }
        return x == y
    }

    /// Before the install regenerates the CA (gate-service-v0 §5.5): a copy of the certificate this user trusted, so
    /// the app can later offer to remove it from the login keychain. Nil when neither candidate is trusted.
    public static func rememberTrusted(candidates: [URL], into target: URL, fileManager: FileManager = .default) throws -> URL? {
        guard let trusted = candidates.first(where: isTrusted), let text = try? String(contentsOf: trusted, encoding: .utf8) else {
            return nil
        }
        try fileManager.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true,
                                        attributes: [.posixPermissions: 0o700])
        try Data(text.utf8).write(to: target, options: .atomic)
        try fileManager.setAttributes([.posixPermissions: 0o644], ofItemAtPath: target.path)
        return trusted
    }
}

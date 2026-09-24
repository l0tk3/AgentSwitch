import Foundation
import Security

/// A keypair as `secret-gate keys --json` reports it.
public struct Keypair: Codable, Equatable, Identifiable, Sendable {
    public let name: String
    public let `public`: String
    public let current: Bool

    public var id: String { name }

    public init(name: String, public: String, current: Bool) {
        self.name = name
        self.public = `public`
        self.current = current
    }
}

/// The few calls of the bundled `secret-gate` CLI the app needs (same contract as packages/secret-gate-ui):
/// `keys --json [list | new <name> [--use] | use <name>]`. The private key is never read.
public struct GateCLI: Sendable {
    public let executable: URL
    public let environment: [String: String]
    public static let timeout: TimeInterval = 30
    public static let defaultKeypair = "default"
    /// keyring.NAME_PATTERN in secret-gate, minus the reserved names.
    public static let namePattern = #"^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$"#

    public init(executable: URL, environment: [String: String]) {
        self.executable = executable
        self.environment = environment
    }

    public static func isValidName(_ name: String) -> Bool {
        name.range(of: namePattern, options: .regularExpression) != nil && !["keys", "current"].contains(name)
    }

    public func listKeys() async throws -> [Keypair] {
        try decode(try await run(["keys", "--json"]))
    }

    public func newKey(named name: String, makeCurrent: Bool) async throws -> [Keypair] {
        guard GateCLI.isValidName(name) else { throw CommandError("密钥对名字只能用字母、数字和 . _ -，最多 32 个字符") }
        return try decode(try await run(["keys", "--json", "new", name] + (makeCurrent ? ["--use"] : [])))
    }

    public func useKey(named name: String) async throws -> [Keypair] {
        try decode(try await run(["keys", "--json", "use", name]))
    }

    /// First run: a keypair named `default`, made current, when the gate home has none.
    public func ensureKeypair() async throws -> (keys: [Keypair], created: Bool) {
        let keys = try await listKeys()
        if !keys.isEmpty { return (keys, false) }
        return (try await newKey(named: GateCLI.defaultKeypair, makeCurrent: true), true)
    }

    func run(_ args: [String]) async throws -> Data {
        guard FileManager.default.isExecutableFile(atPath: executable.path) else {
            throw CommandError("找不到内置 secret-gate：\(executable.path)")
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
            throw CommandError("secret-gate 的输出无法解析：\(error.localizedDescription)")
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

    /// The keychain step of `secret-gate install-ca`, run only when the user clicks (macOS asks for the password).
    public static func trustCommand(ca: URL, userHome: URL) -> (URL, [String]) {
        (URL(fileURLWithPath: "/usr/bin/security"),
         ["add-trusted-cert", "-r", "trustRoot", "-k", userHome.appendingPathComponent("Library/Keychains/login.keychain-db").path, ca.path])
    }
}

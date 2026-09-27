import Foundation
import SQLite3

/// Finds each harness and checks for a login without ever calling a model: `--version`, then credential files,
/// a keychain item's presence (attributes only, never its secret) or a credential row count.
public struct HarnessDetector: Sendable {
    public let path: String
    public let home: String
    public let environment: [String: String]
    public static let versionTimeout: TimeInterval = 8

    public init(path: String, home: String, environment: [String: String]) {
        self.path = path
        self.home = home
        self.environment = environment
    }

    public func detectAll() async -> [HarnessReport] {
        await withTaskGroup(of: HarnessReport.self) { group in
            for harness in Harness.allCases { group.addTask { await detect(harness) } }
            var out: [HarnessReport] = []
            for await report in group { out.append(report) }
            return Harness.allCases.compactMap { h in out.first { $0.harness == h } }
        }
    }

    public func detect(_ harness: Harness) async -> HarnessReport {
        guard let binary = ExecutableLookup.find(harness.rawValue, path: path, extra: harness.knownLocations(home: home)) else {
            return HarnessEvaluator.evaluate(HarnessFacts(harness: harness, binary: nil, versionOutput: nil, loginEvidence: nil))
        }
        var env = environment
        env["PATH"] = path
        let version = try? await ProcessRunner.run(URL(fileURLWithPath: binary), ["--version"], environment: env,
                                                   timeout: HarnessDetector.versionTimeout)
        let output = version.map { $0.stdoutText + $0.stderrText }
        return HarnessEvaluator.evaluate(HarnessFacts(harness: harness, binary: binary, versionOutput: output,
                                                      loginEvidence: await loginEvidence(harness)))
    }

    func loginEvidence(_ harness: Harness) async -> String? {
        let fm = FileManager.default
        switch harness {
        case .claude:
            if fm.fileExists(atPath: "\(home)/.claude/.credentials.json") { return "~/.claude/.credentials.json" }
            if await keychainItemExists(service: "Claude Code-credentials") { return "钥匙串中的 Claude Code 登录项" }
            if HarnessDetector.claudeConfigHasAccount(URL(fileURLWithPath: "\(home)/.claude.json")) { return "~/.claude.json 中的账户" }
            return nil
        case .codex:
            let codexHome = environment["CODEX_HOME"] ?? "\(home)/.codex"
            return fm.fileExists(atPath: "\(codexHome)/auth.json") ? "\(codexHome)/auth.json" : nil
        case .opencode:
            let data = environment["XDG_DATA_HOME"].map { "\($0)/opencode" } ?? "\(home)/.local/share/opencode"
            if fm.fileExists(atPath: "\(data)/auth.json") { return "\(data)/auth.json" }
            if let count = HarnessDetector.credentialRows(URL(fileURLWithPath: "\(data)/opencode.db")), count > 0 {
                return "opencode 凭据库中的 \(count) 条凭据"
            }
            return nil
        }
    }

    /// `security find-generic-password -s <service>` without `-g`/`-w`: attributes only, so no prompt and no secret.
    func keychainItemExists(service: String) async -> Bool {
        let result = try? await ProcessRunner.run(URL(fileURLWithPath: "/usr/bin/security"),
                                                  ["find-generic-password", "-s", service], timeout: 5)
        return result?.ok == true
    }

    /// Only the presence of the key is read; the file stays in memory for this call.
    static func claudeConfigHasAccount(_ url: URL) -> Bool {
        guard let data = try? Data(contentsOf: url),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        return object["oauthAccount"] != nil
    }

    /// Row count of OpenCode's `credential` table, read-only; nil when the file or table is absent.
    static func credentialRows(_ url: URL) -> Int? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        var db: OpaquePointer?
        guard sqlite3_open_v2(url.path, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else {
            sqlite3_close(db)
            return nil
        }
        defer { sqlite3_close(db) }
        sqlite3_busy_timeout(db, 500)
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT count(*) FROM credential", -1, &stmt, nil) == SQLITE_OK else { return nil }
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_step(stmt) == SQLITE_ROW else { return nil }
        return Int(sqlite3_column_int64(stmt, 0))
    }
}

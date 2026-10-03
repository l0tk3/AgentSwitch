import Foundation

/// `New Ciphertext` on the Dispatch page (docs/dispatch-v0.md §2): one value sealed by this Mac's own gate through the
/// bundled CLI — `secret-gate enc --batch`, the value on stdin and never in argv, as packages/secret-gate-ui does — with
/// the phone's rules for a website password (the Kit's SecretDraft): a name, the sites it may be used on, `http` and
/// `fill`. Works with the gate as the user's process or as its own service (the CLI reads the public key either way).
public struct GateSealRequest: Sendable, Equatable {
    public let label: String
    /// As typed: comma, space, `|`, `;`, `，` or newline separated; bare `host[:port]`, `*.example.com`, or a URL.
    public let sites: String
    public let value: String

    public init(label: String, sites: String, value: String) {
        self.label = label
        self.sites = sites
        self.value = value
    }

    /// A website password: replaced in requests and typed into pages (SecretDraft.websiteUses).
    public static let uses = ["http", "fill"]
    /// secret_gate.constants.LABEL_PATTERN.
    public static let labelPattern = #"^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$"#

    public var trimmedLabel: String { label.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// What the gate binds the value to: `host[:port]` of each site, deduplicated in order.
    public var hostList: [String] {
        var seen = Set<String>()
        return sites.split(whereSeparator: { ",|; \n，".contains($0) })
            .map { Self.host(of: $0.trimmingCharacters(in: .whitespaces)) }
            .filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    /// `https://user@core.example:8600/login?x` → `core.example:8600`; a bare host passes through (SecretDraft.hostOf).
    public static func host(of site: String) -> String {
        var s = Substring(site)
        if let r = s.range(of: "://") { s = s[r.upperBound...] }
        if let end = s.firstIndex(where: { $0 == "/" || $0 == "?" || $0 == "#" }) { s = s[..<end] }
        if let at = s.lastIndex(of: "@") { s = s[s.index(after: at)...] }
        return String(s).lowercased()
    }

    /// Why it cannot be sealed yet, in the sheet's words; nil when it can. The gate checks hosts itself.
    public var problem: String? {
        if trimmedLabel.isEmpty { return "缺少名称" }
        if trimmedLabel.range(of: Self.labelPattern, options: .regularExpression) == nil {
            return "名称以字母或数字开头，仅可使用字母、数字和 . _ / -，最多 64 个字符"
        }
        if hostList.isEmpty { return "须填写可使用此密文的站点" }
        if value.isEmpty { return "缺少值" }
        return nil
    }

    /// stdin for `enc --batch`: one entry.
    public func batchInput() throws -> Data {
        let entry: [String: Any] = ["label": trimmedLabel, "hosts": hostList, "uses": Self.uses, "kind": "secret", "value": value]
        return try JSONSerialization.data(withJSONObject: [entry])
    }

    /// The token from `enc --batch`'s output (`[{label, token}]`), or the gate's reason (`[{label, error}]`).
    public static func token(from output: Data) throws -> String {
        guard let rows = try? JSONSerialization.jsonObject(with: output) as? [[String: Any]], let row = rows.first else {
            throw CommandError("无法解析 secret-gate 的输出")
        }
        if let token = row["token"] as? String, token.hasPrefix("enc:v1:") { return token }
        throw CommandError((row["error"] as? String).map { "无法生成密文：\($0)" } ?? "无法生成密文")
    }
}

extension GateCLI {
    /// Seals `request` for the gate's current keypair. Exit 1 is a per-entry refusal, whose reason is in the output.
    public func seal(_ request: GateSealRequest) async throws -> String {
        if let problem = request.problem { throw CommandError(problem) }
        guard FileManager.default.isExecutableFile(atPath: executable.path) else {
            throw CommandError("未找到内置 secret-gate：\(executable.path)")
        }
        let result = try await ProcessRunner.run(executable, ["enc", "--batch"], environment: environment,
                                                 stdin: try request.batchInput(), timeout: GateCLI.timeout)
        guard !result.timedOut, result.status == 0 || result.status == 1 else {
            let text = result.stderrText.trimmingCharacters(in: .whitespacesAndNewlines)
            throw CommandError(result.timedOut ? "secret-gate 超时" : (text.isEmpty ? "secret-gate 退出码 \(result.status)" : text))
        }
        return try GateSealRequest.token(from: result.stdout)
    }
}

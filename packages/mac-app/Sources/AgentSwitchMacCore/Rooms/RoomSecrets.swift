import Foundation

/// A room's secrets (2026-11-24, daemon `rooms/secrets.ts`): what its members log in, call an API or run a command
/// with, sealed by this Mac's gate before it goes to the service — the service keeps ciphertexts only.
public struct RoomSecret: Codable, Equatable, Sendable, Identifiable {
    public enum Kind: String, Codable, Sendable, CaseIterable {
        case site, api, exec
        public var word: String { switch self { case .site: "网站登录"; case .api: "API Key"; case .exec: "命令用" } }
        /// What the gate lets the value be used for (gate-simple-v0 §2): a site's password into requests and pages,
        /// a key into requests only, a command's value into its environment only.
        public var uses: [String] { switch self { case .site: ["http", "fill"]; case .api: ["http"]; case .exec: ["exec"] } }
    }
    public let id: String
    public let name: String
    public let kind: Kind
    public let url: String?
    public let account: String?
    public let env: String?
    public let token: String
    public let addedAt: Int64?
}

/// One secret to seal: its value goes to the gate on stdin and nowhere else.
public struct RoomSecretDraft: Sendable, Equatable {
    public var name: String
    public var kind: RoomSecret.Kind
    public var url: String
    public var account: String
    public var env: String
    public var value: String

    public init(name: String = "", kind: RoomSecret.Kind = .site, url: String = "", account: String = "", env: String = "", value: String = "") {
        self.name = name; self.kind = kind; self.url = url; self.account = account; self.env = env; self.value = value
    }

    /// The gate's label: the name in its letters (`GitHub 登录` → `GitHub`), else `secret`.
    public var label: String {
        let kept = name.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) && $0.isASCII || "._/-".unicodeScalars.contains($0) }
        let s = String(String.UnicodeScalarView(kept)).trimmingCharacters(in: CharacterSet(charactersIn: "._/-"))
        return s.isEmpty ? "secret" : String(s.prefix(64))
    }

    public var hosts: [String] { url.isEmpty ? [] : GateSealRequest(label: "x", sites: url, value: "").hostList }

    /// Why it can not be sealed, in the sheet's words; nil: it can.
    public var problem: String? {
        if name.trimmingCharacters(in: .whitespaces).isEmpty { return "缺少名称" }
        if kind != .exec, hosts.isEmpty { return "\(name)：网站登录和 API Key 要写网址" }
        if kind == .exec, env.range(of: #"^[A-Z][A-Z0-9_]{0,63}$"#, options: .regularExpression) == nil { return "\(name)：命令用的要写环境变量名（大写，如 OPENAI_API_KEY）" }
        if value.isEmpty { return "\(name)：缺少密码或密钥" }
        if value.unicodeScalars.count < GateSealRequest.minValueLength { return "\(name)：\(GateSealRequest.valueTooShort)" }
        return nil
    }

    /// The service's item, once sealed.
    public func item(token: String) -> [String: Any] {
        var o: [String: Any] = ["name": name.trimmingCharacters(in: .whitespaces), "kind": kind.rawValue, "token": token]
        if !url.isEmpty { o["url"] = url }
        if !account.isEmpty { o["account"] = account }
        if kind == .exec { o["env"] = env }
        return o
    }

    /// The template to fill (user #194: 导出明文填写模版): a header and one example row.
    public static let template = "name,kind,url,account,env,secret\nGitHub 登录,site,https://github.com,me@example.com,,在这里填密码\nOpenAI,api,https://api.openai.com,,,sk-...\n部署密钥,exec,,,DEPLOY_TOKEN,...\n"

    /// A filled template read back: one draft a row; a row that is not one is said by its line number.
    public static func parse(csv: String) -> (drafts: [RoomSecretDraft], problems: [String]) {
        var drafts: [RoomSecretDraft] = [], problems: [String] = []
        let lines = csv.replacingOccurrences(of: "\r\n", with: "\n").split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
        guard let head = lines.first.map(fields) else { return ([], ["文件是空的"]) }
        let col = { (name: String) in head.firstIndex { $0.trimmingCharacters(in: .whitespaces).lowercased() == name } }
        guard let n = col("name"), let k = col("kind"), let v = col("secret") else { return ([], ["第一行要是 name,kind,url,account,env,secret"]) }
        for (i, line) in lines.dropFirst().enumerated() {
            let f = fields(line)
            func at(_ c: Int?) -> String { c.flatMap { $0 < f.count ? f[$0].trimmingCharacters(in: .whitespaces) : nil } ?? "" }
            guard let kind = RoomSecret.Kind(rawValue: at(k).lowercased()) else { problems.append("第 \(i + 2) 行：kind 要是 site、api 或 exec"); continue }
            drafts.append(RoomSecretDraft(name: at(n), kind: kind, url: at(col("url")), account: at(col("account")), env: at(col("env")), value: at(v)))
        }
        return (drafts, problems)
    }

    /// One CSV line's fields, quotes understood.
    static func fields(_ line: String) -> [String] {
        var out: [String] = [], cur = "", quoted = false
        var it = Array(line).makeIterator()
        while let c = it.next() {
            if quoted {
                if c == "\"" { quoted = false } else { cur.append(c) }
            } else if c == "\"" { quoted = true }
            else if c == "," { out.append(cur); cur = "" }
            else { cur.append(c) }
        }
        out.append(cur)
        return out
    }
}

extension GateCLI {
    /// Many values sealed in one `enc --batch` (each on stdin, never in argv): a token for each, or the gate's reason.
    public func seal(drafts: [RoomSecretDraft]) async throws -> [Result<String, CommandError>] {
        guard FileManager.default.isExecutableFile(atPath: executable.path) else { throw CommandError("未找到内置 secret-gate：\(executable.path)") }
        let entries: [[String: Any]] = drafts.map { ["label": $0.label, "hosts": $0.hosts, "uses": $0.kind.uses, "kind": "secret", "value": $0.value] }
        let result = try await ProcessRunner.run(executable, ["enc", "--batch"], environment: environment, stdin: try JSONSerialization.data(withJSONObject: entries), timeout: GateCLI.timeout)
        guard !result.timedOut, result.status == 0 || result.status == 1 else {
            let text = result.stderrText.trimmingCharacters(in: .whitespacesAndNewlines)
            throw CommandError(result.timedOut ? "secret-gate 超时" : (text.isEmpty ? "secret-gate 退出码 \(result.status)" : text))
        }
        guard let rows = try? JSONSerialization.jsonObject(with: result.stdout) as? [[String: Any]], rows.count == drafts.count else { throw CommandError("无法解析 secret-gate 的输出") }
        return rows.map { row in
            if let token = row["token"] as? String, token.hasPrefix("enc:v1:") { return .success(token) }
            return .failure(CommandError((row["error"] as? String).map { "无法生成密文：\($0)" } ?? "无法生成密文"))
        }
    }
}

public extension DaemonClient {
    private struct Secrets: Decodable { let secrets: [RoomSecret] }
    func roomSecrets(_ room: String) async throws -> [RoomSecret] { try decode(Secrets.self, try await call("GET", "/rooms/\(DaemonClient.segment(room))/secrets", timeout: 10)).secrets }

    /// Sealed items (`RoomSecretDraft.item`, or secrets exported from another room) added; the room's list back.
    func addRoomSecrets(_ items: Data, to room: String) async throws -> [RoomSecret] {
        try decode(Secrets.self, try await call("POST", "/rooms/\(DaemonClient.segment(room))/secrets", body: items, timeout: 10)).secrets
    }

    func removeRoomSecret(_ id: String, from room: String) async throws {
        _ = try await call("DELETE", "/rooms/\(DaemonClient.segment(room))/secrets/\(DaemonClient.segment(id))", timeout: 10)
    }
}

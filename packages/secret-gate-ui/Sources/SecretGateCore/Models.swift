import Foundation

/// A keypair as reported by `secret-gate keys --json`.
public struct Keypair: Codable, Identifiable, Hashable, Sendable {
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

public enum SecretKind: String, CaseIterable, Codable, Sendable {
    case secret, totp

    public var title: String {
        switch self {
        case .secret: return "密码 / token"
        case .totp: return "2FA 密钥 (TOTP)"
        }
    }
}

public enum SecretUse: String, CaseIterable, Codable, Sendable {
    case http, otp, exec

    public var title: String {
        switch self {
        case .http: return "http（代理替换）"
        case .otp: return "otp（取验证码）"
        case .exec: return "exec（本地命令模板）"
        }
    }
}

/// One row of the batch table. Immutable: edits produce a new value via `with`.
/// `note` (what the platform is for) and `account` (optional login name) never reach the CLI; they
/// travel with the minted token into the CONTEXT.md-shaped entry the user pastes into AgentSwitch.
public struct TokenEntry: Identifiable, Hashable, Sendable {
    public let id: UUID
    public let label: String
    public let hosts: String   // comma or space separated, split at encode time
    public let kind: SecretKind
    public let uses: Set<SecretUse>
    public let value: String
    public let note: String
    public let account: String
    /// Mint the account as a second token (`<label>/user`, same hosts, http use) so the login name is PII the
    /// model never sees in the clear either; the executor fills it with secret_fill like the password.
    public let encryptAccount: Bool

    public init(id: UUID = UUID(), label: String = "", hosts: String = "", kind: SecretKind = .secret,
                uses: Set<SecretUse> = [.http], value: String = "", note: String = "", account: String = "", encryptAccount: Bool = true) {
        self.id = id
        self.label = label
        self.hosts = hosts
        self.kind = kind
        self.uses = uses
        self.value = value
        self.note = note
        self.account = account
        self.encryptAccount = encryptAccount
    }

    public func with(label: String? = nil, hosts: String? = nil, kind: SecretKind? = nil,
                     uses: Set<SecretUse>? = nil, value: String? = nil, note: String? = nil, account: String? = nil, encryptAccount: Bool? = nil) -> TokenEntry {
        TokenEntry(id: id, label: label ?? self.label, hosts: hosts ?? self.hosts, kind: kind ?? self.kind,
                   uses: uses ?? self.uses, value: value ?? self.value, note: note ?? self.note, account: account ?? self.account,
                   encryptAccount: encryptAccount ?? self.encryptAccount)
    }

    /// Label of the companion token that carries the account name.
    public var accountLabel: String { label + "/user" }

    /// Everything but the secret value, for the rows file: the table survives a restart, plaintext never touches disk.
    public struct Saved: Codable, Sendable {
        public let id: UUID
        public let label: String
        public let hosts: String
        public let kind: SecretKind
        public let uses: [SecretUse]
        public let note: String
        public let account: String
        public let encryptAccount: Bool
    }

    public var saved: Saved {
        Saved(id: id, label: label, hosts: hosts, kind: kind, uses: uses.map(\.rawValue).sorted().compactMap(SecretUse.init(rawValue:)), note: note, account: account, encryptAccount: encryptAccount)
    }

    public init(saved s: Saved) {
        self.init(id: s.id, label: s.label, hosts: s.hosts, kind: s.kind, uses: Set(s.uses), value: "", note: s.note, account: s.account, encryptAccount: s.encryptAccount)
    }

    /// The extra row sent to the CLI when the account is to be encrypted (nil when there is nothing to encrypt).
    public var accountEntry: TokenEntry? {
        guard encryptAccount, !account.isEmpty, !hostList.isEmpty else { return nil }
        return TokenEntry(label: accountLabel, hosts: hosts, kind: .secret, uses: [.http], value: account)
    }

    public var hostList: [String] {
        hosts.split(whereSeparator: { $0 == "," || $0 == " " || $0 == "|" || $0 == ";" })
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }

    /// What `secret-gate enc --batch` expects on stdin, one object per entry.
    public var batchObject: [String: Any] {
        [
            "label": label,
            "hosts": hostList,
            "kind": kind.rawValue,
            "uses": uses.map(\.rawValue).sorted(),
            "value": value,
        ]
    }

    /// Cheap client-side checks so obvious mistakes are caught before the CLI runs.
    public var problem: String? {
        if label.isEmpty { return "缺少 label" }
        if value.isEmpty { return "缺少值" }
        if uses.isEmpty { return "至少选一种用途" }
        if uses.contains(.http) && hostList.isEmpty { return "http 用途需要 host" }
        if uses.contains(.otp) && kind != .totp { return "otp 用途只对 TOTP 有效" }
        return nil
    }
}

/// A minted token joined back to the row it came from, so the result can be copied as a complete
/// CONTEXT.md entry (label, hosts, note, account, token) rather than a bare token.
public struct MintedRow: Identifiable, Hashable, Sendable {
    public let id: UUID
    public let label: String
    public let hosts: [String]
    public let kind: SecretKind
    public let note: String
    public let account: String
    /// The account as ciphertext when the row asked for it; the plaintext account is then not printed anywhere.
    public let accountToken: String?
    public let token: String?
    public let error: String?

    public var ok: Bool { token != nil }

    public init(entry: TokenEntry, result: TokenResult, accountResult: TokenResult? = nil) {
        id = entry.id
        label = entry.label
        hosts = entry.hostList
        kind = entry.kind
        note = entry.note
        account = entry.account
        accountToken = accountResult?.token
        token = result.token
        error = [result.error, accountResult?.error.map { "账号密文失败：\($0)" }].compactMap { $0 }.joined(separator: "; ").nonEmpty
    }

    /// Match CLI results to the batch that produced them: by label, in order, so duplicate labels still pair up.
    /// Account companions (`<label>/user`) are folded into their row rather than listed on their own.
    public static func join(entries: [TokenEntry], results: [TokenResult]) -> [MintedRow] {
        var remaining = results
        func take(_ label: String) -> TokenResult? {
            guard let i = remaining.firstIndex(where: { $0.label == label }) else { return nil }
            return remaining.remove(at: i)
        }
        return entries.map { entry in
            let r = take(entry.label) ?? TokenResult(label: entry.label, token: nil, error: "no result from the CLI")
            let a = entry.accountEntry.flatMap { take($0.label) ?? TokenResult(label: $0.label, token: nil, error: "no result from the CLI") }
            return MintedRow(entry: entry, result: r, accountResult: a)
        }
    }

    /// The entry as AgentSwitch's CONTEXT.md wants it: a list item the router and the executor can read, with
    /// the token on a "密码"/"2FA" line so the plaintext lint recognises it.
    public var contextEntry: String? {
        guard let token else { return nil }
        let title = note.isEmpty ? label : "\(note)（\(label)）"
        var lines = ["- \(title)：\(hosts.joined(separator: ", "))"]
        if let accountToken { lines.append("  账号 \(accountToken)（密文，用 secret_fill 填）") }
        else if !account.isEmpty { lines.append("  账号 \(account)") }
        lines.append(kind == .totp ? "  2FA \(token)（用 secret_otp 取码）" : "  密码 \(token)")
        return lines.joined(separator: "\n")
    }

    /// JSON export row (no plaintext ever).
    public var exportObject: [String: Any] {
        ["label": label, "hosts": hosts, "kind": kind.rawValue, "note": note, "account": accountToken ?? account, "account_encrypted": accountToken != nil, "token": token ?? "", "error": error ?? ""]
    }
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}

/// One line of `secret-gate enc --batch` output.
public struct TokenResult: Codable, Identifiable, Hashable, Sendable {
    public let label: String?
    public let token: String?
    public let error: String?

    public var id: String { (label ?? "") + (token ?? error ?? "") }
    public var ok: Bool { token != nil }

    public init(label: String?, token: String?, error: String?) {
        self.label = label
        self.token = token
        self.error = error
    }
}

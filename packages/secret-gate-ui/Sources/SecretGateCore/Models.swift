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

    public init(id: UUID = UUID(), label: String = "", hosts: String = "", kind: SecretKind = .secret,
                uses: Set<SecretUse> = [.http], value: String = "", note: String = "", account: String = "") {
        self.id = id
        self.label = label
        self.hosts = hosts
        self.kind = kind
        self.uses = uses
        self.value = value
        self.note = note
        self.account = account
    }

    public func with(label: String? = nil, hosts: String? = nil, kind: SecretKind? = nil,
                     uses: Set<SecretUse>? = nil, value: String? = nil, note: String? = nil, account: String? = nil) -> TokenEntry {
        TokenEntry(id: id, label: label ?? self.label, hosts: hosts ?? self.hosts, kind: kind ?? self.kind,
                   uses: uses ?? self.uses, value: value ?? self.value, note: note ?? self.note, account: account ?? self.account)
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
    public let token: String?
    public let error: String?

    public var ok: Bool { token != nil }

    public init(entry: TokenEntry, result: TokenResult) {
        id = entry.id
        label = entry.label
        hosts = entry.hostList
        kind = entry.kind
        note = entry.note
        account = entry.account
        token = result.token
        error = result.error
    }

    /// Match CLI results to the batch that produced them: by label, in order, so duplicate labels still pair up.
    public static func join(entries: [TokenEntry], results: [TokenResult]) -> [MintedRow] {
        var remaining = results
        return entries.map { entry in
            let i = remaining.firstIndex { $0.label == entry.label } ?? 0
            let r = remaining.isEmpty ? TokenResult(label: entry.label, token: nil, error: "no result from the CLI") : remaining.remove(at: i)
            return MintedRow(entry: entry, result: r)
        }
    }

    /// The entry as AgentSwitch's CONTEXT.md wants it: a list item the router and the executor can read, with
    /// the token on a "密码"/"2FA" line so the plaintext lint recognises it.
    public var contextEntry: String? {
        guard let token else { return nil }
        let title = note.isEmpty ? label : "\(note)（\(label)）"
        var lines = ["- \(title)：\(hosts.joined(separator: ", "))"]
        if !account.isEmpty { lines.append("  账号 \(account)") }
        lines.append(kind == .totp ? "  2FA \(token)（用 secret_otp 取码）" : "  密码 \(token)")
        return lines.joined(separator: "\n")
    }

    /// JSON export row (no plaintext ever).
    public var exportObject: [String: Any] {
        ["label": label, "hosts": hosts, "kind": kind.rawValue, "note": note, "account": account, "token": token ?? "", "error": error ?? ""]
    }
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

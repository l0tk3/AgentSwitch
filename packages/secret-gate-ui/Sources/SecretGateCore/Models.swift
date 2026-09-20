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
public struct TokenEntry: Identifiable, Hashable, Sendable {
    public let id: UUID
    public let label: String
    public let hosts: String   // comma or space separated, split at encode time
    public let kind: SecretKind
    public let uses: Set<SecretUse>
    public let value: String

    public init(id: UUID = UUID(), label: String = "", hosts: String = "", kind: SecretKind = .secret,
                uses: Set<SecretUse> = [.http], value: String = "") {
        self.id = id
        self.label = label
        self.hosts = hosts
        self.kind = kind
        self.uses = uses
        self.value = value
    }

    public func with(label: String? = nil, hosts: String? = nil, kind: SecretKind? = nil,
                     uses: Set<SecretUse>? = nil, value: String? = nil) -> TokenEntry {
        TokenEntry(id: id, label: label ?? self.label, hosts: hosts ?? self.hosts, kind: kind ?? self.kind,
                   uses: uses ?? self.uses, value: value ?? self.value)
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

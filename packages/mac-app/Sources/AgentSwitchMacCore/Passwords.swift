import Foundation

/// The password book (packages/daemon/src/vault/passwords.ts, api/passwords.ts; user #345-#351): this Mac's service.
public struct PasswordItem: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let sites: [String]
    public let account: String
    public let tags: [String]
    public let updatedAt: Int64
    public let hasTotp: Bool
    public let hasNote: Bool
    /// The password's length (the dots shown for it).
    public let length: Int
}

public struct PasswordSecret: Decodable, Equatable, Sendable {
    public struct Code: Decodable, Equatable, Sendable { public let code: String; public let left: Int }
    public let password: String
    public let note: String?
    public let totp: Code?
}

/// What an edit sends: nil fields are left as they are.
public struct PasswordDraft: Equatable, Sendable {
    public var name = ""
    public var sites = ""
    public var account = ""
    public var password = ""
    public var totp = ""
    public var note = ""
    public init() {}

    func body(new: Bool) -> [String: Any] {
        var b: [String: Any] = ["name": name, "account": account,
                                "sites": sites.split(whereSeparator: { $0 == "," || $0 == " " || $0 == "\n" }).map(String.init)]
        if new || !password.isEmpty { b["password"] = password }
        if new || !totp.isEmpty { b["totp"] = totp }
        if new || !note.isEmpty { b["note"] = note }
        return b
    }
}

public extension DaemonClient {
    /// `?room=<id>` for a room's own book (user #416); nothing for the book of everything.
    static func passwordsQuery(_ room: String?) -> String {
        room.flatMap { $0.addingPercentEncoding(withAllowedCharacters: .alphanumerics) }.map { "?room=\($0)" } ?? ""
    }

    func passwords(room: String? = nil) async throws -> [PasswordItem] {
        struct A: Decodable { let entries: [PasswordItem] }
        return try decode(A.self, try await call("GET", "/passwords" + DaemonClient.passwordsQuery(room), timeout: 10)).entries
    }

    @discardableResult
    func savePassword(_ draft: PasswordDraft, id: String?, room: String? = nil) async throws -> PasswordItem {
        struct A: Decodable { let entry: PasswordItem }
        let body = try JSONSerialization.data(withJSONObject: draft.body(new: id == nil))
        let path = id.map { "/passwords/\(DaemonClient.segment($0))" } ?? "/passwords" + DaemonClient.passwordsQuery(room)
        return try decode(A.self, try await call(id == nil ? "POST" : "PATCH", path, body: body, timeout: 10)).entry
    }

    func removePassword(_ id: String) async throws { _ = try await call("DELETE", "/passwords/\(DaemonClient.segment(id))", timeout: 10) }

    func revealPassword(_ id: String) async throws -> PasswordSecret {
        try decode(PasswordSecret.self, try await call("POST", "/passwords/\(DaemonClient.segment(id))/reveal", timeout: 10))
    }

    func importPasswords(csv: String, room: String? = nil) async throws -> (added: Int, replaced: Int, skipped: Int) {
        struct A: Decodable { let added: Int; let replaced: Int; let skipped: Int }
        let a = try decode(A.self, try await call("POST", "/passwords/import" + DaemonClient.passwordsQuery(room), body: try JSONSerialization.data(withJSONObject: ["csv": csv]), timeout: 60))
        return (a.added, a.replaced, a.skipped)
    }

    /// A secret sealed under the node's own vault key (packages/daemon/src/vault/seal.ts): what a profile keeps of
    /// its API key, a proxy's password or a session key, in place of a gate's ciphertext (user #369).
    func vaultSeal(_ value: String) async throws -> String {
        struct A: Decodable { let token: String }
        return try decode(A.self, try await call("POST", "/vault/seal", body: try JSONSerialization.data(withJSONObject: ["value": value]), timeout: 10)).token
    }

    func generatePassword(length: Int = 20) async throws -> String {
        struct A: Decodable { let password: String }
        return try decode(A.self, try await call("GET", "/passwords/generate?length=\(length)", timeout: 10)).password
    }
}

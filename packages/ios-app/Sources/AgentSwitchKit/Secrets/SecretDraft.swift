import Foundation

/// What the mint form holds (a value type the form binds to). `value` is plaintext and lives only in memory; the form
/// clears it after minting.
public struct SecretDraft: Sendable, Equatable {
    public var label: String
    public var sites: String      // comma / space / | / ; separated; bare host[:port], *.example.com, or a URL
    public var kind: SecretKind
    public var uses: Set<SecretUse>
    public var value: String
    public var note: String

    public init(label: String = "", sites: String = "", kind: SecretKind = .secret, uses: Set<SecretUse> = [.http],
                value: String = "", note: String = "") {
        self.label = label
        self.sites = sites
        self.kind = kind
        self.uses = uses
        self.value = value
        self.note = note
    }

    /// The sites as typed, one per entry.
    public var siteList: [String] {
        sites.split(whereSeparator: { $0 == "," || $0 == " " || $0 == "|" || $0 == ";" || $0 == "\n" || $0 == "，" })
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }

    /// What the gate binds to: `host[:port]` of each site, deduplicated in order.
    public var hostList: [String] {
        var seen = Set<String>()
        return siteList.map(Self.hostOf).filter { seen.insert($0).inserted }
    }

    /// `https://user@core.example:8600/login?x` → `core.example:8600`; a bare host passes through.
    public static func hostOf(_ site: String) -> String {
        var s = Substring(site)
        if let r = s.range(of: "://") { s = s[r.upperBound...] }
        if let end = s.firstIndex(where: { $0 == "/" || $0 == "?" || $0 == "#" }) { s = s[..<end] }
        if let at = s.lastIndex(of: "@") { s = s[s.index(after: at)...] }
        return String(s)
    }

    /// Usability checks on top of the gate's rules (same as secret-gate-ui): a token the gate would accept but that
    /// could never be used is refused here.
    public var problem: String? {
        if label.isEmpty { return "缺少 label" }
        if value.isEmpty { return "缺少值" }
        if uses.isEmpty { return "至少选一种用途" }
        if (uses.contains(.http) || uses.contains(.fill)) && hostList.isEmpty { return "http / fill 用途需要站点" }
        if uses.contains(.otp) && kind != .totp { return "otp 用途只对 TOTP 有效" }
        do { _ = try payload() } catch { return error.localizedDescription }
        return nil
    }

    public func payload() throws -> SecretPayload {
        try SecretPayload.make(value: value, hosts: hostList, uses: uses, label: label, kind: kind)
    }

    /// The note saved with the token: what the user typed, else `label → hosts` so the list stays readable.
    public var effectiveNote: String {
        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { return trimmed }
        return hostList.isEmpty ? label : "\(label) → \(hostList.joined(separator: ", "))"
    }
}

import Foundation

/// Parses pasted text into entries, one per line:
///
///     label, host1|host2, kind, value
///     label, host1|host2, value            (kind defaults to secret)
///     label, , totp, BASE32SECRET          (no host: use = otp)
///
/// Lines starting with `#` and blank lines are ignored. Fields are comma separated;
/// hosts inside a field are separated by `|` or spaces.
public enum CSVImport {
    public static func parse(_ text: String) -> [TokenEntry] {
        text.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.hasPrefix("#") }
            .compactMap(parseLine)
    }

    static func parseLine(_ line: String) -> TokenEntry? {
        let fields = line.split(separator: ",", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
        guard fields.count >= 3 else { return nil }
        let label = fields[0]
        let hosts = fields[1]
        let kind: SecretKind
        let value: String
        if fields.count >= 4, let k = SecretKind(rawValue: fields[2].lowercased()) {
            kind = k
            value = fields[3...].joined(separator: ",")  // values may legitimately contain commas
        } else {
            kind = .secret
            value = fields[2...].joined(separator: ",")
        }
        let uses: Set<SecretUse> = kind == .totp
            ? (hosts.isEmpty ? [.otp] : [.otp, .http])
            : [.http]
        return TokenEntry(label: label, hosts: hosts, kind: kind, uses: uses, value: value)
    }
}

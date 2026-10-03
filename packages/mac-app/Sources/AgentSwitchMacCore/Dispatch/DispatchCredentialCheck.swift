import Foundation

/// Where an MCP server's configuration may hold a credential, and in what form (docs/dispatch-v0.md §3; a password or
/// token only ever as a secret-gate ciphertext): one whole `enc:v1:` token, which the gate's network layer swaps on the
/// way out. The daemon stores the configuration as given (extensions/types.ts says so in a comment only), so the form
/// refuses plaintext before Save:
/// - a variable or header whose name says it holds a credential (`GITHUB_TOKEN`, `accessToken`, `PGPASSWORD`,
///   `X-Api-Key`, `Authorization`): its value is one token (a header may put `Bearer ` or `token ` first);
/// - an argument `--token=…`, `--password …`, `GITHUB_TOKEN=…` or `Authorization: …`: the same;
/// - a URL with a password in it (`postgres://user:pass@host`) or a credential-named query item (`?api_key=…`).
/// A reference to a variable (`${GITHUB_TOKEN}`, `$GITHUB_TOKEN`) holds no secret itself: the variable is checked.
public enum DispatchCredentialCheck {
    /// The gate's token (secret_gate/constants.py TOKEN_PATTERN, the daemon's core/contextDoc.ts TOKEN).
    private static let token = "enc:v1:[A-Za-z0-9_-]{16,}={0,2}"
    private static let reference = "\\$(?:\\{[A-Za-z_][A-Za-z0-9_]*\\}|[A-Za-z_][A-Za-z0-9_]*)"
    private static let wholeValue = regex("^(?:\(token)|\(reference))$")
    private static let headerValue = regex("^(?:(?i:bearer|token)[ \\t]+)?(?:\(token)|\(reference))$")
    /// Names that say a credential anywhere in them, case aside (`accessToken`, `clientSecret`, `PGPASSWORD`,
    /// `GITHUBTOKEN`); `TOKENS` and `TOKENIZER` count pieces of text (`MAX_TOKENS`, `TOKENIZERS_PARALLELISM`).
    private static let fragments = regex(
        "TOKEN(?!S|IZ)|SECRET|PASSWORD|PASSWD|PASSPHRASE|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|COOKIE|AUTHORIZATION|BEARER",
        caseInsensitive: true)
    /// Short words that say it only as a word of their own (`DB_PWD`, `X-Api-Key`, `privateKey`, `GITHUB_PAT`; not
    /// `KEYBOARD`, `AUTHOR`, `PATH`).
    private static let words: Set<String> = ["KEY", "PWD", "PASS", "PAT", "AUTH"]
    /// `scheme://user:password@`: the password part.
    private static let userinfo = regex("[A-Za-z][A-Za-z0-9+.-]*://[^/\\s:@]*:([^@\\s/]*)@")
    /// `Name: value` as a header given on a command line.
    private static let headerLine = regex("^([A-Za-z0-9_-]+)[ \\t]*:[ \\t]*(.*)$")

    // MARK: names and values

    public static func namesCredential(_ name: String) -> Bool {
        if matches(fragments, name) { return true }
        return Self.words(of: name).contains(where: words.contains)
    }

    /// One token (or a reference to a variable), nothing else.
    public static func isCiphertext(_ value: String) -> Bool { matches(wholeValue, value) }

    /// A header's value: a token, after `Bearer ` or `token ` if any.
    public static func isHeaderCiphertext(_ value: String) -> Bool { matches(headerValue, value) }

    /// The words of a name: split at anything but letters and digits and where camelCase turns upper (`X-Api-Key`,
    /// `privateKey` → `X API KEY`, `PRIVATE KEY`).
    static func words(of name: String) -> [String] {
        var out: [String] = []
        var current = ""
        var previous: Character?
        for character in name {
            guard character.isLetter || character.isNumber else {
                if !current.isEmpty { out.append(current) }
                (current, previous) = ("", nil)
                continue
            }
            if let previous, character.isUppercase, previous.isLowercase || previous.isNumber, !current.isEmpty {
                out.append(current)
                current = ""
            }
            current.append(character)
            previous = character
        }
        if !current.isEmpty { out.append(current) }
        return out.map { $0.uppercased() }
    }

    /// A URL in `text` carries a secret in plaintext: a password in its user part, or a credential-named query item.
    public static func urlHoldsPlaintext(_ text: String) -> Bool {
        let range = NSRange(text.startIndex..., in: text)
        for match in userinfo.matches(in: text, range: range) {
            guard let part = Range(match.range(at: 1), in: text) else { continue }
            let password = String(text[part]).removingPercentEncoding ?? String(text[part])
            if !password.isEmpty && !isCiphertext(password) { return true }
        }
        guard let items = URLComponents(string: text.trimmingCharacters(in: .whitespaces))?.queryItems else { return false }
        return items.contains { namesCredential($0.name) && !($0.value ?? "").isEmpty && !isCiphertext($0.value ?? "") }
    }

    // MARK: the form's fields

    /// The credential-named variables whose value is plaintext, and those with a URL holding a secret (an empty value
    /// is no credential).
    public static func plaintextVariables(_ pairs: [(key: String, value: String)]) -> [String] {
        pairs.filter { pair in
            !pair.value.isEmpty && ((namesCredential(pair.key) && !isCiphertext(pair.value)) || urlHoldsPlaintext(pair.value))
        }.map(\.key)
    }

    public static func plaintextHeaders(_ pairs: [(key: String, value: String)]) -> [String] {
        pairs.filter { pair in
            !pair.value.isEmpty && ((namesCredential(pair.key) && !isHeaderCiphertext(pair.value)) || urlHoldsPlaintext(pair.value))
        }.map(\.key)
    }

    /// Arguments that hand a secret over in plaintext, each named as the form shows it: the option (`--token`), the
    /// variable (`GITHUB_TOKEN`), the header (`Authorization`), else its place (`第 3 个参数`). A `--no-…` switch takes no
    /// value.
    public static func plaintextArguments(_ args: [String]) -> [String] {
        args.indices.compactMap { index in
            let next = index + 1 < args.count ? args[index + 1] : nil
            return plaintextArgument(args[index], next: next) ?? (urlHoldsPlaintext(args[index]) ? "第 \(index + 1) 个参数" : nil)
        }
    }

    /// `--name=value` / `NAME=value`, `Name: value`, or `--name` followed by its value: the name when it says a
    /// credential and the value is plaintext.
    private static func plaintextArgument(_ arg: String, next: String?) -> String? {
        let bare = String(arg.drop { $0 == "-" })
        if let cut = bare.firstIndex(of: "="), !bare[..<cut].contains(":") {
            let value = String(bare[bare.index(after: cut)...])
            guard namesCredential(String(bare[..<cut])), !value.isEmpty, !isCiphertext(value) else { return nil }
            return String(arg.prefix { $0 != "=" })
        }
        if !arg.hasPrefix("-"), let header = headerLine.firstMatch(in: arg, range: NSRange(arg.startIndex..., in: arg)),
           let name = Range(header.range(at: 1), in: arg).map({ String(arg[$0]) }),
           let value = Range(header.range(at: 2), in: arg).map({ String(arg[$0]) }) {
            return namesCredential(name) && !value.isEmpty && !isHeaderCiphertext(value) ? name : nil
        }
        guard arg.hasPrefix("-"), !bare.isEmpty, !bare.lowercased().hasPrefix("no-"), namesCredential(bare),
              let value = next, !value.hasPrefix("-") else { return nil }
        return isCiphertext(value) || isHeaderCiphertext(value) ? nil : arg
    }

    // MARK: plumbing

    private static func regex(_ pattern: String, caseInsensitive: Bool = false) -> NSRegularExpression {
        try! NSRegularExpression(pattern: pattern, options: caseInsensitive ? [.caseInsensitive] : [])
    }

    private static func matches(_ regex: NSRegularExpression, _ text: String) -> Bool {
        regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }
}

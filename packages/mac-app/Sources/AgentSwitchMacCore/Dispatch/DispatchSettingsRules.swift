import Foundation

// What the settings window's Dispatch group decides besides drawing (docs/dispatch-v0.md §3): the Log's segments and
// columns, a topic's hue, a file's size against the daemon's limit, the experience rows' words, and the MCP server and
// skill forms — their key-value lines (the web console's `lines` / `parseLines`) and the daemon's own checks
// (extensions/types.ts), so a refusal is caught before Save.

// MARK: - Log

/// The Log page's segments. The routing log records only what came of a task's routing: a target (dispatched), a
/// question to the user instead (`clarify`: answered without dispatching) or nothing (`give_up`, a repair asked before
/// any dispatch, an error with no default left: refused).
public enum DispatchRoutingLogFilter: String, CaseIterable, Sendable {
    case all, dispatched, answered, refused

    public var title: String {
        switch self {
        case .all: return "All"
        case .dispatched: return "Dispatched"
        case .answered: return "Answered"
        case .refused: return "Refused"
        }
    }

    public func matches(_ entry: DispatchRoutingLogEntry) -> Bool {
        self == .all || entry.verdict == self
    }
}

extension DispatchRoutingLogEntry {
    /// The decision's `action` (`redispatch`, `clarify`, `give_up`, `repair`); nil without a decision (a pin).
    public var action: String? {
        guard let data = decision?.data(using: .utf8), let json = try? JSONDecoder().decode(DispatchJSON.self, from: data) else { return nil }
        return json["action"]?.string
    }

    /// Which segment the row is in (never `.all`).
    public var verdict: DispatchRoutingLogFilter {
        if target != nil { return .dispatched }
        return action == "clarify" ? .answered : .refused
    }

    /// The From column: where the target came from — `Pinned` (the user's pin), `Auto` (the dispatch model's
    /// choice), `Default` (the default target); the source as stored otherwise.
    public var sourceWord: String {
        switch source {
        case "pin": return "Pinned"
        case "router": return "Auto"
        case "default": return "Default"
        default: return source
        }
    }

    /// The Time column, one width for every row: `10:40` today, `9/30` before.
    public func timeColumn(now: Date = Date(), calendar: Calendar = .current) -> String {
        if calendar.isDate(date, inSameDayAs: now) {
            let parts = calendar.dateComponents([.hour, .minute], from: date)
            return String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
        }
        let parts = calendar.dateComponents([.month, .day], from: date)
        return "\(parts.month ?? 0)/\(parts.day ?? 0)"
    }
}

// MARK: - topics

/// A topic's own hue (the web console's `topicHue`, ui/lib/sidebar.js): which topic something belongs to, never a status.
public enum DispatchTopicHue {
    public static let palette: [UInt32] = [0x9FB4FF, 0xE8A0C8, 0x8FD8C4, 0xD8C28F, 0xB9A0E8, 0xA0D0E8]

    /// The same hue the web console gives the same id: a 31-hash of each character's first UTF-16 unit, mod 2^32.
    public static func hex(for id: String) -> UInt32 {
        var hash: UInt32 = 0
        for scalar in id.unicodeScalars {
            hash = hash &* 31 &+ UInt32(String(scalar).utf16.first ?? 0)
        }
        return palette[Int(hash % UInt32(palette.count))]
    }
}

// MARK: - context.md

/// Sizes as the web console's Context page writes them (`812 B`, `1.2 KB`), against the daemon's limit
/// (core/contextDoc.ts MAX_CONTEXT_BYTES: a longer file is cut there when loaded).
public enum DispatchFileSize {
    public static let contextLimit = 64 * 1024

    public static func text(bytes: Int) -> String {
        bytes < 1024 ? "\(bytes) B" : String(format: "%.1f KB", Double(bytes) / 1024)
    }

    /// `1.2 KB / 64 KB`.
    public static func ofContextLimit(_ text: String) -> String {
        "\(Self.text(bytes: text.utf8.count)) / \(contextLimit / 1024) KB"
    }

    public static func exceedsContextLimit(_ text: String) -> Bool { text.utf8.count > contextLimit }
}

// MARK: - experience

extension DispatchPlatformMemory {
    /// The row's state word: `Expired` once past its date, else `Verified` or `Pending`.
    public func stateWord(now: Date = Date()) -> String {
        isExpired(now: now) ? "Expired" : status == "verified" ? "Verified" : "Pending"
    }

    /// `Operation` (操作经验) or `Incident` (临时事件).
    public var kindWord: String { kind == "incident" ? "Incident" : "Operation" }

    public var updated: Date { Date(dispatchMilliseconds: updatedAt) }
    public var expires: Date { Date(dispatchMilliseconds: expiresAt) }
}

// MARK: - extensions

/// Names the daemon takes for an MCP server or a skill (extensions/types.ts NAME_RE, RESERVED_NAMES).
public enum DispatchExtensionName {
    /// Taken by the gate's own wiring: an MCP server may not shadow them.
    public static let reserved: Set<String> = ["secret-gate", "playwright"]
    private static let pattern = try! NSRegularExpression(pattern: "^[a-z0-9][a-z0-9_-]{0,63}$")

    public static func isValid(_ name: String) -> Bool {
        pattern.firstMatch(in: name, range: NSRange(name.startIndex..., in: name)) != nil
    }

    /// Why a name cannot be saved, in a sentence; nil when it can.
    public static func problem(_ name: String, reservedApplies: Bool) -> String? {
        if name.isEmpty { return "请填写名称。" }
        if !isValid(name) { return "名称仅可使用小写字母、数字、- 和 _，以字母或数字开头，最多 64 个字符。" }
        if reservedApplies && reserved.contains(name) { return "名称 \(name) 由凭据网关使用，请使用其他名称。" }
        return nil
    }
}

/// `KEY=VALUE` (env) and `Key: Value` (headers), one per line: the web console's `lines` and `parseLines`.
public enum DispatchKeyValueLines {
    public static func format(_ map: [String: String], separator: String) -> String {
        map.keys.sorted().map { "\($0)\(separator)\(map[$0] ?? "")" }.joined(separator: "\n")
    }

    /// Blank lines skipped; a line without the separator is a key with an empty value; both sides trimmed.
    public static func parse(_ text: String, separator: String) -> [(key: String, value: String)] {
        text.split(separator: "\n", omittingEmptySubsequences: true).compactMap { raw in
            let line = raw.trimmingCharacters(in: .whitespaces)
            guard !line.isEmpty else { return nil }
            guard let cut = line.range(of: separator) else { return (line, "") }
            return (String(line[..<cut.lowerBound]).trimmingCharacters(in: .whitespaces),
                    String(line[cut.upperBound...]).trimmingCharacters(in: .whitespaces))
        }
    }

    /// The pairs as a map, a later key replacing an earlier one (as the web's `Object.fromEntries`).
    public static func map(_ pairs: [(key: String, value: String)]) -> [String: String] {
        pairs.reduce(into: [:]) { $0[$1.key] = $1.value }
    }
}

/// The MCP server form (new or edited): the fields as typed, the daemon's checks and the server to `PUT /mcp/:name`.
/// Credentials go in as `enc:v1:` ciphertexts only — the gate's network layer swaps them on the way out — so a variable,
/// header or argument whose name says it is a credential must hold one (DispatchCredentialCheck). `PUT` replaces a
/// server of the same name, so a new one may not take a name in use.
public struct DispatchMCPServerDraft: Sendable, Hashable {
    public var name: String
    /// `stdio` or `http`.
    public var kind: String
    public var command: String
    /// One argument per line.
    public var arguments: String
    /// `KEY=VALUE` per line (stdio).
    public var environment: String
    public var url: String
    /// `Key: Value` per line (http).
    public var headers: String
    /// `ask` or `allow`.
    public var approval: String
    public var note: String
    public var harnesses: [String]
    /// Kept from the server edited (a new one starts on).
    public let enabled: Bool
    /// Editing an existing server: the name is fixed.
    public let isNew: Bool

    /// The daemon's limit, in UTF-16 units (DispatchLimits).
    public static let maxNote = DispatchLimits.note
    public static let ciphertextMark = "enc:v1:"
    public static let nameTaken = "已有同名的 MCP 服务，请换一个名称，或编辑现有的。"

    public init(_ server: DispatchMCPServer? = nil) {
        name = server?.name ?? ""
        kind = server?.kind ?? "stdio"
        command = server?.command ?? ""
        arguments = (server?.args ?? []).joined(separator: "\n")
        environment = DispatchKeyValueLines.format(server?.env ?? [:], separator: "=")
        url = server?.url ?? ""
        headers = DispatchKeyValueLines.format(server?.headers ?? [:], separator: ": ")
        approval = server?.approval ?? "ask"
        note = server?.note ?? ""
        harnesses = server?.harnesses ?? DispatchExtensionHarnesses.all
        enabled = server?.enabled ?? true
        isNew = server == nil
    }

    public var trimmedName: String { name.trimmingCharacters(in: .whitespaces) }
    private var envPairs: [(key: String, value: String)] { DispatchKeyValueLines.parse(environment, separator: "=") }
    private var headerPairs: [(key: String, value: String)] { DispatchKeyValueLines.parse(headers, separator: ":") }
    private var argumentLines: [String] {
        arguments.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    /// Why it cannot be saved yet, one sentence each; empty when it can.
    public var problems: [String] { problems(existing: []) }

    /// The same, a new server also checked against the names of the servers there are (`existing`).
    public func problems(existing: Set<String>) -> [String] {
        var out: [String] = []
        if let problem = DispatchExtensionName.problem(trimmedName, reservedApplies: true) {
            out.append(problem)
        } else if isNew && existing.contains(trimmedName) {
            out.append(Self.nameTaken)
        }
        let pairs: [(key: String, value: String)]
        if kind == "http" {
            if !Self.isWebAddress(url.trimmingCharacters(in: .whitespaces)) {
                out.append("HTTP 服务需要以 http:// 或 https:// 开头的地址。")
            }
            pairs = headerPairs
            if pairs.contains(where: { $0.key.isEmpty }) { out.append("请求头每行须为 Key: Value 格式。") }
        } else {
            if command.trimmingCharacters(in: .whitespaces).isEmpty { out.append("stdio 服务需要填写命令。") }
            pairs = envPairs
            if pairs.contains(where: { $0.key.isEmpty }) { out.append("环境变量每行须为 KEY=VALUE 格式。") }
        }
        let plaintext = kind == "http"
            ? DispatchCredentialCheck.plaintextHeaders(pairs) + (DispatchCredentialCheck.urlHoldsPlaintext(url) ? ["URL"] : [])
            : DispatchCredentialCheck.plaintextVariables(pairs) + DispatchCredentialCheck.plaintextArguments(argumentLines)
        let named = plaintext.reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }
        if !named.isEmpty { out.append("以下项的值须为 enc:v1: 密文：\(named.joined(separator: "、"))。") }
        if DispatchLimits.length(note.trimmingCharacters(in: .whitespacesAndNewlines)) > Self.maxNote {
            out.append("备注最多 \(Self.maxNote) 个字符。")
        }
        return out
    }

    /// The server as the daemon takes it: only the chosen kind's fields.
    public func server() -> DispatchMCPServer {
        let isHTTP = kind == "http"
        let commandLine = command.trimmingCharacters(in: .whitespaces)
        return DispatchMCPServer(
            name: trimmedName, kind: isHTTP ? "http" : "stdio",
            command: isHTTP || commandLine.isEmpty ? nil : commandLine,
            args: isHTTP ? [] : argumentLines,
            env: isHTTP ? [:] : DispatchKeyValueLines.map(envPairs),
            url: isHTTP ? url.trimmingCharacters(in: .whitespaces) : nil,
            headers: isHTTP ? DispatchKeyValueLines.map(headerPairs) : [:],
            enabled: enabled, harnesses: DispatchExtensionHarnesses.all.filter(harnesses.contains),
            approval: approval == "allow" ? "allow" : "ask", note: note.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// http(s) with a host (the daemon's `z.url()` and `^https?://`).
    static func isWebAddress(_ text: String) -> Bool {
        guard text.hasPrefix("http://") || text.hasPrefix("https://"), let host = URL(string: text)?.host else { return false }
        return !host.isEmpty
    }

    /// A name that says the value is a credential (DispatchCredentialCheck: `GITHUB_TOKEN`, `accessToken`,
    /// `PGPASSWORD`, `Authorization`, `X-Api-Key`).
    public static func namesCredential(_ key: String) -> Bool { DispatchCredentialCheck.namesCredential(key) }
}

/// The skill form: a new skill needs a valid name and some SKILL.md (the daemon adds missing frontmatter).
public struct DispatchSkillDraft: Sendable, Hashable {
    public var name: String
    public var content: String
    public var harnesses: [String]
    public let isNew: Bool

    public init(name: String = "", content: String = "", harnesses: [String] = DispatchExtensionHarnesses.all, isNew: Bool = true) {
        self.name = name
        self.content = content
        self.harnesses = harnesses
        self.isNew = isNew
    }

    public var trimmedName: String { name.trimmingCharacters(in: .whitespaces) }

    public static let nameTaken = "已有同名的 skill，请换一个名称，或编辑现有的。"

    public var problems: [String] { problems(existing: []) }

    /// The same, a new skill also checked against the names of the skills there are (`PUT /skills/:name` would write
    /// over that one's SKILL.md).
    public func problems(existing: Set<String>) -> [String] {
        var out: [String] = []
        if let problem = DispatchExtensionName.problem(trimmedName, reservedApplies: false) {
            out.append(problem)
        } else if isNew && existing.contains(trimmedName) {
            out.append(Self.nameTaken)
        }
        if content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { out.append("请填写 SKILL.md 的内容。") }
        return out
    }

    public var update: DispatchSkillUpdate {
        DispatchSkillUpdate(content: content, harnesses: DispatchExtensionHarnesses.all.filter(harnesses.contains))
    }
}

/// Who an extension is given to, as a row says it: `All`, `Claude Code · Codex`, `None`.
public enum DispatchHarnessList {
    public static func text(_ harnesses: [String]) -> String {
        let known = DispatchExtensionHarnesses.all.filter(harnesses.contains)
        if known.count == DispatchExtensionHarnesses.all.count { return "All" }
        if known.isEmpty { return "None" }
        return known.map(HarnessName.display).joined(separator: " · ")
    }
}

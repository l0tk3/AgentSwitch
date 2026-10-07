import Foundation

// What a reply box offers as it is typed in (docs/simple-view-v0.md §5.5): the agent's slash commands after a `/`, the
// folder's files after an `@`, and a word on what the agent's other first characters do — the same things its own
// prompt offers in the terminal. The lists come from the service (`GET /terminals/:id/commands`, `…/files`); what is
// asked for, how a list is narrowed and what a choice types are here.

/// A slash command the terminal's agent takes: its own, or one of yours (a command file or skill in your home or the
/// project).
public struct SlashCommand: Decodable, Sendable, Hashable, Identifiable {
    /// Without the slash: "compact", "frontend:lint".
    public let name: String
    public let description: String
    /// builtin · user · project
    public let source: String

    public var id: String { name }

    public init(name: String, description: String, source: String = "builtin") {
        self.name = name
        self.description = description
        self.source = source
    }

    private enum CodingKeys: String, CodingKey { case name, description, source }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        description = (try? c.decodeIfPresent(String.self, forKey: .description)) ?? ""
        source = (try? c.decodeIfPresent(String.self, forKey: .source)) ?? "builtin"
    }
}

public enum ReplyHints {
    /// What the text up to the caret asks for.
    public enum Ask: Equatable, Sendable {
        /// A slash command: what is typed after the slash.
        case commands(String)
        /// A file of the folder: what is typed after the `@`, and where the `@` is (UTF-16, as a text view counts).
        case files(query: String, at: Int)
        /// A first character that changes what the line is, said in a line.
        case mark(Mark)
    }

    /// A first character an agent's prompt takes specially, as its own program says it.
    public struct Mark: Equatable, Sendable {
        public let sign: String
        public let word: String
        public let says: String

        public init(sign: String, word: String, says: String) {
            self.sign = sign
            self.word = word
            self.says = says
        }
    }

    /// The agents whose prompt runs a line that begins with `!` in the shell (read from the installed programs,
    /// 2026-10-07: Claude Code 2.1.292 "! for shell mode", Codex 0.158 "! to run it locally"; OpenCode and pi say the
    /// same in their documents).
    private static let shells: Set<String> = ["claude-code", "codex", "opencode", "pi"]

    public static func ask(text: String, caret: Int, harness: String) -> Ask? {
        let all = text as NSString
        let head = all.substring(to: min(max(caret, 0), all.length))
        // A command is the whole reply so far: a slash, then its name, the caret still in it.
        if head.hasPrefix("/"), !head.contains(where: \.isWhitespace) {
            let rest = all.substring(from: (head as NSString).length)
            if rest.isEmpty || rest.first?.isWhitespace == true { return .commands(String(head.dropFirst())) }
        }
        // A file: the word the caret is in begins with `@` (an address — `me@host` — does not).
        let word = head.split(omittingEmptySubsequences: false, whereSeparator: \.isWhitespace).last.map(String.init) ?? ""
        if word.hasPrefix("@"), !word.dropFirst().contains("@") {
            return .files(query: String(word.dropFirst()), at: (head as NSString).length - (word as NSString).length)
        }
        if head.hasPrefix("!"), shells.contains(harness) {
            return .mark(Mark(sign: "!", word: "Shell", says: "这一行作为命令在它的 shell 里运行，输出进入对话。"))
        }
        if head.hasPrefix("$"), harness == "codex", !head.contains(where: \.isWhitespace) {
            return .mark(Mark(sign: "$", word: "Skills", says: "Codex 的技能与应用列表在它自己的屏幕上选：切到终端视图输入 $。"))
        }
        return nil
    }

    public static let shown = 8

    /// The commands `typed` may be the start of: names that start with it first, then names with a word that does
    /// (`lint` finds `frontend:lint`). A complete name alone needs no list.
    public static func matching(_ typed: String, in commands: [SlashCommand], limit: Int = shown) -> [SlashCommand] {
        let typed = typed.lowercased()
        let starts = commands.filter { $0.name.lowercased().hasPrefix(typed) }
        let inside = typed.isEmpty ? [] : commands.filter { c in
            !c.name.lowercased().hasPrefix(typed)
                && c.name.lowercased().split(whereSeparator: { ":-_".contains($0) }).contains { $0.hasPrefix(typed) }
        }
        let found = starts + inside
        if found.count == 1, found[0].name.lowercased() == typed { return [] }
        return Array(found.prefix(limit))
    }

    /// What choosing a command types in place of what was typed: the command and a space, ready for what it takes.
    public static func typed(command: SlashCommand) -> String { "/\(command.name) " }

    /// What choosing a file types in place of the `@…` word. Claude Code, OpenCode and pi read `@path` in the reply
    /// as the file; Codex's own list leaves the bare path. A path with a space is quoted the way each takes it.
    public static func typed(file path: String, harness: String) -> String {
        let spaced = path.contains(where: \.isWhitespace)
        if harness == "codex" { return spaced ? "\"\(path)\" " : "\(path) " }
        return spaced ? "@\"\(path)\" " : "@\(path) "
    }

    /// A file's name and the folder it is in, for a row: `host.ts` · `src/terminals`.
    public static func parts(of path: String) -> (name: String, folder: String) {
        guard let slash = path.lastIndex(of: "/") else { return (path, "") }
        return (String(path[path.index(after: slash)...]), String(path[..<slash]))
    }
}

extension DaemonClient {
    /// The slash commands the agent in a terminal takes, in its folder.
    public func terminalCommands(id: String) async throws -> [SlashCommand] {
        struct Reply: Decodable { let commands: [SlashCommand] }
        return try JSONDecoder().decode(Reply.self, from: try await call("GET", "/terminals/\(Self.segment(id))/commands")).commands
    }

    /// The files of a terminal's folder that `query` may mean, best first.
    public func terminalFiles(id: String, query: String) async throws -> [String] {
        struct Reply: Decodable { let files: [String] }
        var parts = URLComponents()
        parts.queryItems = [URLQueryItem(name: "q", value: query)]
        return try JSONDecoder().decode(Reply.self, from: try await call("GET", "/terminals/\(Self.segment(id))/files?\(parts.percentEncodedQuery ?? "")")).files
    }
}

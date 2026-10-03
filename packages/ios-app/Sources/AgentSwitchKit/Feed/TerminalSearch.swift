import Foundation

/// Searching the terminals tab (docs/terminal-v0.md §1 搜索), as the web page's list does: folders by name, terminals and
/// sessions by name, and sessions by what was said in them (`said`, from the Mac's `GET /sessions/search`). The tree
/// keeps its order; what is left is what matched — a folder whose name matched with all it holds, else only its rows
/// that did — and a match in the words carries a line of them.
public enum TerminalSearch {
    public enum Item: Sendable, Equatable {
        case terminal(TerminalInfo)
        case session(SessionSummary)
    }

    public struct Row: Sendable, Equatable, Identifiable {
        public let item: Item
        /// Its name matched.
        public let titleHit: Bool
        /// The words around the match in what was said, when that matched and the name did not.
        public let said: String?
        public var id: String {
            switch item {
            case .terminal(let t): "t:\(t.id)"
            case .session(let s): "s:\(s.id)"
            }
        }
    }

    public struct Folder: Sendable, Equatable, Identifiable {
        public let cwd: String
        /// As the tree names it, under the names of the folders it sits in ("Worktop/Codex", "Worktop/培训/靶场").
        public let name: String
        public let git: GitSummary?
        public let nameHit: Bool
        public let rows: [Row]
        public var id: String { cwd }
    }

    public struct Result: Sendable, Equatable {
        public let folders: [Folder]
        public let folderHits: Int
        public let titleHits: Int
        public let textHits: Int

        /// `// 1 folder · 2 titles · 3 in text`
        public var summary: String {
            let n = { (k: Int, one: String, many: String) in k == 0 ? "" : "\(k) \(k == 1 ? one : many)" }
            let parts = [n(folderHits, "folder", "folders"), n(titleHits, "title", "titles"), n(textHits, "in text", "in text")].filter { !$0.isEmpty }
            return "// " + parts.joined(separator: " · ")
        }
    }

    /// `said`: a session's words around the match, by `harness:id` (a terminal by the session it writes). Each folder
    /// with terminals or sessions of its own, named by the folders it sits in ("Worktop/培训/靶场"): a match on a
    /// folder's name keeps every folder under it as well.
    public static func run(_ tree: [TerminalTree.Folder], query: String, said: [String: String] = [:]) -> Result {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return Result(folders: [], folderHits: 0, titleHits: 0, textHits: 0) }
        var folders: [Folder] = []
        var folderHits = 0, titleHits = 0, textHits = 0
        for (group, name) in TerminalTree.flatten(tree) where group.holdsOwn {
            let nameHit = name.lowercased().contains(q) || tilde(group.cwd).lowercased().contains(q)
            var rows: [Row] = []
            for t in group.terminals {
                let title = t.name.lowercased().contains(q)
                let words = t.agentSessionId.flatMap { said["\(t.harness):\($0)"] }
                if nameHit || title || words != nil { rows.append(Row(item: .terminal(t), titleHit: title, said: title ? nil : words)) }
            }
            for s in group.sessions {
                let title = s.displayTitle.lowercased().contains(q)
                let words = said["\(s.harness):\(s.sessionId)"]
                if nameHit || title || words != nil { rows.append(Row(item: .session(s), titleHit: title, said: title ? nil : words)) }
            }
            guard nameHit || !rows.isEmpty else { continue }
            if nameHit { folderHits += 1 }
            titleHits += rows.filter(\.titleHit).count
            textHits += rows.filter { $0.said != nil }.count
            folders.append(Folder(cwd: group.cwd, name: name, git: group.git, nameHit: nameHit, rows: rows))
        }
        return Result(folders: folders, folderHits: folderHits, titleHits: titleHits, textHits: textHits)
    }

    /// Where `query` is in `text` (case aside), for marking it.
    public static func match(_ query: String, in text: String) -> Range<String.Index>? {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return nil }
        return text.range(of: q, options: [.caseInsensitive, .diacriticInsensitive])
    }

    /// The words from a little before the match: the row is narrow, and the match must show.
    public static func near(_ query: String, in text: String) -> String {
        guard let range = match(query, in: text) else { return text }
        let before = text.distance(from: text.startIndex, to: range.lowerBound)
        guard before > 8 else { return text }
        let start = text.index(range.lowerBound, offsetBy: -6)
        return "…" + String(text[start...].drop { $0 == "…" })
    }

    /// `/Users/<name>/x` as `~/x`, as the web page shows paths.
    static func tilde(_ path: String) -> String { TerminalTree.tilde(path) }
}

/// A session whose words matched a search (`GET /sessions/search`).
public struct SessionHit: Decodable, Sendable, Equatable {
    public let harness: String
    public let id: String
    public let excerpt: String

    public init(harness: String, id: String, excerpt: String) {
        self.harness = harness
        self.id = id
        self.excerpt = excerpt
    }
}

struct SessionHits: Decodable {
    let hits: [SessionHit]
}

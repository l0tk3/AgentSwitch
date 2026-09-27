import Foundation

/// Search results as the phone shows them (control-v0 §4): the daemon marks each hit in `snippet` with ⟦ and ⟧; the
/// marks go and the hits are bold.
public enum SearchSnippet {
    public static let open: Character = "⟦"
    public static let close: Character = "⟧"

    public struct Part: Sendable, Hashable {
        public let text: String
        public let hit: Bool

        public init(_ text: String, hit: Bool) {
            self.text = text
            self.hit = hit
        }
    }

    /// The snippet in runs of plain text and hits, the marks removed; an unclosed mark runs to the end, a stray close
    /// mark is dropped.
    public static func parts(_ snippet: String) -> [Part] {
        var parts: [Part] = []
        var current = ""
        var inHit = false
        func flush() {
            if !current.isEmpty { parts.append(Part(current, hit: inHit)) }
            current = ""
        }
        for ch in MessageDisplay.readable(snippet) {
            switch ch {
            case open where !inHit: flush(); inHit = true
            case close where inHit: flush(); inHit = false
            case open, close: continue
            default: current.append(ch)
            }
        }
        flush()
        return parts
    }

    /// The snippet as plain text (accessibility, copying).
    public static func plain(_ snippet: String) -> String {
        parts(snippet).map(\.text).joined()
    }

    /// Search over the tasks the phone already has, marked the daemon's way: for a Mac without `/search` and for the
    /// demo screens. Case-insensitive; the snippet is cut around the first hit, taken from what came of the task before
    /// its own text (which is already the title).
    public static func local(_ tasks: [AgentTask], query: String, limit: Int = 30) -> [SearchResult] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return [] }
        let hits: [SearchResult] = tasks.compactMap { task in
            let fields = [task.speech, task.result, task.error, task.spoken, task.task].compactMap { $0.map(MessageDisplay.readable) }
            guard let text = fields.first(where: { $0.range(of: q, options: .caseInsensitive) != nil }) else { return nil }
            return SearchResult(taskId: task.id, title: LiveSummary.clip(MessageDisplay.readable(task.task), 40),
                                snippet: marked(text, query: q), status: task.status, updatedAt: task.updatedAt)
        }
        return Array(hits.sorted { $0.updatedAt > $1.updatedAt }.prefix(limit))
    }

    static let context = 30

    /// Every occurrence of `query` in a window around the first one, wrapped in ⟦⟧.
    static func marked(_ text: String, query: String) -> String {
        let flat = text.replacingOccurrences(of: "\n", with: " ")
        guard let first = flat.range(of: query, options: .caseInsensitive) else { return String(flat.prefix(context * 2)) }
        let start = flat.index(first.lowerBound, offsetBy: -context, limitedBy: flat.startIndex) ?? flat.startIndex
        let end = flat.index(first.upperBound, offsetBy: context * 2, limitedBy: flat.endIndex) ?? flat.endIndex
        var window = String(flat[start..<end])
        var out = ""
        while let hit = window.range(of: query, options: .caseInsensitive) {
            out += String(window[..<hit.lowerBound])
            out += "⟦" + String(window[hit]) + "⟧"
            window = String(window[hit.upperBound...])
        }
        out += window
        return (start > flat.startIndex ? "…" : "") + out + (end < flat.endIndex ? "…" : "")
    }
}

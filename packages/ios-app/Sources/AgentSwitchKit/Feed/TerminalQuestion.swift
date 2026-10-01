import Foundation

/// What is picked on a question card (docs/terminal-v0.md §3 "选择题", 2026-10-01, user: 能不能hook的更精细，直接用这个框来选
/// agent给的选项): per question, its options by label — one, or several when it takes several — and the words written
/// in Other. Writing in Other picks it: in place of the option picked (one), or beside them (several). Submit once every
/// question has an answer.
public struct QuestionPicks: Sendable, Equatable {
    /// One question's answer as the Mac takes it (`POST /terminals/:id/permissions/:pid {answers}`).
    public struct Answer: Encodable, Sendable, Equatable {
        public let labels: [String]
        public let other: String?
    }

    public let questions: [TerminalQuestion]
    private var labels: [[String]]
    private var others: [String]

    public init(_ questions: [TerminalQuestion]) {
        self.questions = questions
        labels = questions.map { _ in [] }
        others = questions.map { _ in "" }
    }

    public func isPicked(_ label: String, in question: Int) -> Bool { labels[question].contains(label) }
    public func other(in question: Int) -> String { others[question] }
    public func hasOther(in question: Int) -> Bool { !others[question].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    /// A tap on an option: the one picked (one), or on and off (several).
    public mutating func pick(_ label: String, in question: Int) {
        if questions[question].multiSelect {
            if let at = labels[question].firstIndex(of: label) { labels[question].remove(at: at) } else { labels[question].append(label) }
        } else {
            labels[question] = [label]
            others[question] = ""
        }
    }

    public mutating func write(_ text: String, in question: Int) {
        others[question] = text
        if !questions[question].multiSelect, hasOther(in: question) { labels[question] = [] }
    }

    public func isAnswered(_ question: Int) -> Bool { !labels[question].isEmpty || hasOther(in: question) }
    public var isComplete: Bool { questions.indices.allSatisfy(isAnswered) }

    /// By question text, as the Mac checks them: the labels in the order of the options, Other's words trimmed.
    public var answers: [String: Answer] {
        var out: [String: Answer] = [:]
        for (i, q) in questions.enumerated() where isAnswered(i) {
            let picked = q.options.map(\.label).filter { labels[i].contains($0) }
            out[q.question] = Answer(labels: picked, other: hasOther(in: i) ? others[i].trimmingCharacters(in: .whitespacesAndNewlines) : nil)
        }
        return out
    }
}

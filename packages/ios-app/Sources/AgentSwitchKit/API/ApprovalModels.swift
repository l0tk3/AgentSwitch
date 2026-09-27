import Foundation

public enum ApprovalKind: String, Codable, Sendable {
    case approval, question, other

    public init(from decoder: Decoder) throws {
        self = ApprovalKind(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .other
    }
}

public enum ApprovalStatus: String, Codable, Sendable {
    /// `withdrawn`: the executor cancelled its own request (control-v0 §4); only `pending` ones are ever shown.
    case pending, allowed, denied, expired, withdrawn, other

    public init(from decoder: Decoder) throws {
        self = ApprovalStatus(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .other
    }
}

/// engine/types.ts Approval: allow/deny for a dangerous action, or a question that needs text from the user.
public struct Approval: Codable, Sendable, Hashable, Identifiable {
    public let id: String
    public let taskId: String
    public let createdAt: Int64
    public let kind: ApprovalKind
    public let action: String
    public let evidence: String
    public let status: ApprovalStatus
    public let resolvedAt: Int64?
    public let answer: String?

    public var created: Date { Date(milliseconds: createdAt) }

    /// For a question, the structured evidence (core/questions.ts); nil for allow/deny approvals.
    public var questionEvidence: QuestionEvidence? {
        guard kind == .question, let data = evidence.data(using: .utf8) else { return nil }
        guard let parsed = try? JSONDecoder().decode(QuestionEvidence.self, from: data), !parsed.questions.isEmpty else { return nil }
        return parsed
    }
}

/// core/questions.ts QuestionEvidence.
public struct QuestionEvidence: Codable, Sendable, Hashable {
    public let source: String
    public let questions: [UserQuestion]
}

/// core/questions.ts UserQuestion, with the schema's defaults applied.
public struct UserQuestion: Codable, Sendable, Hashable, Identifiable {
    public struct Option: Codable, Sendable, Hashable {
        public let label: String
        public let description: String

        public init(label: String, description: String = "") {
            self.label = label
            self.description = description
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            label = try c.decode(String.self, forKey: .label)
            description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
        }
    }

    public let id: String
    public let header: String
    public let text: String
    public let options: [Option]
    public let multi: Bool
    /// The harness flagged the answer as sensitive: answer with a ciphertext, never plaintext.
    public let secret: Bool

    public init(id: String, header: String = "", text: String, options: [Option] = [], multi: Bool = false, secret: Bool = false) {
        self.id = id
        self.header = header
        self.text = text
        self.options = options
        self.multi = multi
        self.secret = secret
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        header = try c.decodeIfPresent(String.self, forKey: .header) ?? ""
        text = try c.decode(String.self, forKey: .text)
        options = try c.decodeIfPresent([Option].self, forKey: .options) ?? []
        multi = try c.decodeIfPresent(Bool.self, forKey: .multi) ?? false
        secret = try c.decodeIfPresent(Bool.self, forKey: .secret) ?? false
    }
}

/// Answers keyed by question id, validated like core/questions.ts validateAnswers before they are sent.
public enum AnswerCheck {
    public static let maxLength = 4000

    public static func problem(questions: [UserQuestion], answers: [String: [String]]) -> String? {
        for q in questions {
            let values = (answers[q.id] ?? []).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
            if values.isEmpty { return "未回答：\(q.text)" }
            if !q.multi && values.count > 1 { return "仅可选择一项：\(q.text)" }
            if values.contains(where: { $0.count > maxLength }) { return "回答过长（最多 \(maxLength) 字）" }
        }
        let extra = Set(answers.keys).subtracting(questions.map(\.id))
        return extra.isEmpty ? nil : "无对应问题的回答：\(extra.sorted().joined(separator: ", "))"
    }

    /// Drops blanks and trims, so what is sent is what was checked.
    public static func cleaned(_ answers: [String: [String]]) -> [String: [String]] {
        answers.mapValues { $0.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty } }
    }
}

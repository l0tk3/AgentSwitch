import Foundation

// Approvals and questions (engine/types.ts Approval, core/questions.ts), ported from the iPhone Kit
// (API/ApprovalModels.swift) with the answer form's logic from the phone's ApprovalCard. A card sits inside its task's
// card (docs/dispatch-v0.md §2); one without a card in the record is a loose approval (DispatchFeed.looseApprovals).

public enum DispatchApprovalKind: String, Codable, Sendable {
    case approval, question, other

    public init(from decoder: Decoder) throws {
        self = DispatchApprovalKind(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .other
    }
}

public enum DispatchApprovalStatus: String, Codable, Sendable {
    /// `withdrawn`: the executor cancelled its own request (control-v0 §4); only `pending` ones are ever shown.
    case pending, allowed, denied, expired, withdrawn, other

    public init(from decoder: Decoder) throws {
        self = DispatchApprovalStatus(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .other
    }
}

/// `POST /tasks/:id/approve` decisions.
public enum DispatchApprovalDecision: String, Codable, Sendable { case allow, deny }

/// Allow/deny for an action, or a question that needs an answer from the user.
public struct DispatchApproval: Decodable, Sendable, Hashable, Identifiable {
    public let id: String
    public let taskId: String
    public let createdAt: Int64
    public let kind: DispatchApprovalKind
    /// What it asks to do (`Bash: rm -rf build`), or a question's one-line text.
    public let action: String
    /// The tool input as JSON for an approval; a question's structured evidence (DispatchQuestionEvidence).
    public let evidence: String
    public let status: DispatchApprovalStatus
    public let resolvedAt: Int64?
    public let answer: String?

    public init(id: String, taskId: String, createdAt: Int64, kind: DispatchApprovalKind, action: String, evidence: String = "",
                status: DispatchApprovalStatus = .pending, resolvedAt: Int64? = nil, answer: String? = nil) {
        self.id = id
        self.taskId = taskId
        self.createdAt = createdAt
        self.kind = kind
        self.action = action
        self.evidence = evidence
        self.status = status
        self.resolvedAt = resolvedAt
        self.answer = answer
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        self.init(id: try c.require(String.self, "id"), taskId: try c.require(String.self, "taskId"),
                  createdAt: c.first(Int64.self, "createdAt") ?? 0, kind: c.first(DispatchApprovalKind.self, "kind") ?? .other,
                  action: c.first(String.self, "action") ?? "", evidence: c.first(String.self, "evidence") ?? "",
                  status: c.first(DispatchApprovalStatus.self, "status") ?? .other, resolvedAt: c.first(Int64.self, "resolvedAt"),
                  answer: c.first(String.self, "answer"))
    }

    public var created: Date { Date(dispatchMilliseconds: createdAt) }

    /// For a question, the structured evidence (core/questions.ts); nil for allow/deny approvals and old formats.
    public var questionEvidence: DispatchQuestionEvidence? {
        guard kind == .question, let data = evidence.data(using: .utf8) else { return nil }
        guard let parsed = try? JSONDecoder().decode(DispatchQuestionEvidence.self, from: data), !parsed.questions.isEmpty else { return nil }
        return parsed
    }

    /// How its card reads: allow/deny, a form of questions, or a question in a format this app cannot answer.
    public var card: DispatchApprovalCard {
        if let evidence = questionEvidence { return .questions(evidence) }
        if kind == .question { return .unsupportedQuestion(action) }
        return .approve(action: action, details: evidence.isEmpty ? nil : evidence)
    }

    /// One line of what it waits for: the first question, else the action (the active-topics strip, the step line).
    public var waitingLine: String {
        questionEvidence?.questions.first?.text ?? action
    }
}

/// The three kinds of card a pending approval makes (the phone's ApprovalCard).
public enum DispatchApprovalCard: Sendable, Hashable {
    /// `[ Deny ]` `[ Allow ]` on an action; `details` is the evidence (tool input), shown folded.
    case approve(action: String, details: String?)
    /// One or more questions: options (one or several) and/or a typed answer; a `secret` one wants a ciphertext.
    case questions(DispatchQuestionEvidence)
    /// A question whose evidence does not parse: shown, answered elsewhere (the web console).
    case unsupportedQuestion(String)

    /// `Approval` / `Question`: the card's title bar (mac-window.html `[!] Approval`, `? Question`).
    public var title: String {
        if case .approve = self { return "Approval" }
        return "Question"
    }
}

/// core/questions.ts QuestionEvidence.
public struct DispatchQuestionEvidence: Codable, Sendable, Hashable {
    public let source: String
    public let questions: [DispatchQuestion]

    public init(source: String, questions: [DispatchQuestion]) {
        self.source = source
        self.questions = questions
    }

    /// One question, one choice, nothing typed or secret: its options can answer it straight from the card as buttons
    /// (mac-window.html `[ Keep ] [ Delete ]`); nil when the form is needed.
    public var oneTapOptions: [String]? {
        guard questions.count == 1, let q = questions.first, !q.multi, !q.secret, !q.options.isEmpty else { return nil }
        return q.options.map(\.label)
    }
}

/// core/questions.ts UserQuestion, with the schema's defaults applied.
public struct DispatchQuestion: Codable, Sendable, Hashable, Identifiable {
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
    /// The harness flagged the answer as sensitive: the Mac seals what is typed (or a ciphertext is given).
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

    /// The typed answer's placeholder: an answer, or another one beside the options.
    public var placeholder: String {
        if secret { return "直接输入，由 Mac 加密" }
        return options.isEmpty ? "回答" : "其他回答（可选）"
    }
}

/// Answers keyed by question id, checked like core/questions.ts validateAnswers before they are sent.
public enum DispatchAnswerCheck {
    /// Each answer's limit, in UTF-16 units as the daemon counts (DispatchLimits).
    public static let maxLength = DispatchLimits.answer

    public static func problem(questions: [DispatchQuestion], answers: [String: [String]]) -> String? {
        for q in questions {
            let values = (answers[q.id] ?? []).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
            if values.isEmpty { return "未回答：\(q.text)" }
            if !q.multi && values.count > 1 { return "仅可选择一项：\(q.text)" }
            if values.contains(where: { DispatchLimits.length($0) > maxLength }) { return "回答过长（最多 \(maxLength) 个字符）" }
        }
        let extra = Set(answers.keys).subtracting(questions.map(\.id))
        return extra.isEmpty ? nil : "无对应问题的回答：\(extra.sorted().joined(separator: ", "))"
    }

    /// Drops blanks and trims, so what is sent is what was checked.
    public static func cleaned(_ answers: [String: [String]]) -> [String: [String]] {
        answers.mapValues { $0.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty } }
    }
}

/// The state of one question card's form (the phone's QuestionForm): options picked and text typed per question. A
/// value: every change returns a new form.
public struct DispatchQuestionForm: Sendable, Hashable {
    public let chosen: [String: Set<String>]
    public let typed: [String: String]

    public init(chosen: [String: Set<String>] = [:], typed: [String: String] = [:]) {
        self.chosen = chosen
        self.typed = typed
    }

    public func isChosen(_ question: DispatchQuestion, _ label: String) -> Bool { chosen[question.id]?.contains(label) == true }

    /// One of several: `< >` / `<x>`; several: `[ ]` / `[x]` (docs/ui-v0.md §7.2.6).
    public func mark(_ question: DispatchQuestion, _ label: String) -> String {
        let on = isChosen(question, label)
        return question.multi ? (on ? "[x]" : "[ ]") : (on ? "<x>" : "< >")
    }

    /// Picks or unpicks an option: one question takes one option unless `multi`.
    public func toggling(_ question: DispatchQuestion, _ label: String) -> DispatchQuestionForm {
        var set = chosen[question.id] ?? []
        if set.contains(label) { set.remove(label) } else if question.multi { set.insert(label) } else { set = [label] }
        var next = chosen
        next[question.id] = set
        return DispatchQuestionForm(chosen: next, typed: typed)
    }

    public func typing(_ question: DispatchQuestion, _ text: String) -> DispatchQuestionForm {
        var next = typed
        next[question.id] = text
        return DispatchQuestionForm(chosen: chosen, typed: next)
    }

    /// What is sent: the options picked (in their order) and the typed text, cleaned.
    public func answers(for evidence: DispatchQuestionEvidence) -> [String: [String]] {
        var out: [String: [String]] = [:]
        for q in evidence.questions {
            let picked = q.options.map(\.label).filter { isChosen(q, $0) }
            let text = typed[q.id] ?? ""
            out[q.id] = picked + (text.isEmpty ? [] : [text])
        }
        return DispatchAnswerCheck.cleaned(out)
    }

    /// Why the form cannot be sent yet, or nil.
    public func problem(for evidence: DispatchQuestionEvidence) -> String? {
        DispatchAnswerCheck.problem(questions: evidence.questions, answers: answers(for: evidence))
    }
}

/// A decision or an answer the Mac no longer takes (api/tasks.ts: 404 "no pending approval / question with that id",
/// or 409): the request is not pending any more — decided or answered elsewhere (the phone, the web console), expired,
/// or its task ended. Said in the page's words instead of the daemon's; the lists are then read again.
public enum DispatchApprovalRefusal {
    public static let handledElsewhere = "该请求已在别处处理。"

    public static func isHandledElsewhere(_ error: Error) -> Bool {
        guard case DaemonError.http(let status, _) = error else { return false }
        return status == 404 || status == 409
    }
}

import AgentSwitchKit
import SwiftUI

/// One pending approval (allow / deny) or question (answer form).
struct ApprovalCard: View {
    let approval: Approval
    let onDecide: (ApprovalDecision) async -> Void
    let onAnswer: ([String: [String]]) async -> Void
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.m) {
            if let evidence = approval.questionEvidence {
                QuestionForm(evidence: evidence, busy: busy) { answers in await run { await onAnswer(answers) } }
            } else if approval.kind == .question {
                Heading(text: "等你回答")
                Text(approval.action)
                Text("此问题的格式暂不支持在 iPhone 上回答，请在 Mac 上回答。").font(.footnote).foregroundStyle(.secondary)
            } else {
                Heading(text: "等你批准")
                Text(approval.action).font(.callout.monospaced()).textSelection(.enabled)
                if !approval.evidence.isEmpty {
                    DisclosureGroup("详情") {
                        Text(approval.evidence).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                    .font(.footnote)
                }
                HStack(spacing: Theme.Space.m) {
                    Button(role: .destructive) { Task { await run { await onDecide(.deny) } } } label: {
                        Text("拒绝").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    Button { Task { await run { await onDecide(.allow) } } } label: {
                        Text("允许").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent).tint(Theme.fill)
                }
                .disabled(busy)
            }
        }
    }

    private func run(_ body: () async -> Void) async {
        busy = true
        await body()
        busy = false
    }
}

/// The questions of one card: pick options (one, or several when `multi`) and/or type an answer. A `secret` question
/// is answered with a ciphertext picked from the saved list, never plaintext.
struct QuestionForm: View {
    let evidence: QuestionEvidence
    let busy: Bool
    let onSubmit: ([String: [String]]) async -> Void
    @Environment(AppModel.self) private var model
    @State private var chosen: [String: Set<String>] = [:]
    @State private var typed: [String: String] = [:]
    @State private var pickingFor: String?
    @State private var problem: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.m) {
            Heading(text: "等你回答")
            ForEach(evidence.questions) { q in question(q) }
            if let problem { Text(problem).font(.footnote).foregroundStyle(Theme.failed) }
            Button {
                Task { await submit() }
            } label: {
                Text(busy ? "提交中" : "提交").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent).tint(Theme.fill)
            .disabled(busy)
        }
        .sheet(item: Binding(get: { pickingFor.map(QuestionID.init) }, set: { pickingFor = $0?.id })) { target in
            CiphertextPicker { token in typed[target.id] = token }
        }
    }

    @ViewBuilder
    private func question(_ q: UserQuestion) -> some View {
        VStack(alignment: .leading, spacing: Theme.Space.s) {
            Text(Markdown.inline(q.text)).font(.body)
            ForEach(q.options, id: \.label) { option in
                Button { toggle(q, option.label) } label: {
                    HStack(alignment: .top) {
                        Image(systemName: isChosen(q, option.label) ? (q.multi ? "checkmark.square.fill" : "largecircle.fill.circle") : (q.multi ? "square" : "circle"))
                        VStack(alignment: .leading) {
                            Text(option.label)
                            if !option.description.isEmpty { Text(option.description).font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                }
                .buttonStyle(.plain)
            }
            if q.secret {
                // Typed as is: the Mac seals the answer before anything stores it (router-v0 §9); a saved ciphertext works too.
                SecureField("直接输入，由 Mac 加密", text: Binding(get: { typed[q.id] ?? "" }, set: { typed[q.id] = $0 }))
                    .answerField()
                if !model.ciphertexts.isEmpty {
                    Button("使用已存密文", systemImage: "lock.doc") { pickingFor = q.id }.font(.footnote)
                }
            } else {
                TextField(q.options.isEmpty ? "回答" : "其他回答（可选）", text: Binding(get: { typed[q.id] ?? "" }, set: { typed[q.id] = $0 }), axis: .vertical)
                    .answerField()
            }
        }
    }

    private func isChosen(_ q: UserQuestion, _ label: String) -> Bool { chosen[q.id]?.contains(label) == true }

    private func toggle(_ q: UserQuestion, _ label: String) {
        var set = chosen[q.id] ?? []
        if set.contains(label) { set.remove(label) } else if q.multi { set.insert(label) } else { set = [label] }
        chosen[q.id] = set
    }

    private func submit() async {
        var answers: [String: [String]] = [:]
        for q in evidence.questions {
            let picked = q.options.map(\.label).filter { isChosen(q, $0) }
            let text = typed[q.id] ?? ""
            answers[q.id] = picked + (text.isEmpty ? [] : [text])
        }
        let cleaned = AnswerCheck.cleaned(answers)
        if let issue = AnswerCheck.problem(questions: evidence.questions, answers: cleaned) {
            problem = issue
            return
        }
        problem = nil
        await onSubmit(cleaned)
    }
}

private struct QuestionID: Identifiable {
    let id: String
}

/// "等你回答" / "等你批准": the one line in the waiting colour.
private struct Heading: View {
    let text: String
    var body: some View {
        Text(text).font(.footnote.weight(.semibold)).foregroundStyle(Theme.waiting)
    }
}

private extension View {
    /// An answer box on the card's grey: a lighter field, not the system's bordered look.
    func answerField() -> some View {
        self.padding(.horizontal, 12).padding(.vertical, 10)
            .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .autocorrectionDisabled()
            .textInputAutocapitalization(.never)
    }
}

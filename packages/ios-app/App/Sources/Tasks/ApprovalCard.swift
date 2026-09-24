import AgentSwitchKit
import SwiftUI

/// One pending approval (allow / deny) or question (answer form).
struct ApprovalCard: View {
    let approval: Approval
    let onDecide: (ApprovalDecision) async -> Void
    let onAnswer: ([String: [String]]) async -> Void
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let evidence = approval.questionEvidence {
                QuestionForm(evidence: evidence, busy: busy) { answers in await run { await onAnswer(answers) } }
            } else if approval.kind == .question {
                Text(approval.action)
                Text("这个问题的格式 App 还不认识，请在 Mac 上回答。").font(.footnote).foregroundStyle(.secondary)
            } else {
                Label(approval.action, systemImage: "exclamationmark.shield").font(.headline)
                if !approval.evidence.isEmpty {
                    DisclosureGroup("详情") {
                        Text(approval.evidence).font(.caption.monospaced()).textSelection(.enabled)
                    }
                }
                HStack {
                    Button(role: .destructive) { Task { await run { await onDecide(.deny) } } } label: {
                        Label("拒绝", systemImage: "xmark").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    Button { Task { await run { await onDecide(.allow) } } } label: {
                        Label("允许", systemImage: "checkmark").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                }
                .disabled(busy)
            }
            Text(approval.created.relative).font(.caption2).foregroundStyle(.tertiary)
        }
        .padding(.vertical, 4)
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
        VStack(alignment: .leading, spacing: 12) {
            Text(evidence.source == "executor" ? "执行者问你" : "路由器问你").font(.caption).foregroundStyle(.secondary)
            ForEach(evidence.questions) { q in question(q) }
            if let problem { Text(problem).font(.footnote).foregroundStyle(.red) }
            Button {
                Task { await submit() }
            } label: {
                Text(busy ? "提交中…" : "提交回答").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(busy)
        }
        .sheet(item: Binding(get: { pickingFor.map(QuestionID.init) }, set: { pickingFor = $0?.id })) { target in
            CiphertextPicker { token in typed[target.id] = token }
        }
    }

    @ViewBuilder
    private func question(_ q: UserQuestion) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if !q.header.isEmpty { Text(q.header).font(.caption.bold()).foregroundStyle(.secondary) }
            Text(Markdown.inline(q.text))
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
                HStack {
                    Text(typed[q.id].flatMap { $0.isEmpty ? nil : "已选密文" } ?? "敏感信息：请用密文回答")
                        .font(.footnote).foregroundStyle(.orange)
                    Spacer()
                    Button("选择密文") { pickingFor = q.id }.buttonStyle(.bordered).disabled(model.ciphertexts.isEmpty)
                }
            } else {
                TextField(q.options.isEmpty ? "你的回答" : "其他回答（可选）", text: Binding(get: { typed[q.id] ?? "" }, set: { typed[q.id] = $0 }), axis: .vertical)
                    .textFieldStyle(.roundedBorder)
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

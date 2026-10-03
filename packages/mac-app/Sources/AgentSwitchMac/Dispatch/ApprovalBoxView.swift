import AgentSwitchMacCore
import SwiftUI

/// An approval or question inside its task's card or page (docs/dispatch-v0.md §2, demo `.box.ask` / `.box.q`): a
/// floating box with an amber head while it waits for you. An approval shows what it runs and where, `[ Deny ⌘⌫ ]`
/// `[ Allow ⌘↩ ]`; a question with one choice is answered by its option buttons, any other by the full form (`< >` one of
/// several, `[ ]` several, a typed answer, a secure field for a secret — the Mac seals it). It glitches once when it
/// arrives after the page loaded. `keys`: this box takes ⌘↩ / ⌘⌫ (one box at a time, never while the input is typed in).
struct ApprovalBoxView: View {
    let approval: DispatchApproval
    let task: DispatchTask?
    /// The step the task is on, for the hint.
    var step: Int?
    let model: DispatchModel
    var keys = false
    /// Shows `⌘⌫` / `⌘↩` (the box the keys belong to, also while the input has them).
    var hints = false
    @State private var form = DispatchQuestionForm()
    @State private var problem: String?

    var body: some View {
        Group {
            switch approval.card {
            case .approve: approve
            case .questions(let evidence): questions(evidence)
            case .unsupportedQuestion(let text): unsupported(text)
            }
        }
        .glitch(on: approval.id, onAppear: { model.takeFresh(approval.id) })
    }

    /// A decision or an answer on its way (from this box, or the same request's box on another page).
    private var busy: Bool { model.isBusy(approval) }

    // MARK: allow / deny

    private var approve: some View {
        let text = DispatchApprovalText(approval)
        return FloatingBox(title: "[!] Approval", trailing: text.tool) {
            VStack(alignment: .leading, spacing: 3) {
                Text(text.target)
                    .font(.system(size: 13, design: .monospaced))
                    .foregroundStyle(Look.ink)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                if let folder { Text(folder).font(.system(size: 11.5, design: .monospaced)).foregroundStyle(Look.faint) }
            }
            .padding(EdgeInsets(top: 10, leading: 12, bottom: 4, trailing: 12))
            .frame(maxWidth: .infinity, alignment: .leading)
            .help(approval.evidence)
            footer(hint: [step.map { "第 \($0) 步" }, text.about].compactMap { $0 }.joined(separator: " · ")) {
                Button { decide(.deny) } label: { BracketLabel(word: "Deny", key: hints ? "⌘⌫" : nil) }
                    .buttonStyle(BracketButtonStyle(role: .destructive, size: 12.5))
                    .modifier(Shortcut(key: .delete, on: keys))
                Button { decide(.allow) } label: { BracketLabel(word: "Allow", key: hints ? "⌘↩" : nil) }
                    .buttonStyle(BracketButtonStyle(role: .primary, size: 12.5))
                    .modifier(Shortcut(key: .return, on: keys))
            }
        }
    }

    /// The task's folder, where the command runs (not for a throw-away one).
    private var folder: String? {
        guard let task, !task.ephemeral, let cwd = task.cwd, !cwd.isEmpty else { return nil }
        return DisplayPath.short(cwd, home: NSHomeDirectory())
    }

    private func decide(_ decision: DispatchApprovalDecision) {
        guard !busy else { return }
        Task { await model.decide(approval, decision) }
    }

    // MARK: questions

    private func questions(_ evidence: DispatchQuestionEvidence) -> some View {
        let quick = evidence.oneTapOptions
        return FloatingBox(title: "? Question", trailing: asker(evidence)) {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(evidence.questions) { question in
                    VStack(alignment: .leading, spacing: 8) {
                        if evidence.questions.count > 1 && !question.header.isEmpty { PartLabel(question.header) }
                        Text(DispatchMarkdown.inline(question.text))
                            .font(.system(size: 14)).lineSpacing(5).foregroundStyle(Look.ink)
                            .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                        if quick == nil { answerForm(question) }
                    }
                }
                if let problem { Text(problem).font(.system(size: 12)).foregroundStyle(Color.failed) }
            }
            .padding(EdgeInsets(top: 10, leading: 12, bottom: 4, trailing: 12))
            .frame(maxWidth: .infinity, alignment: .leading)
            footer(hint: "回答后任务继续") {
                if let quick {
                    ForEach(Array(quick.enumerated()), id: \.offset) { index, label in
                        Button { submit([evidence.questions[0].id: [label]]) } label: { BracketLabel(word: label) }
                            .buttonStyle(BracketButtonStyle(role: index == quick.count - 1 ? .primary : .normal, size: 12.5))
                    }
                } else {
                    Button { submitForm(evidence) } label: { BracketLabel(word: busy ? "Sending" : "Submit", key: hints ? "⌘↩" : nil) }
                        .buttonStyle(BracketButtonStyle(role: .primary, size: 12.5))
                        .modifier(Shortcut(key: .return, on: keys))
                }
            }
        }
    }

    /// Who asks: the executor (by its name) or the dispatch model.
    private func asker(_ evidence: DispatchQuestionEvidence) -> String {
        guard evidence.source == "executor" else { return "Dispatch" }
        return task?.harness.map(HarnessName.display) ?? "Executor"
    }

    @ViewBuilder
    private func answerForm(_ question: DispatchQuestion) -> some View {
        ForEach(question.options, id: \.label) { option in
            Button { form = form.toggling(question, option.label) } label: {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(form.mark(question, option.label)).mono(13)
                        .foregroundStyle(form.isChosen(question, option.label) ? Color.signal : Look.ink2)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(option.label).font(.system(size: 13.5)).foregroundStyle(Look.ink)
                        if !option.description.isEmpty {
                            Text(option.description).font(.system(size: 12)).foregroundStyle(Look.ink2)
                        }
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        let typed = Binding(get: { form.typed[question.id] ?? "" }, set: { form = form.typing(question, $0) })
        Group {
            if question.secret {
                SecureField("", text: typed, prompt: Text(question.placeholder))
            } else {
                TextField("", text: typed, prompt: Text(question.placeholder), axis: .vertical).lineLimit(1...4)
            }
        }
        .textFieldStyle(.plain)
        .font(.system(size: 13.5))
        .autocorrectionDisabled()
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .overlay(Rectangle().strokeBorder(Look.line, lineWidth: 1))
    }

    private func submitForm(_ evidence: DispatchQuestionEvidence) {
        if let issue = form.problem(for: evidence) {
            problem = issue
            return
        }
        problem = nil
        submit(form.answers(for: evidence))
    }

    private func submit(_ answers: [String: [String]]) {
        guard !busy else { return }
        Task { await model.answer(approval, answers) }
    }

    private func unsupported(_ text: String) -> some View {
        FloatingBox(title: "? Question", trailing: "Dispatch") {
            VStack(alignment: .leading, spacing: 6) {
                Text(DispatchMessageDisplay.readable(text)).font(.system(size: 14)).foregroundStyle(Look.ink)
                Text("此问题的格式暂不支持在此回答，请在网页控制台回答。").font(.system(size: 12)).foregroundStyle(Look.ink2)
            }
            .padding(EdgeInsets(top: 10, leading: 12, bottom: 12, trailing: 12))
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: the foot

    private func footer<Buttons: View>(hint: String, @ViewBuilder buttons: () -> Buttons) -> some View {
        HStack(spacing: 14) {
            Text(hint).font(.system(size: 12, design: .monospaced)).foregroundStyle(Look.faint).lineLimit(1)
            Spacer(minLength: 8)
            buttons()
        }
        .disabled(busy)
        .padding(EdgeInsets(top: 8, leading: 12, bottom: 10, trailing: 12))
    }
}

/// ⌘ + `key` on the one box that takes the keys.
private struct Shortcut: ViewModifier {
    let key: KeyEquivalent
    let on: Bool

    func body(content: Content) -> some View {
        if on { content.keyboardShortcut(key, modifiers: .command) } else { content }
    }
}

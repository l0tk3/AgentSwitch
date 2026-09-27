import AgentSwitchMacCore
import SwiftUI

/// 权限 (docs/control-v0.md §1): who answers an executor's approvals, via `GET|PUT /approvals/policy`. Changes apply to
/// approvals from then on; nothing restarts. Only this Mac can change it (the phone only reads it).
struct PermissionsView: View {
    @Environment(AppModel.self) private var model

    private var control: ControlSettings { model.control }

    var body: some View {
        Group {
            if !model.daemonReady {
                EmptyPage(title: "服务未就绪", symbol: "hourglass", message: model.daemonLine.text)
            } else if let policy = control.policy {
                form(policy)
            } else if let problem = control.policyLoadProblem {
                EmptyPage(title: "无法读取权限设置", symbol: "exclamationmark.triangle", message: problem) {
                    Button("重试") { Task { await control.loadPolicy(model.client) } }
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { Task { await control.loadPolicy(model.client) } } label: { Label("重新读取", systemImage: "arrow.clockwise") }
                    .help("重新读取")
                    .disabled(!model.daemonReady)
            }
        }
        .task(id: model.daemonReady) {
            if model.daemonReady { await control.loadPolicy(model.client) }
        }
    }

    private func form(_ policy: ApprovalPolicySettings) -> some View {
        Form {
            Section {
                ApprovalModePicker(policy: policy)
            } header: {
                Text("审批")
            } footer: {
                Footer(policy.mode == nil ? "服务报告的模式为 \(policy.rawMode)，当前版本的应用无法识别。" : "更改立即生效，仅影响之后的审批。")
            }
            if policy.mode == .scoped && !policy.categories.isEmpty {
                Section {
                    ForEach(policy.categories) { category in
                        Toggle(category.title, isOn: Binding(
                            get: { policy.human.contains(category.id) },
                            set: { on in Task { await control.savePolicy(mode: .scoped, human: policy.human(setting: category.id, on: on), model.client) } }))
                            .toggleStyle(.checkbox)
                            .disabled(control.savingPolicy)
                    }
                } header: {
                    Text("以下类别仍由你确认")
                } footer: {
                    Footer("未勾选的类别由调度模型代为批准。")
                }
            }
            if policy.mode == .skip {
                Section {
                    ForEach(ApprovalMode.alwaysApplies, id: \.self) { Text($0) }
                } header: {
                    Text("仍然生效")
                } footer: {
                    Footer("此模式仅跳过审批；以上限制在任何模式下均有效。")
                }
            }
            if let problem = control.policySaveProblem {
                Section {
                    Label(problem, systemImage: "xmark.circle.fill").foregroundStyle(.red).textSelection(.enabled)
                }
            }
        }
        .formStyle(.grouped)
    }
}

/// The four modes as a radio group with one line each; 跳过权限 only after a confirmation that says what still holds.
/// Shared by 权限 and the first-run wizard. Saving is immediate.
struct ApprovalModePicker: View {
    @Environment(AppModel.self) private var model
    let policy: ApprovalPolicySettings
    /// Tighter rows (the wizard's sheet).
    var compact = false
    @State private var confirmSkip = false

    var body: some View {
        Picker("审批方式", selection: selection) {
            ForEach(ApprovalMode.allCases) { mode in
                VStack(alignment: .leading, spacing: 2) {
                    Text(mode.title)
                    Text(mode.summary).font(.callout).foregroundStyle(.secondary)
                }
                .padding(.vertical, compact ? 0 : 3)
                .tag(Optional(mode))
            }
        }
        .pickerStyle(.radioGroup)
        .labelsHidden()
        .disabled(model.control.savingPolicy)
        .confirmationDialog("跳过权限？", isPresented: $confirmSkip) {
            Button("跳过权限", role: .destructive) { save(.skip) }
        } message: {
            Text(ApprovalMode.skipWarning)
        }
    }

    private var selection: Binding<ApprovalMode?> {
        Binding(get: { policy.mode }, set: { next in
            guard let next, next != policy.mode else { return }
            if next == .skip { confirmSkip = true } else { save(next) }
        })
    }

    private func save(_ mode: ApprovalMode) {
        Task { await model.control.savePolicy(mode: mode, human: policy.human, model.client) }
    }
}

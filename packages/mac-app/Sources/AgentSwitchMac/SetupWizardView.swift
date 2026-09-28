import AgentSwitchMacCore
import SwiftUI

/// The first-run wizard (docs/control-v0.md §6), a sheet on the settings window: 执行器 → 配对手机 → 权限与启动 → 完成.
/// Every step can be passed without doing it; Esc asks before leaving; progress is saved after each step
/// (SettingsNavigation → SetupWizardStore).
struct SetupWizardView: View {
    @Environment(AppModel.self) private var model
    @Environment(SettingsNavigation.self) private var navigation
    @State private var confirmSkip = false

    static let size = CGSize(width: 640, height: 560)

    private var step: SetupStep { navigation.wizardStep ?? .executors }

    var body: some View {
        VStack(spacing: 0) {
            StepIndicator(current: step)
                .padding(.horizontal, 24)
                .padding(.top, 20)
                .padding(.bottom, 16)
            Divider()
            // The window's banner is behind the sheet: a failed 登录 has to show here.
            ErrorBanner()
            VStack(alignment: .leading, spacing: 4) {
                Text(heading).font(.title2.weight(.semibold))
                Text(intro).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 24)
            .padding(.top, 16)
            content
                // One surface for the whole sheet: the forms' cards sit on the sheet's own background.
                .scrollContentBackground(.hidden)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            Divider()
            buttons
                .padding(.horizontal, 20)
                .padding(.vertical, 14)
        }
        .frame(width: SetupWizardView.size.width, height: SetupWizardView.size.height)
        .tint(.brand)
        .interactiveDismissDisabled()
        .gateServiceSheet(model, active: true)
        .confirmationDialog("跳过引导？", isPresented: $confirmSkip) {
            Button("skip") { navigation.closeWizard(.skipped, at: step) }
        } message: {
            Text("之后可在「general」中重新运行。")
        }
    }

    // MARK: text

    private var heading: String {
        switch step {
        case .executors: return "executors"
        case .pairing: return "pair iPhone"
        case .permissions: return "permissions & launch"
        case .done: return "done"
        }
    }

    private var intro: String {
        switch step {
        case .executors: return "任务由这台 Mac 上的 Claude Code、Codex 或 OpenCode 执行，至少需要一个可用。"
        case .pairing: return "在 iPhone 上打开 AgentSwitch，扫描此二维码。"
        case .permissions: return "选择执行器进行有风险的操作时由谁批准。推荐「auto」，之后可在「permissions」中更改。"
        case .done: return "在 iPhone 上打开 AgentSwitch 并发送任务。"
        }
    }

    // MARK: steps

    @ViewBuilder
    private var content: some View {
        switch step {
        case .executors: ExecutorsStep()
        case .pairing: PairingStep()
        case .permissions: PermissionsStep()
        case .done: DoneStep()
        }
    }

    /// Whether the step's goal is met; if not, the forward button says 跳过此步.
    private var stepMet: Bool {
        switch step {
        case .executors: return model.harnesses.contains { $0.state == .ready }
        case .pairing: return !model.activeDevices.isEmpty
        case .permissions, .done: return true
        }
    }

    // MARK: buttons

    private var buttons: some View {
        HStack(spacing: 8) {
            if step != .done {
                Button("skip guide") { confirmSkip = true }
                    .keyboardShortcut(.cancelAction)
            }
            Spacer()
            if step.previous != nil {
                Button("back") { navigation.backWizard(from: step) }
            }
            forward
        }
    }

    @ViewBuilder
    private var forward: some View {
        if step == .done {
            Button("done") { navigation.closeWizard(.completed, at: step) }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
        } else if stepMet {
            Button("continue") { navigation.advanceWizard(from: step) }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
        } else {
            Button("skip step") { navigation.advanceWizard(from: step) }
                .keyboardShortcut(.defaultAction)
        }
    }
}

/// `(1) 执行器 ── (2) 配对手机 ── (3) 权限与启动 ── (4) 完成`: the current step filled with the accent, passed ones ticked.
private struct StepIndicator: View {
    let current: SetupStep

    var body: some View {
        HStack(spacing: 10) {
            ForEach(SetupStep.allCases) { step in
                if step.previous != nil {
                    Capsule().fill(Color.primary.opacity(0.12)).frame(height: 1).frame(minWidth: 12, maxWidth: .infinity)
                }
                HStack(spacing: 6) {
                    marker(step)
                    Text(step.title)
                        .font(.callout.weight(step == current ? .semibold : .regular))
                        .foregroundStyle(step == current ? .primary : .secondary)
                }
                .fixedSize()
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("第 \(current.rawValue + 1) 步，共 \(SetupStep.allCases.count) 步：\(current.title)")
    }

    @ViewBuilder
    private func marker(_ step: SetupStep) -> some View {
        ZStack {
            // square cells on the grid (docs/ui-v0.md §7): the current step in the signal, done ones hollow with ✓
            if step == current {
                Rectangle().fill(Color.signal)
                Text("\(step.rawValue + 1)").mono(11, weight: .bold).foregroundStyle(.black)
            } else {
                Rectangle().strokeBorder(Color.secondary.opacity(0.5), lineWidth: 1)
                Text(step.rawValue < current.rawValue ? "✓" : "\(step.rawValue + 1)").mono(11).foregroundStyle(.secondary)
            }
        }
        .frame(width: 20, height: 20)
    }
}

// MARK: - 1 执行器

private struct ExecutorsStep: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Form {
            Section {
                ForEach(SetupChecklist.harnessItems(model.harnesses)) { SetupItemRow(item: $0) }
            } footer: {
                HStack(alignment: .top, spacing: 8) {
                    Footer("登录在“终端”中完成，返回此窗口后自动重新检测。")
                    Button("check again") { model.detectEnvironment() }.disabled(model.detecting)
                }
            }
        }
        .formStyle(.grouped)
    }
}

// MARK: - 2 配对手机

private struct PairingStep: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if !model.remoteEnabled {
            EmptyPage(title: "iPhone off", symbol: "iphone.slash", message: "配对和使用 iPhone 需要打开此连接。") {
                Button("turn on") { model.setRemoteAccess(true) }
            }
        } else if !model.daemonReady {
            EmptyPage(title: "service not ready", symbol: "hourglass", message: model.daemonLine.text)
        } else {
            Form {
                Section {
                    PairingCodeView(returnGenerates: false)
                } footer: {
                    Footer("配对码 5 分钟内有效，仅可使用一次。")
                }
                if !model.activeDevices.isEmpty {
                    Section {
                        Label("paired · \(model.activeDevices.map(\.name).joined(separator: ", "))", systemImage: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                    }
                }
                if let problem = model.pairingSession.problem {
                    Section {
                        Label(problem, systemImage: "exclamationmark.triangle.fill").foregroundStyle(Color.attention).textSelection(.enabled)
                    }
                }
            }
            .formStyle(.grouped)
            // A code right away when no phone is paired yet: the user came here to scan one.
            .task {
                let session = model.pairingSession
                if model.activeDevices.isEmpty && session.pairing == nil && !session.busy { await session.start(model: model) }
            }
        }
    }
}

// MARK: - 3 权限与启动

private struct PermissionsStep: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Form {
            Section {
                if let policy = model.control.policy {
                    ApprovalModePicker(policy: policy, compact: true)
                } else if !model.daemonReady {
                    Text("服务未就绪。之后可在「permissions」中选择。").foregroundStyle(.secondary)
                } else if let problem = model.control.policyLoadProblem {
                    Text(problem).foregroundStyle(.secondary)
                } else {
                    ProgressView().controlSize(.small)
                }
                if let problem = model.control.policySaveProblem {
                    Text(problem).foregroundStyle(.red)
                }
            }
            Section {
                LoginItemRows()
            } footer: {
                Footer("打开后，AgentSwitch 在登录时自动运行，iPhone 可随时连接这台 Mac。")
            }
            if let item = model.setupItems.first(where: { $0.id == SetupChecklist.gateServiceID }) {
                // The row says why; the confirmation sheet says what happens.
                Section { SetupItemRow(item: item) }
            }
        }
        .formStyle(.grouped)
        .task(id: model.daemonReady) {
            if model.daemonReady { await model.control.loadPolicy(model.client) }
        }
    }
}

// MARK: - 4 完成

private struct DoneStep: View {
    @Environment(AppModel.self) private var model
    @Environment(SettingsNavigation.self) private var navigation

    static let examples = ["看看 ~/Projects/blog 为什么构建失败", "把这周的提交整理成更新说明", "给 README 补上安装步骤"]

    var body: some View {
        Form {
            Section {
                ForEach(DoneStep.examples, id: \.self) { example in
                    Text("“\(example)”")
                }
            } header: {
                SectionLabel("examples")
            } footer: {
                Footer("需要你批准或回答时，iPhone 上会显示卡片。")
            }
            if model.setupUnmet > 0 {
                Section {
                    HStack(spacing: 8) {
                        StatusDot(level: .warning)
                        Text("setup: \(model.setupUnmet) left")
                        Spacer(minLength: 8)
                        Button("view") {
                            navigation.closeWizard(.completed, at: .done)
                            navigation.tab = .environment
                        }
                    }
                } footer: {
                    Footer("可在「environment」中继续完成。")
                }
            }
        }
        .formStyle(.grouped)
    }
}

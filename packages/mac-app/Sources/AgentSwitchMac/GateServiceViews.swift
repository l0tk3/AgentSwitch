import AgentSwitchMacCore
import SwiftUI

extension View {
    /// The gate service's confirmation sheet from `model.gateServiceRequest`. `active` lets only one presenter show it
    /// (the settings window, or the first-run wizard while that sheet is up).
    func gateServiceSheet(_ model: AppModel, active: Bool) -> some View {
        sheet(item: Binding(get: { active ? model.gateServiceRequest : nil },
                            set: { if $0 == nil { model.dismissGateServiceRequest() } })) { request in
            GateServiceSheet(request: request).environment(model)
        }
    }
}

/// 安装 · 更新 · 修复 · 改端口 · 卸载 (docs/gate-service-v0.md §4): what will happen in a few lines, then one administrator
/// prompt, then the outcome with the command's output. A cancelled prompt returns here quietly.
struct GateServiceSheet: View {
    @Environment(AppModel.self) private var model
    let request: GateServiceRequest
    @State private var deleteKeys: Bool
    @State private var confirmDelete = false

    static let width: CGFloat = 480

    /// `deleteKeys`: the checkbox's first state (the design preview shows it ticked).
    init(request: GateServiceRequest, deleteKeys: Bool = false) {
        self.request = request
        _deleteKeys = State(initialValue: deleteKeys)
    }

    private var operation: GateServiceOperation { request.operation }
    private var running: Bool { model.gateServiceOperation == effectiveOperation }
    private var result: AdminOutcome? {
        guard let r = model.gateServiceResult, r.operation == effectiveOperation else { return nil }
        return r.outcome
    }
    /// Uninstall carries the checkbox's choice.
    private var effectiveOperation: GateServiceOperation {
        if case .uninstall = operation { return .uninstall(deleteKeys: deleteKeys) }
        return operation
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            // A question until it is confirmed, then the operation's name over its progress and outcome.
            Text(running || (result != nil && result != .cancelled) ? String(title.dropLast()) : title).font(.headline)
            if running {
                progress
            } else if let result, result != .cancelled {
                outcome(result)
            } else {
                confirmation
            }
            buttons
        }
        .padding(20)
        .frame(width: GateServiceSheet.width, alignment: .leading)
        .tint(.brand)
        .interactiveDismissDisabled(running)
        .confirmationDialog("删除全部密钥？", isPresented: $confirmDelete) {
            Button("删除密钥并卸载", role: .destructive) { start() }
        } message: {
            Text("用这些密钥加密的密文将全部无法解密，此操作无法撤销。")
        }
    }

    // MARK: text

    private var title: String {
        switch operation {
        case .install: return "安装凭据网关服务？"
        case .update: return "更新凭据网关服务？"
        case .repair: return "修复凭据网关服务？"
        case .changePort: return "更改凭据网关端口？"
        case .uninstall: return "卸载凭据网关服务？"
        }
    }

    private var lines: [String] {
        switch operation {
        case .install:
            return ["新建系统账户 \(GateServicePaths.account)。该账户无法登录，凭据网关以该账户运行。",
                    "已有密钥移入该账户，当前用户无法再读取；用已有密钥生成的密文仍可解密。",
                    "新建密钥对 main 并设为当前，iPhone 与调度模型之后使用该密钥加密。",
                    "网关证书重新生成。旧证书如已加入登录钥匙串，需重新信任新证书。"]
        case .update:
            return ["以 App 内置的凭据网关程序替换已安装的程序，并重启服务。", "密钥和数据保持不变。"]
        case .repair:
            return ["凭据网关服务无响应。以 App 内置的程序重新安装，并重启服务。", "密钥和数据保持不变。"]
        case .changePort(let port):
            return ["凭据网关服务改用端口 \(port)，并重启服务。", "AgentSwitch 服务随后重启，进行中的任务将中断。"]
        case .uninstall:
            return ["停止并删除凭据网关的系统服务和程序。",
                    "密钥和数据默认保留在 \(model.paths.gateService.privateDir.path)，系统账户保留。",
                    "卸载后，AgentSwitch 以当前用户身份运行凭据网关并新建密钥对；用服务中的密钥生成的密文在重新安装前无法解密。"]
        }
    }

    private var footnote: String {
        switch operation {
        case .install: return "安装期间服务暂停。macOS 将要求输入管理员密码。"
        case .update, .repair: return "更新期间凭据网关暂停，进行中的请求可能失败。macOS 将要求输入管理员密码。"
        case .changePort, .uninstall: return "macOS 将要求输入管理员密码。"
        }
    }

    private var confirmTitle: String {
        switch operation {
        case .install: return "安装"
        case .update: return "更新"
        case .repair: return "修复"
        case .changePort: return "更改"
        case .uninstall: return "卸载"
        }
    }

    // MARK: phases

    private var confirmation: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(lines, id: \.self) { line in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("•").foregroundStyle(.secondary)
                        Text(line).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            if case .update = operation, let installed = model.gateService.runtimeVersion {
                VStack(alignment: .leading, spacing: 2) {
                    Text("已安装：\(GateVersionText.label(installed))")
                    Text("App 内置：\(model.bundledGateVersion.map(GateVersionText.label) ?? "未知")")
                }
                .font(.caption).foregroundStyle(.secondary).monospacedDigit()
            }
            if case .uninstall = operation {
                Toggle("同时删除密钥", isOn: $deleteKeys)
                if deleteKeys {
                    Label("密钥删除后无法恢复，用这些密钥加密的所有密文将永久无法解密。", systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Text(footnote).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if model.gateServiceResult?.outcome == .cancelled {
                Text("已取消").font(.callout).foregroundStyle(.secondary)
            }
        }
    }

    private var progress: some View {
        HStack(alignment: .top, spacing: 10) {
            ProgressView().controlSize(.small)
            VStack(alignment: .leading, spacing: 4) {
                Text(operation.progressText)
                Text("请在 macOS 的授权窗口中输入管理员密码。完成前请勿退出 AgentSwitch。")
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func outcome(_ outcome: AdminOutcome) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            switch outcome {
            case .succeeded(let output):
                Label {
                    Text(effectiveOperation.doneText)
                } icon: {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                }
                OutputBox(text: output)
            case .failed(let reason, let output):
                Label("\(effectiveOperation.failedText)：\(reason)", systemImage: "xmark.octagon.fill")
                    .foregroundStyle(.red).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                OutputBox(text: output)
            case .cancelled:
                EmptyView()
            }
        }
    }

    // MARK: buttons

    @ViewBuilder
    private var buttons: some View {
        HStack {
            Spacer()
            if running {
                EmptyView()   // nothing to press until macOS and the command are done
            } else if let result, result != .cancelled {
                Button(result.succeeded ? "完成" : "关闭") { model.dismissGateServiceRequest() }
                    .keyboardShortcut(.defaultAction)
            } else {
                Button("取消") { model.dismissGateServiceRequest() }.keyboardShortcut(.cancelAction)
                if case .uninstall = operation {
                    Button(deleteKeys ? "卸载并删除密钥" : confirmTitle, role: .destructive) {
                        if deleteKeys { confirmDelete = true } else { start() }
                    }
                    .keyboardShortcut(.defaultAction)
                } else {
                    Button(confirmTitle) { start() }
                        .buttonStyle(.borderedProminent)
                        .keyboardShortcut(.defaultAction)
                }
            }
        }
    }

    private func start() {
        let next = GateServiceRequest(operation: effectiveOperation, ports: request.ports)
        Task { await model.runGateService(next) }
    }
}

/// The command's own lines, monospaced and selectable; nothing when it printed nothing.
private struct OutputBox: View {
    let text: String

    var body: some View {
        if !text.isEmpty {
            ScrollView {
                Text(text)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
            }
            .frame(maxHeight: 160)
            .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 6))
        }
    }
}

/// 通用 › gate.log in service mode: the service's logs through `logs tail` (its log files belong to the service account).
struct GateLogSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var name: GateLogName = .proxy
    @State private var text = ""
    @State private var problem: String?
    @State private var loading = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("凭据网关日志").font(.headline)
                Spacer()
                Picker("日志", selection: $name) {
                    ForEach(GateLogName.allCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
            }
            ScrollView {
                Text(problem ?? (text.isEmpty ? (loading ? "读取中" : "无日志") : text))
                    .font(.caption.monospaced())
                    .foregroundStyle(problem == nil ? .primary : .secondary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
            }
            .frame(minHeight: 280)
            .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 6))
            Text("最近 300 行，由凭据网关服务提供。").font(.callout).foregroundStyle(.secondary)
            HStack {
                Spacer()
                Button("刷新") { Task { await load() } }.disabled(loading)
                Button("关闭") { dismiss() }.keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 640)
        .tint(.brand)
        .task(id: name) { await load() }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            text = try await model.gateLog(name)
            problem = nil
        } catch {
            problem = "无法读取日志：\(error.localizedDescription)"
        }
    }
}

/// 环境 › 凭据网关服务: state, account, program version, and the three operations.
struct GateServiceSection: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let facts = model.gateServiceFacts
        let state = facts.state
        Section {
            // The full line is under 服务与网络 › 凭据网关.
            StatusRow(label: "状态", line: GateServiceText.short(facts))
            if state.isInstalled {
                LabeledContent("运行账户", value: GateServicePaths.account)
                LabeledContent("程序版本") {
                    HStack(spacing: 6) {
                        if facts.updateAvailable { StatusDot(level: .warning) }
                        Text(state.runtimeVersion.map(GateVersionText.label) ?? "未知").foregroundStyle(.secondary).monospacedDigit()
                    }
                    .help(facts.updateAvailable ? "App 内置：\(model.bundledGateVersion ?? "未知")" : (state.runtimeVersion ?? ""))
                }
            }
            if let problem = state.problem {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    StatusDot(level: .warning)
                    Text(problem).foregroundStyle(.secondary).textSelection(.enabled)
                }
            }
            if state.availability != .unsupported {
                LabeledContent("操作") { actions(facts) }
            }
        } header: {
            Text("凭据网关服务")
        } footer: {
            Footer(footer(state))
        }
    }

    @ViewBuilder
    private func actions(_ facts: GateServiceFacts) -> some View {
        let busy = facts.operation != nil
        HStack(spacing: 8) {
            if busy { ProgressView().controlSize(.small) }
            if facts.state.isInstalled {
                if facts.health == .notResponding {
                    Button("修复…") { model.requestGateService(.repair) }.disabled(busy)
                } else if facts.updateAvailable {
                    Button("更新…") { model.requestGateService(.update) }.disabled(busy)
                }
                Button("卸载…") { model.requestGateService(.uninstall(deleteKeys: false)) }.disabled(busy)
            } else {
                Button("安装…") { model.requestGateService(.install) }.disabled(busy || facts.state.availability == .unknown)
            }
        }
    }

    private func footer(_ state: GateServiceState) -> String {
        switch state.availability {
        case .installed:
            return "私钥由系统账户 \(GateServicePaths.account) 保管，当前用户无法读取。服务随系统启动，不依赖 AgentSwitch 运行。"
        case .unsupported:
            return "App 内置的 secret-gate 版本较旧，不支持系统服务。凭据网关由 AgentSwitch 以当前用户身份运行。"
        case .notInstalled, .unknown:
            return "凭据网关目前以当前用户身份运行，私钥位于 \(model.shortPath(model.paths.gateHome))，当前用户的程序均可读取。安装为系统服务后，私钥由独立账户保管。"
        }
    }
}

/// A gate program version, `<secret-gate>+<built>`: 0.1.0 · 构建于 9月20日 11:41; anything else as it is.
enum GateVersionText {
    static func label(_ version: String) -> String {
        let parts = version.split(separator: "+", maxSplits: 1).map(String.init)
        let built = parts.last ?? version
        guard built.contains("T"), FlexibleDate.parse(built) != nil else { return version }
        let when = "构建于 \(TimeText.build(built))"
        return parts.count == 2 ? "\(parts[0]) · \(when)" : when
    }
}

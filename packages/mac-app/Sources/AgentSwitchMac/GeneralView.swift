import AgentSwitchMacCore
import AppKit
import ServiceManagement
import SwiftUI

/// 通用: iPhone access, the default work dir, ports, login item, the first-run wizard, logs and data folders, runtime
/// versions.
struct GeneralView: View {
    @Environment(AppModel.self) private var model
    @Environment(SettingsNavigation.self) private var navigation
    @State private var local = ""
    @State private var remote = ""
    @State private var gate = ""
    @State private var opencode = ""
    @State private var showingGateLog = false
    @AppStorage(DockPresence.alwaysShowKey) private var alwaysShowInDock = false

    private var draft: PortSettings? {
        guard let l = Int(local), let r = Int(remote), let g = Int(gate), let o = Int(opencode) else { return nil }
        return PortSettings(local: l, remote: r, gate: g, opencode: o)
    }

    var body: some View {
        Form {
            Section {
                Toggle("允许 iPhone 连接", isOn: Binding(get: { model.remoteEnabled }, set: { model.setRemoteAccess($0) }))
            } header: {
                Text("iPhone")
            } footer: {
                Footer("关闭后 iPhone 无法连接或配对，已配对的设备保留。切换时服务将重启。")
            }

            WorkDirSection()

            Section {
                portField("本地接口", $local, help: "供网页控制台和本应用使用")
                portField("远程接口", $remote, help: "供已配对的 iPhone 使用（HTTPS）")
                portField("凭据网关", $gate, help: model.gateMode.isService ? "凭据网关服务的代理端口，更改时需要管理员授权"
                                                                            : "端口上已运行 secret-gate 时直接复用")
                portField("OpenCode 服务", $opencode, help: "服务常驻使用的 OpenCode 实例")
                ForEach(portProblems, id: \.self) { problem in
                    HStack(spacing: 6) {
                        StatusDot(level: .warning)
                        Text(problem).foregroundStyle(.secondary)
                    }
                }
            } header: {
                Text("端口")
            } footer: {
                HStack(alignment: .top, spacing: 8) {
                    Footer("更改远程端口后，局域网内的 iPhone 自动发现新端口；在局域网外使用的 iPhone 需重新扫码。")
                    Button("恢复默认") { fill(.defaults) }
                    Button("保存并重启") { if let draft { save(draft) } }
                        .buttonStyle(.borderedProminent)
                        .disabled(!portProblems.isEmpty || draft == model.ports)
                }
            }

            Section {
                LoginItemRows()
                Toggle("始终在程序坞显示", isOn: $alwaysShowInDock)
                    // This window is open while the toggle is used, so the icon stays until the window closes.
                    .onChange(of: alwaysShowInDock) { _, always in
                        NSApp.setActivationPolicy(DockPresence.showsInDock(alwaysShow: always, settingsWindowOpen: true) ? .regular : .accessory)
                    }
                LabeledContent("首次运行引导") {
                    Button("重新运行") { navigation.openWizard() }
                }
            } header: {
                Text("启动")
            } footer: {
                Footer("关闭时仅显示在菜单栏；打开设置窗口时临时显示在程序坞。")
            }

            Section {
                LabeledContent("日志") {
                    HStack(spacing: 8) {
                        Button("daemon.log") { open(model.paths.daemonLog) }
                        Button("gate.log") {
                            if model.gateMode.isService { showingGateLog = true } else { open(model.paths.gateLog) }
                        }
                        .help(model.gateMode.isService ? "凭据网关服务的日志" : model.shortPath(model.paths.gateLog))
                        Button("打开文件夹") { open(model.paths.logsDir) }
                    }
                }
                LabeledContent("数据") {
                    Button("打开文件夹") { open(model.paths.agentswitchHome) }
                }
            } header: {
                Text("日志与数据")
            } footer: {
                Footer("日志位于 \(model.shortPath(model.paths.logsDir))，数据位于 \(model.shortPath(model.paths.agentswitchHome))。")
                    .textSelection(.enabled)
            }

            Section {
                let versions = model.runtimeVersions
                if versions.isEmpty {
                    Text(RuntimePlan.missingRuntime(model.paths.runtime.missing()) ?? "无版本信息").foregroundStyle(.secondary)
                } else {
                    if let built = versions["built"] {
                        LabeledContent("构建于", value: TimeText.build(built)).help(built)
                    }
                    ForEach(VersionRow.order(versions.keys.filter { $0 != "built" }), id: \.self) { key in
                        LabeledContent(VersionRow.label(key), value: versions[key] ?? "").textSelection(.enabled)
                    }
                }
                if model.options != .standard {
                    HStack(spacing: 6) {
                        StatusDot(level: .warning)
                        Text("开发模式：executors=\(model.options.executors) router=\(model.options.router ?? "默认")").foregroundStyle(.secondary)
                    }
                }
            } header: {
                Text("版本")
            } footer: {
                Footer("内置运行时位于 \(model.shortPath(model.paths.runtime.root))。")
                    .textSelection(.enabled)
            }
        }
        .formStyle(.grouped)
        .onAppear { fill(model.ports) }
        .onChange(of: model.ports) { _, ports in fill(ports) }
        .sheet(isPresented: $showingGateLog) { GateLogSheet().environment(model) }
        .task(id: model.daemonReady) {
            if model.daemonReady { await model.control.loadWorkDir(model.client) }
        }
    }

    private var portProblems: [String] { draft?.problems() ?? ["端口必须是数字"] }

    /// A new gate port in service mode is the service's to change (`system update --port`, administrator prompt); the
    /// other ports are saved with it once that succeeded.
    private func save(_ next: PortSettings) {
        if model.gateMode.isService && next.gate != model.ports.gate {
            model.requestGateService(.changePort(next.gate), ports: next)
        } else {
            model.applyPorts(next)
        }
    }

    private func portField(_ label: String, _ text: Binding<String>, help: String) -> some View {
        TextField(label, text: text).monospacedDigit().help(help)
    }

    private func fill(_ p: PortSettings) {
        local = String(p.local)
        remote = String(p.remote)
        gate = String(p.gate)
        opencode = String(p.opencode)
    }

    private func open(_ url: URL) {
        if FileManager.default.fileExists(atPath: url.path) {
            NSWorkspace.shared.open(url)
        } else {
            model.errorMessage = "\(model.shortPath(url)) 不存在"
        }
    }
}

/// 默认工作目录 (docs/control-v0.md §2): `GET|PUT /settings/workdir`; the daemon checks the folder and says why not.
private struct WorkDirSection: View {
    @Environment(AppModel.self) private var model

    private var control: ControlSettings { model.control }

    var body: some View {
        let settings = control.workDir.settings
        Section {
            LabeledContent("位置") {
                HStack(spacing: 8) {
                    if control.savingWorkDir { ProgressView().controlSize(.small) }
                    Text(location).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle).textSelection(.enabled)
                        .help(settings?.path ?? "")
                    Button("选择…") { model.chooseWorkDir() }.disabled(settings == nil || control.savingWorkDir)
                }
            }
            if let problem = settings?.problem {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    StatusDot(level: .warning)
                    Text(problem).foregroundStyle(.secondary).textSelection(.enabled)
                }
            }
            if let refused = control.workDirSaveProblem {
                Text(refused).foregroundStyle(.red).textSelection(.enabled)
            }
        } header: {
            Text("默认工作目录")
        } footer: {
            HStack(alignment: .top, spacing: 8) {
                Footer("未指定文件夹的任务在此创建子文件夹，结果保留在其中。")
                Button("恢复默认") {
                    if let settings { Task { await control.setWorkDir(settings.defaultToRestore(home: model.paths.userHome.path), model.client) } }
                }
                .disabled(settings == nil || settings?.isDefault == true || control.savingWorkDir)
            }
        }
    }

    private var location: String {
        switch control.workDir {
        case .known(let s): return model.shortPath(s.path)
        case .unsupported: return "内置服务版本较旧，不支持此设置"
        case .unknown: return model.daemonReady ? "读取中" : "服务未就绪"
        }
    }
}

/// 登录时启动, and the way to allow it when macOS holds it back. Also in the first-run wizard.
struct LoginItemRows: View {
    @State private var state = LoginItem.status()
    @State private var problem: String?

    var body: some View {
        Group {
            Toggle("登录时启动", isOn: Binding(get: { state == .enabled }, set: { set($0) }))
            if state == .requiresApproval {
                LabeledContent {
                    Button("打开系统设置") { SMAppService.openSystemSettingsLoginItems() }
                } label: {
                    HStack(spacing: 6) {
                        StatusDot(level: .warning)
                        Text("需在“登录项”中允许")
                    }
                }
            }
            if let problem {
                Text(problem).foregroundStyle(.red)
            }
        }
        .onAppear { state = LoginItem.status() }
    }

    private func set(_ on: Bool) {
        problem = LoginItem.set(on)
        state = LoginItem.status()
    }
}

/// `SMAppService.mainApp`: the app itself as a login item (macOS 13+).
enum LoginItem {
    enum State { case enabled, disabled, requiresApproval, unavailable }

    static func status() -> State {
        switch SMAppService.mainApp.status {
        case .enabled: return .enabled
        case .requiresApproval: return .requiresApproval
        case .notRegistered: return .disabled
        case .notFound: return .unavailable
        @unknown default: return .unavailable
        }
    }

    /// Nil on success, else what went wrong in words.
    static func set(_ on: Bool) -> String? {
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            return nil
        } catch {
            return "无法\(on ? "打开" : "关闭")登录时启动：\(error.localizedDescription)"
        }
    }
}

/// The bundled components in a fixed order, with their product names.
enum VersionRow {
    static let known = ["daemon", "secret-gate", "mitmproxy", "node", "python"]

    static func order(_ keys: [String]) -> [String] {
        known.filter(keys.contains) + keys.filter { !known.contains($0) }.sorted()
    }

    static func label(_ key: String) -> String {
        switch key {
        case "daemon": return "服务"
        case "secret-gate": return "secret-gate"
        case "mitmproxy": return "mitmproxy"
        case "node": return "Node.js"
        case "python": return "Python"
        default: return key
        }
    }
}

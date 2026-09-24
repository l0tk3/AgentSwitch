import AgentSwitchMacCore
import AppKit
import ServiceManagement
import SwiftUI

/// 通用: iPhone access, ports, login item, logs and data folders, runtime versions.
struct GeneralView: View {
    @Environment(AppModel.self) private var model
    @State private var local = ""
    @State private var remote = ""
    @State private var gate = ""
    @State private var opencode = ""
    @State private var loginItem = LoginItem.status()
    @State private var loginProblem: String?
    @AppStorage(DockPresence.alwaysShowKey) private var alwaysShowInDock = false

    private var draft: PortSettings? {
        guard let l = Int(local), let r = Int(remote), let g = Int(gate), let o = Int(opencode) else { return nil }
        return PortSettings(local: l, remote: r, gate: g, opencode: o)
    }

    var body: some View {
        Form {
            Section {
                Toggle("允许 iPhone 连接（远程接口与 Bonjour）", isOn: Binding(get: { model.remoteEnabled }, set: { model.setRemoteAccess($0) }))
            } header: { Text("iPhone") } footer: {
                Text("关掉后守护进程不开远程 HTTPS 端口，也不在局域网里广播，手机连不上、也不能配对；已配对的设备保留，重新打开后照常使用。切换时会重启守护进程。")
                    .foregroundStyle(.secondary)
            }

            Section {
                portField("本地接口（网页控制台、本应用）", $local)
                portField("远程接口（配对的手机，HTTPS）", $remote)
                portField("凭据网关", $gate)
                portField("OpenCode 路由服务", $opencode)
                let problems = draft?.problems() ?? ["端口必须是数字"]
                ForEach(problems, id: \.self) { Text($0).foregroundStyle(.orange).font(.caption) }
                HStack {
                    Button("保存并重启服务") { if let draft { model.applyPorts(draft) } }
                        .disabled(!problems.isEmpty || draft == model.ports)
                    Button("恢复默认") { fill(.defaults) }
                }
            } header: { Text("端口") } footer: {
                Text("网关端口上已经有 secret-gate 时直接复用它。改了远程端口后，已配对的手机在同一局域网里能通过 Bonjour 找到新端口；在外（Tailscale）要重新扫码。")
                    .foregroundStyle(.secondary)
            }

            Section("启动") {
                Toggle("登录时自动启动 AgentSwitch", isOn: Binding(get: { loginItem == .enabled }, set: { setLoginItem($0) }))
                if loginItem == .requiresApproval {
                    HStack {
                        Text("需要在「系统设置 › 通用 › 登录项」里允许。").foregroundStyle(.orange)
                        Button("打开系统设置") { SMAppService.openSystemSettingsLoginItems() }
                    }
                }
                if let loginProblem { Text(loginProblem).foregroundStyle(.orange).font(.caption) }
                Toggle("始终在程序坞显示", isOn: $alwaysShowInDock)
                    // This window is open while the toggle is used, so the icon stays until the window closes.
                    .onChange(of: alwaysShowInDock) { _, always in
                        NSApp.setActivationPolicy(DockPresence.showsInDock(alwaysShow: always, settingsWindowOpen: true) ? .regular : .accessory)
                    }
                Text("关掉时 AgentSwitch 只在菜单栏；打开设置窗口时会临时出现在程序坞里。").font(.caption).foregroundStyle(.secondary)
            }

            Section("日志与数据") {
                HStack {
                    Button("日志文件夹") { open(model.paths.logsDir) }
                    Button("daemon.log") { open(model.paths.daemonLog) }
                    Button("gate.log") { open(model.paths.gateLog) }
                    Button("数据目录") { open(model.paths.agentswitchHome) }
                }
                Text(model.paths.logsDir.path).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
            }

            Section("内置运行时") {
                let versions = model.paths.runtime.versions()
                if versions.isEmpty {
                    Text(RuntimePlan.missingRuntime(model.paths.runtime.missing()) ?? "版本信息缺失").foregroundStyle(.secondary)
                } else {
                    ForEach(versions.keys.sorted(), id: \.self) { key in
                        LabeledContent(key, value: versions[key] ?? "")
                    }
                }
                Text(model.paths.runtime.root.path).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                if model.options != .standard {
                    Text("开发模式：executors=\(model.options.executors) router=\(model.options.router ?? "默认")").foregroundStyle(.orange)
                }
            }
        }
        .formStyle(.grouped)
        .onAppear {
            fill(model.ports)
            loginItem = LoginItem.status()
        }
    }

    private func portField(_ label: String, _ text: Binding<String>) -> some View {
        TextField(label, text: text).monospacedDigit()
    }

    private func fill(_ p: PortSettings) {
        local = String(p.local)
        remote = String(p.remote)
        gate = String(p.gate)
        opencode = String(p.opencode)
    }

    private func setLoginItem(_ on: Bool) {
        loginProblem = LoginItem.set(on)
        loginItem = LoginItem.status()
    }

    private func open(_ url: URL) {
        if FileManager.default.fileExists(atPath: url.path) {
            NSWorkspace.shared.open(url)
        } else {
            model.errorMessage = "还没有 \(url.path)"
        }
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
            return "没能\(on ? "开启" : "关闭")登录自启：\(error.localizedDescription)"
        }
    }
}

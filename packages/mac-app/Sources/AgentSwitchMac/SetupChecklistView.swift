import AgentSwitchMacCore
import AppKit
import SwiftUI

/// 环境 › 设置清单 (docs/control-v0.md §6): each missing piece with the one action that fixes it; what is done folds into
/// one line, so a finished setup takes a single row.
struct SetupChecklistSection: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let items = model.setupItems
        let todo = items.filter { $0.state == .todo }
        let checking = items.filter { $0.state == .checking }
        let done = items.filter { $0.state == .done }
        let working = items.filter { $0.state == .working }
        Section {
            ForEach(working + todo) { SetupItemRow(item: $0) }
            if !checking.isEmpty {
                SetupSummaryRow(level: .busy, label: "checking", names: checking.map(\.title))
            }
            if !done.isEmpty {
                SetupSummaryRow(level: .ok, label: todo.isEmpty && checking.isEmpty ? "all set" : "done", names: done.map(\.title))
            }
        } header: {
            HStack {
                SectionLabel("setup")
                Spacer()
                if !todo.isEmpty { Text("\(todo.count) left").font(.callout).foregroundStyle(.secondary) }
            }
        } footer: {
            if todo.contains(where: { if case .login = $0.action { return true } else { return false } }) {
                Footer("登录在“终端”中完成，返回此窗口后自动重新检测。")
            }
        }
    }
}

/// `● 已完成   Claude Code、Codex、iPhone`
private struct SetupSummaryRow: View {
    let level: StatusLevel
    let label: String
    let names: [String]

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            StatusDot(level: level).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 }
            Text(label)
            Spacer(minLength: 12)
            Text(names.joined(separator: ", ")).foregroundStyle(.secondary).multilineTextAlignment(.trailing)
        }
        .padding(.vertical, 2)
    }
}

/// `● OpenCode                                    未登录  [登录]`
///   `在“终端”里运行 opencode auth login`
struct SetupItemRow: View {
    @Environment(AppModel.self) private var model
    @Environment(SettingsNavigation.self) private var navigation
    let item: SetupItem
    @State private var copied = false
    @State private var confirmTrust = false
    @State private var busy = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            StatusDot(level: level).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 }
            VStack(alignment: .leading, spacing: 3) {
                Text(item.title)
                if let detail = item.detail {
                    Text(detail)
                        .font(isCommand ? .caption.monospaced() : .caption)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            }
            Spacer(minLength: 12)
            if item.state == .working || busy { ProgressView().controlSize(.small) }
            Text(item.status).mono(12).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
            if let action = item.action {
                Button(copied ? "copied" : action.title) { perform(action) }.disabled(busy)
            }
        }
        .padding(.vertical, 2)
        .confirmationDialog("将网关证书加入登录钥匙串？", isPresented: $confirmTrust) {
            Button("trust") { run { _ = await model.trustGateCA() } }
        } message: {
            Text(GateCATrustText.confirmation(service: model.gateMode.isService))
        }
    }

    private var level: StatusLevel {
        switch item.state {
        case .done: return .ok
        case .todo: return .warning
        case .checking, .working: return .busy
        }
    }

    private var isCommand: Bool {
        if case .copyInstall = item.action { return true }
        return false
    }

    private func perform(_ action: SetupAction) {
        switch action {
        case .login(let harness):
            model.login(harness)
        case .copyInstall(let harness):
            Clipboard.copy(HarnessInstall.command(harness))
            copied = true
            Task {
                try? await Task.sleep(for: .seconds(2))
                copied = false
            }
        case .pair:
            navigation.tab = .pairing
        case .openTailscale:
            openTailscale()
        case .installTailscale:
            if let url = URL(string: "https://tailscale.com/download/mac") { NSWorkspace.shared.open(url) }
        case .chooseWorkDir:
            model.chooseWorkDir()
        case .installGateService:
            model.requestGateService(.install)
        case .updateGateService:
            model.requestGateService(.update)
        case .repairGateService:
            model.requestGateService(.repair)
        case .trustGateCA:
            confirmTrust = true
        case .removePreviousGateCA:
            run { await model.removePreviousCA() }
        }
    }

    /// A keychain step: macOS asks for the password; the row waits for it.
    private func run(_ work: @escaping @MainActor () async -> Void) {
        busy = true
        Task {
            await work()
            busy = false
        }
    }

    /// The app the CLI belongs to (`…/Tailscale.app/Contents/MacOS/Tailscale`), else the download page.
    private func openTailscale() {
        if let app = SetupChecklist.tailscaleApp(binary: model.tailscale?.binary) {
            NSWorkspace.shared.open(URL(fileURLWithPath: app))
        } else if let url = URL(string: "https://tailscale.com/download/mac") {
            NSWorkspace.shared.open(url)
        }
    }
}

extension AppModel {
    /// 选择… / 选择文件夹: a folder from the open panel, checked and saved by the daemon.
    func chooseWorkDir() {
        guard let url = FolderPanel.choose(message: "未指定文件夹的任务将在此处创建子文件夹。", startingAt: control.workDir.settings?.path) else { return }
        Task { await control.setWorkDir(url.path, client) }
    }
}

/// The confirmation before 加入 (环境 › 网关证书 and the checklist row).
enum GateCATrustText {
    static func confirmation(service: Bool) -> String {
        let key = service ? "签发用的私钥由凭据网关服务保管" : "签发用的私钥位于 ~/.mitmproxy"
        return "加入后，本机所有程序都将信任此证书签发的任何网站证书，\(key)。仅建议在个人电脑上执行此操作。macOS 将要求输入登录密码。"
    }
}

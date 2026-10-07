import AgentSwitchMacCore
import SwiftUI

/// 环境: the setup checklist, harnesses (installed? logged in?), the services and the network in detail, the gate as a
/// system service, the gate CA, file access and the PATH children get.
struct EnvironmentView: View {
    @Environment(AppModel.self) private var model
    @State private var trusting = false
    @State private var confirmTrust = false
    @State private var trustResult: String?
    /// The shared browser's engine, read when the page comes up (docs/browser-v0.md §7.2 第 6 条).
    @State private var engine: BrowserEngine?

    var body: some View {
        Form {
            SetupChecklistSection()

            Section {
                if model.harnesses.isEmpty {
                    HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Checking").foregroundStyle(.secondary) }
                }
                ForEach(model.harnesses) { HarnessRow(report: $0, path: model.shortPath($0.binary ?? "")) }
            } header: {
                SectionLabel("Executors")
            } footer: {
                Footer("执行器需自行安装并登录。此处仅检查命令和登录凭据，不调用模型。")
            }

            Section {
                StatusRow(label: "Service", line: model.daemonLine)
                StatusRow(label: "Gateway", line: model.gateLine)
                StatusRow(label: "Remote", line: model.remoteLine)
                StatusRow(label: "Bonjour", line: model.bonjourLine)
                StatusRow(label: "LAN", line: model.lanAddresses.isEmpty ? StatusLine("No Private Address", .warning)
                                                                        : StatusLine(model.lanAddresses.joined(separator: ", "), .ok))
                StatusRow(label: "Tailscale", line: tailscaleLine)
            } header: {
                SectionLabel("Service & Network")
            } footer: {
                if let note = networkFooter { Footer(note) }
            }

            GateServiceSection()

            Section {
                StatusRow(label: "Engine", line: BrowserEngineText.environment(engine))
            } header: {
                SectionLabel("Browser")
            } footer: {
                Footer(BrowserEngineText.environmentHint)
            }
            .task { engine = try? await model.client.browserEngine(check: false) }

            Section {
                StatusRow(label: "Cert File", line: model.caFilePresent ? StatusLine(model.shortPath(model.gateCA), .ok)
                                                                   : StatusLine("Created on First Gateway Start", .busy))
                LabeledContent("Login Keychain") {
                    HStack(spacing: 8) {
                        if trusting { ProgressView().controlSize(.small) }
                        Text(trustResult ?? (model.caTrusted ? "Trusted" : "Not Trusted")).foregroundStyle(.secondary)
                        if !model.caTrusted {
                            Button("Trust…") { confirmTrust = true }.disabled(!model.caFilePresent || trusting)
                        }
                    }
                }
            } header: {
                SectionLabel("Gateway Cert")
            } footer: {
                Footer("执行器通过环境变量单独信任此证书，通常无需加入钥匙串。")
            }

            Section {
                LabeledContent("System Settings") {
                    HStack(spacing: 8) {
                        Button("Files & Folders") { openPrivacyPane("Privacy_FilesAndFolders") }
                        Button("Full Disk Access") { openPrivacyPane("Privacy_AllFiles") }
                    }
                }
            } header: {
                SectionLabel("File Access")
            } footer: {
                Footer("项目位于桌面、文稿或下载文件夹时，需要为 AgentSwitch 授权，否则任务无法读取文件。建议将 AgentSwitch 放在“应用程序”文件夹中。")
            }

            Section {
                if let lp = model.loginPath {
                    LabeledContent("Source") {
                        if lp.source == .loginShell {
                            Text("Login Shell").foregroundStyle(.secondary)
                        } else {
                            HStack(spacing: 6) {
                                StatusDot(level: .warning)
                                Text("Common Folders").foregroundStyle(.secondary)
                            }
                            .help(lp.note ?? "")
                        }
                    }
                    Text(lp.path.split(separator: ":").map { model.shortPath(String($0)) }.joined(separator: ":"))
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                } else {
                    Text("Loading").foregroundStyle(.secondary)
                }
            } header: {
                SectionLabel("PATH")
            } footer: {
                if let note = model.loginPath?.note { Footer("无法从登录 shell 读取 PATH：\(note)。") }
            }
        }
        .formStyle(.grouped)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { model.detectEnvironment() } label: { Label("Check Again", systemImage: "arrow.clockwise") }
                    .help("Check Again")
                    .disabled(model.detecting)
            }
        }
        .confirmationDialog("将网关证书加入登录钥匙串？", isPresented: $confirmTrust) {
            Button("Trust") { Task { await trust() } }
        } message: {
            Text(GateCATrustText.confirmation(service: model.gateMode.isService))
        }
    }

    private var tailscaleLine: StatusLine {
        guard let ts = model.tailscale else { return StatusLine("Checking", .busy) }
        switch ts.state {
        case .notInstalled: return StatusLine("Not Installed", .off)
        case .stopped: return StatusLine("Disconnected · \(ts.backendState ?? "Unknown")", .warning)
        case .running: return StatusLine((ts.ipv4 + [ts.dnsName].compactMap { $0 }).joined(separator: " · "), .ok)
        }
    }

    private var networkFooter: String? {
        switch model.tailscale?.state {
        case .notInstalled: return "未安装 Tailscale 时，iPhone 仅可在同一局域网内连接。在 Mac 和 iPhone 上登录同一 Tailscale 账户并重新配对后，可在局域网外使用。"
        case .stopped: return "打开并登录 Tailscale 后，iPhone 可在局域网外连接。"
        default: return nil
        }
    }

    /// The keychain step of `secret-gate install-ca`, only on this click; macOS asks for the login password.
    private func trust() async {
        trusting = true
        defer { trusting = false }
        trustResult = await model.trustGateCA()
    }
}

/// `■ Claude Code  2.1.278                         OK`
///   `~/.local/bin/claude`, then install or login steps when there are any.
private struct HarnessRow: View {
    let report: HarnessReport
    let path: String

    var body: some View {
        let status = StatusText.harness(report.state)
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            StatusDot(level: status.level).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 }
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(report.harness.title)
                    if let version = report.version { Text(version).foregroundStyle(.secondary).monospacedDigit() }
                }
                if report.binary != nil {
                    Text(path).font(.caption.monospaced()).foregroundStyle(.secondary)
                        .help(report.evidence.map { "Credentials · \($0)" } ?? "No Credentials Found")
                }
                ForEach(report.guidance, id: \.self) { line in
                    Text(line).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                }
            }
            Spacer(minLength: 12)
            Text(status.text).mono(12).foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }
}

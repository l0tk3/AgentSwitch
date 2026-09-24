import AgentSwitchMacCore
import SwiftUI

/// 环境: harnesses (installed? logged in?), Tailscale, the gate CA, and the PATH children get.
struct EnvironmentView: View {
    @Environment(AppModel.self) private var model
    @State private var trusting = false
    @State private var trustResult: String?

    var body: some View {
        Form {
            Section {
                if model.harnesses.isEmpty {
                    HStack { ProgressView().controlSize(.small); Text("检测中…") }
                }
                ForEach(model.harnesses) { HarnessRow(report: $0) }
            } header: {
                HStack {
                    Text("执行器（需要你自己安装并登录）")
                    Spacer()
                    Button("重新检测") { model.detectEnvironment() }.disabled(model.detecting)
                }
            } footer: {
                Text("只检查命令是否存在和登录凭据是否在（文件、钥匙串条目），不会调用任何模型。").foregroundStyle(.secondary)
            }

            Section("Tailscale") {
                if let ts = model.tailscale {
                    Label(ts.summary, systemImage: ts.state == .running ? "checkmark.circle.fill" : "info.circle")
                        .foregroundStyle(ts.state == .running ? .green : .secondary)
                    if ts.state == .notInstalled {
                        Text("在外面用手机需要 Tailscale：Mac 和 iPhone 装上并登录同一个账号，然后重新生成配对码。").font(.caption).foregroundStyle(.secondary)
                    }
                } else {
                    Text("检测中…")
                }
            }

            Section("凭据网关证书（CA）") { caSection }

            Section("文件访问") {
                Text("任务在“桌面”“文稿”“下载”里的项目上运行时，macOS 要求 AgentSwitch 有对应文件夹的访问权限。没有授权时，执行器会停在读文件那一步不动。请在「系统设置 › 隐私与安全性 › 文件和文件夹」里给 AgentSwitch 打开这些文件夹（或在「完全磁盘访问权限」里加入 AgentSwitch）。")
                    .font(.callout).foregroundStyle(.secondary)
                HStack {
                    Button("打开「文件和文件夹」") { openPrivacyPane("Privacy_FilesAndFolders") }
                    Button("打开「完全磁盘访问权限」") { openPrivacyPane("Privacy_AllFiles") }
                }
                Text("建议把 AgentSwitch.app 放进“应用程序”文件夹再运行：放在桌面上时，它自己也位于受保护的文件夹里。")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section("子进程使用的 PATH") {
                if let lp = model.loginPath {
                    Text(lp.source == .loginShell ? "来自登录 shell（\(model.paths.userHome.path) 下的 shell 配置）" : "登录 shell 没给出 PATH，用了常见目录：\(lp.note ?? "")")
                        .font(.caption).foregroundStyle(lp.source == .loginShell ? Color.secondary : Color.orange)
                    Text(lp.path).font(.caption.monospaced()).textSelection(.enabled)
                } else {
                    Text("读取中…")
                }
            }
        }
        .formStyle(.grouped)
    }

    @ViewBuilder
    private var caSection: some View {
        let hasCopy = FileManager.default.fileExists(atPath: model.paths.gateCA.path)
        Label(hasCopy ? "已复制到 \(model.paths.gateCA.path)" : "还没有：网关第一次启动后自动生成并复制",
              systemImage: hasCopy ? "checkmark.circle.fill" : "hourglass")
            .foregroundStyle(hasCopy ? .green : .secondary)
        Label(model.caTrusted ? "已加入登录钥匙串（本机所有程序都信任它）" : "没有加入钥匙串（一般不需要）",
              systemImage: model.caTrusted ? "lock.shield" : "lock.open")
            .foregroundStyle(.secondary)
        Text("网关用这张 mitmproxy 证书解开 HTTPS，把请求里的密文换成真实值。执行器通过 SSL_CERT_FILE、NODE_EXTRA_CA_CERTS 等环境变量单独信任 \(model.paths.gateCA.lastPathComponent)，所以通常不用改钥匙串。只有想让本机其他程序（比如浏览器）也经过网关时才需要加入钥匙串；加入后本机所有程序都会信任它签发的任何网站证书，而签发用的私钥就在 ~/.mitmproxy 里。只在你自己的电脑上这样做。")
            .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        HStack {
            Button("加入登录钥匙串…") { Task { await trust() } }
                .disabled(!hasCopy || model.caTrusted || trusting)
            if trusting { ProgressView().controlSize(.small) }
            if let trustResult { Text(trustResult).font(.caption).foregroundStyle(.secondary) }
        }
    }

    /// The keychain step of `secret-gate install-ca`, only on this click; macOS asks for the login password.
    private func trust() async {
        trusting = true
        defer { trusting = false }
        let (exe, args) = GateCA.trustCommand(ca: model.paths.gateCA, userHome: model.paths.userHome)
        do {
            let result = try await ProcessRunner.run(exe, args, timeout: 120)
            trustResult = result.ok ? "已加入" : "没有加入：\(result.stderrText.trimmingCharacters(in: .whitespacesAndNewlines))"
        } catch {
            trustResult = error.localizedDescription
        }
        model.detectEnvironment()
    }
}

private struct HarnessRow: View {
    let report: HarnessReport

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Image(systemName: icon).foregroundStyle(color)
                Text(report.harness.title).fontWeight(.semibold)
                if let version = report.version { Text(version).foregroundStyle(.secondary) }
                Spacer()
                Text(stateText).foregroundStyle(color)
            }
            if let binary = report.binary {
                Text(binary + (report.evidence.map { " · 登录凭据：\($0)" } ?? "")).font(.caption.monospaced()).foregroundStyle(.secondary)
            }
            ForEach(report.guidance, id: \.self) { line in
                Text(line).font(.caption).textSelection(.enabled)
            }
        }
        .padding(.vertical, 2)
    }

    private var stateText: String {
        switch report.state {
        case .ready: return "可用"
        case .notLoggedIn: return "没有登录"
        case .missing: return "没有安装"
        }
    }

    private var icon: String {
        switch report.state {
        case .ready: return "checkmark.circle.fill"
        case .notLoggedIn: return "person.crop.circle.badge.exclamationmark"
        case .missing: return "xmark.circle"
        }
    }

    private var color: Color {
        switch report.state {
        case .ready: return .green
        case .notLoggedIn: return .orange
        case .missing: return .secondary
        }
    }
}

/// Opens a Privacy & Security pane of System Settings (the anchors are the documented x-apple.systempreferences ones).
@MainActor
private func openPrivacyPane(_ anchor: String) {
    if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)") {
        NSWorkspace.shared.open(url)
    }
}

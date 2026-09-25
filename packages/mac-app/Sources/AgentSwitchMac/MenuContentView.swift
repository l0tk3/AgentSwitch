import AgentSwitchMacCore
import AppKit
import SwiftUI

/// The menu-bar panel: status of every piece plus quick actions.
struct MenuContentView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.showSettings) private var showSettings
    @Environment(\.quitApp) private var quitApp

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            Divider()
            VStack(alignment: .leading, spacing: 6) {
                StatusRow(label: "守护进程", line: model.daemonLine)
                StatusRow(label: "凭据网关", line: model.gateLine)
                StatusRow(label: "远程监听", line: model.remoteLine)
                StatusRow(label: "局域网", line: StatusLine(model.lanAddresses.isEmpty ? "没有私有网段地址" : model.lanAddresses.joined(separator: "  "),
                                                         model.lanAddresses.isEmpty ? .warning : .ok))
                StatusRow(label: "Tailscale", line: tailscaleLine)
                StatusRow(label: "Bonjour", line: model.bonjourLine)
                StatusRow(label: "已配对设备", line: model.devicesLine)
            }
            attention
            update
            Divider()
            actions
        }
        .padding(14)
        .frame(width: 380)
        .task { await model.pollOnce() }
    }

    private var header: some View {
        HStack {
            Text("AgentSwitch").font(.headline)
            Spacer()
            StatusDot(level: model.overallLevel)
            Text(overallText).font(.caption).foregroundStyle(.secondary)
        }
    }

    private var overallText: String {
        switch model.overallLevel {
        case .ok: return "一切正常"
        case .busy, .off: return "启动中"
        case .warning: return "需要留意"
        case .error: return "需要处理"
        }
    }

    private var tailscaleLine: StatusLine {
        if !model.tailnetAddresses.isEmpty { return StatusLine(model.tailnetAddresses.joined(separator: "  "), .ok) }
        switch model.tailscale?.state {
        case .none: return StatusLine("检测中…", .busy)
        case .notInstalled: return StatusLine("没装：只能在同一局域网使用", .off)
        case .stopped: return StatusLine("没有连接：打开 Tailscale 登录", .warning)
        case .running: return StatusLine((model.tailscale?.ipv4 ?? []).joined(separator: "  "), .ok)
        }
    }

    /// Harnesses missing or logged out, first-run notes.
    @ViewBuilder
    private var attention: some View {
        let missing = model.harnesses.filter { $0.state != .ready }
        if !missing.isEmpty || !model.notices.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(missing) { report in
                    Label("\(report.harness.title)：\(report.state == .missing ? "没有安装" : "没有登录")", systemImage: "exclamationmark.circle")
                        .foregroundStyle(.orange)
                }
                ForEach(model.notices, id: \.self) { Label($0, systemImage: "info.circle").foregroundStyle(.secondary) }
            }
            .font(.caption)
        }
    }

    /// A newer AgentSwitch.app is staged (assistant-v0 §5): install after a confirmation; the helper puts the current
    /// version back by itself if the new one does not start.
    @ViewBuilder
    private var update: some View {
        if let built = model.stagedUpdate {
            HStack {
                Label("有新版本（构建于 \(built)）", systemImage: "arrow.down.circle").font(.caption)
                Spacer()
                Button("安装并重启…") { confirmUpdate(built) }.font(.caption)
            }
        }
    }

    private func confirmUpdate(_ built: String) {
        let alert = NSAlert()
        alert.messageText = "安装新版本？"
        alert.informativeText = "构建于 \(built)。AgentSwitch 会退出、换成新版本再启动；正在运行的任务会被中断。新版本 150 秒内没起来，会自动退回现在这一版。App 若放在桌面、文稿或下载里，macOS 可能先要你允许 AgentSwitch 访问那个文件夹。"
        alert.addButton(withTitle: "安装并重启")
        alert.addButton(withTitle: "取消")
        if alert.runModal() == .alertFirstButtonReturn { Task { await model.installUpdate() } }
    }

    private var actions: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Button { showSettings(.pairing) } label: { Label("配对新设备…", systemImage: "qrcode") }
                Spacer()
                Button { showSettings(nil) } label: { Label("设置…", systemImage: "gearshape") }
            }
            HStack {
                Button { openConsole() } label: { Label("网页控制台", systemImage: "safari") }
                    .disabled(!model.daemonReady)
                Button { model.restartAll() } label: { Label("重启服务", systemImage: "arrow.clockwise") }
                Spacer()
                Button("退出") { quitApp() }
            }
        }
        .buttonStyle(.borderless)
    }

    private func openConsole() {
        if let url = URL(string: "http://127.0.0.1:\(model.ports.local)/ui") { NSWorkspace.shared.open(url) }
    }
}

import AgentSwitchMacCore
import AppKit
import SwiftUI

/// The menu-bar panel: one status line, the four services, usage, what needs the user, a new version, the actions.
/// Details (ports, pids, addresses) are in 设置 › 环境; hovering a row shows its full line.
struct MenuContentView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.showSettings) private var showSettings
    @Environment(\.quitApp) private var quitApp

    static let width: CGFloat = 320

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
                .padding(.horizontal, 16)
                .padding(.top, 14)
                .padding(.bottom, 12)
            Divider().padding(.horizontal, 12)
            services
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
            if !model.usageRows.isEmpty {
                Divider().padding(.horizontal, 12)
                usage
                    .padding(.horizontal, 16)
                    .padding(.top, 8)
                    .padding(.bottom, 12)
            }
            if !attention.isEmpty || !model.notices.isEmpty {
                Divider().padding(.horizontal, 12)
                attentionList
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
            }
            if let built = model.stagedUpdate {
                Divider().padding(.horizontal, 12)
                update(built)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
            }
            Divider().padding(.horizontal, 12)
            actions
                .padding(.horizontal, 6)
                .padding(.vertical, 6)
        }
        .frame(width: MenuContentView.width)
        .tint(.brand)
        .task {
            await model.pollOnce()
            await model.refreshUsage()
        }
    }

    // MARK: header

    /// `AgentSwitch   ● 运行中`, or how many things wait for the user once the services are fine.
    private var header: some View {
        HStack(spacing: 8) {
            Text("AgentSwitch").font(.headline)
            Spacer(minLength: 8)
            StatusBadge(line: headline).font(.callout)
        }
    }

    private var headline: StatusLine {
        let level = model.overallLevel
        let waiting = attention.map(\.count).reduce(0, +)
        if level == .ok && waiting > 0 { return StatusLine("\(waiting) 项等你处理", .warning) }
        return StatusLine(StatusText.headline(level), level)
    }

    // MARK: services

    private var services: some View {
        VStack(alignment: .leading, spacing: 8) {
            ServiceRow(label: "服务", line: StatusText.service(model.daemonState, ready: model.daemonReady), detail: model.daemonLine.text)
            ServiceRow(label: "凭据网关", line: model.gateShortLine, detail: model.gateLine.text)
            ServiceRow(label: "iPhone", line: StatusText.phone(remote: model.remoteLine, enabled: model.remoteEnabled,
                                                                devices: model.devices, online: model.remote?.onlineDevices),
                       detail: model.remoteLine.text)
            ServiceRow(label: "Tailscale", line: StatusText.tailscale(model.tailscale, tailnet: model.tailnetAddresses),
                       detail: model.tailscale?.summary ?? "检测中")
        }
    }

    // MARK: usage

    /// Claude Code, Codex and OpenCode as the daemon last read them (docs/ui-v0.md §4.2); details in 设置 › 模型.
    private var usage: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("用量").font(.caption.weight(.medium)).foregroundStyle(.secondary)
            ForEach(model.usageRows) { UsageRowView(row: $0, compact: true) }
        }
    }

    // MARK: attention

    private struct Attention: Identifiable {
        let id: String
        let text: String
        /// How many things the row stands for (the setup row counts each missing piece).
        var count = 1
        /// The button's title; 处理 opens 设置 › 环境.
        var action = "处理"
        /// An error rather than something to do (the gate service not answering).
        var level = StatusLevel.warning
    }

    /// The gate service when it needs the user (gate-service-v0 §4: 未安装, 无响应, 有更新), what else the setup
    /// checklist misses (control-v0 §6), Bonjour held by macOS, the remote listener in trouble: each opens 设置 › 环境.
    private var attention: [Attention] {
        var out: [Attention] = []
        let facts = model.gateServiceFacts
        let gate = GateServiceText.attention(facts)
        if let gate {
            let update = facts.updateAvailable && facts.health == .responding && !facts.ownedByAnotherUser
            out.append(Attention(id: "gate", text: gate, action: update ? "更新…" : "处理",
                                 level: facts.health == .notResponding || facts.ownedByAnotherUser ? .error : .warning))
        }
        let unmet = model.setupItems.filter { $0.state == .todo && (gate == nil || $0.id != SetupChecklist.gateServiceID) }.count
        if unmet > 0 { out.append(Attention(id: "setup", text: "\(unmet) 项设置未完成", count: unmet)) }
        if model.remoteEnabled && model.daemonReady && model.remoteLine.level >= .warning {
            out.append(Attention(id: "remote", text: "iPhone 连接不可用"))
        }
        if model.bonjourLine.level >= .warning {
            out.append(Attention(id: "bonjour", text: "局域网广播不可用"))
        }
        return out
    }

    private var attentionList: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(attention) { item in
                HStack(spacing: 8) {
                    StatusDot(level: item.level)
                    Text(item.text)
                    Spacer(minLength: 8)
                    Button(item.action) {
                        // 更新…: the confirmation sheet, in 环境 where the outcome stays readable.
                        if item.id == "gate" && item.action != "处理" { model.requestGateService(.update) }
                        showSettings(.environment)
                    }
                    .controlSize(.small)
                }
            }
            ForEach(model.notices, id: \.self) { notice in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: "info.circle").foregroundStyle(.secondary)
                    Text(notice).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    // MARK: update

    /// A newer AgentSwitch.app is staged (assistant-v0 §5): install after a confirmation; the app puts the current
    /// version back by itself if the new one does not start.
    private func update(_ built: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "arrow.down.circle.fill").font(.title2).foregroundStyle(Color.brand)
            VStack(alignment: .leading, spacing: 2) {
                Text("新版本可用")
                Text("构建于 \(TimeText.build(built))").font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Button("安装…") { confirmUpdate(built) }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
        }
    }

    private func confirmUpdate(_ built: String) {
        let alert = NSAlert()
        alert.messageText = "安装新版本？"
        alert.informativeText = "AgentSwitch 将退出并替换为构建于 \(TimeText.build(built)) 的版本，正在运行的任务将中断。新版本 \(AppUpdate.healthWait) 秒内未启动时，自动恢复当前版本。macOS 请求文件夹访问权限时，请选择允许。"
        alert.addButton(withTitle: "安装并重启")
        alert.addButton(withTitle: "取消")
        if alert.runModal() == .alertFirstButtonReturn { Task { await model.installUpdate() } }
    }

    // MARK: actions

    private var actions: some View {
        VStack(alignment: .leading, spacing: 0) {
            MenuAction(title: "配对新设备…", symbol: "qrcode") { showSettings(.pairing) }
            MenuAction(title: "打开网页控制台", symbol: "safari", enabled: model.daemonReady) { openConsole() }
            MenuAction(title: "重启服务", symbol: "arrow.clockwise") { model.restartAll() }
            MenuAction(title: "设置…", symbol: "gearshape") { showSettings(nil) }
            Divider().padding(.horizontal, 6).padding(.vertical, 4)
            MenuAction(title: "退出 AgentSwitch", symbol: "power") { quitApp() }
        }
    }

    /// Signed in through a one-time link (the local API wants its token; the browser gets a session instead).
    private func openConsole() {
        Task {
            do { NSWorkspace.shared.open(try await model.client.consoleLink()) }
            catch { model.errorMessage = "无法打开网页控制台：\(error.localizedDescription)" }
        }
    }
}

/// `● 服务        运行中`; the full status line on hover.
private struct ServiceRow: View {
    let label: String
    let line: StatusLine
    let detail: String

    var body: some View {
        HStack(spacing: 8) {
            StatusDot(level: line.level)
            Text(label)
            Spacer(minLength: 12)
            Text(line.text).foregroundStyle(.secondary).monospacedDigit().lineLimit(1).truncationMode(.middle)
        }
        .help(detail)
    }
}

/// A menu-style row: full width, highlighted under the pointer.
private struct MenuAction: View {
    let title: String
    let symbol: String
    var enabled = true
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: symbol).frame(width: 18).foregroundStyle(.secondary)
                Text(title)
                Spacer()
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .contentShape(Rectangle())
            .background(hovering && enabled ? Color.primary.opacity(0.08) : .clear, in: RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.4)
        .onHover { hovering = $0 }
    }
}

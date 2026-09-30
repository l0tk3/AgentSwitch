import AgentSwitchMacCore
import AppKit
import SwiftUI

/// The menu-bar panel (docs/ui-v0.md §7): the mark and one status word, the four services, usage, what needs the
/// user, a new version, the actions. Short words monospaced in lowercase English, sentences formal Chinese; every row
/// keeps the same mark column so the words start in one line. Details (ports, pids, addresses) are in settings ›
/// environment; hovering a row shows its full line.
struct MenuContentView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.showSettings) private var showSettings
    @Environment(\.showTerminals) private var showTerminals
    @Environment(\.quitApp) private var quitApp
    @AppStorage(DockPresence.alwaysShowKey) private var alwaysShowInDock = true

    static let width: CGFloat = 320

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
                .padding(.horizontal, 16)
                .padding(.top, 14)
                .padding(.bottom, 10)
            SectionLabel("status").padding(.horizontal, 16).padding(.top, 4)
            services
                .padding(.horizontal, 16)
                .padding(.top, 6)
                .padding(.bottom, 10)
            if !model.usageRows.isEmpty {
                SectionLabel("usage").padding(.horizontal, 16).padding(.top, 4)
                usage
                    .padding(.horizontal, 16)
                    .padding(.top, 6)
                    .padding(.bottom, 12)
            }
            if !attention.isEmpty || !model.notices.isEmpty {
                SectionLabel("waiting").padding(.horizontal, 16).padding(.top, 4)
                attentionList
                    .padding(.horizontal, 16)
                    .padding(.top, 6)
                    .padding(.bottom, 10)
            }
            if let built = model.stagedUpdate {
                DottedRule().padding(.horizontal, 12)
                update(built)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
            }
            DottedRule().padding(.horizontal, 12)
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

    /// The mark (with depth: an identity mark of 20+ pt) in the app's state, the name, and one word: `ok`, or how
    /// many things wait for the user once the services are fine.
    private var header: some View {
        HStack(spacing: 10) {
            // The name and the word beside it say all the mark does: VoiceOver reads those once.
            PixelMarkView(state: PixelArt.markState(model.overallLevel, waiting: waitingCount), pixel: 2)
                .accessibilityHidden(true)
            Text("AgentSwitch").mono(13, weight: .bold)
            Spacer(minLength: 8)
            Text(headline.text).mono(11).foregroundStyle(headline.level >= .warning ? headline.level.color : .secondary)
        }
    }

    private var attention: [AttentionItem] { model.attention }
    private var waitingCount: Int { model.waitingCount }

    private var headline: StatusLine {
        let level = model.overallLevel
        if level == .ok && waitingCount > 0 { return StatusLine("\(waitingCount) waiting", .warning) }
        return StatusLine(StatusText.headline(level), level)
    }

    // MARK: services

    private var services: some View {
        VStack(alignment: .leading, spacing: 8) {
            ServiceRow(label: "service", line: StatusText.service(model.daemonState, ready: model.daemonReady), detail: model.daemonLine.text)
            ServiceRow(label: "gateway", line: model.gateShortLine, detail: model.gateLine.text)
            ServiceRow(label: "iPhone", line: StatusText.phone(remote: model.remoteLine, enabled: model.remoteEnabled,
                                                                devices: model.devices, online: model.remote?.onlineDevices),
                       detail: model.remoteLine.text)
            ServiceRow(label: "Tailscale", line: StatusText.tailscale(model.tailscale, tailnet: model.tailnetAddresses),
                       detail: model.tailscale?.summary ?? "checking")
        }
    }

    // MARK: usage

    /// Claude Code, Codex and OpenCode as the daemon last read them (docs/ui-v0.md §4.2); details in settings › models.
    private var usage: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(model.usageRows) { UsageRowView(row: $0, compact: true) }
        }
    }

    // MARK: attention

    private var attentionList: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(attention) { item in
                HStack(spacing: 8) {
                    StatusMark(level: item.level).frame(width: 10)
                    Text(item.text).mono(12)
                    Spacer(minLength: 8)
                    Button(item.action) {
                        // update…: the confirmation sheet, in environment where the outcome stays readable.
                        if item.id == "gate" && item.action != "fix" { model.requestGateService(.update) }
                        showSettings(.environment)
                    }
                    .controlSize(.small)
                    .font(.system(size: 11, design: .monospaced))
                }
            }
            ForEach(model.notices, id: \.self) { notice in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("i").mono(11, weight: .bold).foregroundStyle(.secondary).frame(width: 10).accessibilityHidden(true)
                    Text(notice).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    // MARK: update

    /// A newer AgentSwitch.app is staged (assistant-v0 §5): install after a confirmation; the app puts the current
    /// version back by itself if the new one does not start.
    private func update(_ built: String) -> some View {
        HStack(spacing: 8) {
            Color.clear.frame(width: 10, height: 1)
            Text("new build · \(TimeText.build(built))").mono(11).foregroundStyle(.secondary).lineLimit(1)
            Spacer(minLength: 8)
            Button("install…") { confirmUpdate(built) }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .font(.system(size: 11, design: .monospaced))
        }
    }

    private func confirmUpdate(_ built: String) {
        let alert = NSAlert()
        alert.messageText = "安装新版本？"
        alert.informativeText = "AgentSwitch 将退出并替换为构建于 \(TimeText.build(built)) 的版本，正在运行的任务将中断。新版本 \(AppUpdate.healthWait) 秒内未启动时，自动恢复当前版本。macOS 请求文件夹访问权限时，请选择允许。"
        alert.addButton(withTitle: "install & restart")
        alert.addButton(withTitle: "cancel")
        if alert.runModal() == .alertFirstButtonReturn { Task { await model.installUpdate() } }
    }

    // MARK: actions

    private var actions: some View {
        VStack(alignment: .leading, spacing: 0) {
            // words only: an icon on every item differentiates nothing (docs/ui-v0.md §7.2.5)
            MenuAction(title: "pair device…") { showSettings(.pairing) }
            // The Dock icon opens the terminal window (2026-09-30, user: dock 栏直接点图标就可以打开 terminal，就不用状态栏里的
            // open terminal 了); without a Dock icon this is the way in.
            if !alwaysShowInDock {
                MenuAction(title: "open terminal", enabled: model.daemonReady) { showTerminals() }
            }
            MenuAction(title: "open console", enabled: model.daemonReady) { openConsole() }
            MenuAction(title: "restart service") { model.restartAll() }
            MenuAction(title: "settings…") { showSettings(nil) }
            DottedRule().padding(.horizontal, 6).padding(.vertical, 5)
            MenuAction(title: "quit AgentSwitch") { quitApp() }
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

/// `■ service        ok`; the full status line on hover.
private struct ServiceRow: View {
    let label: String
    let line: StatusLine
    let detail: String

    var body: some View {
        HStack(spacing: 8) {
            StatusMark(level: line.level).frame(width: 10)
            Text(label).mono(12)
            Spacer(minLength: 12)
            Text(line.text).mono(11.5).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
        }
        .help(detail)
    }
}

/// A menu-style row: full width, in reverse under the pointer (a text-mode menu's highlight); the words start in the
/// mark column's line.
private struct MenuAction: View {
    let title: String
    var enabled = true
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Color.clear.frame(width: 10, height: 1)
                Text(title).mono(12)
                Spacer()
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .contentShape(Rectangle())
            .foregroundStyle(hovering && enabled ? Color(nsColor: .windowBackgroundColor) : .primary)
            .background(hovering && enabled ? Color.primary : .clear)
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.4)
        .onHover { hovering = $0 }
    }
}

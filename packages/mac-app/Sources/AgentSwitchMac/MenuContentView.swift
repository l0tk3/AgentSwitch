import AgentSwitchMacCore
import AppKit
import SwiftUI

/// The menu-bar panel (docs/ui-v0.md §7): the mark and one status word, the four services, usage, what needs the
/// user, a new version, the actions. Short words monospaced in title-case English, sentences formal Chinese; every row
/// keeps the same mark column so the words start in one line. Details (ports, pids, addresses) are in settings ›
/// environment; hovering a row shows its full line.
struct MenuContentView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.showSettings) private var showSettings
    @Environment(\.showMainWindow) private var showMainWindow
    @Environment(\.quitApp) private var quitApp
    @AppStorage(DockPresence.alwaysShowKey) private var alwaysShowInDock = true

    static let width: CGFloat = 320

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
                .padding(.horizontal, 16)
                .padding(.top, 14)
                .padding(.bottom, 10)
            SectionLabel("Status").padding(.horizontal, 16).padding(.top, 4)
            services
                .padding(.horizontal, 16)
                .padding(.top, 6)
                .padding(.bottom, 10)
            if !model.usageRows.isEmpty {
                SectionLabel("Usage").padding(.horizontal, 16).padding(.top, 4)
                usage
                    .padding(.horizontal, 16)
                    .padding(.top, 6)
                    .padding(.bottom, 12)
            }
            if !attention.isEmpty || !model.notices.isEmpty {
                SectionLabel("Waiting").padding(.horizontal, 16).padding(.top, 4)
                attentionList
                    .padding(.horizontal, 16)
                    .padding(.top, 6)
                    .padding(.bottom, 10)
            }
            if let built = model.stagedUpdate {
                HairRule().padding(.horizontal, 12)
                update(built)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
            }
            HairRule().padding(.horizontal, 12)
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

    /// The mark (with depth: an identity mark of 20+ pt) in the app's state, the name, and one word: `OK`, or how
    /// many things wait for the user once the services are fine.
    private var header: some View {
        HStack(spacing: 10) {
            // The name and the word beside it say all the mark does: VoiceOver reads those once.
            PixelMarkView(state: PixelArt.markState(model.overallLevel, waiting: waitingCount), pixel: 2)
                .accessibilityHidden(true)
            Text("AgentSwitch").mono(13, weight: .bold)
            Spacer(minLength: 8)
            LookWord(headline.text).mono(11).foregroundStyle(headline.level >= .warning ? headline.level.color : .secondary)
        }
    }

    private var attention: [AttentionItem] { model.attention }
    private var waitingCount: Int { model.waitingCount }

    private var headline: StatusLine {
        let level = model.overallLevel
        if level == .ok && waitingCount > 0 { return StatusLine("\(waitingCount) Waiting", .warning) }
        return StatusLine(StatusText.headline(level), level)
    }

    // MARK: services

    private var services: some View {
        VStack(alignment: .leading, spacing: 8) {
            ServiceRow(label: "Service", line: StatusText.service(model.daemonState, ready: model.daemonReady), detail: model.daemonLine.text)
            ServiceRow(label: "Gateway", line: model.gateShortLine, detail: model.gateLine.text)
            ServiceRow(label: "iPhone", line: StatusText.phone(remote: model.remoteLine, enabled: model.remoteEnabled,
                                                                devices: model.devices, online: model.remote?.onlineDevices),
                       detail: model.remoteLine.text)
            ServiceRow(label: "Tailscale", line: StatusText.tailscale(model.tailscale, tailnet: model.tailnetAddresses),
                       detail: model.tailscale?.summary ?? "Checking")
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
                        // Update…: the confirmation sheet, in Environment where the outcome stays readable.
                        if item.id == "gate" && item.offersUpdate { model.requestGateService(.update) }
                        showSettings(.environment)
                    }
                    .controlSize(.small)
                    .mono(11)
                }
            }
            ForEach(model.notices, id: \.self) { notice in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    LookGlyph(glyph: "i", symbol: "info.circle", size: 11).foregroundStyle(.secondary).frame(width: 10).accessibilityHidden(true)
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
            Text("New Build · \(TimeText.build(built))").mono(11).foregroundStyle(.secondary).lineLimit(1)
            Spacer(minLength: 8)
            Button("Install…") { confirmUpdate(built) }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .mono(11)
        }
    }

    private func confirmUpdate(_ built: String) {
        let alert = NSAlert()
        alert.messageText = "安装新版本？"
        alert.informativeText = "AgentSwitch 将退出并替换为构建于 \(TimeText.build(built)) 的版本，正在运行的任务将中断。新版本 \(AppUpdate.healthWait) 秒内未启动时，自动恢复当前版本。macOS 请求文件夹访问权限时，请选择允许。"
        alert.addButton(withTitle: "Install & Restart")
        alert.addButton(withTitle: "Cancel")
        if alert.runModal() == .alertFirstButtonReturn { Task { await model.installUpdate() } }
    }

    // MARK: actions

    private var actions: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Each with its picture (2026-10-07, user: 剩下的几个都加上图标 — until then words only, ui-v0 §7.2.5): the ones
            // the same things have elsewhere — the pairing page's code, the rail's own for its pages and for Settings.
            MenuAction(title: "Pair Device…", rows: PixelArt.menuPair) { showSettings(.pairing) }
            // The Dock icon opens the main window (2026-09-30, user: dock 栏直接点图标就可以打开 terminal，就不用状态栏里的
            // open terminal 了; dispatch-v0 §1); without a Dock icon these are the way in, one per page.
            if !alwaysShowInDock {
                MenuAction(title: "Open Dispatch", rows: PixelArt.railDispatch, enabled: model.daemonReady) { showMainWindow(.dispatch) }
                MenuAction(title: "Open Terminals", rows: PixelArt.railTerminals, enabled: model.daemonReady) { showMainWindow(.terminals) }
            }
            // No `Open in Browser` (the web console in the system's browser): taken out 2026-10-07, user: open in brower
            // 删掉，把这个功能直接删掉.
            MenuAction(title: "Restart Service", rows: PixelArt.menuRestart) { model.restartAll() }
            MenuAction(title: "Settings…", rows: PixelArt.toolbarSettings) { showSettings(nil) }
            HairRule().padding(.horizontal, 6).padding(.vertical, 5)
            MenuAction(title: "Quit AgentSwitch", rows: PixelArt.menuQuit) { quitApp() }
        }
    }
}

/// `■ Service        OK`; the full status line on hover.
private struct ServiceRow: View {
    let label: String
    let line: StatusLine
    let detail: String

    var body: some View {
        HStack(spacing: 8) {
            StatusMark(level: line.level).frame(width: 10)
            Text(label).mono(12)
            Spacer(minLength: 12)
            LookWord(line.text).mono(11.5).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
        }
        .help(detail)
    }
}

/// A menu-style row: full width, in reverse under the pointer (a text-mode menu's highlight); its picture before the
/// words, which start in the line of the words above (the status rows').
private struct MenuAction: View {
    let title: String
    /// Its picture: a sprite in the pixel look, the system's symbol that stands for it in the classic one.
    let rows: [String]
    var enabled = true
    let action: () -> Void
    @State private var hovering = false
    @Environment(\.interfaceLook) private var look

    var body: some View {
        // In reverse under the pointer; in the classic look the system's menu highlight: the accent, round.
        let ink: Color = hovering && enabled ? (look.isClassic ? Color.white : Color(nsColor: .windowBackgroundColor)) : .primary
        Button(action: action) {
            HStack(spacing: 6) {
                // One size for all of them in the classic look, whatever grid each sprite was drawn on.
                PixelSprite(rows: rows, pixel: look.isClassic ? 9.5 / CGFloat(max(rows.count, 1)) : 1, color: ink.opacity(hovering && enabled ? 1 : 0.8))
                    .frame(width: 14, height: 12)
                LookWord(title).mono(12)
                Spacer()
            }
            .padding(.leading, 8).padding(.trailing, 10)
            .padding(.vertical, 4)
            .contentShape(Rectangle())
            .foregroundStyle(ink)
            .grounded(hovering && enabled ? (look.isClassic ? Color.signal : Color.primary) : .clear, radius: 5)
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.4)
        .onHover { hovering = $0 }
    }
}

import AgentSwitchMacCore
import SwiftUI

/// The status bar (docs/dispatch-v0.md §1, 左侧图标栏与整窗状态栏; demo `implemented/window-bars.html`, proposal B,
/// 2026-10-03): 24 pt across the whole window, under the rail and the page, a solid edge above it. Its left is the app's
/// and the same on every page: the gateway (a green square and `Gateway`; a red one and `Service Down` / `Gateway Down`,
/// the full line under the pointer) and the phones online. Its right is the page's: the terminal on screen (agent and
/// model, permission mode, where its size is, and the lock — Encrypt & Send), the browser tab's hold (what was the
/// Browser page's footer) and, last, the page's zoom (`−` `100%` `+`, 2026-10-03, BrowserZoomItems), Dispatch's router
/// and open topics. Short monospaced words in the secondary ink. Nothing in it is only here (HIG: a window's bottom
/// edge may be out of sight): ⌘⇧V and the terminal list's menu seal a reply, ⌘⇧T takes a tab over and hands it back,
/// ⌘+ and ⌘− zoom. The words are MainStatus (MacCore).
struct MainStatusBar: View {
    let state: MainWindowState
    let head: TerminalHead
    let model: AppModel
    let browser: BrowserPageModel?
    let seal: () -> Void
    @Environment(\.interfaceLook) private var look

    static let height: CGFloat = 24

    var body: some View {
        HStack(spacing: 14) {
            // The app's words keep their room: a long line on the right (a note, what an agent waits for) gives way.
            HStack(spacing: 14) {
                gateway
                if let phones = MainStatus.phones(model.devicesKnown ? model.devices : nil, online: model.remote?.onlineDevices,
                                                  remoteEnabled: model.remoteEnabled) {
                    if look.isClassic { Rectangle().fill(Look.line).frame(width: 1, height: 12) } else { Text("│").foregroundStyle(Look.line) }
                    Text(phones)
                }
            }
            .fixedSize()
            Spacer(minLength: 12)
            switch state.page {
            case .terminals:
                if let context = head.shown { TerminalStatusItems(context: context, seal: seal) }
            case .browser:
                if let browser {
                    BrowserHoldItems(model: browser)
                    BrowserZoomItems(model: browser)
                }
            case .dispatch:
                ForEach(MainStatus.dispatch(router: state.dispatchRouter, topics: state.dispatchTopics), id: \.self) { Text($0) }
            }
        }
        .mono(11.5)
        .foregroundStyle(Look.ink2)
        .lineLimit(1)
        .padding(.leading, 12)
        .padding(.trailing, 10)
    }

    /// `■ Gateway`: green while the service and the gateway answer, red with the trouble while one does not.
    private var gateway: some View {
        let word = MainStatus.gateway(service: StatusText.service(model.daemonState, ready: model.daemonReady), gateway: model.gateShortLine)
        let color: Color = switch word.tone {
        case .ok: .ok
        case .busy: .busy
        case .failed: .failed
        }
        return HStack(spacing: 6) {
            PixelSprite(rows: PixelArt.square, pixel: 2, color: color)
            Text(ClassicWords.word(word.text, in: look)).foregroundStyle(word.tone == .failed ? Color.failed : Look.ink2)
        }
        .help(word.text == "Service Down" ? model.daemonLine.text : model.gateLine.text)
    }
}

/// The terminal on screen: `✱ claude · Opus 5.5  bypass  On Mac · 139×46  🔒` — the agent's mark and model, the
/// permission mode, where its size is and its grid, and the lock that opens the sealed reply's box under the terminal
/// (the bar that was there, ⌘⇧V); the lock is dimmed while the terminal has ended.
private struct TerminalStatusItems: View {
    let context: TerminalContext
    let seal: () -> Void
    @State private var hovering = false
    @Environment(\.interfaceLook) private var look

    var body: some View {
        HStack(spacing: 14) {
            HStack(spacing: 7) {
                AgentSprite(harness: context.harness)
                Text(context.agent(in: look)).truncationMode(.tail)
            }
            if let mode = context.mode { Text(ClassicWords.word(mode, in: look)) }
            Text(context.size(in: look))
            Button(action: seal) {
                PixelSprite(rows: PixelArt.lock, pixel: 2, color: !context.running ? Look.line : hovering ? Color.signal : Look.ink2,
                            strength: !context.running ? 0.28 : hovering ? 1 : 0.85, shadow: false)
                    .frame(width: 22, height: 20)
                    .background(RoundedRectangle(cornerRadius: 5).fill(Color(white: 0.5).opacity(context.running && hovering ? 0.16 : 0)))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!context.running)
            .onHover { hovering = $0 }
            .help(look.isClassic ? "Encrypt & Send (⌘⇧V)：密码与令牌在发送前加密，agent 仅接收密文。" : "Encrypt & Send ⌘⇧V：密码与令牌在发送前加密，agent 仅接收密文。")
            .accessibilityLabel("Encrypt & Send")
        }
    }
}

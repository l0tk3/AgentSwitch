import AgentSwitchMacCore
import SwiftUI

/// The status bar (docs/dispatch-v0.md §1, 左侧图标栏与整窗状态栏; demo `implemented/window-bars.html`, proposal B,
/// 2026-10-03): 24 pt across the whole window, under the rail and the page, a solid edge above it. Its left is the app's
/// and the same on every page: `«` / `»`, which puts the rail away and brings it back (2026-10-05, RailToggle); the gateway (a green square and `Gateway`; a red one and `Service Down` / `Gateway Down`,
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

    /// 26 pt since 2026-10-05 (24 before): its words at the bar's 12 pt and its buttons the bar's own size — the two
    /// bars on one ruler (demo `docs/design/concepts/bars.html`).
    static let height: CGFloat = 26

    var body: some View {
        HStack(spacing: 14) {
            // The app's words keep their room: a long line on the right (a note, what an agent waits for) gives way.
            HStack(spacing: 14) {
                // `«` / `»`: the rail put away or brought back, under the rail's middle whether it is there or not.
                RailToggle(state: state)
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
                    // Tabs with windows of their own are held, sized and zoomed in their windows (docs/browser-v0.md §7.2).
                    if !browser.windows {
                        BrowserHoldItems(model: browser)
                        BrowserZoomItems(model: browser)
                    }
                    // Last: the engine's word and the browser's identity, which opens its box (docs/browser-v0.md §7.2).
                    BrowserIdentityItems(model: browser.identity)
                }
            case .dispatch:
                ForEach(MainStatus.dispatch(router: state.dispatchRouter, topics: state.dispatchTopics), id: \.self) { Text($0) }
            }
        }
        .mono(12)
        .foregroundStyle(Look.ink2)
        .lineLimit(1)
        .padding(.leading, look.isClassic ? RailToggle.classicLeading : RailToggle.pixelLeading)
        // Its last button ends where the bar's does.
        .padding(.trailing, look.isClassic ? 6 : 8)
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
struct TerminalStatusItems: View {
    let context: TerminalContext
    let seal: () -> Void
    private static let sealOffered = false
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
            // The lock (Encrypt & Send) is gone with the gate from terminals (docs/profiles-v0.md §8, 2026-10-08: a
            // terminal's reply is typed as written). Its place is the browser's, when profiles bring one.
            if Self.sealOffered { Button(action: seal) {
                Group {
                    if look.isClassic {
                        // The bar's buttons' size and weight.
                        Image(systemName: "lock").font(.system(size: 12.5, weight: .regular))
                            .foregroundStyle(!context.running ? Look.line : hovering ? Color.signal : Look.ink2)
                    } else {
                        PixelSprite(rows: PixelArt.lock, pixel: 2, color: !context.running ? Look.line : hovering ? Color.signal : Look.ink2,
                                    strength: !context.running ? 0.28 : hovering ? 1 : 0.85, shadow: false)
                    }
                }
                .frame(width: look.isClassic ? 26 : 28, height: 22)
                .background(RoundedRectangle(cornerRadius: look.isClassic ? Look.controlRadius : 0).fill(Color(white: 0.5).opacity(context.running && hovering ? 0.16 : 0)))
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
}

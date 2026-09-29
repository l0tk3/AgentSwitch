import AgentSwitchKit
import SwiftUI

/// One terminal on the phone (docs/terminal-v0.md §1): the live screen (drag to scroll, pinch for the text size, tap to
/// put the keyboard away), permission requests as cards over its top, the key bar and the reply box under it. A reply
/// goes as typed (checked for secret-looking text first) or, from the lock, through the Mac's sealer in the sealed box;
/// `/` lists the agent's commands; keys go by name. The menu renames or closes it (asked first; the record may go too).
struct TerminalPage: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @AppStorage("terminal.fontSize") private var fontSize: Double = 10
    @State private var page: TerminalPageModel
    @State private var reply = ""
    @State private var renaming = false
    @State private var newName = ""
    @State private var confirmClose = false
    /// The sealed box is open (the lock): the reply goes through the sealer.
    @State private var sealing = false
    /// A direct reply that looks like it holds a secret, asked about before it goes.
    @State private var secretCheck: String?
    @FocusState private var replying: Bool

    init(terminal: TerminalInfo) {
        let size = UserDefaults.standard.object(forKey: "terminal.fontSize") as? Double ?? 10
        _page = State(initialValue: TerminalPageModel(terminal: terminal, fontSize: CGFloat(size)))
    }

    var body: some View {
        ZStack(alignment: .top) {
            TerminalScreen(controller: page.screen, onPinchEnded: { size in fontSize = Double(size) },
                           onWheel: { up, count in page.wheel(up: up, count: count) }, onTap: { replying = false })
                .padding(.horizontal, 6)
            if !page.drawn {
                HStack(spacing: 6) {
                    BrailleSpinner(color: .secondary)
                    Text("connecting").mono(12).foregroundStyle(.secondary)
                }
                .padding(.top, 60)
            }
            VStack(spacing: 10) {
                ForEach(page.permissions) { p in permissionCard(p) }
            }
            .padding(.horizontal, Theme.Space.m)
            .padding(.top, Theme.Space.s)
        }
        .background(Color.black)
        .safeAreaInset(edge: .bottom, spacing: 0) { controls }
        // The whole height for the screen; back returns to the tabs.
        .toolbar(.hidden, for: .tabBar)
        // The screen keeps the Mac's (dark) terminal colours in light mode too: the bar over it reads light on dark.
        .toolbarColorScheme(.dark, for: .navigationBar)
        .toolbarBackground(Color.black, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 1) {
                    Text(page.name).font(.headline).lineLimit(1)
                    HStack(spacing: 5) {
                        TerminalStatusMark(status: page.permissions.isEmpty ? page.status : .waiting)
                        Text(page.permissions.isEmpty ? page.status.label : "waiting").mono(11).foregroundStyle(.secondary)
                    }
                }
            }
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button("rename") { newName = page.name; renaming = true }
                    Button("close", role: .destructive) { if page.status == .exited && !canDeleteRecord { Task { await close() } } else { confirmClose = true } }
                } label: { Text("⋯").mono(17) }
                .tint(Theme.ink)
            }
        }
        .alert("rename", isPresented: $renaming) {
            TextField("名称（留空恢复自动命名）", text: $newName)
            Button("save") { Task { await page.rename(newName) } }
            Button("cancel", role: .cancel) {}
        }
        .confirmationDialog("关闭「\(page.name)」？", isPresented: $confirmClose, titleVisibility: .visible) {
            Button("close", role: .destructive) { Task { await close() } }
            if canDeleteRecord {
                Button("close and delete record", role: .destructive) { Task { await close(deleteRecord: true) } }
            }
        } message: {
            Text(canDeleteRecord ? "程序将结束并从列表移除。会话记录默认保留，之后可继续；删除记录后无法恢复。" : "程序将结束并从列表移除；会话记录保留，之后可继续。")
        }
        .confirmationDialog("这段文字可能包含密码或令牌", isPresented: Binding(get: { secretCheck != nil }, set: { if !$0 { secretCheck = nil } }),
                            titleVisibility: .visible, presenting: secretCheck) { text in
            Button("加密发送") { Task { await send(text, sealed: true) } }
            Button("仍然直接发送", role: .destructive) { Task { await send(text, sealed: false) } }
        } message: { _ in
            Text("加密发送时，Mac 会先把其中的凭据换成密文，再交给 agent。")
        }
        .onAppear {
            page.start(model.api, style: model.terminals.style)
            #if DEBUG
            switch UserDefaults.standard.string(forKey: "uiDemoScreen") {
            case "terminalsealed":
                reply = "my password is hunter2"
                // After the page has slid in, as a tap on the lock would: the box glitches open.
                DispatchQueue.main.asyncAfter(deadline: .now() + 3) { sealing = true }
            case "terminalslash": reply = "/co"
            default: break
            }
            #endif
        }
        .onDisappear { page.stop() }
        .onChange(of: page.removed) { if page.removed { model.terminals.remove(page.id); dismiss() } }
        .onChange(of: fontSize) { page.screen.setFontSize(CGFloat(fontSize)) }
    }

    // MARK: permission requests

    private func permissionCard(_ p: TerminalPermission) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                PixelSprite(rows: PixelArt.square, pixel: 2, color: Theme.waiting)
                Text("permission · \(p.tool)").mono(12, weight: .semibold).foregroundStyle(Theme.waiting)
            }
            Text(p.detail).font(.callout.monospaced()).foregroundStyle(Theme.ink).lineLimit(6).textSelection(.enabled)
            HStack(spacing: Theme.Space.m) {
                Button("[ deny ]") { Task { await page.decide(p, allow: false) } }.buttonStyle(SquareButtonStyle(destructive: true))
                Button("[ allow ]") { Task { await page.decide(p, allow: true) } }.buttonStyle(SquareButtonStyle(prominent: true))
            }
        }
        .padding(14)
        .background(Theme.base)
        .overlay(Rectangle().strokeBorder(Theme.ink, lineWidth: 1))
        // The floating layer's hard, dithered shadow (§7.3), not a blur.
        .background(DitherShadow().offset(x: 6, y: 6))
    }

    // MARK: keys and reply

    static let keys: [(TerminalKey, String)] = [(.esc, "esc"), (.tab, "tab"), (.shiftTab, "⇧tab"), (.up, "↑"), (.down, "↓"),
                                                (.left, "←"), (.right, "→"), (.pageUp, "pgup"), (.pageDown, "pgdn"), (.ctrlC, "^C"),
                                                (.enter, "⏎"), (.y, "y"), (.n, "n"), (.one, "1"), (.two, "2"), (.three, "3")]

    private var controls: some View {
        VStack(spacing: 0) {
            if !suggestions.isEmpty { suggestionList }
            Theme.line.frame(height: 1)
            if let error = page.error {
                HStack {
                    Text(error).font(.footnote).foregroundStyle(Theme.failed).lineLimit(2)
                    Spacer()
                    Button { page.error = nil } label: { Text("×").mono(15) }.buttonStyle(.plain).foregroundStyle(.secondary)
                }
                .padding(.horizontal, Theme.Space.l).padding(.top, 6)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    if replying {
                        Button { replying = false } label: { Image(systemName: "keyboard.chevron.compact.down").font(.system(size: 14)) }
                            .buttonStyle(KeyCapStyle())
                            .accessibilityLabel("hide keyboard")
                    }
                    ForEach(Self.keys, id: \.0) { key, label in
                        Button { Task { await page.press(key) } } label: { Text(label).mono(13) }
                            .buttonStyle(KeyCapStyle())
                            .disabled(page.status == .exited)
                    }
                }
                .padding(.horizontal, Theme.Space.l)
                .padding(.vertical, 8)
            }
            if sealing { sealedBox } else { replyRow }
            if let note = page.sealedNote {
                Text(note).mono(11).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, Theme.Space.l).padding(.bottom, 6)
            }
        }
        .background(Theme.base)
    }

    /// Typed as it is (the lock opens the sealed box instead).
    private var replyRow: some View {
        HStack(alignment: .bottom, spacing: Theme.Space.s) {
            Button { withAnimation(.snappy(duration: 0.18)) { sealing = true } } label: {
                PixelSprite(rows: PixelArt.lock, pixel: 3, color: Theme.signal)
            }
            .buttonStyle(SquareIconButtonStyle(active: false))
            .accessibilityLabel("sealed reply")
            TextField("回复", text: $reply, axis: .vertical)
                .lineLimit(1...5)
                .focused($replying)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .overlay(Rectangle().strokeBorder(Theme.line, lineWidth: 1))
            Button { Task { await sendDirect() } } label: { sendLabel }
                .buttonStyle(SquareIconButtonStyle(active: canSend || page.sending))
                .disabled(!canSend)
                .accessibilityLabel("send")
        }
        .padding(.horizontal, Theme.Space.l)
        .padding(.bottom, Theme.Space.s)
    }

    /// The desktop's sealed composer (ui-v0 §7.4): a framed box with a signal head bar naming the terminal and a hard
    /// dithered shadow; it glitches as it opens; the reply goes through the sealer, then the box closes.
    private var sealedBox: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                PixelSprite(rows: PixelArt.lock, pixel: 2, color: .black)
                Text("sealed → \(page.name)").mono(12).lineLimit(1)
                Spacer(minLength: 4)
                Button { withAnimation(.snappy(duration: 0.18)) { sealing = false } } label: { Text("×").mono(15) }
                    .buttonStyle(.plain)
                    .accessibilityLabel("cancel")
            }
            .foregroundStyle(.black)
            .padding(.horizontal, 8)
            .frame(height: 26)
            .background(Theme.signal)
            TextField("message", text: $reply, axis: .vertical)
                .mono(14)
                .lineLimit(2...6)
                .focused($replying)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .padding(.horizontal, 12)
                .padding(.top, 10)
            HStack(spacing: Theme.Space.s) {
                Text("凭据在 Mac 上换成密文后再交给 agent").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                Spacer(minLength: 4)
                Button { Task { await send(reply, sealed: true) } } label: {
                    if page.sending { BrailleSpinner(color: Theme.base) } else { Text("[ send ]") }
                }
                .buttonStyle(SquareButtonStyle(prominent: true))
                .fixedSize()
                .disabled(!canSend)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
        }
        .background(Theme.base)
        .overlay(Rectangle().strokeBorder(Theme.ink, lineWidth: 1))
        .background(DitherShadow().offset(x: 6, y: 6))
        .glitch(on: sealing, onAppear: true)
        .padding(.leading, Theme.Space.l)
        .padding(.trailing, Theme.Space.l + 6)
        .padding(.bottom, Theme.Space.m + 6)
        .onAppear { replying = true }
    }

    @ViewBuilder
    private var sendLabel: some View {
        if page.sending { BrailleSpinner(color: Theme.base) } else { Text("↑").font(.system(size: 18, weight: .bold, design: .monospaced)) }
    }

    // MARK: slash commands

    private var suggestions: [SlashCommand] { sealing ? [] : SlashCommand.matching(reply, in: page.commands) }

    /// What `/` may be: tap one to put it in the box (a space after it, ready for arguments).
    private var suggestionList: some View {
        VStack(alignment: .leading, spacing: 0) {
            Theme.line.frame(height: 1)
            ForEach(suggestions) { c in
                Button { reply = "/\(c.name) " } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text("/\(c.name)").mono(13, weight: .medium).foregroundStyle(Theme.ink).lineLimit(1).fixedSize()
                        Text(c.description).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        Spacer(minLength: 0)
                        if c.source != "builtin" { Text(c.source).mono(10).foregroundStyle(.tertiary) }
                    }
                    .padding(.horizontal, Theme.Space.l)
                    .padding(.vertical, 8)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .background(Theme.raised)
    }

    private var canSend: Bool {
        !page.sending && page.status != .exited && !reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Typed straight in, unless it looks like a secret: then asked which way.
    private func sendDirect() async {
        guard canSend else { return }
        if SecretHint.looksSecret(reply) { secretCheck = reply; return }
        await send(reply, sealed: false)
    }

    private func send(_ text: String, sealed: Bool) async {
        if await page.send(text, sealed: sealed) {
            if reply == text { reply = "" }
            if sealed { withAnimation(.snappy(duration: 0.18)) { sealing = false } }
        }
    }

    /// It wrote a session of its own that the Mac can delete (one continued in place stays: the Mac refuses).
    private var canDeleteRecord: Bool { page.ownsRecord && TerminalsTab.deletable.contains(page.harness) }

    private func close(deleteRecord: Bool = false) async {
        if await page.close(deleteRecord: deleteRecord) {
            model.terminals.remove(page.id)
            dismiss()
        }
    }
}

/// A key on the bar: a small square cap with a 2 pt base (§7.3: the key bar's caps have 2 px of thickness).
private struct KeyCapStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(Theme.ink)
            .frame(minWidth: 34)
            .padding(.horizontal, 6)
            .padding(.vertical, 7)
            .background(configuration.isPressed ? Theme.line : Theme.raised)
            .overlay(Rectangle().strokeBorder(Theme.line, lineWidth: 1))
            .overlay(alignment: .bottom) { Theme.inkDim.frame(height: 2) }
    }
}

/// The dithered hard shadow of a floating layer (a 50 % checkerboard of 1 pt cells).
struct DitherShadow: View {
    var body: some View {
        Canvas { context, size in
            var y: CGFloat = 0
            var row = 0
            while y < size.height {
                var x: CGFloat = row % 2 == 0 ? 0 : 1
                while x < size.width {
                    context.fill(Path(CGRect(x: x, y: y, width: 1, height: 1)), with: .color(Theme.inkDim))
                    x += 2
                }
                y += 1
                row += 1
            }
        }
        .accessibilityHidden(true)
    }
}

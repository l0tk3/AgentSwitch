import AgentSwitchKit
import SwiftUI

/// One terminal on the phone (docs/terminal-v0.md §1): the live screen (pinch for the text size), permission requests
/// as cards over its top, the key bar and the reply box under it. The reply goes through the Mac's sealer; keys go by
/// name. The menu renames or closes it (closing a running one asks first; the agent's own record stays).
struct TerminalPage: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @AppStorage("terminal.fontSize") private var fontSize: Double = 10
    @State private var page: TerminalPageModel
    @State private var reply = ""
    @State private var renaming = false
    @State private var newName = ""
    @State private var confirmClose = false
    @FocusState private var replying: Bool

    init(terminal: TerminalInfo) {
        let size = UserDefaults.standard.object(forKey: "terminal.fontSize") as? Double ?? 10
        _page = State(initialValue: TerminalPageModel(terminal: terminal, fontSize: CGFloat(size)))
    }

    var body: some View {
        ZStack(alignment: .top) {
            TerminalScreen(controller: page.screen) { size in fontSize = Double(size) }
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
                    Button("close", role: .destructive) { if page.status == .exited { Task { await close() } } else { confirmClose = true } }
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
        } message: {
            Text("程序将结束并从列表移除；会话记录保留，之后可继续。")
        }
        .onAppear { page.start(model.api, style: model.terminals.style) }
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
                                                (.left, "←"), (.right, "→"), (.ctrlC, "^C"), (.enter, "⏎"), (.y, "y"), (.n, "n"),
                                                (.one, "1"), (.two, "2"), (.three, "3")]

    private var controls: some View {
        VStack(spacing: 0) {
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
                    ForEach(Self.keys, id: \.0) { key, label in
                        Button { Task { await page.press(key) } } label: { Text(label).mono(13) }
                            .buttonStyle(KeyCapStyle())
                    }
                }
                .padding(.horizontal, Theme.Space.l)
                .padding(.vertical, 8)
            }
            .disabled(page.status == .exited)
            HStack(alignment: .bottom, spacing: Theme.Space.s) {
                TextField("回复（经 Mac 加密后发送）", text: $reply, axis: .vertical)
                    .lineLimit(1...5)
                    .focused($replying)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .overlay(Rectangle().strokeBorder(Theme.line, lineWidth: 1))
                Button {
                    Task {
                        if await page.send(reply) { reply = "" }
                    }
                } label: {
                    if page.sending { BrailleSpinner(color: Theme.base) } else { Text("↑").font(.system(size: 18, weight: .bold, design: .monospaced)) }
                }
                .buttonStyle(SquareIconButtonStyle(active: canSend || page.sending))
                .disabled(!canSend)
                .accessibilityLabel("send")
            }
            .padding(.horizontal, Theme.Space.l)
            .padding(.bottom, Theme.Space.s)
            if let note = page.sealedNote {
                Text(note).mono(11).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, Theme.Space.l).padding(.bottom, 6)
            }
        }
        .background(Theme.base)
    }

    private var canSend: Bool {
        !page.sending && page.status != .exited && !reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func close() async {
        if await page.close() {
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

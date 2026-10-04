import AgentSwitchKit
import SwiftUI

/// One tab on the phone (docs/browser-v0.md §1, demo page `docs/design/implemented/browser.html`): the address on top (the
/// lock and the place; tap to edit) with `⋯` (Copy URL, Reload, Close Tab); under it who holds the tab — the agent and
/// what it is doing, or `You`; the live picture, the agent's last action outlined on it; the bar at the bottom — `‹ ›
/// ↻`, the keyboard, the zoom (`100%`), and on an agent's tab `[ Take Over ]` / `[ Hand Back ]`. Typing brings the
/// system keyboard and the key bar (`esc tab ⏎ ⌫ ← →`, as the terminal page's caps, and on your own tabs `⚿ Fill
/// Ciphertext`); the zoom key opens the zoom row in its place (`− 100% +`, BrowserZoomBar).
struct BrowserPage: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var page: BrowserPageModel
    @State private var editing = false
    @State private var address = ""
    @FocusState private var addressFocused: Bool
    @State private var composing = ""
    @State private var confirmClose = false
    @State private var pickingCiphertext = false
    @State private var makingCiphertext = false
    /// On screen (another tab of the app hides it without leaving it): only then does coming back to the app restart
    /// the stream.
    @State private var visible = false
    /// The zoom row is open over the bar (browser-v0 §1 页面缩放, 2026-10-03): never together with the key bar, closed
    /// when the page is left.
    @State private var zooming = false
    /// The link's speed the picture was last asked by (Tailscale; nil: not measured, or it told nothing): a new zoom
    /// asks again by the same.
    @State private var mbps: Double?

    init(tab: BrowserTabInfo) {
        _page = State(initialValue: BrowserPageModel(tab: tab))
    }

    var body: some View {
        let store = model.browser
        VStack(spacing: 0) {
            holderLine
            HairRule()
            screenArea
        }
        .background { Theme.base.ignoresSafeArea() }
        .safeAreaInset(edge: .bottom, spacing: 0) { controls(store) }
        .toolbar(.hidden, for: .tabBar)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarRole(.editor)
        .toolbar {
            ToolbarItem(placement: .principal) { addressBar }
            ToolbarItem(placement: .primaryAction) { menu }
        }
        .onAppear {
            visible = true
            page.agentName = model.agentName(of: page.tab.owner)
            page.store = model.browser
            let known = model.browser.knownSpeed(on: model.connection.endpoint) ?? nil
            mbps = known
            page.start(model.api, options: streamOptions(mbps: known))
            measure()
            #if DEBUG
            switch UserDefaults.standard.string(forKey: "uiDemoScreen") {
            case "browserclose": DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { confirmClose = true }
            // After the page has slid in and its picture is drawn, as a tap on the zoom key would; on codex's tab,
            // only watched, two more on `+` (the picture at 150%).
            case "browserzoom": DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { zooming = true }
            case "browserzoomwatch":
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                    zooming = true
                    page.zoomIn()
                    page.zoomIn()
                }
            default: break
            }
            #endif
        }
        .onDisappear {
            visible = false
            zooming = false
            page.stop()
        }
        // In the background the stream ends and the tab goes back; in front again, the stream comes back.
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .background: page.stop()
            case .active:
                if visible {
                    page.resume()
                    measure()
                }
            default: break
            }
        }
        .onChange(of: page.closed) {
            if page.closed != nil {
                zooming = false
                model.browser.remove(page.id)
            }
        }
        // The zoom this phone sets the page at changes what the stream asks (a page zoomed in is fewer CSS pixels
        // across the same screen, one zoomed out more): asked again, as after a measure.
        .onChange(of: page.streamZoom) { page.retune(streamOptions(mbps: mbps)) }
        // The zoom row and the key bar never show together: a keyboard coming up (the page's, the address bar's)
        // closes the row.
        .onChange(of: page.typing) { if page.typing { zooming = false } }
        .onChange(of: editing) { if editing { zooming = false } }
        .pixelBox(isPresented: $confirmClose) {
            PixelBox(head: "Close Tab", tone: .red,
                     message: "关闭「\(page.tab.displayTitle)」？\(page.agentName) 正在使用此标签，关闭后它对此标签的操作将失败。",
                     actions: [.init(label: "Close", role: .primary) { Task { await close() } }])
        }
        .sheet(isPresented: $pickingCiphertext) {
            CiphertextPicker(title: "Fill Ciphertext") { token in Task { if !(await page.fill(token)) { model.browser.fillUnavailable = true } } }
        }
        .sheet(isPresented: $makingCiphertext) { NavigationStack { CiphertextsView() } }
    }

    /// What the stream asks for on this link: the local network the screen's device pixels; Tailscale by the speed
    /// measured (browser-v0 §1 iPhone; `mbps` nil — not measured yet, or nothing to tell — the slow way); either way
    /// times the zoom this phone sets the page at.
    private func streamOptions(mbps: Double?) -> BrowserStreamOptions {
        let screen = UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.screen }.first
        let pixels = screen.map { CGSize(width: $0.bounds.width * $0.scale, height: $0.bounds.height * $0.scale) }
        return BrowserStreamPolicy.options(kind: model.connection.endpoint?.kind, mbps: mbps, screenPixels: pixels, screenScale: screen.map { Double($0.scale) },
                                           zoom: page.streamZoom)
    }

    /// Over Tailscale: the link measured (or the measure from the last minute on this address), and the stream asked
    /// again when the picture it allows differs from the one asked for.
    private func measure() {
        let endpoint = model.connection.endpoint
        guard BrowserStreamPolicy.measures(endpoint?.kind) else { return }
        Task {
            let measured = await model.browser.speed(model.api, on: endpoint)
            guard visible, model.connection.endpoint == endpoint else { return }
            mbps = measured
            page.retune(streamOptions(mbps: measured))
        }
    }

    // MARK: the address

    private var addressBar: some View {
        let shown = BrowserAddress.display(page.tab.url)
        return Group {
            if editing {
                TextField("网址、Mac 上的路径或 localhost:5173", text: $address)
                    .mono(13)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .submitLabel(.go)
                    .focused($addressFocused)
                    .onSubmit {
                        let typed = address
                        editing = false
                        model.browser.remember(typed)
                        Task { await page.navigate(typed) }
                    }
                    .onChange(of: addressFocused) { if !addressFocused { editing = false } }
            } else {
                Button {
                    guard page.canDrive else { return }
                    page.typing = false
                    address = page.tab.url == "about:blank" ? "" : page.tab.url
                    editing = true
                    addressFocused = true
                } label: {
                    HStack(spacing: 6) {
                        if page.tab.loading {
                            BrailleSpinner(color: .secondary)
                        } else if shown.secure {
                            PixelSprite(rows: PixelArt.lock, pixel: 2, color: .secondary, strength: 0.7, shadow: false, picture: .lockSmall)
                        }
                        Text(shown.text.isEmpty ? "about:blank" : shown.text).mono(12).lineLimit(1).truncationMode(.middle)
                        Spacer(minLength: 0)
                    }
                    .foregroundStyle(Theme.ink)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("地址 \(shown.text)")
                .accessibilityHint(page.canDrive ? "编辑地址" : "")
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .frame(minWidth: 230, maxWidth: .infinity)
        .framed(Theme.line, radius: Theme.Radius.control)
    }

    private var menu: some View {
        Menu {
            Button("Copy URL", systemImage: "doc.on.doc") { UIPasteboard.general.string = page.tab.url }
            Button("Reload", systemImage: "arrow.clockwise") { Task { await page.history(.reload) } }
                .disabled(!page.canDrive)
            Button("Close Tab", systemImage: "xmark", role: .destructive) {
                if page.tab.owner.isAgent { confirmClose = true } else { Task { await close() } }
            }
        } label: { LookGlyph.more }
        .tint(Theme.ink)
    }

    // MARK: who holds it

    /// The agent and what it is doing; `You` (taken over from it, at the phone's size); or the screen that has it.
    @ViewBuilder
    private var holderLine: some View {
        let tab = page.tab
        HStack(spacing: 7) {
            if page.mine && tab.owner.isAgent {
                PixelSprite(rows: PixelArt.square, pixel: 2, color: Theme.signal)
                (Text("You") + Text(" · Taken Over from \(page.agentName)").foregroundStyle(.secondary))
                    .mono(11).foregroundStyle(Theme.signal).lineLimit(1)
                Spacer(minLength: 6)
                if page.phoneSized { Text("Phone Size").mono(11).foregroundStyle(.secondary) }
            } else if let holder = page.heldElsewhere {
                PixelSprite(rows: PixelArt.square, pixel: 2, color: Theme.inkDim)
                Text(holder.label).mono(11).foregroundStyle(.secondary)
                Spacer(minLength: 6)
                if tab.owner.isAgent { Text(tab.owner.label).mono(11).foregroundStyle(.tertiary).lineLimit(1) }
            } else if tab.owner.isAgent {
                PixelSprite(rows: PixelArt.agents[model.harness(of: tab.owner) ?? ""] ?? PixelArt.square, pixel: 2, color: .secondary, strength: 0.8, shadow: false)
                Text(tab.owner.label).mono(11).foregroundStyle(.secondary).lineLimit(1)
                Spacer(minLength: 6)
                agentDoing(tab)
            } else {
                // Your own tab: this phone's while it is open here (a solid square), or nobody's for now.
                PixelSprite(rows: page.mine ? PixelArt.square : PixelArt.hollow, pixel: 2, color: page.mine ? Theme.signal : Theme.inkDim)
                Text("You").mono(11).foregroundStyle(page.mine ? Theme.signal : .secondary)
                Spacer(minLength: 6)
                Text(placeNote(tab)).mono(11).foregroundStyle(.tertiary).lineLimit(1).truncationMode(.middle)
            }
        }
        .padding(.horizontal, Theme.Space.m)
        .frame(height: 26)
        .glitch(on: tab.status, when: { $0 == .waiting })
        .glitch(on: tab.heldBy)
    }

    @ViewBuilder
    private func agentDoing(_ tab: BrowserTabInfo) -> some View {
        switch tab.status {
        case .busy:
            BrailleSpinner()
            if let action = tab.action { Text(action.description.isEmpty ? action.tool : action.description).mono(11).foregroundStyle(.secondary).lineLimit(1) }
        case .waiting:
            PixelSprite(rows: PixelArt.square, pixel: 2, color: Theme.waiting).waitingBlink()
            Text(tab.waitingReason ?? "Waiting").mono(11).foregroundStyle(Theme.waiting).lineLimit(1)
        default:
            Text(tab.status.label).mono(11).foregroundStyle(.tertiary)
        }
    }

    /// Your own tab's line: what is open on the Mac.
    private func placeNote(_ tab: BrowserTabInfo) -> String {
        switch tab.kind {
        case .file: return "Mac 上的文件"
        case .local:
            let port = Int(tab.site.split(separator: ":").last ?? "") ?? 0
            guard let server = model.browser.server(port: port) else { return tab.site }
            return [server.name, MacPath.tilde(server.cwd)].filter { !$0.isEmpty }.joined(separator: " · ")
        case .web, .blank: return ""
        }
    }

    // MARK: the picture

    private var screenArea: some View {
        GeometryReader { g in
            ZStack(alignment: .top) {
                BrowserScreen(view: page.screen, layout: page.layout,
                              onTap: { point in editing = false; page.tap(at: point) },
                              onLongPress: { page.longPress(at: $0) },
                              onDrag: { delta, at in page.drag(delta, at: at) },
                              onPinch: { page.pinch($0, at: $1) },
                              onPan: { page.pan($0) })
                    .screenRefresh(on: page.refreshes, ground: Theme.base)
                if page.frameSize == nil && page.closed == nil {
                    HStack(spacing: 6) {
                        BrailleSpinner(color: .secondary)
                        Text("Connecting").mono(12).foregroundStyle(.secondary)
                    }
                    .padding(.top, 60)
                }
                HStack(alignment: .top) {
                    if page.connection == .reconnecting { chip { BrailleSpinner(color: .secondary); Text("Reconnecting") } }
                    Spacer()
                    if page.zoom.isZoomed {
                        Button { page.resetZoom() } label: { chip { Text(page.zoom.times); Text("×").foregroundStyle(.secondary) } }
                            .buttonStyle(.plain)
                            .accessibilityLabel("恢复原始大小")
                    }
                }
                .padding(8)
                if let reason = page.closed { closedCover(reason) }
            }
            .onAppear { page.area = g.size }
            .onChange(of: g.size) { page.area = g.size }
        }
        .clipped()
    }

    private func chip<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        HStack(spacing: 5) { content() }
            .mono(11)
            .foregroundStyle(Theme.ink)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(Theme.base)
            .framed(Theme.ink, radius: Theme.Radius.card)
    }

    /// The tab is gone (closed elsewhere, the browser quit): why, over the last picture, dithered.
    private func closedCover(_ reason: BrowserClosedReason) -> some View {
        ZStack {
            Theme.base.opacity(0.5)
            Checker(color: Theme.base)
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 6) {
                    PixelSprite(rows: PixelArt.square, pixel: 2, color: Theme.base)
                    Text("Closed").mono(12, weight: .semibold)
                }
                .foregroundStyle(Theme.base)
                .padding(.horizontal, 10)
                .frame(maxWidth: .infinity, minHeight: 24, alignment: .leading)
                .background(Theme.ink)
                Text(reason.said).font(.callout).foregroundStyle(Theme.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 12).padding(.top, 12)
                HStack {
                    Spacer()
                    Button { dismiss() } label: { ButtonWord("Back") }.buttonStyle(SquareButtonStyle(prominent: true, expand: false))
                }
                .padding(12)
            }
            .background(Theme.base)
            .framed(Theme.ink, radius: Theme.Radius.card)
            .background(DitherShadow().offset(x: 6, y: 6))
            .padding(.horizontal, 28)
            .glitch(on: reason, onAppear: true)
        }
    }

    // MARK: the bars

    /// What an input needs, as the terminal page's caps (⏎ the one solid key).
    static let keys: [(BrowserKey, String)] = [(.escape, "esc"), (.tab, "tab"), (.enter, "⏎"), (.backspace, "⌫"), (.arrowLeft, "←"), (.arrowRight, "→")]

    private func controls(_ store: BrowserStore) -> some View {
        VStack(spacing: 0) {
            if let words = page.error ?? page.note {
                HStack(alignment: .firstTextBaseline) {
                    Text(words).font(.footnote).foregroundStyle(page.error != nil ? Theme.failed : Color.secondary).lineLimit(3)
                    Spacer()
                    if page.error != nil {
                        Button { page.error = nil } label: { LookGlyph(glyph: "×", symbol: "xmark", size: 15) }.buttonStyle(.plain).foregroundStyle(.secondary)
                            .accessibilityLabel("close")
                    }
                }
                .padding(.horizontal, Theme.Space.l).padding(.vertical, 6)
                .glitch(on: words, onAppear: true)
            }
            if page.typing {
                keyBar(store)
            } else if zooming {
                BrowserZoomBar(percent: page.zoomPercent, canZoomOut: page.canZoomOut, canZoomIn: page.canZoomIn, pictureOnly: !page.zoomsPage,
                               onOut: { page.zoomOut() }, onReset: { page.zoomToStandard() }, onIn: { page.zoomIn() })
            }
            Theme.line.frame(height: 1)
            bottomBar
        }
        .background { Theme.base.ignoresSafeArea(edges: .bottom) }
        .background(alignment: .topLeading) {
            BrowserTypingField(typing: $page.typing, composing: $composing,
                               onText: { page.type($0) }, onKey: { page.press($0) })
                .frame(width: 1, height: 1)
                .allowsHitTesting(false)
        }
    }

    private func keyBar(_ store: BrowserStore) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            // The keyboard goes away from the bar's own key under this one.
            HStack(spacing: 5) {
                ForEach(Self.keys, id: \.0) { key, label in
                    Button { page.press(key) } label: { Text(label).mono(13, weight: key == .enter ? .semibold : .regular) }
                        .buttonStyle(KeyCapStyle(solid: key == .enter, compact: true))
                }
                // Your own tabs only: an agent sees its page again after the hand-back (the Mac refuses it there).
                if !store.fillUnavailable && page.canFill {
                    Button {
                        page.typing = false
                        if model.ciphertexts.isEmpty { makingCiphertext = true } else { pickingCiphertext = true }
                    } label: {
                        HStack(spacing: 5) {
                            PixelSprite(rows: PixelArt.lock, pixel: 2, color: Theme.signal, strength: 0.9, shadow: false, picture: .lockSmall)
                            Text("Fill Ciphertext").mono(12)
                        }
                        .foregroundStyle(Theme.signal)
                    }
                    .buttonStyle(KeyCapStyle(compact: true))
                    .overlay(Rectangle().strokeBorder(Theme.signal, lineWidth: 1).padding(.bottom, 0))
                    .accessibilityLabel("从密文填入")
                }
                if !composing.isEmpty { Text(composing).mono(13).foregroundStyle(.secondary).padding(.leading, 4) }
            }
            .padding(.horizontal, Theme.Space.m)
            .padding(.vertical, 8)
        }
        .background(Theme.raised.opacity(0.5))
    }

    /// `‹ › ↻`, the keyboard, the zoom, and `[ Take Over ]` / `[ Hand Back ]` where the tab is an agent's or another
    /// screen's.
    private var bottomBar: some View {
        let tab = page.tab
        let showsHold = tab.owner.isAgent || page.heldElsewhere != nil
        // With the hold button the five keys keep a fixed width and it takes the rest — narrow enough to leave it room
        // on a 375 pt phone (52 while there were four); without it they share the bar.
        let key: CGFloat? = showsHold ? 46 : nil
        return HStack(spacing: 0) {
            barButton("‹", label: "back", width: key) { Task { await page.history(.back) } }
            barButton("›", label: "forward", width: key) { Task { await page.history(.forward) } }
            barButton("↻", label: "reload", width: key) { Task { await page.history(.reload) } }
            Button {
                editing = false
                page.typing.toggle()
            } label: {
                Image(systemName: page.typing ? "keyboard.chevron.compact.down" : "keyboard").font(.system(size: 16))
                    .frame(minWidth: key, maxWidth: key ?? .infinity, minHeight: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(page.canDrive ? Theme.ink : Theme.inkDim)
            .disabled(!page.canDrive)
            .accessibilityLabel("keyboard")
            zoomKey(width: key)
            if showsHold {
                Group {
                    if page.mine {
                        Button { Task { await page.handBack() } } label: { ButtonWord("Hand Back") }
                    } else {
                        Button { Task { await page.takeOver() } } label: { ButtonWord("Take Over") }
                    }
                }
                .buttonStyle(HoldButtonStyle(waiting: tab.status == .waiting && !page.mine))
                .disabled(page.holding || page.closed != nil)
                .frame(maxWidth: .infinity)
            }
        }
        .padding(.horizontal, 6)
        .frame(height: 46)
    }

    /// The zoom in force (browser-v0 §1 页面缩放, 2026-10-03): the page's while this phone sizes the tab, the picture's
    /// while it only watches — in the signal colour when it is not 100%. Opens and closes the zoom row; the keyboard
    /// goes as it opens.
    private func zoomKey(width: CGFloat?) -> some View {
        let percent = page.zoomPercent
        let closed = page.closed != nil
        return Button {
            editing = false
            page.typing = false
            zooming.toggle()
        } label: {
            Text("\(percent)%").mono(12).frame(minWidth: width, maxWidth: width ?? .infinity, minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(closed ? Theme.inkDim : percent == BrowserPageZoom.standard ? Theme.ink : Theme.signal)
        .disabled(closed)
        .accessibilityLabel("缩放 \(percent)%")
    }

    private func barButton(_ glyph: String, label: String, width: CGFloat?, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(glyph).mono(19).frame(minWidth: width, maxWidth: width ?? .infinity, minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(page.canDrive ? Theme.ink : Theme.inkDim)
        .disabled(!page.canDrive)
        .accessibilityLabel(label)
    }

    private func close() async {
        if await page.close() {
            model.browser.remove(page.id)
            dismiss()
        }
    }
}

/// `[ Take Over ]` on the bar: ink words, filled while pressed (the demo page's .act); amber while the agent waits for
/// you, as a primary button.
private struct HoldButtonStyle: ButtonStyle {
    var waiting = false
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed
        configuration.label
            .mono(12.5, weight: .semibold)
            .lineLimit(1)
            .fixedSize()
            .foregroundStyle(pressed || waiting ? Theme.base : Theme.ink)
            .padding(.horizontal, 4)
            .padding(.vertical, 3)
            .background(pressed ? Theme.signal : waiting ? Theme.waiting : Color.clear)
            .opacity(enabled ? 1 : 0.45)
    }
}

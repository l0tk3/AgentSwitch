import SwiftUI
import UIKit

/// A floating box on the cell grid, as the desktop's confirm boxes and menus (docs/design/implemented/phone.html): a 1 pt
/// ink frame, square, a dithered hard shadow, a head bar in a status colour, the words in formal Chinese and the
/// buttons as short English words in brackets; it glitches as it opens. A confirm box dims what is under it; a menu
/// sits by the row it belongs to. A tap outside is cancel.
struct PixelBox {
    enum Tone { case plain, amber, red, signal }

    struct Action {
        enum Role { case normal, primary, destructive }
        let label: String
        var role: Role = .normal
        let run: () -> Void
    }

    var head: String?
    var tone: Tone = .plain
    var message = ""
    /// The way out first (`[ Cancel ]`); nil for a box that only informs, or where a tap outside is the way out.
    var cancel: String? = "Cancel"
    var actions: [Action]
    /// A menu: its actions as rows, placed under (or over) this rect on the screen.
    var anchor: CGRect?
}

/// One window above everything (a sheet, the tab bar) holds the box open now: the page under it keeps its keyboard and
/// its text field's focus. A box shown over another closes that one first.
@MainActor
final class PixelBoxWindow {
    static let shared = PixelBoxWindow()
    private var window: UIWindow?
    private var owner: UUID?
    private var closeShown: (() -> Void)?

    func show(_ box: PixelBox, owner: UUID, close: @escaping () -> Void) {
        if let previous = closeShown, self.owner != owner { previous() }
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        guard let scene = scenes.first(where: { $0.activationState == .foregroundActive }) ?? scenes.first else { return }
        let w = window ?? UIWindow(windowScene: scene)
        w.windowLevel = .alert
        w.backgroundColor = .clear
        let host = UIHostingController(rootView: PixelBoxLayer(box: box, close: close))
        host.view.backgroundColor = .clear
        host.view.accessibilityViewIsModal = true
        w.rootViewController = host
        w.isHidden = false
        window = w
        self.owner = owner
        closeShown = close
        UIAccessibility.post(notification: .screenChanged, argument: host.view)
    }

    func hide(owner: UUID) {
        guard self.owner == owner else { return }
        window?.isHidden = true
        window?.rootViewController = nil
        window = nil
        self.owner = nil
        closeShown = nil
    }
}

/// The veil and the box, over the whole screen.
private struct PixelBoxLayer: View {
    let box: PixelBox
    let close: () -> Void

    var body: some View {
        GeometryReader { g in
            ZStack(alignment: .topLeading) {
                // A menu leaves the screen as it is; a confirm box dims it.
                Color.black.opacity(box.anchor == nil ? 0.45 : 0.001)
                    .onTapGesture(perform: close)
                    .accessibilityLabel(box.cancel ?? "close")
                    .accessibilityAddTraits(.isButton)
                if let anchor = box.anchor {
                    menu.offset(menuOrigin(anchor, in: g.size))
                } else {
                    confirm
                        .padding(.leading, 22)
                        .padding(.trailing, 28)
                        .frame(width: g.size.width, height: g.size.height)
                }
            }
        }
        .ignoresSafeArea()
    }

    // MARK: confirm

    private var confirm: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let head = box.head {
                HStack(spacing: 8) {
                    Text(head).mono(12).lineLimit(2)
                    Spacer(minLength: 0)
                }
                .foregroundStyle(box.tone == .plain ? Theme.ink : Color.black)
                .padding(.horizontal, 8)
                .frame(minHeight: 24)
                .background(toneColor)
            }
            if !box.message.isEmpty {
                Text(box.message)
                    .font(.system(size: 13))
                    .lineSpacing(3)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 12)
                    .padding(.top, 10)
                    .padding(.bottom, 4)
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) {
                    Spacer(minLength: 0)
                    buttons
                }
                VStack(alignment: .trailing, spacing: 6) { buttons }
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
            .padding(.horizontal, 12)
            .padding(.top, 8)
            .padding(.bottom, 10)
        }
        .background(Theme.base)
        .overlay(Rectangle().strokeBorder(Theme.ink, lineWidth: 1))
        .background(DitherShadow().offset(x: 6, y: 6))
        .glitch(on: 0, onAppear: true)
    }

    @ViewBuilder
    private var buttons: some View {
        if let cancel = box.cancel {
            Button("[ \(cancel) ]", action: close).buttonStyle(BoxButtonStyle(role: .normal))
        }
        ForEach(Array(box.actions.enumerated()), id: \.offset) { _, a in
            Button("[ \(a.label) ]") { close(); a.run() }.buttonStyle(BoxButtonStyle(role: a.role))
        }
    }

    private var toneColor: Color {
        switch box.tone {
        case .plain: Theme.raised
        case .amber: Theme.waiting
        case .red: Theme.failed
        case .signal: Theme.signal
        }
    }

    // MARK: menu

    static let menuWidth: CGFloat = 180
    static let menuRow: CGFloat = 36

    private var menu: some View {
        VStack(spacing: 0) {
            ForEach(Array(box.actions.enumerated()), id: \.offset) { _, a in
                Button { close(); a.run() } label: {
                    HStack {
                        Text(a.label).mono(14)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 12)
                    .frame(height: Self.menuRow)
                    .contentShape(Rectangle())
                }
                .buttonStyle(MenuRowStyle(destructive: a.role == .destructive))
            }
        }
        .frame(width: Self.menuWidth)
        .background(Theme.base)
        .overlay(Rectangle().strokeBorder(Theme.ink, lineWidth: 1))
        .background(DitherShadow().offset(x: 6, y: 6))
        .glitch(on: 0, onAppear: true)
    }

    /// Under the row, at the right (as the desktop's); over it when there is no room below.
    private func menuOrigin(_ anchor: CGRect, in size: CGSize) -> CGSize {
        let height = CGFloat(box.actions.count) * Self.menuRow + 2
        let x = size.width - 28 - Self.menuWidth
        let below = anchor.maxY + 4
        let y = below + height + 40 < size.height ? below : max(60, anchor.minY - 4 - height)
        return CGSize(width: x, height: y)
    }
}

/// A box's button (the web page's .btn): mono words in brackets; the primary one filled with ink, the signal colour
/// while pressed; a destructive one in red.
private struct BoxButtonStyle: ButtonStyle {
    let role: PixelBox.Action.Role

    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed
        configuration.label
            .mono(13)
            .lineLimit(1)
            .fixedSize()
            .foregroundStyle(role == .primary ? (pressed ? Color.black : Theme.base) : role == .destructive ? Theme.failed : Theme.ink)
            .padding(.horizontal, 6)
            .padding(.vertical, 4)
            .background(role == .primary ? (pressed ? Theme.signal : Theme.ink) : (pressed ? Theme.line : Color.clear))
    }
}

private struct MenuRowStyle: ButtonStyle {
    let destructive: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(configuration.isPressed ? Theme.base : destructive ? Theme.failed : Theme.ink)
            .background(configuration.isPressed ? Theme.ink : Color.clear)
    }
}

/// Shows a box while `item` is set (and for as long as it stays set); a button or a tap outside clears it.
private struct PixelBoxPresenter<Item: Equatable>: ViewModifier {
    @Binding var item: Item?
    let make: (Item) -> PixelBox
    @State private var owner = UUID()

    func body(content: Content) -> some View {
        content
            .onChange(of: item) { update() }
            .onAppear { if item != nil { update() } }
            .onDisappear { PixelBoxWindow.shared.hide(owner: owner) }
    }

    private func update() {
        if let item {
            PixelBoxWindow.shared.show(make(item), owner: owner) { self.item = nil }
        } else {
            PixelBoxWindow.shared.hide(owner: owner)
        }
    }
}

extension View {
    /// A pixel box while `item` is set.
    func pixelBox<Item: Equatable>(item: Binding<Item?>, _ make: @escaping (Item) -> PixelBox) -> some View {
        modifier(PixelBoxPresenter(item: item, make: make))
    }

    /// A pixel box while `isPresented`.
    func pixelBox(isPresented: Binding<Bool>, _ make: @escaping () -> PixelBox) -> some View {
        let item = Binding<Bool?>(get: { isPresented.wrappedValue ? true : nil }, set: { isPresented.wrappedValue = $0 ?? false })
        return modifier(PixelBoxPresenter(item: item, make: { _ in make() }))
    }
}

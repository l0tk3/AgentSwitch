import AgentSwitchMacCore
import AppKit
import SwiftUI

// Menus the system draws (ui-v0 §7.2.5: the system's menus keep the system's look, every row its SF Symbol; a list of
// choices of one kind — models, Auto — has none): the input's `+`, `[ Hand to ▾ ]`, and the right-click menus.

/// One row of a pop-up menu.
struct MenuEntry {
    var title: String
    var symbol: String?
    /// A key equivalent shown at the row's end (`v` → ⌘V).
    var key: String?
    var checked = false
    var enabled = true
    var children: [MenuEntry]?
    var action: (() -> Void)?
    var isSeparator = false

    static var separator: MenuEntry { MenuEntry(title: "", isSeparator: true) }
}

/// A SwiftUI button that pops up a system menu from itself (above it, for the input at the window's foot). The caller's
/// button style applies.
struct MenuButton<Label: View>: View {
    let entries: () -> [MenuEntry]
    var above = false
    var help: String = ""
    @ViewBuilder let label: Label
    @State private var anchor = MenuAnchorHolder()

    var body: some View {
        Button { PopUpMenu.show(entries(), from: anchor.view, above: above) } label: { label }
            .background(MenuAnchor(holder: anchor))
            .help(help)
    }
}

/// Where a menu pops up from: an empty view in the button's frame.
@MainActor
final class MenuAnchorHolder {
    weak var view: NSView?
}

private struct MenuAnchor: NSViewRepresentable {
    let holder: MenuAnchorHolder

    func makeNSView(context: Context) -> NSView {
        let view = FlippedView()
        holder.view = view
        return view
    }

    func updateNSView(_ view: NSView, context: Context) { holder.view = view }

    final class FlippedView: NSView {
        override var isFlipped: Bool { true }
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }
}

@MainActor
enum PopUpMenu {
    static func show(_ entries: [MenuEntry], from view: NSView?, above: Bool) {
        guard let view else { return }
        let menu = make(entries)
        let y = above ? -(menu.size.height + 4) : view.bounds.height + 4
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: y), in: view)
    }

    static func make(_ entries: [MenuEntry]) -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        for entry in entries {
            if entry.isSeparator { menu.addItem(.separator()); continue }
            let item = ActionMenuItem(title: entry.title, handler: entry.action)
            if let symbol = entry.symbol { item.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil) }
            if let key = entry.key {
                item.keyEquivalent = key
                item.keyEquivalentModifierMask = .command
            }
            item.state = entry.checked ? .on : .off
            item.isEnabled = entry.enabled
            if let children = entry.children { item.submenu = make(children) }
            menu.addItem(item)
        }
        return menu
    }
}

/// A menu row that runs a closure.
private final class ActionMenuItem: NSMenuItem {
    private let handler: (() -> Void)?

    init(title: String, handler: (() -> Void)?) {
        self.handler = handler
        super.init(title: title, action: handler == nil ? nil : #selector(run), keyEquivalent: "")
        target = self
    }

    required init(coder: NSCoder) { fatalError("not used") }

    @objc private func run() { handler?() }
}

/// The right-click menu of a card or a line (DispatchMenuItem: the phone's long-press items and symbols), delete last
/// after a divider.
struct RecordMenu: View {
    let items: [DispatchMenuItem]
    let perform: (DispatchMenuItem) -> Void

    var body: some View {
        ForEach(items, id: \.self) { item in
            if item.isDestructive { Divider() }
            Button(role: item.isDestructive ? .destructive : nil) { perform(item) } label: {
                Label(item.title, systemImage: item.symbol).labelStyle(.titleAndIcon)
            }
            .disabled(!item.isEnabled)
        }
    }
}

/// `Auto` and the catalog's models, for `[ Hand to ▾ ]` (a choice of one kind: no icons).
func handToEntries(_ targets: DispatchTargets?, pick: @escaping (DispatchTarget?) -> Void) -> [MenuEntry] {
    [MenuEntry(title: "Auto", action: { pick(nil) }), .separator]
        + (targets?.pinOptions ?? []).map { target in MenuEntry(title: target.displayName, action: { pick(target) }) }
}

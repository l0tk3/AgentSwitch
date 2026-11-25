import AgentSwitchMacCore
import AppKit

/// The main windows (docs/mesh-v0.md §9 B 2): the one the app opens, and one more for each node opened in a window of
/// its own from the node menu (2026-10-14, user: 这里每一个节点都可以单独开一个窗口). A node is in one window at most —
/// its terminals' layout, its browser's picture, this Mac's screen on it are one each: asking for a node another window
/// is on brings that window forward. Windows opened on a node are not opened again when the app starts.
@MainActor
final class MainWindows {
    private let model: AppModel
    /// The window the app opens (the menu's `Open Dispatch`, the Dock icon, the probes).
    let main: MainWindowController
    /// The windows opened on a node, while they are open.
    private(set) var more: [MainWindowController] = []
    var all: [MainWindowController] { [main] + more }

    /// Told as each window opens or closes, by a name of its own (the Dock icon).
    var onVisibilityChange: (String, Bool) -> Void = { _, _ in }
    var openSettings: () -> Void = {}
    var openNodes: () -> Void = {}
    /// The terminals in windows of their own (this Mac's), for each window.
    var windows: TerminalWindows? { didSet { for controller in all { controller.windows = windows } } }
    /// This Mac's last `GET /live`, for a window opened later.
    private var ownLive: LiveSnapshot?
    private var detached: Set<String> = []

    init(model: AppModel) {
        self.model = model
        main = MainWindowController(model: model)
        wire(main, name: "main")
    }

    /// The nodes with a window of their own open now.
    var nodeWindows: [String] { more.compactMap { $0.window != nil ? $0.state.nodeId : nil } }

    /// The open window whose pages are this node's (nil: this Mac's).
    func on(_ node: String?) -> MainWindowController? {
        all.first { $0.window != nil && $0.state.nodeId == node }
    }

    /// `node`'s pages in a window of their own, or the window already on it, in front. The first time beside `beside`.
    func open(_ node: NodeStatus?, beside: MainWindowController? = nil) {
        if let there = on(node?.id) { there.raise(); return }
        let first = (beside ?? main).window.map { NSRect(x: $0.frame.minX + 28, y: $0.frame.minY - 28, width: $0.frame.width, height: $0.frame.height) }
        let controller = MainWindowController(model: model, node: node, frameName: "\(MainWindowController.frameName)-\(node?.id ?? "this-mac")", firstFrame: first)
        wire(controller, name: "main-\(UUID().uuidString)")
        controller.windows = windows
        controller.liveChanged(ownLive)
        controller.detachedChanged(detached)
        more.append(controller)
        controller.show()
    }

    // MARK: what the app sends to the windows

    /// The main window (the menu's `Open Dispatch` / `Open Terminals`, the Dock icon). Closed on a node that has since
    /// got a window of its own, it opens on this Mac — or this Mac's window, if it has one, comes forward.
    func show(_ page: MainPage? = nil) {
        if main.window == nil, let node = main.state.nodeId, on(node) != nil {
            if let here = on(nil) { here.show(page); return }
            main.use(node: nil)
        }
        main.show(page)
    }

    /// One terminal on screen (the Live Activity): the window on its node, else the main window goes there.
    func show(terminal id: String, node: String?) { (on(node) ?? main).show(terminal: id, node: node) }

    /// The terminals on screen in any of the windows: the Live Activity says nothing of their turns.
    var watchingTerminals: Set<String> { all.reduce(into: Set<String>()) { $0.formUnion($1.watchingTerminals) } }

    func liveChanged(_ snapshot: LiveSnapshot?) {
        ownLive = snapshot
        for controller in all { controller.liveChanged(snapshot) }
    }

    func detachedChanged(_ ids: Set<String>) {
        detached = ids
        for controller in all { controller.detachedChanged(ids) }
    }

    // MARK: each window

    private func wire(_ controller: MainWindowController, name: String) {
        controller.onVisibilityChange = { [weak self, weak controller] open in
            guard let self else { return }
            self.onVisibilityChange(name, open)
            // A window opened on a node is let go once it closes; the main window stays to be opened again.
            if !open, let controller, controller !== self.main { self.more.removeAll { $0 === controller } }
        }
        controller.openSettings = { [weak self] in self?.openSettings() }
        controller.openNodes = { [weak self] in self?.openNodes() }
        controller.openWindow = { [weak self, weak controller] node in self?.open(node, beside: controller) }
        controller.elsewhere = { [weak self, weak controller] node in
            guard let self, let there = self.on(node), there !== controller else { return false }
            there.raise()
            return true
        }
    }
}

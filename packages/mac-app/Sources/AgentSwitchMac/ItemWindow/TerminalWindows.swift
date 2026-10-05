import AgentSwitchMacCore
import AppKit

/// The terminals shown in windows of their own (docs/dispatch-v0.md §1 单独的窗口, 2026-10-05): one window a terminal,
/// beside the one main window. A terminal is in one place: the main window's page is told which are out (it leaves
/// their panes, marks their rows, and raises the window when one is picked). The windows live as long as they are open;
/// nothing of them is kept across a restart — the terminals are all still in the list.
@MainActor
final class TerminalWindows {
    private let client: () -> DaemonClient
    private var open: [String: TerminalWindowController] = [:]
    /// Where the window opened last stands, while it is open: the next one a step down and right of it.
    private weak var last: TerminalWindowController?
    /// The terminals out in windows changed: the main window's page hears it.
    var onChange: (Set<String>) -> Void = { _ in }
    /// Told when the first window opens (true) and the last one closes (false), for the Dock icon.
    var onVisibilityChange: (Bool) -> Void = { _ in }
    /// The main window's frame while it is open: the first window opens beside its corner.
    var mainFrame: () -> NSRect? = { nil }
    /// ⌘T in one of the windows: a new terminal is made in the main window.
    var newTerminal: () -> Void = {}
    /// Something could not be done, in a sentence (the app's notice).
    var onError: (String) -> Void = { _ in }

    init(client: @escaping () -> DaemonClient) {
        self.client = client
    }

    /// The terminals out in windows.
    var ids: Set<String> { Set(open.keys) }

    /// The terminals whose window is the one in use: their turns need no telling (the Live Activity).
    var watching: Set<String> { Set(open.filter { $0.value.watching }.keys) }

    /// Terminal `id` in a window of its own: opened, or brought forward when it has one. Asked for by its id alone, the
    /// service is asked first what it is — a terminal it does not have gets no window.
    func show(_ id: String) {
        if raise(id) { return }
        let c = client()
        Task {
            do {
                let info = try await c.terminal(id: id)
                if !raise(id) { present(id, info: info) }
            } catch {
                onError("无法在新窗口中打开终端：\((error as? DaemonError)?.reason ?? error.localizedDescription)")
            }
        }
    }

    /// Its window to the front; false when it has none.
    @discardableResult
    func raise(_ id: String) -> Bool {
        guard let controller = open[id] else { return false }
        controller.raise()
        return true
    }

    /// Back to the main window: its own closes (the terminal runs on).
    func close(_ id: String) { open[id]?.close() }

    func closeAll() {
        for controller in Array(open.values) { controller.close() }
    }

    private func present(_ id: String, info: TerminalInfo) {
        let controller = TerminalWindowController(id: id, client: client, info: info)
        controller.newTerminal = { [weak self] in self?.newTerminal() }
        controller.onClosed = { [weak self] in self?.closed(id) }
        let wasEmpty = open.isEmpty
        open[id] = controller
        controller.open(frame: frame())
        last = controller
        if wasEmpty { onVisibilityChange(true) }
        onChange(ids)
    }

    private func closed(_ id: String) {
        guard open.removeValue(forKey: id) != nil else { return }
        if open.isEmpty { onVisibilityChange(false) }
        onChange(ids)
    }

    /// At the size the last window of this kind had, a step from the one opened last (TerminalWindowPlace).
    private func frame() -> NSRect {
        let saved = UserDefaults.standard.string(forKey: TerminalWindowController.sizeKey).map(NSSizeFromString)
        let size = saved.flatMap { $0.width >= TerminalWindowPlace.minSize.width && $0.height >= TerminalWindowPlace.minSize.height ? $0 : nil } ?? TerminalWindowPlace.size
        let main = mainFrame()
        let screen = (last?.window?.screen ?? NSScreen.screens.first { screen in main.map { screen.frame.intersects($0) } ?? false } ?? NSScreen.main)?.visibleFrame
            ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        return TerminalWindowPlace.next(after: last?.window?.frame, size: size, screen: screen, beside: main)
    }

    #if DEBUG
    /// The probe's: a terminal's window, once it is open.
    func probe(_ id: String) -> TerminalWindowController? { open[id] }
    #endif
}

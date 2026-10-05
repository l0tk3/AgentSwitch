import AgentSwitchMacCore
import AppKit
import SwiftUI

/// One pane of the Terminals page (docs/terminal-v0.md §1 分屏): its native screen — its own stream and screen id, so
/// each pane holds its terminal's size — and, while it shows a terminal, that terminal's model: the requests it waits
/// on, the sealed reply, where it is in use when not here (the same model a terminal's own window has).
@MainActor
@Observable
final class TerminalPaneState: Identifiable {
    let id: Int
    @ObservationIgnored let screen: TerminalScreenController
    @ObservationIgnored let stage: ItemTerminalStage
    @ObservationIgnored private let client: () -> DaemonClient
    /// The terminal it shows now; none in an empty pane.
    private(set) var session: TerminalWindowModel?
    /// `Starting Claude Code`, `Opening 「…」`: said over the screen until the agent has drawn something.
    private(set) var loading: String?
    /// The screen's grid, as it fits its pane.
    private(set) var grid: (cols: Int, rows: Int)?
    @ObservationIgnored private var loadingTask: Task<Void, Never>?
    /// The screen was clicked: the pane takes the focus.
    @ObservationIgnored var onClick: () -> Void = {}
    /// The terminal's ground (its theme's), for the window's bars.
    @ObservationIgnored var onGround: (NSColor) -> Void = { _ in }
    /// Its terminal was deleted: the list is read again.
    @ObservationIgnored var onGone: () -> Void = {}
    /// A key of the page's from the screen (⌘T, ⌘W, ⌘1–9 …).
    @ObservationIgnored var onShortcut: (_ key: String, _ shift: Bool, _ alt: Bool) -> Void = { _, _, _ in }
    /// The keyboard back to this pane's screen.
    @ObservationIgnored var onFocusScreen: () -> Void = {}

    static let loadingFor: Duration = .seconds(20)

    init(id: Int, client: @escaping () -> DaemonClient) {
        self.id = id
        self.client = client
        screen = TerminalScreenController(client: client)
        screen.pane = id
        stage = ItemTerminalStage(screen: screen)
        screen.onMessage = { [weak self] event, data in self?.received(event: event, data: data) }
        screen.onSize = { [weak self] grid, away in
            self?.session?.screenSaid(grid: grid.map { [$0.cols, $0.rows] }, away: away)
        }
        screen.onClick = { [weak self] in
            self?.session?.screenClicked()
            self?.onClick()
        }
        screen.onGround = { [weak self] color in
            self?.session?.ground = color
            self?.onGround(color)
        }
        screen.onShortcut = { [weak self] key, shift, alt in self?.onShortcut(key, shift, alt) }
        screen.onGrid = { [weak self] cols, rows in self?.grid = (cols, rows) }
    }

    /// The terminal the pane shows (nil: none), with what the list knows of it now.
    func show(_ terminal: TerminalInfo?, git: FolderGit?) {
        guard let terminal else {
            if session != nil { leave() }
            screen.show(nil)
            return
        }
        if let session, session.id == terminal.id {
            session.update(info: terminal, git: git)
        } else {
            leave()
            let next = TerminalWindowModel(id: terminal.id, client: client, info: terminal)
            next.update(info: terminal, git: git)
            next.ground = screen.view.nativeBackgroundColor
            next.onNote = { [weak self] text in self?.screen.note(text) }
            next.onClaim = { [weak self] in self?.screen.claim() }
            next.onFocusScreen = { [weak self] in self?.onFocusScreen() }
            next.onGone = { [weak self] in self?.onGone() }
            next.onInfo = { [weak self, weak next] in self?.screen.workdir = next?.info?.workdir }
            session = next
        }
        screen.workdir = terminal.workdir
        // The keyboard goes where the page says, not to whichever pane was shown last.
        screen.show(terminal.id, keyboard: false)
    }

    private func leave() {
        session?.stop()
        session = nil
        say(nil)
    }

    /// The line over the screen while the agent starts; gone once it paints, or after a while.
    func say(_ text: String?) {
        loadingTask?.cancel()
        loading = text
        guard text != nil else { return }
        loadingTask = Task { [weak self] in
            try? await Task.sleep(for: Self.loadingFor)
            guard !Task.isCancelled else { return }
            self?.loading = nil
        }
    }

    private func received(event: String, data: String) {
        session?.received(event: event, data: data)
        guard loading != nil, event == "snapshot" || event == "output" || event == "exit" else { return }
        if event == "exit" { return say(nil) }
        struct Body: Decodable { let data: String }
        if let text = (try? JSONDecoder().decode(Body.self, from: Data(data.utf8)))?.data, TerminalListText.paints(text) { say(nil) }
    }

    func stop() {
        leave()
        screen.stop()
        stage.removeFromSuperview()
    }
}

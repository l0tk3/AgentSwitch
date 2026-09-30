import AgentSwitchKit
import Foundation
import Observation
import SwiftUI

/// One terminal on the phone (docs/terminal-v0.md §1): its stream drawn into the screen, its status and name, the
/// permission requests waiting, and what the phone sends — a sealed reply, named keys, a decision. While it is open the
/// phone's grid wins (the last screen to interact sets the size): after the snapshot and whenever the text size or the
/// space changes, the service hears the new size and the agent draws again.
@MainActor
@Observable
final class TerminalPageModel {
    let id: String
    private(set) var name: String
    private(set) var harness: String
    private(set) var status: TerminalStatus
    /// It writes a session of its own (not one it continues in place): closing may delete that record.
    let ownsRecord: Bool
    /// What `/` offers: the agent's slash commands in this folder.
    private(set) var commands: [SlashCommand] = []
    /// The Mac's AgentSwitch is too old to list them (said when `/` is typed).
    private(set) var commandsUnavailable = false
    private(set) var permissions: [TerminalPermission] = []
    /// The terminal was closed (here or elsewhere): the page leaves.
    private(set) var removed = false
    /// Drawn at least once (the placeholder goes).
    private(set) var drawn = false
    /// Screens drawn afresh from a snapshot (each comes in top down).
    private(set) var snapshots = 0
    /// The Mac takes the wheel (one that predates it says so once, and the drag stops sending).
    private(set) var wheelWorks = true
    var error: String?
    /// "1 secret sealed" after a reply the sealer changed; cleared by the next one.
    private(set) var sealedNote: String?
    private(set) var sending = false
    @ObservationIgnored let screen: TerminalScreenController
    @ObservationIgnored private var api: AgentSwitchAPI?
    @ObservationIgnored private var follow: Task<Void, Never>?
    @ObservationIgnored private var resizing: Task<Void, Never>?
    /// The grid the service last heard from this phone.
    @ObservationIgnored private var told: (cols: Int, rows: Int)?
    /// Wheel notches not sent yet (up positive), and the send under way.
    @ObservationIgnored private var wheelPending = 0
    @ObservationIgnored private var wheeling: Task<Void, Never>?

    init(terminal: TerminalInfo, fontSize: CGFloat) {
        id = terminal.id
        name = terminal.name
        harness = terminal.harness
        status = terminal.status
        permissions = terminal.permissions
        ownsRecord = terminal.resumedFrom == nil || terminal.forked
        screen = TerminalScreenController(fontSize: fontSize)
        screen.onSize = { [weak self] cols, rows in self?.sizeChanged(cols: cols, rows: rows) }
    }

    func start(_ api: AgentSwitchAPI?, style: TerminalStyle?) {
        if let style { screen.apply(style) }
        guard follow == nil else { return }
        self.api = api
        guard let api else {
            #if DEBUG
            screen.snapshot(DemoData.terminalScreen)
            drawn = true
            snapshots += 1
            commands = DemoData.slashCommands
            #endif
            return
        }
        let id = id
        Task { [weak self] in
            do {
                let listed = try await api.terminalCommands(id)
                self?.commands = listed ?? []
                self?.commandsUnavailable = listed == nil
            } catch {
                self?.commandsUnavailable = true
            }
        }
        follow = Task { [weak self] in
            do {
                for try await event in api.terminalEvents(id) {
                    guard let self else { return }
                    self.handle(event)
                }
            } catch {
                self?.error = error.localizedDescription
            }
        }
    }

    /// The screen's own background (the Mac's terminal colours): what covers it before it is drawn.
    var ground: Color { Color(uiColor: screen.view.nativeBackgroundColor) }

    func stop() {
        follow?.cancel()
        follow = nil
        resizing?.cancel()
        wheeling?.cancel()
        wheeling = nil
        wheelPending = 0
    }

    func handle(_ event: TerminalEvent) {
        switch event {
        case .snapshot(_, let cols, let rows, let data):
            screen.snapshot(data)
            drawn = true
            snapshots += 1
            // Drawn at the size it had (the Mac, another phone); now at this phone's, and the agent draws again (its
            // links and status line are not in a snapshot).
            told = (cols, rows)
            let grid = screen.grid
            tellSize(cols: grid.cols, rows: grid.rows, redraw: true)
        case .output(_, let data):
            screen.output(data)
            drawn = true
        case .status(let s):
            status = s
        case .name(let n):
            name = n
        case .resize:
            break   // another screen's size; this one takes it back when used
        case .permission(let p):
            if !permissions.contains(where: { $0.id == p.id }) { permissions.append(p) }
        case .permissionResolved(let pid):
            permissions.removeAll { $0.id == pid }
        case .exit(let code):
            status = .exited
            permissions = []
            screen.write("\r\n\u{1b}[2m[exited · code \(code.map(String.init) ?? "?")]\u{1b}[0m\r\n")
        case .removed:
            removed = true
        }
    }

    // MARK: size

    private func sizeChanged(cols: Int, rows: Int) {
        guard drawn else { return }
        tellSize(cols: cols, rows: rows, redraw: false)
    }

    /// Debounced: a pinch or the keyboard sliding in changes the grid many times.
    private func tellSize(cols: Int, rows: Int, redraw: Bool) {
        guard cols >= 20, rows >= 5, status != .exited, let api else { return }
        let id = id
        let same = told.map { $0.cols == cols && $0.rows == rows } ?? false
        resizing?.cancel()
        resizing = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            if !same { try? await api.resizeTerminal(id, cols: min(cols, 500), rows: min(rows, 300)) }
            self?.told = (cols, rows)
            // The same size makes no redraw on its own: ask for one.
            if redraw && same { try? await api.redrawTerminal(id) }
        }
    }

    /// This phone takes the size back (the user is about to act here).
    func claimSize() {
        let grid = screen.grid
        told = nil
        tellSize(cols: grid.cols, rows: grid.rows, redraw: false)
    }

    // MARK: sending

    /// A reply, pasted in and entered: as typed, or sealed on the Mac first (credentials become ciphertext).
    func send(_ text: String, sealed: Bool) async -> Bool {
        guard let api, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        sending = true
        defer { sending = false }
        claimSize()
        do {
            let result = try await api.sendTerminalInput(id, text: text, sealed: sealed)
            sealedNote = result.sealed == 0 ? nil : result.sealed == 1 ? "1 secret sealed" : "\(result.sealed) secrets sealed"
            error = nil
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }

    /// Pictures for the agent (the photo button): made small and upright on the phone (no location leaves it), sent to
    /// the Mac, their paths pasted into the prompt; the reply is still to write and send.
    func attach(_ files: [UploadFile]) async -> Bool {
        let prepared = files.compactMap(ImagePrep.prepare)
        guard let api, !prepared.isEmpty else { return false }
        sending = true
        defer { sending = false }
        claimSize()
        do {
            let staged = try await api.upload(prepared)
            let attached = try await api.attachToTerminal(id, uploads: staged.map(\.id))
            sealedNote = attached.count == 1 ? "1 image attached" : "\(attached.count) images attached"
            error = nil
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }

    /// Notches from a drag, sent together every 50 ms (at most 20 at a time) instead of one request each.
    func wheel(up: Bool, count: Int) {
        guard api != nil, status != .exited else { return }
        wheelPending += up ? count : -count
        guard wheeling == nil else { return }
        wheeling = Task { [weak self] in
            while let self, self.wheelPending != 0, !Task.isCancelled {
                let n = max(-20, min(20, self.wheelPending))
                self.wheelPending -= n
                do {
                    try await self.api?.sendTerminalKeys(self.id, Array(repeating: n > 0 ? .wheelUp : .wheelDown, count: abs(n)))
                } catch {
                    // Said once, and this drag stops: a Mac that predates the wheel answers 400.
                    if case APIError.http(status: 400, message: _) = error {
                        self.wheelWorks = false
                        self.error = "此 Mac 上的 AgentSwitch 版本不支持滑动翻页，请先更新。"
                    } else {
                        self.error = error.localizedDescription
                    }
                    self.wheelPending = 0
                    break
                }
                try? await Task.sleep(for: .milliseconds(50))
            }
            self?.wheeling = nil
        }
    }

    func press(_ key: TerminalKey) async {
        guard let api else { return }
        do { try await api.sendTerminalKeys(id, [key]) } catch { self.error = error.localizedDescription }
    }

    func decide(_ permission: TerminalPermission, allow: Bool) async {
        guard let api else { permissions.removeAll { $0.id == permission.id }; return }
        do {
            try await api.decideTerminalPermission(id, permissionId: permission.id, allow: allow)
            permissions.removeAll { $0.id == permission.id }
        } catch {
            self.error = error.localizedDescription
        }
    }

    func rename(_ newName: String) async {
        guard let api else { return }
        do { name = try await api.renameTerminal(id, name: newName.isEmpty ? nil : newName).name } catch { self.error = error.localizedDescription }
    }

    func close(deleteRecord: Bool = false) async -> Bool {
        guard let api else { return true }
        do {
            try await api.closeTerminal(id, deleteRecord: deleteRecord)
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }
}

import AgentSwitchKit
import Foundation
import Observation
import SwiftUI

/// The terminals tab's data (docs/terminal-v0.md §1): the Mac's terminals, the agents it can start and their models,
/// the Mac's other coding sessions (moved here from settings), and the Mac's terminal colours. Read again while the tab
/// is on screen; the page of one terminal follows its own stream.
@MainActor
@Observable
final class TerminalsStore {
    private(set) var list: TerminalList?
    private(set) var sessions: [SessionSummary] = []
    private(set) var style: TerminalStyle?
    /// The last read failed (kept list shown); cleared by the next good one.
    var error: String?

    var terminals: [TerminalInfo] { list?.terminals ?? [] }
    var nodes: [TerminalTree.Node] { TerminalTree.build(terminals: terminals, sessions: sessions) }
    /// Terminals waiting for an answer: the tab's badge.
    var waiting: Int { terminals.filter { $0.status == .waiting || !$0.permissions.isEmpty }.count }

    /// Folders used before, newest first, for the new-terminal sheet.
    var recentFolders: [String] {
        var seen = Set<String>()
        let byTime = terminals.map { ($0.cwd, $0.lastOutputAt) } + sessions.map { ($0.cwd, $0.updatedAt) }
        return byTime.sorted { $0.1 > $1.1 }.map(\.0).filter { !$0.isEmpty && seen.insert($0).inserted }.prefix(8).map { $0 }
    }

    func refresh(_ api: AgentSwitchAPI?) async {
        guard let api else { return }
        do {
            async let list = api.terminals()
            async let sessions = api.sessions(limit: 80)
            self.list = try await list
            self.sessions = (try? await sessions) ?? self.sessions
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        if style == nil { style = try? await api.terminalStyle() }
    }

    /// A terminal just started or resumed: listed at once, before the next read.
    func add(_ terminal: TerminalInfo) {
        guard let list, !list.terminals.contains(where: { $0.id == terminal.id }) else { return }
        self.list = TerminalList(terminals: [terminal] + list.terminals, agents: list.agents, models: list.models)
    }

    func remove(_ id: String) {
        guard let list else { return }
        self.list = TerminalList(terminals: list.terminals.filter { $0.id != id }, agents: list.agents, models: list.models)
    }

    #if DEBUG
    func setDemo(_ list: TerminalList, sessions: [SessionSummary]) {
        self.list = list
        self.sessions = sessions
    }
    #endif
}

/// `~/x` for a path under the user's home on the Mac (the Mac's home, as the paths carry it).
enum MacPath {
    static func tilde(_ path: String) -> String {
        guard path.hasPrefix("/Users/") else { return path }
        let rest = path.dropFirst("/Users/".count)
        guard let slash = rest.firstIndex(of: "/") else { return "~" }
        return "~" + rest[slash...]
    }
}

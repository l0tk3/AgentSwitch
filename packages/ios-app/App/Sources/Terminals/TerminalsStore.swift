import AgentSwitchKit
import Foundation
import Observation
import SwiftUI

/// The terminals tab's data (docs/terminal-v0.md §1): the Mac's terminals, the agents it can start and their models,
/// the Mac's other coding sessions (moved here from settings), and the Mac's terminal colours. The list is read again
/// from every tab (AppModel.refreshTerminals: the badge, the cue, the Live Activity), the sessions while the tab is on
/// screen; the page of one terminal follows its own stream.
@MainActor
@Observable
final class TerminalsStore {
    private(set) var list: TerminalList?
    private(set) var sessions: [SessionSummary] = []
    /// The folders' git, after their names in the tree.
    private(set) var git: [String: GitSummary] = [:]
    private(set) var style: TerminalStyle?
    /// The last read failed (kept list shown); cleared by the next good one.
    var error: String?
    /// Bumped by `reset` (another Mac): a read that started before it is dropped.
    @ObservationIgnored private var generation = 0

    var terminals: [TerminalInfo] { list?.terminals ?? [] }
    var nodes: [TerminalTree.Node] { TerminalTree.build(terminals: terminals, sessions: sessions, git: git) }
    /// Terminals waiting for an answer: the tab's badge.
    var waiting: Int { terminals.filter(\.waitsForYou).count }

    /// Folders used before, newest first, for the new-terminal sheet.
    var recentFolders: [String] {
        var seen = Set<String>()
        let byTime = terminals.map { ($0.cwd, $0.lastOutputAt) } + sessions.map { ($0.cwd, $0.updatedAt) }
        return byTime.sorted { $0.1 > $1.1 }.map(\.0).filter { !$0.isEmpty && seen.insert($0).inserted }.prefix(8).map { $0 }
    }

    func refreshList(_ api: AgentSwitchAPI?) async {
        guard let api else { return }
        let asked = generation
        do {
            let fresh = try await api.terminals()
            guard asked == generation else { return }
            list = fresh
            error = nil
        } catch {
            if asked == generation { self.error = error.localizedDescription }
        }
        if style == nil, let fresh = try? await api.terminalStyle(), asked == generation { style = fresh }
    }

    /// The Mac's other sessions; a failed read keeps the last ones.
    func refreshSessions(_ api: AgentSwitchAPI?) async {
        guard let api else { return }
        let asked = generation
        if let fresh = try? await api.sessions(limit: 80), asked == generation { sessions = fresh }
    }

    /// The folders' git; a failed read keeps the last.
    func refreshGit(_ api: AgentSwitchAPI?) async {
        guard let api else { return }
        let asked = generation
        if let fresh = try? await api.folderGit(), asked == generation, fresh != git { git = fresh }
    }

    /// Another Mac (or none): nothing of this one's stays.
    func reset() {
        generation += 1
        list = nil
        sessions = []
        git = [:]
        style = nil
        error = nil
    }

    /// A terminal just started or resumed: listed at once, before the next read.
    func add(_ terminal: TerminalInfo) {
        guard let list, !list.terminals.contains(where: { $0.id == terminal.id }) else { return }
        self.list = TerminalList(terminals: [terminal] + list.terminals, agents: list.agents, models: list.models, defaults: list.defaults)
    }

    func remove(_ id: String) {
        guard let list else { return }
        self.list = TerminalList(terminals: list.terminals.filter { $0.id != id }, agents: list.agents, models: list.models, defaults: list.defaults)
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

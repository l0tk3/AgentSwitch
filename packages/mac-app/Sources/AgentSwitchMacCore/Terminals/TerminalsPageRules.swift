import Foundation

// The native Terminals page (docs/terminal-v0.md §1 Mac, 2026-10-05; user: terminal全都改成原生): what the web page's
// script decided, without AppKit — the list's rows from the directory tree, the words on them, and what a key does.

/// A row of the list, top to bottom as it is drawn.
public enum TerminalListRow: Equatable, Sendable, Identifiable {
    /// A folder's line: its name, its git, the running terminals and the sessions in it and under it.
    public struct Folder: Equatable, Sendable {
        public let cwd: String
        public let name: String
        public let depth: Int
        /// It has terminals or sessions of its own (else it only gathers folders: a quieter line).
        public let own: Bool
        public let closed: Bool
        /// Folded with the terminal on screen inside: the line is marked in its place.
        public let holds: Bool
        public let git: FolderGit?
        public let live: Int
        public let waiting: Bool
        public let sessions: Int
        /// Found by a search: no folding, no `+`.
        public let found: Bool
    }

    case folder(Folder)
    /// A terminal: `index` is its ⌘1–9 (by when it was opened), `twig` its branch of the tree (`├─`, `└─`).
    case terminal(TerminalInfo, twig: String, depth: Int, index: Int?)
    case subagent(TerminalSubagent, terminal: String, twig: String, depth: Int)
    case session(SessionSummary, twig: String, depth: Int)
    /// `3 More` / `Less` under a folder's first sessions.
    case more(cwd: String, twig: String, depth: Int, hidden: Int, all: Bool)
    /// A search's words around the match, under the row they were said in.
    case hit(id: String, text: String, twig: String, terminal: String?, session: SessionSummary?)
    /// A search's count: `// 1 folder · 2 titles`.
    case found(String)
    /// Nothing to list, or nothing found, in a sentence.
    case note(String)

    public var id: String {
        switch self {
        case .folder(let f): "d:\(f.cwd)"
        case .terminal(let t, _, _, _): "t:\(t.id)"
        case .subagent(let a, let terminal, _, _): "a:\(terminal):\(a.id)"
        case .session(let s, _, _): "s:\(s.recordID)"
        case .more(let cwd, _, _, _, _): "m:\(cwd)"
        case .hit(let id, _, _, _, _): "h:\(id)"
        case .found: "found"
        case .note: "note"
        }
    }
}

/// What of the list is shown (docs/terminal-v0.md §1 Mac, 2026-10-11, user: 这里要加上筛选某个agent的会话 和筛选活跃会话的功能):
/// one agent's terminals and sessions alone, and what is active alone — the terminals that run, and the sessions the
/// service says are being written now (one open in another program). Both can be on.
public struct TerminalListFilter: Equatable, Sendable {
    /// An agent's id (`codex`); nil: every agent's.
    public var agent: String?
    public var active: Bool

    public init(agent: String? = nil, active: Bool = false) {
        self.agent = agent
        self.active = active
    }

    public var isOn: Bool { agent != nil || active }

    public func keeps(_ terminal: TerminalInfo) -> Bool { (agent == nil || terminal.harness == agent) && (!active || terminal.running) }
    public func keeps(_ session: SessionSummary) -> Bool { (agent == nil || session.harness == agent) && (!active || session.active) }

    /// `agent` alone; chosen again, every agent's.
    public func choosing(_ agent: String) -> TerminalListFilter { TerminalListFilter(agent: self.agent == agent ? nil : agent, active: active) }

    /// The agents to choose from, in the page's order: those with a terminal or a session in the list, and the one
    /// chosen even when nothing of its is left (so it can be taken off). None while there is one agent and no choice:
    /// nothing to choose between.
    public static func agents(terminals: [TerminalInfo], sessions: [SessionSummary], chosen: String? = nil) -> [String] {
        let there = Set(terminals.map(\.harness)).union(sessions.map(\.harness))
        let known = TerminalListText.agents.map(\.id)
        var listed = known.filter(there.contains) + there.subtracting(known).sorted()
        if let chosen, !listed.contains(chosen) { listed.append(chosen) }
        return listed.count > 1 || chosen != nil ? listed : []
    }
}

public enum TerminalListRows {
    /// A folder shows this many of its sessions until `More` is asked for.
    public static let sessionsShown = 3
    public static let noSessions = "暂无会话。"
    /// The filter left nothing.
    public static let noneKept = "没有符合筛选条件的会话。"

    /// The terminals in the order they were opened: ⌘1–9 follow it, wherever the tree puts them.
    public static func order(_ terminals: [TerminalInfo]) -> [String] {
        terminals.enumerated().sorted { ($0.element.createdAt, $0.offset) < ($1.element.createdAt, $1.offset) }.map(\.element.id)
    }

    /// The tree as rows: a folder's line, its terminals (each with its sub-agents), its first sessions (`expanded`: all
    /// of them), then the folders under it a step further in. A folded folder shows only its line.
    /// `tools`: the tool terminals (yazi, docs/yazi-v0.md), each listed a step under its agent terminal after its
    /// sub-agents.
    public static func build(_ tree: [TerminalTree.Folder], git: [String: FolderGit] = [:], collapsed: Set<String> = [], expanded: Set<String> = [],
                             current: String? = nil, order: [String] = [], tools: [TerminalInfo] = []) -> [TerminalListRow] {
        let toolsOf = Dictionary(grouping: tools.filter { $0.parent != nil }, by: { $0.parent! })
        var out: [TerminalListRow] = []
        func add(_ folder: TerminalTree.Folder, depth: Int) {
            let closed = collapsed.contains(folder.cwd)
            let all = folder.allTerminals
            out.append(.folder(.init(cwd: folder.cwd, name: folder.name, depth: depth, own: folder.holdsOwn, closed: closed,
                                     holds: closed && current != nil && all.contains { $0.id == current }, git: git[folder.cwd],
                                     live: all.filter(\.running).count, waiting: all.contains { $0.status == "waiting" },
                                     sessions: folder.allSessions.count, found: false)))
            guard !closed else { return }
            let everything = expanded.contains(folder.cwd)
            let shown = everything ? folder.sessions : Array(folder.sessions.prefix(sessionsShown))
            let more = folder.sessions.count > sessionsShown
            let count = folder.terminals.count + shown.count + (more ? 1 : 0)
            var drawn = 0
            func twig() -> String { drawn += 1; return drawn == count ? "└─" : "├─" }
            for terminal in folder.terminals {
                let branch = twig()
                out.append(.terminal(terminal, twig: branch, depth: depth, index: order.firstIndex(of: terminal.id)))
                out.append(contentsOf: subagents(of: terminal, under: branch, depth: depth, then: toolsOf[terminal.id]?.count ?? 0))
                out.append(contentsOf: Self.tools(toolsOf[terminal.id] ?? [], under: branch, depth: depth))
            }
            for session in shown { out.append(.session(session, twig: twig(), depth: depth)) }
            if more { out.append(.more(cwd: folder.cwd, twig: twig(), depth: depth, hidden: folder.sessions.count - shown.count, all: everything)) }
            for child in folder.children { add(child, depth: depth + 1) }
        }
        for folder in tree { add(folder, depth: 0) }
        return out.isEmpty ? [.note(noSessions)] : out
    }

    /// A terminal's sub-agents at work, a step under it; none once it has ended. `then`: rows that follow them on the
    /// same branch (its tool terminals), so the last sub-agent is not the branch's end.
    static func subagents(of terminal: TerminalInfo, under twig: String, depth: Int, then: Int = 0) -> [TerminalListRow] {
        guard terminal.running else { return [] }
        let stem = twig == "└─" ? "\u{a0}\u{a0}" : "│\u{a0}"
        return terminal.subagents.enumerated().map { index, agent in
            .subagent(agent, terminal: terminal.id, twig: stem + (index == terminal.subagents.count - 1 && then == 0 ? "└─" : "├─"), depth: depth)
        }
    }

    /// A terminal's tool terminals, a step under it, the last at the branch's end.
    static func tools(_ tools: [TerminalInfo], under twig: String, depth: Int) -> [TerminalListRow] {
        let stem = twig == "└─" ? "\u{a0}\u{a0}" : "│\u{a0}"
        let sorted = tools.sorted { $0.createdAt < $1.createdAt }
        return sorted.enumerated().map { index, tool in
            .terminal(tool, twig: stem + (index == sorted.count - 1 ? "└─" : "├─"), depth: depth, index: nil)
        }
    }

    /// What a search left, in the tree's order: each folder that matched or holds a match, its rows, and under a row
    /// whose words matched (not its name) those words.
    public static func found(_ result: TerminalSearch.Result, query: String, order: [String] = []) -> [TerminalListRow] {
        guard !result.folders.isEmpty else {
            return [.note("没有找到与“\(query.trimmingCharacters(in: .whitespacesAndNewlines))”相关的文件夹或会话。")]
        }
        var out: [TerminalListRow] = [.found(result.summary)]
        for folder in result.folders {
            let terminals = folder.rows.compactMap { row -> TerminalInfo? in if case .terminal(let t) = row.item { t } else { nil } }
            let sessions = folder.rows.count - terminals.count
            out.append(.folder(.init(cwd: folder.cwd, name: folder.name, depth: 0, own: true, closed: false, holds: false, git: folder.git,
                                     live: terminals.filter(\.running).count, waiting: terminals.contains { $0.status == "waiting" },
                                     sessions: sessions, found: true)))
            for (index, row) in folder.rows.enumerated() {
                let twig = index == folder.rows.count - 1 ? "└─" : "├─"
                let under = (twig == "└─" ? "\u{a0}\u{a0}" : "│\u{a0}") + "└─"
                switch row.item {
                case .terminal(let terminal):
                    out.append(.terminal(terminal, twig: twig, depth: 0, index: order.firstIndex(of: terminal.id)))
                    out.append(contentsOf: subagents(of: terminal, under: twig, depth: 0))
                    if let said = row.said { out.append(.hit(id: row.id, text: TerminalSearch.near(query, in: said), twig: under, terminal: terminal.id, session: nil)) }
                case .session(let session):
                    out.append(.session(session, twig: twig, depth: 0))
                    if let said = row.said { out.append(.hit(id: "s:\(session.recordID)", text: TerminalSearch.near(query, in: said), twig: under, terminal: nil, session: session)) }
                }
            }
        }
        return out
    }
}

/// The page's short words.
public enum TerminalListText {
    public static let agents: [(id: String, name: String)] = [("claude-code", "Claude Code"), ("codex", "Codex"), ("opencode", "OpenCode"), ("pi", "pi")]
    /// The agents whose sessions can be gone on with (pi's since 2026-10-11, docs/terminal-v0.md §5).
    public static let resumable: Set<String> = ["claude-code", "codex", "opencode", "pi"]
    /// The agents the service can tell are open elsewhere (not OpenCode's or pi's).
    public static let checked: Set<String> = ["claude-code", "codex"]
    /// What is asked before going on with a session the service cannot tell is open elsewhere, when it was written
    /// lately: it goes on in the same record (OpenCode cannot fork one).
    public static func mayBeOpen(_ harness: String) -> String {
        harness == "opencode" ? "此会话可能正在其他终端中运行。OpenCode 不支持分叉，继续将写入同一会话。" : "此会话可能正在其他终端中运行，继续将写入同一会话。"
    }
    /// A session's title in a few words, for a button or a line that names it: one line, `columns` columns at the most
    /// (a wide character — Chinese, Japanese, Korean, a full-width form, an emoji — is two), an ellipsis where it was
    /// cut; `会话` for one with no title. The service gives up to 120 characters of a session's first message, which
    /// is wider than a pane (2026-10-13, user, of an empty pane's `[ Resume 「…」 ]` drawn across the whole window:
    /// 又是什么bug).
    public static func brief(_ title: String, columns: Int = 36) -> String {
        let one = title.split(whereSeparator: \.isNewline).joined(separator: " ").trimmingCharacters(in: .whitespaces)
        guard !one.isEmpty else { return "会话" }
        var width = 0, kept = one.startIndex, fits = true
        for index in one.indices {
            width += wide(one[index]) ? 2 : 1
            if width > columns { fits = false; break }
            // What may stay when it has to be cut: a column is left for the ellipsis.
            if width <= columns - 1 { kept = one.index(after: index) }
        }
        return fits ? one : one[..<kept].trimmingCharacters(in: .whitespaces) + "…"
    }

    /// A character two columns wide in a terminal's font.
    private static func wide(_ character: Character) -> Bool {
        guard let scalar = character.unicodeScalars.first?.value else { return false }
        switch scalar {
        case 0x1100...0x115F, 0x2E80...0xA4CF, 0xAC00...0xD7A3, 0xF900...0xFAFF, 0xFE30...0xFE4F, 0xFF00...0xFF60, 0xFFE0...0xFFE6,
             0x1F300...0x1FAFF, 0x20000...0x3FFFD: return true
        default: return false
        }
    }

    /// How the agent asks before acting: the id the service takes and its name on the panel.
    public static let modes: [(id: String, name: String)] = [("manual", "Ask Each"), ("auto", "Auto"), ("bypass", "Bypass")]

    public static func agentName(_ harness: String) -> String { agents.first { $0.id == harness }?.name ?? harness }

    /// A terminal's status as it is shown; the service's own word for one this page does not know.
    public static func status(_ status: String) -> String {
        switch status {
        case "working": "Busy"
        case "waiting": "Waiting"
        case "idle": "Idle"
        case "exited": "Exited"
        default: status
        }
    }

    /// How long ago, as a unit: `Now`, `12m`, `3h`, `6d`, then the date (`9/22`). The classic look says `12m ago`.
    public static func age(since ms: Int64, now: Date = Date(), calendar: Calendar = .current, classic: Bool = false) -> String {
        let seconds = max(0, Int((now.timeIntervalSince1970 - Double(ms) / 1000).rounded()))
        let unit: String
        if seconds < 45 { return "Now" }
        if seconds < 3600 { unit = "\(Int((Double(seconds) / 60).rounded()))m" }
        else if seconds < 86400 { unit = "\(Int((Double(seconds) / 3600).rounded()))h" }
        else if seconds < 7 * 86400 { unit = "\(Int((Double(seconds) / 86400).rounded()))d" }
        else {
            let parts = calendar.dateComponents([.month, .day], from: Date(timeIntervalSince1970: Double(ms) / 1000))
            return "\(parts.month ?? 1)/\(parts.day ?? 1)"
        }
        return classic ? "\(unit) ago" : unit
    }

    /// All the terminals at a glance, for the rail's and the bar's mark: the state, and its word (`2 Waiting`, `Busy`,
    /// `Idle`; none while nothing runs).
    public static func mark(_ terminals: [TerminalInfo]) -> (state: String, tag: String) {
        let live = terminals.filter(\.running)
        let waiting = live.filter { $0.status == "waiting" }.count
        if waiting > 0 { return ("waiting", "\(waiting) Waiting") }
        if live.contains(where: { $0.status == "working" }) { return ("busy", "Busy") }
        return live.isEmpty ? ("off", "") : ("idle", "Idle")
    }

    /// A model on the menu: its name, with its id when two share the name.
    public static func modelTitle(_ model: TerminalModelOption, among all: [TerminalModelOption]) -> String {
        all.filter { $0.name == model.name }.count > 1 ? "\(model.name) · \(model.id)" : model.name
    }

    /// Output that paints something — not only mode switches, cursor moves and blank space: the agent has drawn its
    /// screen, and the page's `Starting…` line may go.
    public static func paints(_ data: String) -> Bool {
        let pattern = "\u{1b}\\[[\\x20-\\x3f]*[\\x40-\\x7e]|\u{1b}\\][^\\x07\u{1b}]*(\\x07|\u{1b}\\\\)|\u{1b}[\\x20-\\x2f]*[\\x30-\\x7e]|\\s"
        guard let expression = try? NSRegularExpression(pattern: pattern) else { return !data.isEmpty }
        let range = NSRange(data.startIndex..., in: data)
        return !expression.stringByReplacingMatches(in: data, range: range, withTemplate: "").isEmpty
    }
}

/// What a key does on the page (the web page's `shortcut` and its key handlers): the page's own — a new terminal, the
/// list, the search, the panes, ⌘1–9 — and, through `ItemWindowKey`, the cards', the sealed reply's and the fields'.
public enum TerminalsPageKey: Equatable, Sendable {
    case newTerminal
    /// ⌘W: the terminal on screen is closed (asked first while it runs).
    case closeTerminal
    case toggleList
    case search
    /// ⌘D beside, ⌘⇧D below: the pane in focus split, the new half empty.
    case split(PaneSide)
    /// ⌘⇧↩: the pane in focus alone, or all of them again.
    case zoom
    /// ⌘⇧E: the pane in focus as its session's record (the simple view), or as the terminal again.
    case toggleView
    /// ⌘⌥ arrows: the focus to the pane next door.
    case neighbor(dx: Int, dy: Int)
    /// ⌘1–9: the terminal opened first, second…
    case select(Int)
    /// ↩ and esc on the new-terminal panel.
    case start
    case cancelCreate
    case item(ItemWindowKey)

    /// `plainField`: a field of the page's own has the keyboard (the search, a name being changed, the panel's folder):
    /// what is typed, ↩ and esc are its own; the page's ⌘ keys still act.
    public static func action(for press: ItemWindowKey.Press, editing: Bool, plainField: Bool, marking: Bool, inSeal: Bool,
                              cardHasKeys: Bool, creating: Bool) -> TerminalsPageKey? {
        guard !press.control else { return nil }
        if press.command, press.option {
            guard !press.shift else { return nil }
            switch press.keyCode {
            case 123: return .neighbor(dx: -1, dy: 0)
            case 124: return .neighbor(dx: 1, dy: 0)
            case 125: return .neighbor(dx: 0, dy: 1)
            case 126: return .neighbor(dx: 0, dy: -1)
            default: return nil
            }
        }
        guard !press.option else { return nil }
        if press.command {
            if press.shift {
                if press.key == "d" { return .split(.bottom) }
                if press.key == "e" { return .toggleView }
                if press.keyCode == ItemWindowKey.returnKey { return .zoom }
            } else {
                switch press.key {
                case "t": return .newTerminal
                case "w": return .closeTerminal
                case "b": return .toggleList
                case "f": return .search
                case "d": return .split(.right)
                default: break
                }
                if let number = Int(press.key), (1...9).contains(number), press.keyCode != ItemWindowKey.returnKey { return .select(number) }
            }
            return ItemWindowKey.action(for: press, editing: editing, marking: marking, inSeal: inSeal, cardHasKeys: cardHasKeys).map(TerminalsPageKey.item)
        }
        guard !plainField else { return nil }
        if creating, !editing, !marking {
            if press.keyCode == ItemWindowKey.returnKey { return .start }
            if press.keyCode == ItemWindowKey.escapeKey { return .cancelCreate }
        }
        return ItemWindowKey.action(for: press, editing: editing, marking: marking, inSeal: inSeal, cardHasKeys: cardHasKeys).map(TerminalsPageKey.item)
    }
}

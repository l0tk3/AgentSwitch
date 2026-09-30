import Foundation

/// The terminals tab as a directory tree (docs/terminal-v0.md §1, docs/ui-v0.md §7.2 "list = directory tree"), as the
/// web page builds it: one group per project folder — its running terminals, then its earlier sessions; projects under
/// one parent with two or more of them sit under that parent. The order is fixed (2026-09-30, user: 目录树顺序应该是固定的，
/// 现在会根据活跃状态顺序乱跳): folders by path; in a folder its terminals in the order they were opened, then its sessions
/// newest-begun first. Work going on moves nothing; something new only comes in at its place.
public enum TerminalTree {
    public struct Group: Sendable, Equatable, Identifiable {
        public let cwd: String
        /// The folder's own name ("AgentSwitch"); at the top level a repeated one carries its parent ("Work/api").
        public let name: String
        public let terminals: [TerminalInfo]
        public let sessions: [SessionSummary]
        public var id: String { cwd }
    }

    public struct Node: Sendable, Equatable, Identifiable {
        /// The shared parent folder when two or more projects sit under it; nil for a project that stands alone.
        public let parent: String?
        public let parentName: String?
        public let groups: [Group]
        public var id: String { parent ?? groups.first?.cwd ?? "" }
        public var terminals: [TerminalInfo] { groups.flatMap(\.terminals) }
    }

    public static func build(terminals: [TerminalInfo], sessions: [SessionSummary]) -> [Node] {
        struct Bucket { var terminals: [TerminalInfo] = []; var sessions: [SessionSummary] = []; var latest: Int64 = 0; var opened = Int64.max }
        var byCwd: [String: Bucket] = [:]
        for t in terminals {
            var b = byCwd[t.cwd, default: Bucket()]
            b.terminals.append(t)
            b.latest = max(b.latest, t.lastOutputAt)
            b.opened = min(b.opened, t.createdAt)
            byCwd[t.cwd] = b
        }
        // A session a running terminal writes (or was forked from) is not listed again; an ended terminal no longer
        // holds its session, so it can be resumed from the list.
        let running = terminals.filter(\.isRunning)
        let shown = Set(running.flatMap { [$0.agentSessionId, $0.resumedFrom].compactMap { $0 } })
        let openForks = Set(running.filter(\.forked).compactMap(\.resumedFrom))
        for s in sessions where !shown.contains(s.sessionId) && !(s.forkedFrom.map(openForks.contains) ?? false) {
            var b = byCwd[s.cwd, default: Bucket()]
            b.sessions.append(s)
            b.latest = max(b.latest, s.updatedAt)
            byCwd[s.cwd] = b
        }
        let groups = byCwd.map { cwd, b in (cwd: cwd, bucket: b) }.sorted { byPath($0.cwd, $1.cwd) }
        var byParent: [String: [(cwd: String, bucket: Bucket)]] = [:]
        var parentOrder: [String] = []
        for g in groups {
            let parent = parentOf(g.cwd)
            if byParent[parent] == nil { parentOrder.append(parent) }
            byParent[parent, default: []].append(g)
        }
        typealias Draft = (parent: String?, groups: [(cwd: String, bucket: Bucket)])
        let drafts: [Draft] = parentOrder.map { parent in
            let gs = byParent[parent] ?? []
            return (gs.count > 1 ? parent : nil, gs)
        }
        let ordered = drafts.sorted { byPath($0.parent ?? $0.groups[0].cwd, $1.parent ?? $1.groups[0].cwd) }
        // Names at the top level that repeat are told apart by their parent.
        let topNames = ordered.map { $0.parent.map(lastComponent) ?? lastComponent($0.groups[0].cwd) }
        return ordered.map { draft in
            let topName = draft.parent.map(lastComponent) ?? lastComponent(draft.groups[0].cwd)
            let repeated = topNames.filter { $0 == topName }.count > 1
            let groups = draft.groups.map { g in
                let own = lastComponent(g.cwd)
                let name = draft.parent == nil && repeated ? "\(lastComponent(parentOf(g.cwd)))/\(own)" : own
                return Group(cwd: g.cwd, name: name, terminals: g.bucket.terminals.sorted { $0.createdAt < $1.createdAt },
                             sessions: g.bucket.sessions.sorted { ($0.startedAt ?? $0.updatedAt, $1.sessionId) > ($1.startedAt ?? $1.updatedAt, $0.sessionId) })
            }
            let shownParent = draft.parent.map { parent in repeated ? "\(lastComponent(parentOf(parent)))/\(lastComponent(parent))" : lastComponent(parent) }
            return Node(parent: draft.parent, parentName: shownParent, groups: groups)
        }
    }

    /// The running terminals in the order the tree shows them.
    public static func order(_ nodes: [Node]) -> [TerminalInfo] { nodes.flatMap(\.terminals) }

    /// Paths as a directory tree sorts them: case aside, numbers by value.
    static func byPath(_ a: String, _ b: String) -> Bool {
        a.compare(b, options: [.caseInsensitive, .numeric]) == .orderedAscending
    }

    static func parentOf(_ path: String) -> String {
        guard let slash = path.lastIndex(of: "/"), slash != path.startIndex else { return "/" }
        return String(path[..<slash])
    }

    static func lastComponent(_ path: String) -> String {
        path == "/" ? "/" : String(path.split(separator: "/").last ?? Substring(path))
    }
}

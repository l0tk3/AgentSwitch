import Foundation

/// The terminals tab as a directory tree (docs/terminal-v0.md §1, docs/ui-v0.md §7.2 "list = directory tree"), as the
/// web page builds it: one group per project folder — its running terminals, then its earlier sessions; projects under
/// one parent with two or more of them sit under that parent. Folders with a terminal come first, in the order they were
/// opened (so the list stays put while agents write), the others by latest activity.
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
        func before(_ a: (terminals: Int, opened: Int64, latest: Int64), _ b: (terminals: Int, opened: Int64, latest: Int64)) -> Bool {
            if (a.terminals > 0) != (b.terminals > 0) { return a.terminals > 0 }
            if a.terminals > 0, a.opened != b.opened { return a.opened < b.opened }
            return a.latest > b.latest
        }
        let groups = byCwd.map { cwd, b in (cwd: cwd, bucket: b) }.sorted { a, b in
            let ka = (a.bucket.terminals.count, a.bucket.opened, a.bucket.latest), kb = (b.bucket.terminals.count, b.bucket.opened, b.bucket.latest)
            if before(ka, kb) { return true }
            if before(kb, ka) { return false }
            return a.cwd < b.cwd
        }
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
        func key(_ d: Draft) -> (terminals: Int, opened: Int64, latest: Int64) {
            (d.groups.reduce(0) { $0 + $1.bucket.terminals.count }, d.groups.map(\.bucket.opened).min() ?? .max, d.groups.map(\.bucket.latest).max() ?? 0)
        }
        let ordered = drafts.enumerated().sorted { a, b in
            let ka = key(a.element), kb = key(b.element)
            if before(ka, kb) { return true }
            if before(kb, ka) { return false }
            return a.offset < b.offset
        }.map(\.element)
        // Names at the top level that repeat are told apart by their parent.
        let topNames = ordered.map { $0.parent.map(lastComponent) ?? lastComponent($0.groups[0].cwd) }
        return ordered.map { draft in
            let topName = draft.parent.map(lastComponent) ?? lastComponent(draft.groups[0].cwd)
            let repeated = topNames.filter { $0 == topName }.count > 1
            let groups = draft.groups.map { g in
                let own = lastComponent(g.cwd)
                let name = draft.parent == nil && repeated ? "\(lastComponent(parentOf(g.cwd)))/\(own)" : own
                return Group(cwd: g.cwd, name: name, terminals: g.bucket.terminals.sorted { $0.createdAt > $1.createdAt },
                             sessions: g.bucket.sessions.sorted { $0.updatedAt > $1.updatedAt })
            }
            let shownParent = draft.parent.map { parent in repeated ? "\(lastComponent(parentOf(parent)))/\(lastComponent(parent))" : lastComponent(parent) }
            return Node(parent: draft.parent, parentName: shownParent, groups: groups)
        }
    }

    /// The running terminals in the order the tree shows them.
    public static func order(_ nodes: [Node]) -> [TerminalInfo] { nodes.flatMap(\.terminals) }

    static func parentOf(_ path: String) -> String {
        guard let slash = path.lastIndex(of: "/"), slash != path.startIndex else { return "/" }
        return String(path[..<slash])
    }

    static func lastComponent(_ path: String) -> String {
        path == "/" ? "/" : String(path.split(separator: "/").last ?? Substring(path))
    }
}

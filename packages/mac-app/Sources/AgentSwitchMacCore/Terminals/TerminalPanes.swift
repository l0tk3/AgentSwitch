import Foundation

// The Terminals page's split panes (docs/terminal-v0.md §1 分屏, 2026-10-03; demo docs/design/implemented/split.html):
// the terminal area as a binary tree of splits, as iTerm2's and tmux's panes are — the rules of the web page's
// `ui/lib/panes.js`, natively (2026-10-05: the page itself is native). Every change gives a new tree. A terminal is in
// one pane at most. Nothing here draws.

/// The session a pane's terminal ran, to go on with once the terminal is gone.
public struct PaneSession: Codable, Equatable, Sendable {
    public let harness: String
    public let session: String
    public let title: String

    public init(harness: String, session: String, title: String = "") {
        self.harness = harness
        self.session = session
        self.title = title
    }
}

/// A pane: the terminal it shows (nil: empty) and, emptied because its terminal went, the session to go on with.
public struct TerminalPane: Equatable, Sendable, Identifiable {
    public let id: Int
    public let term: String?
    public let was: PaneSession?

    public init(id: Int, term: String? = nil, was: PaneSession? = nil) {
        self.id = id
        self.term = term
        self.was = was
    }
}

/// The tree: a pane, or two subtrees side by side (`row`: `a` left of `b`) or one above the other (`col`: `a` above `b`),
/// `ratio` being `a`'s share.
public indirect enum PaneNode: Equatable, Sendable {
    public enum Direction: String, Codable, Sendable { case row, col }

    case pane(TerminalPane)
    case split(id: Int, dir: Direction, ratio: Double, a: PaneNode, b: PaneNode)
}

public enum PaneSide: String, Sendable, CaseIterable { case left, right, top, bottom }

/// Where a drop lands: a pane's middle, or one of its sides.
public enum PaneZone: Equatable, Sendable {
    case center
    case side(PaneSide)
}

public enum TerminalPanes {
    public static let maxPanes = 4
    /// The least a pane may be, in points: about 40 × 8 cells and its header.
    public static let minWidth: CGFloat = 300, minHeight: CGFloat = 160
    /// The line between two panes.
    public static let gap: CGFloat = 1

    public struct Placed: Equatable, Sendable, Identifiable {
        public let id: Int
        public let term: String?
        public let rect: CGRect

        public init(id: Int, term: String?, rect: CGRect) {
            self.id = id
            self.term = term
            self.rect = rect
        }
    }

    /// A line between two panes: where it is, and its split's own rect (`box`), which a drag is measured in.
    public struct Line: Equatable, Sendable, Identifiable {
        public let id: Int
        public let dir: PaneNode.Direction
        public let rect: CGRect
        public let box: CGRect
    }

    public struct Drop: Equatable, Sendable {
        public let zone: PaneZone
        /// The part of the pane the drop would take: all of it, or the half on that side.
        public let rect: CGRect
        /// An edge was meant, and the panes are all used.
        public let full: Bool
    }

    public static func single(_ term: String? = nil) -> PaneNode { .pane(TerminalPane(id: 1, term: term)) }

    /// The panes, left to right and top to bottom as the tree has them.
    public static func panes(of node: PaneNode) -> [TerminalPane] {
        switch node {
        case .pane(let p): [p]
        case .split(_, _, _, let a, let b): panes(of: a) + panes(of: b)
        }
    }

    public static func pane(_ root: PaneNode, _ id: Int) -> TerminalPane? { panes(of: root).first { $0.id == id } }

    public static func paneShowing(_ root: PaneNode, _ term: String?) -> TerminalPane? {
        guard let term else { return nil }
        return panes(of: root).first { $0.term == term }
    }

    private static func ids(_ node: PaneNode) -> [Int] {
        switch node {
        case .pane(let p): [p.id]
        case .split(let id, _, _, let a, let b): [id] + ids(a) + ids(b)
        }
    }

    /// The tree with `change`'s answer for each pane it changes.
    private static func mapPanes(_ node: PaneNode, _ change: (TerminalPane) -> PaneNode?) -> PaneNode {
        switch node {
        case .pane(let p): change(p) ?? node
        case .split(let id, let dir, let ratio, let a, let b): .split(id: id, dir: dir, ratio: ratio, a: mapPanes(a, change), b: mapPanes(b, change))
        }
    }

    /// `term` in pane `id` (nil empties it); the pane forgets the session it kept. Shown in another pane, it leaves that
    /// one, which closes.
    public static func show(_ root: PaneNode, _ id: Int, _ term: String?) -> PaneNode {
        var next = root
        if let from = paneShowing(root, term), from.id != id { next = close(next, from.id) }
        return mapPanes(next) { $0.id == id ? .pane(TerminalPane(id: id, term: term)) : nil }
    }

    /// A new pane beside pane `id` holding `term`; nil when the panes are all used or the pane is not there.
    public static func split(_ root: PaneNode, _ id: Int, _ side: PaneSide, _ term: String? = nil) -> (root: PaneNode, pane: Int)? {
        guard panes(of: root).count < maxPanes, pane(root, id) != nil else { return nil }
        let fresh = TerminalPane(id: (ids(root).max() ?? 0) + 1, term: term)
        let dir: PaneNode.Direction = side == .left || side == .right ? .row : .col
        let first = side == .left || side == .top
        let made = mapPanes(root) { p in
            guard p.id == id else { return nil }
            return .split(id: fresh.id + 1, dir: dir, ratio: 0.5, a: first ? .pane(fresh) : .pane(p), b: first ? .pane(p) : .pane(fresh))
        }
        return (made, fresh.id)
    }

    /// Without pane `id`: its sibling takes the room. The last pane stays (emptied).
    public static func close(_ root: PaneNode, _ id: Int) -> PaneNode {
        if case .pane(let p) = root { return p.id == id ? .pane(TerminalPane(id: p.id)) : root }
        func cut(_ node: PaneNode) -> PaneNode? {
            switch node {
            case .pane(let p): return p.id == id ? nil : node
            case .split(let sid, let dir, let ratio, let a, let b):
                guard let a = cut(a) else { return cut(b) }
                guard let b = cut(b) else { return a }
                return .split(id: sid, dir: dir, ratio: ratio, a: a, b: b)
            }
        }
        return cut(root) ?? root
    }

    /// `term` let go on pane `id`: its middle shows it there, an edge splits that side for it. Dragged out of another
    /// pane, that one closes. Nil when nothing changes.
    public static func drop(_ root: PaneNode, _ term: String, on id: Int, _ zone: PaneZone) -> (root: PaneNode, pane: Int)? {
        let from = paneShowing(root, term)
        guard pane(root, id) != nil, from?.id != id else { return nil }
        guard case .side(let side) = zone else { return (show(root, id, term), id) }
        return split(from.map { close(root, $0.id) } ?? root, id, side, term)
    }

    /// A split's share for its first side.
    public static func resize(_ root: PaneNode, _ id: Int, _ ratio: Double) -> PaneNode {
        switch root {
        case .pane: root
        case .split(let sid, let dir, let old, let a, let b):
            .split(id: sid, dir: dir, ratio: sid == id ? ratio : old, a: resize(a, id, ratio), b: resize(b, id, ratio))
        }
    }

    /// The least room a subtree needs across (`wide`) or down: panes side by side need both and the line.
    public static func least(_ node: PaneNode, wide: Bool) -> CGFloat {
        switch node {
        case .pane: wide ? minWidth : minHeight
        case .split(_, let dir, _, let a, let b):
            (dir == .row) == wide ? least(a, wide: wide) + least(b, wide: wide) + gap : max(least(a, wide: wide), least(b, wide: wide))
        }
    }

    /// Where each pane and each line between panes goes in `rect`.
    public static func place(_ node: PaneNode, in rect: CGRect) -> (panes: [Placed], lines: [Line]) {
        switch node {
        case .pane(let p):
            return ([Placed(id: p.id, term: p.term, rect: rect)], [])
        case .split(let id, let dir, let ratio, let a, let b):
            let first: CGRect, line: CGRect, second: CGRect
            if dir == .row {
                let w = ((rect.width - gap) * ratio).rounded()
                first = CGRect(x: rect.minX, y: rect.minY, width: w, height: rect.height)
                line = CGRect(x: rect.minX + w, y: rect.minY, width: gap, height: rect.height)
                second = CGRect(x: rect.minX + w + gap, y: rect.minY, width: rect.width - w - gap, height: rect.height)
            } else {
                let h = ((rect.height - gap) * ratio).rounded()
                first = CGRect(x: rect.minX, y: rect.minY, width: rect.width, height: h)
                line = CGRect(x: rect.minX, y: rect.minY + h, width: rect.width, height: gap)
                second = CGRect(x: rect.minX, y: rect.minY + h + gap, width: rect.width, height: rect.height - h - gap)
            }
            let one = place(a, in: first), two = place(b, in: second)
            return (one.panes + two.panes, one.lines + [Line(id: id, dir: dir, rect: line, box: rect)] + two.lines)
        }
    }

    /// The share a line dragged to `at` (points from its split's start, along its axis) gives the first side: every
    /// pane on both sides keeps its least size.
    public static func ratio(_ root: PaneNode, line id: Int, in box: CGRect, at: CGFloat) -> Double {
        func find(_ node: PaneNode) -> PaneNode? {
            guard case .split(let sid, _, _, let a, let b) = node else { return nil }
            return sid == id ? node : find(a) ?? find(b)
        }
        guard case .split(_, let dir, let ratio, let a, let b)? = find(root) else { return 0.5 }
        let wide = dir == .row
        let total = (wide ? box.width : box.height) - gap
        guard total > 0 else { return ratio }
        let low = least(a, wide: wide) / total, high = 1 - least(b, wide: wide) / total
        return low > high ? 0.5 : Double(min(max(at / total, low), high))
    }

    /// Where a drop at `point` lands in a pane's `rect`: within a quarter of an edge it splits that side (the half
    /// shown); else, or with no room for two panes there, or with the panes all used, the middle.
    public static func zone(in rect: CGRect, at point: CGPoint, count: Int) -> Drop {
        let across = (point.x - rect.minX) / rect.width, down = (point.y - rect.minY) / rect.height
        let distances: [(PaneSide, CGFloat)] = [(.left, across), (.right, 1 - across), (.top, down), (.bottom, 1 - down)]
        let nearest = distances.min { $0.1 < $1.1 } ?? (.left, 1)
        let (edge, near) = nearest
        let sideways = edge == .left || edge == .right
        let room = sideways ? rect.width >= 2 * minWidth + gap : rect.height >= 2 * minHeight + gap
        let full = count >= maxPanes
        guard near <= 0.25, room, !full else { return Drop(zone: .center, rect: rect, full: near <= 0.25 && full) }
        let half: CGRect = switch edge {
        case .left: CGRect(x: rect.minX, y: rect.minY, width: rect.width / 2, height: rect.height)
        case .right: CGRect(x: rect.midX, y: rect.minY, width: rect.width / 2, height: rect.height)
        case .top: CGRect(x: rect.minX, y: rect.minY, width: rect.width, height: rect.height / 2)
        case .bottom: CGRect(x: rect.minX, y: rect.midY, width: rect.width, height: rect.height / 2)
        }
        return Drop(zone: .side(edge), rect: half, full: false)
    }

    /// The pane next to `id` in a direction (`dx` −1 left, 1 right; `dy` −1 up, 1 down), by the centres of the placed
    /// panes; nil at the edge.
    public static func neighbor(_ placed: [Placed], of id: Int, dx: Int, dy: Int) -> Int? {
        guard let current = placed.first(where: { $0.id == id }) else { return nil }
        let centre = CGPoint(x: current.rect.midX, y: current.rect.midY)
        func sign(_ value: CGFloat) -> Int { value > 0 ? 1 : value < 0 ? -1 : 0 }
        let beyond = placed.filter { p in
            p.id != id && (dx != 0 ? sign(p.rect.midX - centre.x) == dx : sign(p.rect.midY - centre.y) == dy)
        }
        return beyond.min { hypot($0.rect.midX - centre.x, $0.rect.midY - centre.y) < hypot($1.rect.midX - centre.x, $1.rect.midY - centre.y) }?.id
    }

    /// The tree as the terminals are now. A pane whose terminal is gone is emptied and keeps the session it ran, to go
    /// on with; with `closing` it closes instead while other panes remain (a terminal closed while the page is open). A
    /// pane showing a terminal notes its session as it learns it.
    public static func settle(_ root: PaneNode, _ terminals: [TerminalInfo], closing: Bool = false) -> PaneNode {
        let known = Dictionary(terminals.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var next = root
        for p in panes(of: root) {
            guard let term = p.term else { continue }
            if let t = known[term] {
                guard let session = t.agentSessionId else { continue }
                let was = PaneSession(harness: t.harness, session: session, title: t.name)
                if was != p.was { next = mapPanes(next) { $0.id == p.id ? .pane(TerminalPane(id: p.id, term: term, was: was)) : nil } }
            } else if closing, panes(of: next).count > 1 {
                next = close(next, p.id)
            } else {
                next = mapPanes(next) { $0.id == p.id ? .pane(TerminalPane(id: p.id, term: nil, was: p.was)) : nil }
            }
        }
        return next
    }

    /// The tree if it is one that may be shown: whole ids from 1, none twice, no terminal twice, at most `maxPanes`
    /// panes, ratios within (0, 1). What is read back from what this Mac kept goes through here.
    public static func valid(_ root: PaneNode) -> Bool {
        var seen: Set<Int> = [], terms: Set<String> = [], count = 0
        func check(_ node: PaneNode) -> Bool {
            switch node {
            case .pane(let p):
                guard p.id >= 1, seen.insert(p.id).inserted else { return false }
                count += 1
                if let term = p.term { guard !term.isEmpty, terms.insert(term).inserted else { return false } }
                return true
            case .split(let id, _, let ratio, let a, let b):
                guard id >= 1, seen.insert(id).inserted, ratio > 0, ratio < 1 else { return false }
                return check(a) && check(b)
            }
        }
        return check(root) && count <= maxPanes
    }

    /// What this Mac kept, read back: nil unless it is a tree that may be shown.
    public static func restore(_ data: Data?) -> PaneNode? {
        guard let data, let root = try? JSONDecoder().decode(PaneNode.self, from: data), valid(root) else { return nil }
        return root
    }

    public static func kept(_ root: PaneNode) -> Data? { try? JSONEncoder().encode(root) }
}

extension PaneNode: Codable {
    private enum Keys: String, CodingKey { case k, id, term, was, dir, ratio, a, b }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let id = try c.decode(Int.self, forKey: .id)
        switch try c.decode(String.self, forKey: .k) {
        case "pane":
            // A terminal or a session that does not read is none: the pane is empty.
            let term = (try? c.decodeIfPresent(String.self, forKey: .term)).flatMap { $0 }.flatMap { $0.isEmpty ? nil : $0 }
            self = .pane(TerminalPane(id: id, term: term, was: (try? c.decodeIfPresent(PaneSession.self, forKey: .was)) ?? nil))
        case "split":
            self = .split(id: id, dir: try c.decode(Direction.self, forKey: .dir), ratio: try c.decode(Double.self, forKey: .ratio),
                          a: try c.decode(PaneNode.self, forKey: .a), b: try c.decode(PaneNode.self, forKey: .b))
        default:
            throw DecodingError.dataCorruptedError(forKey: .k, in: c, debugDescription: "neither a pane nor a split")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        switch self {
        case .pane(let p):
            try c.encode("pane", forKey: .k)
            try c.encode(p.id, forKey: .id)
            try c.encodeIfPresent(p.term, forKey: .term)
            try c.encodeIfPresent(p.was, forKey: .was)
        case .split(let id, let dir, let ratio, let a, let b):
            try c.encode("split", forKey: .k)
            try c.encode(id, forKey: .id)
            try c.encode(dir, forKey: .dir)
            try c.encode(ratio, forKey: .ratio)
            try c.encode(a, forKey: .a)
            try c.encode(b, forKey: .b)
        }
    }
}

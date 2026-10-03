import Foundation

/// The terminals tab as a directory tree (docs/terminal-v0.md §1, docs/ui-v0.md §7.2 "list = directory tree"), by the
/// rules the web page's list follows (packages/daemon/ui/lib/tree.js). The order is fixed (2026-09-30, user:
/// 目录树顺序应该是固定的，现在会根据活跃状态顺序乱跳): folders by path; in a folder its terminals in the order they were
/// opened, then its sessions newest-begun first, then the folders under it. Work going on moves nothing; something new
/// only comes in at its place.
///
/// Which folders show and where (2026-10-03, user: 怎么分别显示了两个worktop；有共同的祖父节点时并没能正确显示，比如“靶场”
/// 就在 /WorkSpace/Worktop/培训/靶场 下，但是显示起来是独立的): every folder with terminals or sessions of its own, and every
/// folder two or more of those sit directly in. Each sits in the nearest of these above it, named by the path from
/// there ("培训/靶场"); a folder with sessions of its own that also holds others is one line. Folders near the top hold
/// only what sits directly in them: two levels from the top of the disk (`/`, `/Users`, your home, `/private/tmp`) and the
/// places in your home (`~/Desktop`).
public enum TerminalTree {
    public struct Folder: Sendable, Equatable, Identifiable {
        public let cwd: String
        /// At the top its own name ("AgentSwitch"; a repeated one carries its parent's, "Work/api"; your home is "~");
        /// under another folder the path from there ("培训/靶场").
        public let name: String
        /// Its own: none for a folder that only gathers others.
        public let terminals: [TerminalInfo]
        public let sessions: [SessionSummary]
        /// Its git after its name; nil outside a repository (or not known yet).
        public var git: GitSummary? = nil
        /// The folders that sit in it.
        public let children: [Folder]
        public var id: String { cwd }

        /// It has terminals or sessions of its own (else it only gathers the folders under it).
        public var holdsOwn: Bool { !terminals.isEmpty || !sessions.isEmpty }
        /// Its terminals, then those of the folders under it, in the tree's order; the same for sessions.
        public var allTerminals: [TerminalInfo] { terminals + children.flatMap(\.allTerminals) }
        public var allSessions: [SessionSummary] { sessions + children.flatMap(\.allSessions) }
    }

    public static func build(terminals: [TerminalInfo], sessions: [SessionSummary], git: [String: GitSummary] = [:]) -> [Folder] {
        // A session a running terminal writes (or was forked from) is not listed again; an ended terminal no longer
        // holds its session, so it can be resumed from the list.
        // A new Codex terminal says its record's id only after its first turn: until then, a Codex record made in its
        // folder since it started is taken to be its own (Codex ids are UUIDv7, with the time).
        let running = terminals.filter(\.isRunning)
        let held = Set(running.flatMap { [$0.agentSessionId, $0.resumedFrom].compactMap { $0 } })
        let openForks = Set(running.filter(\.forked).compactMap(\.resumedFrom))
        let fresh = running.filter { $0.harness == "codex" && $0.agentSessionId == nil }
        func ownRecord(_ s: SessionSummary) -> Bool {
            s.harness == "codex" && ((s.forkedFrom.map(openForks.contains) ?? false)
                || fresh.contains { $0.cwd == s.cwd && (uuidTime(s.sessionId) ?? 0) >= $0.createdAt - 3000 })
        }
        let listed = sessions.filter { !held.contains($0.sessionId) && !ownRecord($0) }
        let terminalsIn = Dictionary(grouping: terminals, by: \.cwd)
        let sessionsIn = Dictionary(grouping: listed, by: \.cwd)
        let own = Set(terminalsIn.keys).union(sessionsIn.keys)

        var direct: [String: Int] = [:]
        for cwd in own where cwd != "/" { direct[parentOf(cwd), default: 0] += 1 }
        let shown = own.union(direct.filter { $0.value > 1 }.map(\.key))
        var children: [String: [String]] = [:]
        var roots: [String] = []
        for path in shown.sorted(by: byPath) {
            if let holder = holder(of: path, in: shown) { children[holder, default: []].append(path) } else { roots.append(path) }
        }

        func folder(_ cwd: String, name: String) -> Folder {
            Folder(cwd: cwd, name: name,
                   terminals: (terminalsIn[cwd] ?? []).sorted { $0.createdAt < $1.createdAt },
                   sessions: (sessionsIn[cwd] ?? [])
                       .sorted { ($0.startedAt ?? $0.updatedAt, $1.sessionId) > ($1.startedAt ?? $1.updatedAt, $0.sessionId) },
                   git: git[cwd],
                   children: (children[cwd] ?? []).map { folder($0, name: relative($0, to: cwd)) })
        }
        // At the top a folder goes by its own name; names that repeat are told apart by their parent.
        let names = roots.map { lastComponent(tilde($0)) }
        return zip(roots, names).map { cwd, name in
            let tail = tilde(cwd).split(separator: "/").suffix(2).joined(separator: "/")
            return folder(cwd, name: names.filter { $0 == name }.count > 1 ? (tail.isEmpty ? "/" : tail) : name)
        }
    }

    /// The running terminals in the order the tree shows them.
    public static func order(_ folders: [Folder]) -> [TerminalInfo] { folders.flatMap(\.allTerminals) }

    /// Every folder, depth first, with its name as a search shows it: under the names of the folders it sits in
    /// ("Worktop/培训/靶场").
    public static func flatten(_ folders: [Folder], above: String? = nil) -> [(folder: Folder, name: String)] {
        folders.flatMap { f -> [(folder: Folder, name: String)] in
            let name = above.map { "\($0)/\(f.name)" } ?? f.name
            return [(f, name)] + flatten(f.children, above: name)
        }
    }

    /// `path` and every folder above it, nearest first: the folders to open so it shows.
    public static func foldersAbove(_ path: String) -> [String] {
        var out = [path], p = path
        while p != "/" { p = parentOf(p); out.append(p) }
        return out
    }

    /// A folder's line: its name and a slash (the top of the disk is `/` alone).
    public static func slashed(_ name: String) -> String { name.hasSuffix("/") ? name : name + "/" }

    /// The places directly in your home (macOS's own folders), not projects.
    static let places: Set<String> = ["Desktop", "Documents", "Downloads", "Library", "Movies", "Music", "Pictures", "Public", "Applications"]

    /// Near the top: it holds only what sits directly in it.
    static func shallow(_ path: String) -> Bool {
        let parts = path.split(separator: "/").map(String.init)
        return parts.count <= 2 || (parts.count == 3 && parts[0] == "Users" && places.contains(parts[2]))
    }

    /// The nearest shown folder above `path`, or nil at the top.
    static func holder(of path: String, in shown: Set<String>) -> String? {
        guard path != "/" else { return nil }
        var p = parentOf(path), direct = true
        while true {
            if shown.contains(p) && (direct || !shallow(p)) { return p }
            if p == "/" { return nil }
            p = parentOf(p)
            direct = false
        }
    }

    static func relative(_ path: String, to holder: String) -> String {
        holder == "/" ? String(path.drop { $0 == "/" }) : String(path.dropFirst(holder.count + 1))
    }

    /// When a UUIDv7 id (Codex's) was made, in ms; nil for any other id.
    static func uuidTime(_ id: String) -> Int64? {
        let hex = id.replacingOccurrences(of: "-", with: "")
        guard hex.count == 32, hex.allSatisfy(\.isHexDigit), hex[hex.index(hex.startIndex, offsetBy: 12)] == "7" else { return nil }
        return Int64(hex.prefix(12), radix: 16)
    }

    /// Paths as a directory tree sorts them: case aside, numbers by value.
    static func byPath(_ a: String, _ b: String) -> Bool {
        a.compare(b, options: [.caseInsensitive, .numeric]) == .orderedAscending
    }

    static func parentOf(_ path: String) -> String {
        guard let slash = path.lastIndex(of: "/"), slash != path.startIndex else { return "/" }
        return String(path[..<slash])
    }

    /// A folder as the tree and the terminal page's title name it: its last component.
    public static func lastComponent(_ path: String) -> String {
        path == "/" ? "/" : String(path.split(separator: "/").last ?? Substring(path))
    }

    /// `/Users/<name>/x` as `~/x`, as the web page shows paths (not `/Users/Shared`, which is no one's home).
    static func tilde(_ path: String) -> String {
        guard path.hasPrefix("/Users/"), path != "/Users/Shared", !path.hasPrefix("/Users/Shared/") else { return path }
        let rest = path.dropFirst(7)
        guard let slash = rest.firstIndex(of: "/") else { return "~" }
        return "~" + String(path[slash...])
    }
}

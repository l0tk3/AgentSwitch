package com.agentswitch.kit.feed

import com.agentswitch.kit.api.GitSummary
import com.agentswitch.kit.api.SessionSummary
import com.agentswitch.kit.api.TerminalInfo
import com.agentswitch.kit.api.graphemeCount
import com.agentswitch.kit.api.graphemePrefix

/**
 * The terminals tab as a directory tree (docs/terminal-v0.md §1, docs/ui-v0.md §7.2 "list = directory tree"), by the
 * rules the web page's list follows (packages/daemon/ui/lib/tree.js). The order is fixed (2026-09-30, user:
 * 目录树顺序应该是固定的，现在会根据活跃状态顺序乱跳): folders by path; in a folder its terminals in the order they were
 * opened, then its sessions newest-begun first, then the folders under it. Work going on moves nothing; something new
 * only comes in at its place.
 *
 * Which folders show and where (2026-10-03, user: 怎么分别显示了两个worktop；有共同的祖父节点时并没能正确显示，比如“靶场”
 * 就在 /WorkSpace/Worktop/培训/靶场 下，但是显示起来是独立的): every folder with terminals or sessions of its own, and every
 * folder two or more of those sit directly in. Each sits in the nearest of these above it, named by the path from
 * there ("培训/靶场"); a folder with sessions of its own that also holds others is one line. Folders near the top hold
 * only what sits directly in them: two levels from the top of the disk (`/`, `/Users`, your home, `/private/tmp`) and the
 * places in your home (`~/Desktop`).
 */
object TerminalTree {
    data class Folder(
        val cwd: String,
        /**
         * At the top its own name ("AgentSwitch"; a repeated one carries its parent's, "Work/api"; your home is "~");
         * under another folder the path from there ("培训/靶场").
         */
        val name: String,
        /** Its own: none for a folder that only gathers others. */
        val terminals: List<TerminalInfo>,
        val sessions: List<SessionSummary>,
        /** Its git after its name; null outside a repository (or not known yet). */
        val git: GitSummary? = null,
        /** The folders that sit in it. */
        val children: List<Folder>,
    ) {
        val id: String get() = cwd

        /** It has terminals or sessions of its own (else it only gathers the folders under it). */
        val holdsOwn: Boolean get() = terminals.isNotEmpty() || sessions.isNotEmpty()

        /** Its terminals, then those of the folders under it, in the tree's order; the same for sessions. */
        val allTerminals: List<TerminalInfo> get() = terminals + children.flatMap { it.allTerminals }
        val allSessions: List<SessionSummary> get() = sessions + children.flatMap { it.allSessions }
    }

    fun build(terminals: List<TerminalInfo>, sessions: List<SessionSummary>, git: Map<String, GitSummary> = emptyMap()): List<Folder> {
        // A session a running terminal writes (or was forked from) is not listed again; an ended terminal no longer
        // holds its session, so it can be resumed from the list.
        // A new Codex terminal says its record's id only after its first turn: until then, a Codex record made in its
        // folder since it started is taken to be its own (Codex ids are UUIDv7, with the time).
        val running = terminals.filter { it.isRunning }
        val held = running.flatMap { listOfNotNull(it.agentSessionId, it.resumedFrom) }.toSet()
        val openForks = running.filter { it.forked }.mapNotNull { it.resumedFrom }.toSet()
        val fresh = running.filter { it.harness == "codex" && it.agentSessionId == null }
        fun ownRecord(s: SessionSummary): Boolean =
            s.harness == "codex" && ((s.forkedFrom?.let { it in openForks } ?: false) ||
                fresh.any { it.cwd == s.cwd && (uuidTime(s.sessionId) ?: 0L) >= it.createdAt - 3000 })
        val listed = sessions.filter { it.sessionId !in held && !ownRecord(it) }
        val terminalsIn = terminals.groupBy { it.cwd }
        val sessionsIn = listed.groupBy { it.cwd }
        val own = terminalsIn.keys + sessionsIn.keys

        val direct = HashMap<String, Int>()
        for (cwd in own) if (cwd != "/") direct[parentOf(cwd)] = (direct[parentOf(cwd)] ?: 0) + 1
        val shown = own + direct.filter { it.value > 1 }.keys
        val children = HashMap<String, MutableList<String>>()
        val roots = mutableListOf<String>()
        for (path in shown.sortedWith(byPath)) {
            val holder = holder(path, shown)
            if (holder != null) children.getOrPut(holder) { mutableListOf() }.add(path) else roots.add(path)
        }

        fun folder(cwd: String, name: String): Folder = Folder(
            cwd = cwd,
            name = name,
            terminals = (terminalsIn[cwd] ?: emptyList()).sortedBy { it.createdAt },
            sessions = (sessionsIn[cwd] ?: emptyList()).sortedWith(
                compareByDescending<SessionSummary> { it.startedAt ?: it.updatedAt }.thenBy { it.sessionId },
            ),
            git = git[cwd],
            children = (children[cwd] ?: emptyList()).map { folder(it, relative(it, cwd)) },
        )
        // At the top a folder goes by its own name; names that repeat are told apart by their parent.
        val names = roots.map { lastComponent(tilde(it)) }
        return roots.zip(names).map { (cwd, name) ->
            val tail = tilde(cwd).split("/").filter { it.isNotEmpty() }.takeLast(2).joinToString("/")
            folder(cwd, if (names.count { it == name } > 1) tail.ifEmpty { "/" } else name)
        }
    }

    /** The running terminals in the order the tree shows them. */
    fun order(folders: List<Folder>): List<TerminalInfo> = folders.flatMap { it.allTerminals }

    /** A folder with its name as a search shows it (Swift's `(folder:, name:)` tuple). */
    data class Named(val folder: Folder, val name: String)

    /**
     * Every folder, depth first, with its name as a search shows it: under the names of the folders it sits in
     * ("Worktop/培训/靶场").
     */
    fun flatten(folders: List<Folder>, above: String? = null): List<Named> = folders.flatMap { f ->
        val name = if (above != null) "$above/${f.name}" else f.name
        listOf(Named(f, name)) + flatten(f.children, name)
    }

    /** `path` and every folder above it, nearest first: the folders to open so it shows. */
    fun foldersAbove(path: String): List<String> {
        val out = mutableListOf(path)
        var p = path
        while (p != "/") { p = parentOf(p); out.add(p) }
        return out
    }

    /** A folder's line: its name and a slash (the top of the disk is `/` alone). */
    fun slashed(name: String): String = if (name.endsWith("/")) name else "$name/"

    /** The places directly in your home (macOS's own folders), not projects. */
    internal val places: Set<String> = setOf("Desktop", "Documents", "Downloads", "Library", "Movies", "Music", "Pictures", "Public", "Applications")

    /** Near the top: it holds only what sits directly in it. */
    internal fun shallow(path: String): Boolean {
        val parts = path.split("/").filter { it.isNotEmpty() }
        return parts.size <= 2 || (parts.size == 3 && parts[0] == "Users" && parts[2] in places)
    }

    /** The nearest shown folder above `path`, or null at the top. */
    internal fun holder(path: String, shown: Set<String>): String? {
        if (path == "/") return null
        var p = parentOf(path)
        var direct = true
        while (true) {
            if (p in shown && (direct || !shallow(p))) return p
            if (p == "/") return null
            p = parentOf(p)
            direct = false
        }
    }

    internal fun relative(path: String, holder: String): String =
        if (holder == "/") path.dropWhile { it == '/' } else path.substring(path.graphemePrefix(holder.graphemeCount() + 1).length)

    /** When a UUIDv7 id (Codex's) was made, in ms; null for any other id. */
    internal fun uuidTime(id: String): Long? {
        val hex = id.replace("-", "")
        if (hex.length != 32 || !hex.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' } || hex[12] != '7') return null
        return hex.substring(0, 12).toLong(16)
    }

    /** Paths as a directory tree sorts them: case aside, numbers by value. */
    internal val byPath: Comparator<String> = Comparator { a, b -> compareFolded(a.lowercase(), b.lowercase()) }

    private fun compareFolded(a: String, b: String): Int {
        var i = 0
        var j = 0
        while (i < a.length && j < b.length) {
            if (a[i].isDigitAscii() && b[j].isDigitAscii()) {
                var ie = i
                while (ie < a.length && a[ie].isDigitAscii()) ie++
                var je = j
                while (je < b.length && b[je].isDigitAscii()) je++
                val x = a.substring(i, ie).trimStart('0')
                val y = b.substring(j, je).trimStart('0')
                if (x.length != y.length) return x.length.compareTo(y.length)
                val c = x.compareTo(y)
                if (c != 0) return c
                i = ie
                j = je
            } else {
                if (a[i] != b[j]) return a[i].compareTo(b[j])
                i++
                j++
            }
        }
        return (a.length - i).compareTo(b.length - j)
    }

    private fun Char.isDigitAscii(): Boolean = this in '0'..'9'

    internal fun parentOf(path: String): String {
        val slash = path.lastIndexOf('/')
        return if (slash <= 0) "/" else path.substring(0, slash)
    }

    /** A folder as the tree and the terminal page's title name it: its last component. */
    fun lastComponent(path: String): String =
        if (path == "/") "/" else path.split("/").lastOrNull { it.isNotEmpty() } ?: path

    /** `/Users/<name>/x` as `~/x`, as the web page shows paths (not `/Users/Shared`, which is no one's home). */
    internal fun tilde(path: String): String {
        if (!path.startsWith("/Users/") || path == "/Users/Shared" || path.startsWith("/Users/Shared/")) return path
        val rest = path.drop(7)
        val slash = rest.indexOf('/')
        if (slash < 0) return "~"
        return "~" + rest.substring(slash)
    }
}

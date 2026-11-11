package com.agentswitch.android.files

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.agentswitch.android.AppSettings
import com.agentswitch.kit.api.FileRefusal
import com.agentswitch.kit.api.MacFileEntry
import com.agentswitch.kit.api.MacFileSource
import com.agentswitch.kit.api.MacFolder
import com.agentswitch.kit.api.MacPath
import com.agentswitch.kit.api.MacPick
import com.agentswitch.kit.api.UploadConflict
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.File
import java.util.UUID

/**
 * The Files tab across its visits (docs/files-v0.md §5): where it was last on each Mac, a folder another page asked it to
 * show (`Show in Files`: that is `AppModel.openFilesRequest` here, not a field of this store), and the files picked on
 * it for a terminal, until that terminal's page takes them.
 *
 * `settings` is the iPhone's `UserDefaults` (null: nothing is kept); `tempDir` is where files wait on their way to the
 * Mac or on their way to be shared (the iPhone's temporary directory).
 */
@Stable
class FilesStore(
    private val scope: CoroutineScope,
    private val settings: AppSettings? = null,
    private val tempDir: File = File(System.getProperty("java.io.tmpdir") ?: "."),
) {
    /** Where the tab was last, by the Mac's fingerprint. */
    private val last: MutableMap<String, String> = HashMap<String, String>().also { map ->
        val raw = settings?.string(lastKey)
        if (raw != null) try {
            val o = JSONObject(raw)
            for (k in o.keys()) map[k] = o.getString(k)
        } catch (_: Exception) { /* unreadable: starts empty */ }
    }

    /** Files picked on the Files tab for a terminal: its page takes them as it opens. */
    var handoff: Handoff? by mutableStateOf(null)

    /** The Mac's home folder, as its last answer said (`~` in the terminals' folders). */
    var home: String? by mutableStateOf(null)

    /**
     * Files on their way to the Mac (docs/files-v0.md §12.8): kept here, not on a page, so they go on when the page is
     * left; one at a time, in the order picked.
     */
    var uploads: List<Upload> by mutableStateOf(emptyList())
        private set

    /**
     * What changed on the Mac from this phone just now (a file landed, a folder made, something moved): the pages
     * showing it read their level again at once instead of at their next turn.
     */
    var changed: Int by mutableStateOf(0)

    /** A path just made or landed: its row lights up once. */
    var lit: String? by mutableStateOf(null)

    /** The Mac's name, for what a failed upload says. */
    var macName = "Mac"

    private var sending: Pair<String, Deferred<*>>? = null
    private var pumping = false

    /** One file of this phone's on its way into a folder on the Mac. */
    data class Upload(
        val id: String = UUID.randomUUID().toString(),
        val name: String,
        val size: Long,
        val dir: String,
        /** The copy on this phone it is read from (gone once it has landed or is let go). */
        val file: File,
        val conflict: UploadConflict = UploadConflict.Fail,
        val progress: Double = 0.0,
        val state: State = State.Waiting,
    ) {
        sealed class State {
            data object Waiting : State()

            /** Its name is taken there: asked about first. */
            data object Asking : State()
            data object Sending : State()
            data class Failed(val why: String) : State()
        }

        val path: String get() = MacPath.join(dir, name)
    }

    data class Handoff(val terminal: String, val picks: List<MacPick>)

    fun lastPlace(mac: String?): String? = mac?.let { last[it] }

    fun remember(path: String, mac: String?) {
        if (mac == null || last[mac] == path) return
        last[mac] = path
        val o = JSONObject()
        for ((k, v) in last) o.put(k, v)
        settings?.putString(lastKey, o.toString())
    }

    /** Another Mac: what was on its way, and what was picked, goes (what is kept per Mac stays). */
    fun reset() {
        sending?.second?.cancel()
        sending = null
        for (u in uploads) holderOf(u.file)?.deleteRecursively()
        uploads = emptyList()
        handoff = null
        home = null
        lit = null
    }

    // MARK: uploads (the Swift's `extension FilesStore` in FilesChanging.swift)

    /**
     * `files` (copies on this phone) into `dir` on the Mac. A name taken there (`taken`) waits to be asked about: its
     * uploads' ids come back, for one question about all of them. A file over the limit is not sent.
     */
    fun send(files: List<File>, dir: String, taken: Set<String>, source: () -> MacFileSource?): List<String> {
        val asking = ArrayList<String>()
        val added = ArrayList<Upload>()
        for (file in files) {
            val size = file.length()
            var up = Upload(name = file.name, size = size, dir = dir, file = file)
            if (size > MAX_FILE_SHARE) {
                up = up.copy(state = Upload.State.Failed("文件超过 200 MB，未上传。"))
            } else if (taken.any { it.equals(up.name, ignoreCase = true) }) {
                up = up.copy(state = Upload.State.Asking)
                asking.add(up.id)
            }
            added.add(up)
        }
        uploads = uploads + added
        pump(source)
        return asking
    }

    /** The answer about names taken: `Keep Both`, `Replace`, or null for `Stop` (those are let go, the others go on). */
    fun answer(ids: List<String>, conflict: UploadConflict?, source: () -> MacFileSource?) {
        for (id in ids) {
            if (uploads.none { it.id == id }) continue
            if (conflict != null) set(id) { it.copy(conflict = conflict, state = Upload.State.Waiting) } else drop(id)
        }
        pump(source)
    }

    /** `×` on one: stopped if it is going, let go either way. */
    fun stop(id: String) {
        if (sending?.first == id) sending?.second?.cancel()
        drop(id)
    }

    fun retry(id: String, source: () -> MacFileSource?) {
        if (uploads.none { it.id == id }) return
        set(id) { it.copy(state = Upload.State.Waiting, progress = 0.0) }
        pump(source)
    }

    private fun drop(id: String) {
        val up = uploads.firstOrNull { it.id == id } ?: return
        holderOf(up.file)?.deleteRecursively()
        uploads = uploads.filter { it.id != id }
    }

    /**
     * One at a time, while any waits. (The iPhone asks the system for the time to finish one when the phone leaves the
     * app; Android has no such call — the transfer goes on while the process lives.)
     */
    private fun pump(source: () -> MacFileSource?) {
        if (pumping) return
        pumping = true
        scope.launch {
            try {
                while (true) {
                    val next = uploads.firstOrNull { it.state == Upload.State.Waiting } ?: break
                    val api = source() ?: break
                    val id = next.id
                    set(id) { it.copy(state = Upload.State.Sending, progress = 0.0) }
                    val task = async { api.upload(next.file, next.path, next.conflict) { p -> scope.launch { set(id) { u -> u.copy(progress = p) } } } }
                    sending = id to task
                    try {
                        val landed = task.await()
                        drop(id)
                        lit = landed.path
                        changed += 1
                    } catch (e: CancellationException) {
                        // Stopped with `×` (already let go); the scope's own cancellation goes on.
                        currentCoroutineContext().ensureActive()
                    } catch (e: Exception) {
                        val said = when {
                            e is com.agentswitch.kit.api.FileChangeError && e.refusal == FileRefusal.Exists -> "此位置已有“${next.name}”。"
                            e is com.agentswitch.kit.api.FileChangeError && e.refusal != null ->
                                if (e.refusal == FileRefusal.TooLarge) "文件超过 200 MB，未上传。" else e.refusal!!.sentence(macName)
                            task.isCancelled -> ""
                            else -> e.message ?: e.javaClass.simpleName
                        }
                        if (said.isEmpty()) drop(id) else set(id) { it.copy(state = Upload.State.Failed(said)) }
                    }
                    sending = null
                }
            } finally {
                pumping = false
            }
        }
    }

    private fun set(id: String, change: (Upload) -> Upload) {
        uploads = uploads.map { if (it.id == id) change(it) else it }
    }

    /** A folder of its own under the temporary folder for each file picked, so a name is kept as it was. */
    fun holder(): File = File(File(tempDir, "uploads"), UUID.randomUUID().toString()).also { it.mkdirs() }

    /** The folder [holder] made for `file`. */
    private fun holderOf(file: File): File? = file.parentFile?.takeIf { it.parentFile?.name == "uploads" }

    /** A photo the camera took, as the file it is sent as (`Photo 2026-10-18 at 12.30.45.jpg`). */
    fun cameraFile(jpeg: ByteArray, now: Long = System.currentTimeMillis()): File? = try {
        val stamp = java.text.SimpleDateFormat("yyyy-MM-dd 'at' HH.mm.ss", java.util.Locale.US).format(java.util.Date(now))
        File(holder(), "Photo $stamp.jpg").also { it.writeBytes(jpeg) }
    } catch (_: Exception) { null }

    /** A file the system's picker gave as bytes (`name` kept), copied into a holder of its own. */
    fun copy(name: String, bytes: () -> java.io.InputStream?): File? = try {
        val to = File(holder(), name)
        bytes()?.use { input -> to.outputStream().use { input.copyTo(it) } }?.let { to }
    } catch (_: Exception) { null }

    companion object {
        const val lastKey = "files.last"

        /** The most of one file the phone sends or fetches to share (`AgentSwitchAPI.maxFileShare`). */
        const val MAX_FILE_SHARE = 200L * 1024 * 1024
    }
}

/** `⋯`'s choices, kept on this phone for every Mac (keys in [AppSettings]). */
object FilesPrefs {
    const val hiddenKey = "files.hidden"
    const val sortKey = "files.sort"
}

/**
 * One folder's page: its level from the Mac, asked again every few seconds while it is on screen (an unchanged level
 * is a 304), and, in the pixel look, the folders opened in place under it (one level each).
 */
@Stable
class FolderModel(
    /** The folder asked for; null, where the Mac starts this phone (home, or the first folder of its scope). */
    val asked: String?,
) {
    var folder: MacFolder? by mutableStateOf(null)
        private set
    var refusal: FileRefusal? by mutableStateOf(null)
        private set

    /** A failure that is not the Mac refusing (the network): said over what is shown. */
    var failure: String? by mutableStateOf(null)
        private set
    var loading: Boolean by mutableStateOf(false)
        private set
    private var etag: String? = null
    private var hiddenAsked: Boolean? = null

    /** Folders opened in place (pixel), by path, with their entries once read. */
    var opened: Map<String, List<MacFileEntry>> by mutableStateOf(emptyMap())
        private set

    /** The folder asked for, when it is gone and its nearest level still there is shown instead (files-v0 §12.4). */
    var gone: String? by mutableStateOf(null)
        private set

    val path: String? get() = folder?.path ?: asked

    suspend fun load(source: MacFileSource?, hidden: Boolean) {
        if (source == null) return
        if (hiddenAsked != hidden) { etag = null; hiddenAsked = hidden }
        loading = folder == null
        try {
            val got = source.folder(if (gone != null) folder?.path else (asked ?: folder?.path), hidden, etag)
            if (got != null) {
                folder = got.folder
                etag = got.etag
            }
            refusal = null
            failure = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (FileRefusal.of(e) == FileRefusal.NotFound && gone == null && folder == null && asked != null) {
                val up = nearest(asked, source, hidden)
                if (up != null) {
                    gone = asked
                    folder = up.folder
                    etag = up.etag
                    refusal = null
                    return
                }
            }
            val r = FileRefusal.of(e)
            if (r != null) { refusal = r; folder = null; etag = null } else failure = e.message ?: e.javaClass.simpleName
        } finally {
            loading = false
        }
    }

    /** The nearest level above `path` the Mac still has. */
    private suspend fun nearest(path: String, source: MacFileSource, hidden: Boolean): com.agentswitch.kit.api.VersionedFolder? {
        var at = MacPath.parent(path)
        while (at != null) {
            try {
                source.folder(at, hidden, null)?.let { return it }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) { /* one level up */ }
            at = MacPath.parent(at)
        }
        return null
    }

    /** While the page is on screen. */
    suspend fun follow(source: () -> MacFileSource?, hidden: () -> Boolean) {
        while (true) {
            load(source(), hidden())
            for (path in opened.keys.toList()) readOpened(path, source(), hidden())
            delay(POLL_INTERVAL_MS)
        }
    }

    fun isOpen(path: String): Boolean = opened.containsKey(path)

    /** A folder's `▸`: open it in place one level, or close it. */
    suspend fun toggle(path: String, source: MacFileSource?, hidden: Boolean) {
        if (opened.containsKey(path)) { opened = opened - path; return }
        opened = opened + (path to emptyList())
        readOpened(path, source, hidden)
    }

    private suspend fun readOpened(path: String, source: MacFileSource?, hidden: Boolean) {
        if (source == null || !opened.containsKey(path)) return
        try {
            source.folder(path, hidden, null)?.let { if (opened.containsKey(path)) opened = opened + (path to it.folder.entries) }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) { /* kept as it was */ }
    }

    companion object {
        const val POLL_INTERVAL_MS = 3_000L
    }
}

/** Where the browser leads by value: a folder's page or a file's. */
sealed class FilesRoute {
    data class Folder(val path: String) : FilesRoute()
    data class File(val path: String) : FilesRoute()
}

/**
 * One browser (the Files tab, or `+` › Files on Mac over a terminal): the pages it has open, what is picked, and the
 * question asked before a file that may hold a password lands.
 */
@Stable
class FilesSession(val mode: Mode, root: String?) {
    sealed class Mode {
        /** The Files tab: nobody to give to yet (`Add to Reply…` asks which terminal). */
        data object Tab : Mode()

        /** Over a terminal's page: what is picked lands in its reply box. */
        data class Sheet(val terminal: String) : Mode()

        /**
         * Over a page with no reply box (an earlier session's, `Show in Files`, files-v0 §12.4.1): `Add to Reply…`
         * asks which terminal, as the Files tab does; `Done` closes it.
         */
        data object Over : Mode()
    }

    /** The first page's folder; null, where the Mac starts this phone. */
    var root: String? by mutableStateOf(root)
    var stack: List<FilesRoute> by mutableStateOf(emptyList())
    var selecting: Boolean by mutableStateOf(false)
    var picked: List<MacPick> by mutableStateOf(emptyList())
        private set

    /** The picks being looked at on the Mac (which may hold a password) before they go on. */
    var checking: Boolean by mutableStateOf(false)
        private set

    /** Picks that may hold a password, asked about before they land (`then` is where they go). */
    var asking: Asking? by mutableStateOf(null)

    /** The Files tab: picks checked and waiting for a terminal to go to. */
    var choosing: List<MacPick>? by mutableStateOf(null)

    // Changing the Mac's files (docs/files-v0.md §12.3): one question at a time, over whichever page is open.

    /** A name being asked for: a new folder or file, or a new name. */
    var naming: Naming? by mutableStateOf(null)

    /** What is about to go to the Mac's Trash, asked about first. */
    var trashing: Trashing? by mutableStateOf(null)

    /** A folder a terminal runs in, about to be renamed: asked about first. */
    var renameAsk: RenameAsk? by mutableStateOf(null)

    /** The names an upload found taken there, asked about once for all of them. */
    var clashing: Clashing? by mutableStateOf(null)

    /** Files fetched to this phone to be shared (the system's share sheet once they are here). */
    var sharing: Sharing? by mutableStateOf(null)

    /** A change the Mac refused, said in a sentence. */
    var refused: String? by mutableStateOf(null)

    data class Naming(
        val kind: Kind,
        /** The names in that folder now (checked against as typed). */
        val taken: Set<String>,
        val value: String,
        /** Why the last name tried cannot be used: said in a second alert, the name kept to be changed. */
        val error: String? = null,
        val id: String = UUID.randomUUID().toString(),
    ) {
        sealed class Kind {
            data class Folder(val dir: String) : Kind()
            data class File(val dir: String) : Kind()
            data class Rename(val path: String) : Kind()
        }

        val title: String
            get() = when (kind) {
                is Kind.Folder -> "New Folder"
                is Kind.File -> "New File"
                is Kind.Rename -> "Rename"
            }
        val renaming: Boolean get() = kind is Kind.Rename
    }

    data class Trashing(
        val paths: List<String>,
        /** A terminal running in one of them: said, and the Mac told it was asked. */
        val terminal: String? = null,
        /** The Trash would not take them: deleted for good if confirmed. */
        val permanent: Boolean = false,
        val id: String = UUID.randomUUID().toString(),
    )

    data class RenameAsk(val path: String, val name: String, val terminal: String, val id: String = UUID.randomUUID().toString())

    data class Clashing(val uploads: List<String>, val names: List<String>, val id: String = UUID.randomUUID().toString())

    data class Sharing(
        val paths: List<String>,
        val progress: Double = 0.0,
        /** The copies on this phone, once all are here. */
        val files: List<File>? = null,
        val failed: String? = null,
        val id: String = UUID.randomUUID().toString(),
    )

    class Asking(val picks: List<MacPick>, val then: (List<MacPick>) -> Unit, val id: String = UUID.randomUUID().toString()) {
        val names: List<String> get() = picks.filter { it.sensitive }.map { it.name }
    }

    val inTab: Boolean get() = mode == Mode.Tab

    /** Nobody to give to yet: `Add to Reply…` asks which terminal (the Files tab, or over a page with no reply box). */
    val asksTerminal: Boolean get() = mode == Mode.Tab || mode == Mode.Over

    /** A level of the path row: back to it if it is open, else a new first page. */
    fun go(to: String) {
        if (to == root) { stack = emptyList(); return }
        val at = stack.indexOfLast { it == FilesRoute.Folder(to) }
        if (at >= 0) { stack = stack.take(at + 1); return }
        root = to
        stack = emptyList()
    }

    fun isPicked(path: String): Boolean = picked.any { it.path == path }

    fun togglePick(pick: MacPick) {
        val at = picked.indexOfFirst { it.path == pick.path }
        if (at >= 0) picked = picked.filterIndexed { i, _ -> i != at } else if (picked.size < MAX_PICKS) picked = picked + pick
    }

    fun endSelecting() {
        selecting = false
        picked = emptyList()
    }

    /** Each file asked about on the Mac (`/files/stat`): whether it may hold a password. */
    suspend fun checked(picks: List<MacPick>, source: MacFileSource?): List<MacPick> {
        if (source == null) return picks
        checking = true
        try {
            val out = ArrayList<MacPick>()
            for (pick in picks) {
                var p = pick
                if (!p.isFolder) {
                    try {
                        p = p.copy(sensitive = source.fileDetails(p.path).sensitive != null)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (_: Exception) { /* as it was */ }
                }
                out.add(p)
            }
            return out
        } finally {
            checking = false
        }
    }

    /** Picks to land: asked about first when any may hold a password; `Cancel` keeps the others. */
    fun land(picks: List<MacPick>, then: (List<MacPick>) -> Unit) {
        if (picks.any { it.sensitive }) asking = Asking(picks, then) else then(picks)
    }

    /** `Cancel` of the password question (the Swift's `sensitiveQuestion`): the others only land. */
    fun cancelAsking() {
        val ask = asking ?: return
        val rest = ask.picks.filter { !it.sensitive }
        asking = null
        if (rest.isNotEmpty()) ask.then(rest)
    }

    /** `Add` of the password question: all of them land. */
    fun confirmAsking() {
        val ask = asking ?: return
        asking = null
        ask.then(ask.picks)
    }

    companion object {
        /** At most what one reply carries (docs/simple-view-v0.md §5.1). */
        const val MAX_PICKS = 10
    }
}

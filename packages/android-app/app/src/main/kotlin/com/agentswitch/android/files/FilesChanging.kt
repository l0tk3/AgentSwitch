package com.agentswitch.android.files

import com.agentswitch.android.AppModel
import com.agentswitch.kit.api.FileChangeError
import com.agentswitch.kit.api.FileNames
import com.agentswitch.kit.api.FileRefusal
import com.agentswitch.kit.api.MacFileSource
import com.agentswitch.kit.api.MacPath
import com.agentswitch.kit.api.MacPick
import com.agentswitch.kit.api.TerminalInfo
import com.agentswitch.kit.api.UploadConflict
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

// Changing the Mac's files from the phone (docs/files-v0.md §12.3, §12.8): a new folder or file, a new name, the Mac's
// Trash (asked first: the Trash is on the Mac, the phone cannot take it back — there is no undo, as on the iPhone),
// files of this phone's sent into a folder, and a file of the Mac's fetched to share on.
//
// Where this file cuts: the uploads' state machine is `FilesStore` (FilesModels.kt), since it outlives pages. Left to
// the screens: `UploadRow`; `PhotoFilesPicker` and the copying of files picked in the Files app (the screen gets the
// bytes from the system's picker and calls `FilesStore.copy` / `cameraFile`); the alerts and confirmation dialogs
// around `FileChangeQuestions` (their texts and actions are here); the download bar over a share (`fetching`: it reads
// `FilesSession.sharing`); `ActivitySheet` (Android's share sheet is an `ACTION_SEND` intent on copies the screen
// exposes through a `FileProvider`; the copies are in `Sharing.files`).

/** The terminals running in `path` or under it, as the phone knows them (asked about before it moves). */
fun FilesSession.Companion.runningIn(path: String, terminals: List<TerminalInfo>): TerminalInfo? =
    terminals.firstOrNull { it.isRunning && (it.workdir == path || it.workdir.startsWith(if (path == "/") "/" else "$path/")) }

/**
 * What the questions of one session do (the Swift's `FileChangeQuestions` view modifier without its alerts): the
 * screens show `session.naming`, `trashing`, `clashing`, `renameAsk`, `refused` and `sharing` with the titles and
 * messages given here, and call these on the buttons.
 */
class FileChangeQuestions(private val model: AppModel, private val session: FilesSession) {
    private val mac: String get() = model.profile?.name ?: "Mac"

    // MARK: names

    /** Change what the name field says (the alert's field). */
    fun setNamingValue(value: String) { session.naming = session.naming?.copy(value = value) }

    /** `OK` of the second alert: the name is kept to be changed. */
    fun clearNamingError() { session.naming = session.naming?.copy(error = null) }

    /** `Cancel` of the name alert. */
    fun cancelNaming() { session.naming = null }

    /** The name alert's `Create` / `Rename` is disabled while this is true. */
    val namingEmpty: Boolean get() = (session.naming?.value ?: "").trim { it == ' ' || it == '\t' }.isEmpty()

    /** `Create` / `Rename`. */
    suspend fun commitName() {
        val n = session.naming ?: return
        val source = model.fileSource ?: return
        val renamingName = (n.kind as? FilesSession.Naming.Kind.Rename)?.let { MacPath.name(it.path) }
        val check = FileNames.check(n.value, n.taken, renamingName)
        if (check is FileNames.Check.Error) { session.naming = n.copy(error = check.text); return }
        val name = n.value.trim { it == ' ' || it == '\t' }
        try {
            when (val kind = n.kind) {
                is FilesSession.Naming.Kind.Folder -> model.files.lit = source.newFolder(MacPath.join(kind.dir, name)).top
                is FilesSession.Naming.Kind.File -> model.files.lit = source.newFile(MacPath.join(kind.dir, name)).top
                is FilesSession.Naming.Kind.Rename -> {
                    if (name == MacPath.name(kind.path)) { session.naming = null; return }
                    // A folder a terminal runs in: said before it is renamed (files-v0 §12.2).
                    val t = FilesSession.runningIn(kind.path, model.terminals.terminals)
                    if (t != null) {
                        session.naming = null
                        session.renameAsk = FilesSession.RenameAsk(kind.path, name, t.name)
                        return
                    }
                    val to = source.rename(kind.path, name, force = false)
                    moved(kind.path, to)
                    model.files.lit = to
                }
            }
            session.naming = null
            model.files.changed += 1
        } catch (e: CancellationException) {
            throw e
        } catch (e: FileChangeError) {
            when (e.refusal) {
                FileRefusal.Exists -> session.naming = session.naming?.copy(error = "此位置已有“${name.split("/").firstOrNull { it.isNotEmpty() } ?: name}”。请换一个名称。")
                FileRefusal.InUse -> {
                    session.naming = null
                    (n.kind as? FilesSession.Naming.Kind.Rename)?.let {
                        session.renameAsk = FilesSession.RenameAsk(it.path, name, e.terminals.firstOrNull()?.name ?: "")
                    }
                }
                else -> { session.naming = null; session.refused = said(e) }
            }
        } catch (e: Exception) {
            session.naming = null
            session.refused = said(e)
        }
    }

    /** The rename question's title. */
    val renameTitle: String
        get() = session.renameAsk?.let { "将“${MacPath.name(it.path)}”改名为“${it.name}”？" } ?: ""

    /** The rename question's message. */
    val renameMessage: String
        get() = session.renameAsk?.let { "终端“${it.terminal}”正在此文件夹中运行。改名后，其中的 agent 仍会使用原来的路径，可能出错。" } ?: ""

    fun cancelRenameAsk() { session.renameAsk = null }

    /** Once asked: renamed, and the Mac told it was asked. */
    suspend fun rename(r: FilesSession.RenameAsk) {
        session.renameAsk = null
        val source = model.fileSource ?: return
        try {
            val to = source.rename(r.path, r.name, force = true)
            moved(r.path, to)
            model.files.lit = to
            model.files.changed += 1
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            session.refused = said(e)
        }
    }

    // MARK: the Trash

    val trashTitle: String
        get() {
            val t = session.trashing ?: return ""
            val what = if (t.paths.size == 1) "“${MacPath.name(t.paths[0])}”" else " ${t.paths.size} 项"
            return if (t.permanent) "要永久删除${what}吗？" else "将${what}移到 $mac 的废纸篓？"
        }

    fun trashMessage(t: FilesSession.Trashing): String {
        if (t.permanent) return "无法将它们移到 $mac 的废纸篓。此操作无法撤销。"
        t.terminal?.let { return "终端“$it”正在此文件夹中运行。移到废纸篓后，其中的 agent 仍会使用原来的路径，可能出错。" }
        return "可在 $mac 的废纸篓中恢复。"
    }

    /** The destructive button's word: `Delete Permanently` or `Move to Trash`. */
    fun trashButton(t: FilesSession.Trashing): String = if (t.permanent) "Delete Permanently" else "Move to Trash"

    fun cancelTrashing() { session.trashing = null }

    suspend fun trash(t: FilesSession.Trashing) {
        session.trashing = null
        val source = model.fileSource ?: return
        try {
            source.trash(t.paths, force = t.terminal != null, permanent = t.permanent)
            gone(t.paths)
        } catch (e: CancellationException) {
            throw e
        } catch (e: FileChangeError) {
            when (e.refusal) {
                FileRefusal.InUse -> session.trashing = FilesSession.Trashing(t.paths, terminal = e.terminals.firstOrNull()?.name ?: "")
                FileRefusal.NoTrash -> {
                    // What went, went; what the Trash would not take is asked about again, for good this time.
                    gone(t.paths.filter { it !in e.paths })
                    session.trashing = FilesSession.Trashing(e.paths, permanent = true)
                }
                else -> session.refused = said(e)
            }
        } catch (e: Exception) {
            session.refused = said(e)
        }
    }

    /** Gone from the Mac: out of the picks, and off the page that showed one of them. */
    private fun gone(paths: List<String>) {
        for (p in paths) if (session.isPicked(p)) session.togglePick(MacPick(p, isFolder = false))
        val last = session.stack.lastOrNull()
        var stack = session.stack
        if (last is FilesRoute.File && last.path in paths) stack = stack.dropLast(1)
        stack = stack.filterNot { r -> r is FilesRoute.Folder && paths.any { r.path == it || r.path.startsWith("$it/") } }
        session.stack = stack
        model.files.changed += 1
    }

    /** Renamed: a page open on it follows it. */
    private fun moved(from: String, to: String) {
        session.stack = session.stack.map {
            when {
                it is FilesRoute.File && it.path == from -> FilesRoute.File(to)
                it is FilesRoute.Folder && (it.path == from || it.path.startsWith("$from/")) -> FilesRoute.Folder(to + it.path.substring(from.length))
                else -> it
            }
        }
    }

    // MARK: names taken by an upload

    val clashTitle: String
        get() {
            val c = session.clashing ?: return ""
            return if (c.names.size == 1) "此位置已有名为“${c.names[0]}”的项目。要替换它吗？" else "此位置已有 ${c.names.size} 个同名的项目。要替换它们吗？"
        }

    val clashMessage: String get() = "原来的会移到 $mac 的废纸篓。"

    /** `Keep Both` (keep), `Replace` (replace), `Stop` (null). */
    fun answerClash(conflict: UploadConflict?) {
        val c = session.clashing ?: return
        session.clashing = null
        model.files.answer(c.uploads, conflict) { model.fileSource }
    }

    // MARK: sharing

    /** The copies were for the share sheet only (files-v0 §12.3): what was saved is in the Files app now. */
    fun endSharing() {
        for (f in session.sharing?.files ?: emptyList()) f.parentFile?.deleteRecursively()
        session.sharing = null
    }

    /** The sentence for what the Mac refused or what went wrong. */
    fun said(error: Throwable): String {
        (error as? FileChangeError)?.refusal?.let { return it.sentence(mac) }
        return error.message ?: error.javaClass.simpleName
    }
}

/** `Share…`: each file fetched to this phone (one folder each, its name kept), then the system's share sheet. */
fun FilesSession.share(paths: List<String>, source: MacFileSource?, store: FilesStore, scope: CoroutineScope) {
    if (source == null || paths.isEmpty()) return
    val started = FilesSession.Sharing(paths)
    sharing = started
    scope.launch {
        val files = ArrayList<java.io.File>()
        suspend fun fail(f: () -> Unit) { if (sharing?.id == started.id) f() }
        for ((i, path) in paths.withIndex()) {
            if (sharing?.id != started.id) { files.forEach { it.parentFile?.deleteRecursively() }; return@launch }
            val size = try { source.fileDetails(path).size } catch (e: CancellationException) { throw e } catch (_: Exception) { null }
            if (size != null && size > FilesStore.MAX_FILE_SHARE) {
                sharing = sharing?.copy(failed = "文件超过 200 MB，无法在手机上分享。")
                return@launch
            }
            val to = java.io.File(store.holder(), MacPath.name(path))
            try {
                source.downloadFile(path, to) { p -> scope.launch { if (sharing?.id == started.id) sharing = sharing?.copy(progress = (i + p) / paths.size) } }
                files.add(to)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val said = (e as? FileChangeError)?.refusal?.sentence("Mac") ?: (e.message ?: e.javaClass.simpleName)
                fail { sharing = sharing?.copy(failed = said) }
                return@launch
            }
        }
        if (sharing?.id == started.id) sharing = sharing?.copy(files = files) else files.forEach { it.parentFile?.deleteRecursively() }
    }
}

package com.agentswitch.kit.api

import com.agentswitch.kit.support.KitJson
import java.io.File
import kotlin.time.Duration
import kotlin.time.Duration.Companion.minutes
import kotlinx.serialization.Serializable

// Changing the Mac's files from the phone (docs/files-v0.md §12.3, §12.8): `POST /files/folder`, `/files/file`,
// `/files/rename`, `/files/trash`, and `PUT /files/content` — a file of this phone's sent into a folder on the Mac. A
// refusal is a `FileChangeError`: the Mac's code, and what it named with it (the terminals running in a folder, what
// the Trash would not take).

/** What `newFolder` / `newFile` made: the path asked for, and the first folder that had to be made on the way. */
@Serializable
data class MacMade(val path: String, val top: String)

/** One item moved to the Mac's Trash: where it was, and where it went (null when that could not be told). */
@Serializable
data class MacMoved(val path: String, val trashed: String? = null)

/** A file landed on the Mac: where (its name may be another, with `keep`), and how big. */
@Serializable
data class MacUploaded(val path: String, val name: String, val size: Long)

/** When a file sent in has the name of one already there (Finder's three answers, files-v0 §12.8). */
enum class UploadConflict(val rawValue: String) {
    /** Refused (409 `exists`). */
    Fail("fail"),

    /** The one there goes to the Mac's Trash. */
    Replace("replace"),

    /** The new one is named `x 2`. */
    Keep("keep"),
}

/**
 * Why the Mac did not change what was asked. [message] is what the user reads (Swift's `errorDescription`); [detail]
 * is the Mac's own words when they are not one of the codes (Swift's `message`). Equality is by the five fields.
 */
class FileChangeError(
    val refusal: FileRefusal?,
    /** The Mac's own words when they are not one of the codes. */
    val detail: String = "",
    val terminals: List<Terminal> = emptyList(),
    /** What the Trash would not take (`no-trash`). */
    val paths: List<String> = emptyList(),
    val status: Int = 0,
) : Exception() {
    /** The terminal running in a folder that was to move. */
    @Serializable
    data class Terminal(val id: String, val name: String)

    override val message: String? get() = detail.ifEmpty { refusal?.rawValue }

    override fun equals(other: Any?): Boolean =
        other is FileChangeError && refusal == other.refusal && detail == other.detail && terminals == other.terminals &&
            paths == other.paths && status == other.status

    override fun hashCode(): Int = listOf(refusal, detail, terminals, paths, status).hashCode()

    override fun toString(): String = "FileChangeError(refusal=$refusal, message=$detail, terminals=$terminals, paths=$paths, status=$status)"
}

/** The checks a name gets as it is typed (files-v0 §12.2): the same sentences the Mac's column writes. */
object FileNames {
    sealed class Check {
        data object Ok : Check()

        /** Allowed, said in amber. */
        data class Warning(val text: String) : Check()

        /** Not allowed, said in red. */
        data class Error(val text: String) : Check()

        val allowed: Boolean get() = this !is Error
        val sentence: String?
            get() = when (this) {
                Ok -> null
                is Warning -> text
                is Error -> text
            }
    }

    /** `CharacterSet.whitespaces`: the Unicode space separators and the tab. */
    private fun String.trimWhitespaces(): String =
        trim { it == '\t' || Character.getType(it) == Character.SPACE_SEPARATOR.toInt() }

    /**
     * `value` for a new item in a folder holding `taken` (its names), or as the new name of the item named `renaming`.
     * A new item's name may have `/` (folders on the way); a new name may not.
     */
    fun check(value: String, taken: Set<String>, renaming: String? = null): Check {
        val name = value.trimWhitespaces()
        if (name.isEmpty()) return Check.Error("请输入名称。")
        if (renaming != null && name.contains("/")) return Check.Error("名称不能包含“/”。")
        val parts = name.split("/").filter { it.isNotEmpty() }
        if (parts.any { it == "." || it == ".." }) return Check.Error("名称不能是“.”或“..”。")
        if (parts.any { it.toByteArray(Charsets.UTF_8).size > 255 } ||
            name.codePoints().anyMatch { it < 0x20 || it == 0x7f }
        ) {
            return Check.Error("此名称不能使用。")
        }
        // One name: taken here, case aside (a Mac's disk does not tell `Docs` from `docs`); a new name differing only in
        // case is a rename. Folders on the way (`a/b.ts`) may be there already: the Mac finds the rest.
        if (parts.size == 1) {
            val clash = taken.firstOrNull { it.equals(name, ignoreCase = true) }
            if (clash != null && clash != renaming) return Check.Error("此位置已有“$clash”。请换一个名称。")
        }
        if (value != value.trimWhitespaces()) return Check.Warning("名称前后有空格。")
        return Check.Ok
    }

    /** `IMG_0412 2.HEIC`: the name Finder gives the second of two (`Keep Both`). */
    fun keepBoth(name: String, taken: Set<String>): String {
        val ext = nsPathExtension(name)
        val stem = if (ext.isEmpty() || (name.startsWith(".") && !name.drop(1).contains("."))) name else name.dropLast(ext.length + 1)
        val tail = if (stem == name) "" else ".$ext"
        var k = 2
        while ("$stem $k$tail" in taken) k += 1
        return "$stem $k$tail"
    }
}

/** The most of one file the phone sends to the Mac, and fetches to share on (files-v0 §12.3, §12.8). */
val AgentSwitchAPI.Companion.maxFileShare: Long get() = 200L * 1024 * 1024

/** The longest one file may take to go (200 MB over a slow link). */
internal val AgentSwitchAPI.Companion.fileSendTimeout: Duration get() = 30.minutes

@Serializable
private class FilePathBody(val path: String)

@Serializable
private class FileRenameBody(val path: String, val name: String, val force: Boolean? = null)

@Serializable
private class FileTrashBody(val paths: List<String>, val force: Boolean? = null, val permanent: Boolean? = null)

@Serializable
private class FileRenamed(val path: String)

@Serializable
private class FileTrashReply(val moved: List<MacMoved>)

@Serializable
private class FileRefusalBody(
    val error: String? = null,
    val terminals: List<FileChangeError.Terminal>? = null,
    val paths: List<String>? = null,
)

suspend fun AgentSwitchAPI.newFolder(path: String): MacMade =
    change(listOf("files", "folder"), FilePathBody(path), FilePathBody.serializer(), MacMade.serializer())

suspend fun AgentSwitchAPI.newFile(path: String): MacMade =
    change(listOf("files", "file"), FilePathBody(path), FilePathBody.serializer(), MacMade.serializer())

suspend fun AgentSwitchAPI.rename(path: String, to: String, force: Boolean): String =
    change(listOf("files", "rename"), FileRenameBody(path, to, if (force) true else null), FileRenameBody.serializer(), FileRenamed.serializer()).path

suspend fun AgentSwitchAPI.trash(paths: List<String>, force: Boolean, permanent: Boolean): List<MacMoved> =
    change(listOf("files", "trash"), FileTrashBody(paths, if (force) true else null, if (permanent) true else null),
        FileTrashBody.serializer(), FileTrashReply.serializer()).moved

suspend fun AgentSwitchAPI.upload(file: File, to: String, conflict: UploadConflict, progress: (Double) -> Unit): MacUploaded {
    val endpoint = endpoints.endpoint()
    val query = listOf(URLQueryItem("path", to), URLQueryItem("conflict", conflict.rawValue))
    val base = request("PUT", endpoint, listOf("files", "content"), query, null, timeout = AgentSwitchAPI.fileSendTimeout)
    val req = base.copy(headers = base.headers + ("Content-Type" to "application/octet-stream"))
    try {
        val (data, response) = transport.upload(req, file, progress)
        AgentSwitchAPI.checkChange(data, response)
        try {
            return KitJson.decodeFromString(MacUploaded.serializer(), String(data, Charsets.UTF_8))
        } catch (e: Exception) {
            throw APIError.Decoding(e.toString())
        }
    } catch (error: APIError) {
        if (error.isNetworkFailure) endpoints.reportFailure(endpoint)
        throw error
    }
}

/** A JSON change, sent once; a refusal with what it named. */
private suspend fun <T, B> AgentSwitchAPI.change(
    path: List<String>,
    body: B,
    bodySerializer: kotlinx.serialization.KSerializer<B>,
    reply: kotlinx.serialization.KSerializer<T>,
): T {
    val endpoint = endpoints.endpoint()
    val data = try {
        KitJson.encodeToString(bodySerializer, body).toByteArray(Charsets.UTF_8)
    } catch (e: Exception) {
        throw APIError.Decoding("request body: $e")
    }
    val (answer, response) = try {
        transport.send(request("POST", endpoint, path, emptyList(), data))
    } catch (error: APIError) {
        if (error.isNetworkFailure) endpoints.reportFailure(endpoint)
        throw error
    }
    AgentSwitchAPI.checkChange(answer, response)
    try {
        return KitJson.decodeFromString(reply, String(answer, Charsets.UTF_8))
    } catch (e: Exception) {
        throw APIError.Decoding(e.toString())
    }
}

/**
 * 2xx passes; 401 is `Unauthorized`; a refusal is a `FileChangeError` (an older Mac's 404 for a route it does not
 * have: `Unsupported`).
 */
internal fun AgentSwitchAPI.Companion.checkChange(data: ByteArray, response: HTTPResponse) {
    when (response.statusCode) {
        in 200..299 -> return
        401 -> throw APIError.Unauthorized
        else -> {
            val body = try {
                KitJson.decodeFromString(FileRefusalBody.serializer(), String(data, Charsets.UTF_8))
            } catch (e: Exception) {
                null
            }
            val code = body?.error ?: ""
            val refusal = FileRefusal.entries.firstOrNull { it.rawValue == code }
                ?: (if (response.statusCode == 404 && code.isEmpty()) FileRefusal.Unsupported else null)
            throw FileChangeError(
                refusal = refusal,
                detail = if (refusal == null) code else "",
                terminals = body?.terminals ?: emptyList(),
                paths = body?.paths ?: emptyList(),
                status = response.statusCode,
            )
        }
    }
}

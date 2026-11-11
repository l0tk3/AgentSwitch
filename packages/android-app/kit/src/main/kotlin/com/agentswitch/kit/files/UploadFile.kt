package com.agentswitch.kit.files

import kotlinx.serialization.Serializable
import java.io.ByteArrayOutputStream

/** A file on its way to the Mac (`POST /uploads`, app-v0 §5): name, MIME type and bytes. */
class UploadFile(val name: String, val type: String, val data: ByteArray) {
    override fun equals(other: Any?): Boolean =
        other is UploadFile && name == other.name && type == other.type && data.contentEquals(other.data)

    override fun hashCode(): Int = 31 * (31 * name.hashCode() + type.hashCode()) + data.contentHashCode()

    override fun toString(): String = "UploadFile(name=$name, type=$type, data=${data.size} bytes)"
}

/** `POST /uploads` → `{files: [...]}`: a staged file's id goes into the task's `attachments`. */
@Serializable
data class StagedUpload(
    val id: String,
    val name: String,
    val size: Long,
    val type: String,
)

@Serializable
data class StagedUploads(val files: List<StagedUpload>)

/**
 * One file of a task (`GET /tasks/:id/files`): the user's `in/` attachments and the executor's `out/` deliverables,
 * or, once a temporary work dir is gone, the deliverables kept in the artifacts store (no prefix).
 */
data class TaskFile(
    val path: String,
    val size: Long,
    val isDeliverable: Boolean,
) {
    val id: String get() = path
    val name: String get() = path.split("/").lastOrNull { it.isNotEmpty() } ?: path

    /**
     * Documents a web view would render (and could fetch remote resources for) are shown as source instead of in
     * the system preview; the daemon serves them sandboxed to browsers, which a local preview cannot reproduce.
     */
    val opensInPreview: Boolean
        get() = pathExtension(name).lowercase() !in listOf("html", "htm", "xhtml", "svg", "svgz", "xml", "webarchive")

    companion object {
        /**
         * Where a download is cached, below the app's own folder: task id then the listed path, without "." / ".." or
         * empty segments, so a server-supplied path never leaves the task's folder.
         */
        fun cacheSegments(taskId: String, path: String): List<String> {
            fun clean(s: String) = s.split("/").filter { it.isNotEmpty() && it != "." && it != ".." }
            val file = clean(path)
            return listOf(clean(taskId).joinToString("-")) + file.ifEmpty { listOf("file") }
        }

        /** Foundation's `NSString.pathExtension` for a last path component: nothing for a leading-dot-only name. */
        private fun pathExtension(name: String): String {
            val dot = name.lastIndexOf('.')
            return if (dot <= 0) "" else name.substring(dot + 1)
        }
    }
}

@Serializable
data class TaskFileList(
    val root: String? = null,
    val files: List<Entry>,
) {
    @Serializable
    data class Entry(val path: String, val size: Long)

    val taskFiles: List<TaskFile>
        get() = files.map { TaskFile(it.path, it.size, root == "artifacts" || it.path.startsWith("out/")) }
}

/**
 * multipart/form-data with every file under the field name "files". A file name loses CR/LF (no header injection)
 * and has its quotes percent-escaped; an empty type is sent as application/octet-stream.
 */
object Multipart {
    fun body(files: List<UploadFile>, boundary: String): ByteArray {
        val out = ByteArrayOutputStream()
        for (file in files) {
            val name = file.name.replace("\r", "").replace("\n", "").replace("\"", "%22")
            out.write("--$boundary\r\nContent-Disposition: form-data; name=\"files\"; filename=\"$name\"\r\n".toByteArray(Charsets.UTF_8))
            val type = if (file.type.isEmpty()) "application/octet-stream" else file.type
            out.write("Content-Type: $type\r\n\r\n".toByteArray(Charsets.UTF_8))
            out.write(file.data)
            out.write("\r\n".toByteArray(Charsets.UTF_8))
        }
        out.write("--$boundary--\r\n".toByteArray(Charsets.UTF_8))
        return out.toByteArray()
    }
}

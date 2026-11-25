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

/** `POST /uploads` → `{files: [...]}`: a staged file's id goes with what is sent next (a terminal's reply). */
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

package com.agentswitch.kit.api

import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.transformWhile
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer

// The Mac's Files routes (docs/files-v0.md §7.1): `GET /files` (a level, versioned: an unchanged one is a 304),
// `/files/stat`, `/files/preview`, `/files/thumbnail`, `/files/content`. A path goes as the `path` query, as written on
// the Mac. A refusal is `APIError.Http` with the code as its message (`FileRefusal.of`).

/** The most of one file the Mac gives a phone: what is bigger is not asked for (it would answer 413). */
val AgentSwitchAPI.Companion.maxFileDownload: Long get() = 25L * 1024 * 1024

private fun pathQuery(path: String?): List<URLQueryItem> = if (path == null) emptyList() else listOf(URLQueryItem("path", path))

suspend fun AgentSwitchAPI.folder(path: String?, hidden: Boolean, etag: String?): VersionedFolder? {
    val query = pathQuery(path) + (if (hidden) listOf(URLQueryItem("hidden", "1")) else emptyList())
    val got = try {
        versioned(listOf("files"), query, etag, MacFolder.serializer())
    } catch (e: APIError.Transport) {
        versioned(listOf("files"), query, etag, MacFolder.serializer())
    }
    return got?.let { VersionedFolder(it.first, it.second) }
}

suspend fun AgentSwitchAPI.fileDetails(path: String): MacFileDetails = get(listOf("files", "stat"), MacFileDetails.serializer(), pathQuery(path))

suspend fun AgentSwitchAPI.filePreview(path: String): MacFilePreview = get(listOf("files", "preview"), MacFilePreview.serializer(), pathQuery(path))

suspend fun AgentSwitchAPI.fileThumbnail(path: String): ByteArray = bytes(listOf("files", "thumbnail"), pathQuery(path))

/**
 * The bytes into `to`, as they come; `progress` from 0 to 1. Swift writes to a file URL the caller gives (with
 * complete file protection); here it is the `File` itself, its folder made when missing. A refusal or a failure leaves
 * nothing behind: the file is removed.
 */
suspend fun AgentSwitchAPI.downloadFile(path: String, to: File, progress: (Double) -> Unit) {
    val endpoint = endpoints.endpoint()
    val req = request("GET", endpoint, listOf("files", "content"), pathQuery(path), null, accept = "*/*",
        timeout = AgentSwitchAPI.uploadTimeout)
    try {
        val (response, body) = transport.stream(req)
        if (response.statusCode !in 200..299) {
            val data = java.io.ByteArrayOutputStream()
            body.transformWhile<ByteArray, Unit> { chunk ->
                data.write(chunk)
                data.size() <= 4096
            }.collect {}
            AgentSwitchAPI.check(data.toByteArray(), response)
            return
        }
        val total = (response.header("Content-Length")?.trim()?.toLongOrNull() ?: 0L).coerceAtLeast(0L).toDouble()
        withContext(Dispatchers.IO) {
            to.absoluteFile.parentFile?.mkdirs()
            to.writeBytes(ByteArray(0))
        }
        to.outputStream().use { out ->
            var got = 0.0
            progress(0.0)
            body.collect { chunk ->
                withContext(Dispatchers.IO) { out.write(chunk) }
                got += chunk.size.toDouble()
                if (total > 0) progress(minOf(1.0, got / total))
            }
            progress(1.0)
        }
    } catch (error: APIError) {
        if (error.isNetworkFailure) endpoints.reportFailure(endpoint)
        runCatching { to.delete() }
        throw error
    } catch (error: Throwable) {
        runCatching { to.delete() }
        throw error
    }
}

/** A JSON GET sent with the version the screen has (`If-None-Match`): null when the Mac says it is unchanged. */
internal suspend fun <T> AgentSwitchAPI.versioned(
    path: List<String>,
    query: List<URLQueryItem>,
    etag: String?,
    reply: KSerializer<T>,
): Pair<T, String?>? {
    val endpoint = endpoints.endpoint()
    var req = request("GET", endpoint, path, query, null)
    if (etag != null) req = req.copy(headers = req.headers + ("If-None-Match" to etag))
    val (data, response) = try {
        transport.send(req)
    } catch (error: APIError) {
        if (error.isNetworkFailure) endpoints.reportFailure(endpoint)
        throw error
    }
    if (response.statusCode == 304) return null
    val value = AgentSwitchAPI.decode(data, response, reply)
    return value to response.header("ETag")
}

/** A file's bytes as they are, with a query. */
internal suspend fun AgentSwitchAPI.bytes(segments: List<String>, query: List<URLQueryItem>): ByteArray {
    val endpoint = endpoints.endpoint()
    try {
        val (data, response) = transport.send(request("GET", endpoint, segments, query, null, accept = "*/*", timeout = AgentSwitchAPI.uploadTimeout))
        AgentSwitchAPI.check(data, response)
        return data
    } catch (error: APIError) {
        if (error.isNetworkFailure) endpoints.reportFailure(endpoint)
        throw error
    }
}

/**
 * The client as a [MacFileSource] (Swift's `extension AgentSwitchAPI: MacFileSource`; a Kotlin class cannot take an
 * interface in another file).
 */
fun AgentSwitchAPI.asMacFileSource(): MacFileSource = object : MacFileSource {
    override suspend fun folder(path: String?, hidden: Boolean, etag: String?) = this@asMacFileSource.folder(path, hidden, etag)
    override suspend fun fileDetails(path: String) = this@asMacFileSource.fileDetails(path)
    override suspend fun filePreview(path: String) = this@asMacFileSource.filePreview(path)
    override suspend fun fileThumbnail(path: String) = this@asMacFileSource.fileThumbnail(path)
    override suspend fun downloadFile(path: String, to: File, progress: (Double) -> Unit) =
        this@asMacFileSource.downloadFile(path, to, progress)
    override suspend fun newFolder(path: String) = this@asMacFileSource.newFolder(path)
    override suspend fun newFile(path: String) = this@asMacFileSource.newFile(path)
    override suspend fun rename(path: String, to: String, force: Boolean) = this@asMacFileSource.rename(path, to, force)
    override suspend fun trash(paths: List<String>, force: Boolean, permanent: Boolean) =
        this@asMacFileSource.trash(paths, force, permanent)
    override suspend fun upload(file: File, to: String, conflict: UploadConflict, progress: (Double) -> Unit) =
        this@asMacFileSource.upload(file, to, conflict, progress)
}

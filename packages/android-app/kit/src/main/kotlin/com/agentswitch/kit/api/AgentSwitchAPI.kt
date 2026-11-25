package com.agentswitch.kit.api

import com.agentswitch.kit.files.Multipart
import com.agentswitch.kit.files.StagedUpload
import com.agentswitch.kit.files.StagedUploads
import com.agentswitch.kit.files.UploadFile
import com.agentswitch.kit.support.KitJson
import java.util.UUID
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import kotlinx.serialization.KSerializer
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer

/**
 * Client for the daemon's remote API (app-v0 §2). Every call goes through the pinned transport to whatever endpoint the
 * provider selects; a network failure is reported back so the next call re-selects. GETs are retried once on a fresh
 * endpoint; POST, PUT and DELETE never (nothing is sent twice, a delete is not reported twice).
 *
 * Swift's is a struct; here a class whose two settable properties are copied with [copy]. Routes of other files are
 * extension functions written with the plumbing below ([get], [post], [send], [perform], [bytes]), each given the
 * reply's `KSerializer` (and the body's, for a write).
 */
class AgentSwitchAPI(
    val endpoints: EndpointProviding,
    val transport: HTTPTransport,
    val token: String?,
) {
    var requestTimeout: Duration = 15.seconds

    /**
     * Which browser the browser routes are asked of (docs/profiles-v0.md §5.4): null, the shared one; else a profile's
     * own, by its key (`forBrowser`).
     */
    var browserKey: String? = null
        internal set

    /** A copy with the same endpoints, transport and token (Swift copies the struct). */
    internal fun copy(requestTimeout: Duration = this.requestTimeout, browserKey: String? = this.browserKey): AgentSwitchAPI =
        AgentSwitchAPI(endpoints, transport, token).also {
            it.requestTimeout = requestTimeout
            it.browserKey = browserKey
        }

    companion object {
        /**
         * What the Mac seals before it answers (up to 30 s there) gets room, so a slow answer is not taken for a
         * failure and the same thing sent twice.
         */
        val createTaskTimeout: Duration = 60.seconds

        /** Up to 100 MB of attachments over a phone connection. */
        val uploadTimeout: Duration = 180.seconds

        fun <T> decode(data: ByteArray, response: HTTPResponse, reply: KSerializer<T>): T {
            check(data, response)
            try {
                return KitJson.decodeFromString(reply, String(data, Charsets.UTF_8))
            } catch (e: Exception) {
                throw APIError.Decoding(e.toString())
            }
        }

        /** 2xx passes; 401 is `Unauthorized`; anything else carries the daemon's `{error}` text. */
        fun check(data: ByteArray, response: HTTPResponse) {
            when (response.statusCode) {
                in 200..299 -> return
                401 -> throw APIError.Unauthorized
                else -> {
                    val message = try {
                        KitJson.decodeFromString(ErrorReply.serializer(), String(data, Charsets.UTF_8)).error
                    } catch (e: Exception) {
                        ""
                    }
                    throw APIError.Http(status = response.statusCode, message = message)
                }
            }
        }
    }

    // MARK: - routes

    suspend fun health(): Health = get(listOf("healthz"), Health.serializer())
    suspend fun me(): Me = get(listOf("me"), Me.serializer())
    suspend fun addresses(): MacAddresses = get(listOf("addresses"), MacAddresses.serializer())
    /** Stages files on the Mac (multipart, sent once); the ids go with what is sent next. */
    suspend fun upload(files: List<UploadFile>): List<StagedUpload> {
        val boundary = "agentswitch-${UUID.randomUUID().toString().uppercase()}"
        val reply = perform("POST", listOf("uploads"), emptyList(), Multipart.body(files, boundary), StagedUploads.serializer(),
            timeout = uploadTimeout, contentType = "multipart/form-data; boundary=$boundary")
        return reply.files
    }

    /**
     * A picture the user sent with a message of a session (docs/simple-view-v0.md §4, §5.1): the `n`-th of the record's
     * item `item`, as the agent kept it. 404 from a Mac from before this route, for an agent read coarsely, or when
     * the agent kept only where the file was and it is no longer there.
     */
    suspend fun sessionImage(harness: String, id: String, item: String, n: Int): ByteArray =
        bytes(listOf("sessions", harness, id, "images", item, n.toString()))

    /**
     * A picture a step brought back (a picture file it read, a screenshot a tool took): the `k`-th of the `n`-th step
     * of the run of work `work`. 404 from a Mac from before this route.
     */
    suspend fun sessionStepImage(harness: String, id: String, work: String, n: Int, k: Int): ByteArray =
        bytes(listOf("sessions", harness, id, "steps", work, n.toString(), "images", k.toString()))

    // `sessionStep` (RecordStepDetail) is ported with the record models, by another slice.

    /** A file's bytes as they are. */
    suspend fun bytes(segments: List<String>): ByteArray {
        val endpoint = endpoints.endpoint()
        try {
            val (data, response) = transport.send(request("GET", endpoint, segments, emptyList(), null, accept = "*/*", timeout = uploadTimeout))
            check(data, response)
            return data
        } catch (error: APIError) {
            if (error.isNetworkFailure) endpoints.reportFailure(endpoint)
            throw error
        }
    }

    /** A newer AgentSwitch.app staged on the Mac, if any, and the last switch's outcome. */
    suspend fun appUpdate(): AppUpdateInfo = get(listOf("update"), AppUpdateInfo.serializer())

    /**
     * The user's go-ahead: the Mac app quits, swaps in the new version and restarts (the previous one comes back if
     * the new one does not start). The connection drops meanwhile; the assistant reports the outcome.
     */
    suspend fun installUpdate() {
        send("POST", listOf("update", "install"), emptyMap(), MapSerializer(String.serializer(), String.serializer()),
            InstallRequested.serializer())
    }

    // MARK: - plumbing

    /** A GET, retried once (on whatever endpoint is selected then) after a transport failure. */
    suspend fun <T> get(path: List<String>, reply: KSerializer<T>, query: List<URLQueryItem> = emptyList()): T =
        try {
            perform("GET", path, query, null, reply)
        } catch (e: APIError.Transport) {
            perform("GET", path, query, null, reply)
        }

    suspend fun <T, B> post(path: List<String>, body: B, bodySerializer: KSerializer<B>, reply: KSerializer<T>): T =
        send("POST", path, body, bodySerializer, reply)

    /** A JSON write, sent once. */
    suspend fun <T, B> send(
        method: String,
        path: List<String>,
        body: B,
        bodySerializer: KSerializer<B>,
        reply: KSerializer<T>,
        timeout: Duration? = null,
    ): T {
        val data = try {
            KitJson.encodeToString(bodySerializer, body).toByteArray(Charsets.UTF_8)
        } catch (e: Exception) {
            throw APIError.Decoding("request body: $e")
        }
        return perform(method, path, emptyList(), data, reply, timeout = timeout)
    }

    fun request(
        method: String,
        endpoint: APIEndpoint,
        path: List<String>,
        query: List<URLQueryItem>,
        body: ByteArray?,
        accept: String = "application/json",
        timeout: Duration? = null,
        contentType: String = "application/json",
    ): HTTPRequest {
        val headers = LinkedHashMap<String, String>()
        headers["Accept"] = accept
        token?.let { headers["Authorization"] = "Bearer $it" }
        if (body != null) headers["Content-Type"] = contentType
        return HTTPRequest(method = method, url = endpoint.url(path, query), headers = headers, body = body,
            timeout = timeout ?: requestTimeout)
    }

    suspend fun <T> perform(
        method: String,
        path: List<String>,
        query: List<URLQueryItem>,
        body: ByteArray?,
        reply: KSerializer<T>,
        timeout: Duration? = null,
        contentType: String = "application/json",
    ): T {
        val endpoint = endpoints.endpoint()
        val (data, response) = try {
            transport.send(request(method, endpoint, path, query, body, timeout = timeout, contentType = contentType))
        } catch (error: APIError) {
            if (error.isNetworkFailure) endpoints.reportFailure(endpoint)
            throw error
        }
        return decode(data, response, reply)
    }
}

/**
 * The `n`-th step of the run of work `work` of a session, whole (docs/simple-view-v0.md §4). Null when the Mac has
 * none (an older Mac, an agent read coarsely): the record's own line stays.
 */
suspend fun AgentSwitchAPI.sessionStep(harness: String, id: String, work: String, n: Int): RecordStepDetail? =
    try {
        get(listOf("sessions", harness, id, "steps", work, n.toString()), RecordStepDetail.serializer())
    } catch (e: APIError.Http) {
        if (e.status == 404) null else throw e
    }

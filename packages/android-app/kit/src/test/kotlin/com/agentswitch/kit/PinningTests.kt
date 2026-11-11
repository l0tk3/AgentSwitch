package com.agentswitch.kit

import kotlin.concurrent.thread
import java.util.concurrent.atomic.AtomicInteger
import java.io.IOException
import com.agentswitch.kit.api.APIEndpoint
import com.agentswitch.kit.api.APIError
import com.agentswitch.kit.api.AgentSwitchAPI
import com.agentswitch.kit.api.FixedEndpoint
import com.agentswitch.kit.connection.HTTPEndpointProber
import com.agentswitch.kit.connection.ProbeOutcome
import com.agentswitch.kit.api.CertificatePin
import com.agentswitch.kit.api.EndpointKind
import com.agentswitch.kit.api.HTTPRequest
import com.agentswitch.kit.api.PinnedSessionTransport
import java.io.File
import java.net.InetAddress
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.Collections
import java.util.concurrent.TimeUnit
import kotlin.coroutines.cancellation.CancellationException
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate

class CertificatePinTests {
    /** `shasum -a 256 Fixtures/leaf.der` */
    private val fixtureFingerprint = "e11d05c0e9b6cb1e3f3f2361a4ef4fe523c0a42c3e3ba4185d9ae63e19be5607"

    @Test
    fun fingerprintAndMatch() {
        val der = Fixture.data("leaf.der")
        assertEquals(fixtureFingerprint, CertificatePin.fingerprint(der))
        assertTrue(CertificatePin.matches(der, pinned = fixtureFingerprint.uppercase()))
        val colons = fixtureFingerprint.chunked(2).joinToString(":")
        assertTrue(CertificatePin.matches(der, pinned = colons))
        assertFalse(CertificatePin.matches(der, pinned = "0".repeat(64)))
        assertFalse(CertificatePin.matches(der, pinned = "e11d05"))
        assertNull(CertificatePin.normalize("xyz"))
    }

    /** Swift's `testEvaluateSecTrust`, with the certificate chain the JVM hands a trust manager. */
    @Test
    fun evaluateCertificateChain() {
        val der = Fixture.data("leaf.der")
        val cert = CertificateFactory.getInstance("X.509").generateCertificate(der.inputStream()) as X509Certificate
        val chain = arrayOf(cert)
        assertEquals(CertificatePin.Decision.Accept, CertificatePin.evaluate(chain, pinned = fixtureFingerprint))
        assertEquals(CertificatePin.Decision.Reject(seen = fixtureFingerprint), CertificatePin.evaluate(chain, pinned = "a".repeat(64)))
        assertEquals(CertificatePin.Decision.Reject(seen = null), CertificatePin.evaluate(emptyArray(), pinned = fixtureFingerprint))
    }
}

/**
 * Real TLS: a throw-away HTTPS server on 127.0.0.1 (OkHttp's MockWebServer with a fresh self-signed EC P-256
 * certificate like the daemon's) and the real OkHttp transport, asked directly and through the prober and the API
 * client. Swift's version runs a Python server.
 */
class PinnedTransportTLSTests {
    private var server: MockWebServer? = null
    private val tempFiles = mutableListOf<File>()
    private val bodySizes = Collections.synchronizedList(mutableListOf<Long>())
    private val listeners = mutableListOf<java.net.ServerSocket>()

    @AfterTest
    fun tearDown() {
        server?.close()
        listeners.forEach { it.close() }
        tempFiles.forEach { it.delete() }
    }

    private val longLine = "x".repeat(10_000)
    private val streamBody = "event: a\ndata: 1\n\n$longLine\nlast"

    /** Starts the server; returns its endpoint and the certificate fingerprint. */
    private fun startServer(): Pair<APIEndpoint, String> {
        val held = HeldCertificate.Builder().commonName("AgentSwitch").ecdsa256().duration(1, TimeUnit.DAYS).build()
        val certs = HandshakeCertificates.Builder().heldCertificate(held).build()
        val s = MockWebServer()
        s.useHttps(certs.sslSocketFactory())
        s.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.target) {
                "/healthz" -> MockResponse.Builder().code(200).addHeader("Content-Type", "application/json").body("""{"ok":true}""").build()
                "/me" -> if (request.headers["Authorization"] == "Bearer good") {
                    MockResponse.Builder().code(200).body("""{"deviceId":"d1"}""").build()
                } else {
                    MockResponse.Builder().code(401).body("""{"error":"unauthorized"}""").build()
                }
                "/events" -> MockResponse.Builder().code(200).addHeader("Content-Type", "text/event-stream").body(streamBody).build()
                "/slow" -> MockResponse.Builder().code(200).headersDelay(10, TimeUnit.SECONDS).body("late").build()
                "/upload" -> {
                    bodySizes.add(request.bodySize)
                    MockResponse.Builder().code(201).body("""{"ok":true}""").build()
                }
                else -> MockResponse.Builder().code(404).body("""{"error":"not found"}""").build()
            }
        }
        s.start(InetAddress.getByName("127.0.0.1"), 0)
        server = s
        return APIEndpoint(host = "127.0.0.1", port = s.port, kind = EndpointKind.Lan) to CertificatePin.fingerprint(held.certificate.encoded)
    }

    private fun get(endpoint: APIEndpoint, path: String, token: String? = null) = HTTPRequest(
        method = "GET", url = endpoint.url(listOf(path)),
        headers = if (token != null) mapOf("Authorization" to "Bearer $token") else emptyMap(), timeout = 15.seconds,
    )

    @Test
    fun pinnedFingerprintIsAccepted() = runBlocking {
        val (endpoint, fp) = startServer()
        val transport = PinnedSessionTransport(fingerprint = fp)
        val (okBody, ok) = transport.send(get(endpoint, "me", "good"))
        assertEquals(200, ok.statusCode)
        assertEquals("""{"deviceId":"d1"}""", okBody.decodeToString())
        val (_, revoked) = transport.send(get(endpoint, "me", "bad"))
        assertEquals(401, revoked.statusCode)
        val (health, head) = transport.send(get(endpoint, "healthz"))
        assertEquals("""{"ok":true}""", health.decodeToString())
        assertEquals("application/json", head.header("content-type"))

        // Through the prober and the API client (Swift's testPinnedFingerprintIsAccepted).
        val prober = HTTPEndpointProber(transport = transport)
        assertEquals(ProbeOutcome.Ok, prober.probe(endpoint, token = "good"))
        assertEquals(ProbeOutcome.Unauthorized, prober.probe(endpoint, token = "bad"))
        assertTrue(AgentSwitchAPI(endpoints = FixedEndpoint(endpoint), transport = transport, token = null).health().ok)
    }

    @Test
    fun anyOtherCertificateIsRejected() = runBlocking {
        val (endpoint, fp) = startServer()
        val wrong = fp.reversed()
        val transport = PinnedSessionTransport(fingerprint = wrong)
        val error = assertFailsWith<APIError> { transport.send(get(endpoint, "me", "good")) }
        assertEquals(APIError.PinMismatch(seen = fp), error)
        val streamed = assertFailsWith<APIError> { transport.stream(get(endpoint, "events")) }
        assertEquals(APIError.PinMismatch(seen = fp), streamed)
        // Through the prober and the API client (Swift's testAnyOtherCertificateIsRejected).
        assertEquals(ProbeOutcome.PinMismatch(seen = fp), HTTPEndpointProber(transport = transport).probe(endpoint, token = "good"))
        val viaAPI = assertFailsWith<APIError> { AgentSwitchAPI(endpoints = FixedEndpoint(endpoint), transport = transport, token = "good").me() }
        assertEquals(APIError.PinMismatch(seen = fp), viaAPI)
        assertEquals(0, server?.requestCount, "a mismatched certificate must never be used")
    }

    /**
     * A bare TLS server whose first connection dies under its request: the request is read to its end and the
     * connection closed with nothing said — what a connection the Mac closed while the phone kept it amounts to, only
     * that here the request did arrive. Every later request is answered. Returns the endpoint, the certificate's
     * fingerprint and the count of requests that arrived.
     */
    private fun startDroppingServer(): Triple<APIEndpoint, String, AtomicInteger> {
        val held = HeldCertificate.Builder().commonName("AgentSwitch").ecdsa256().duration(1, TimeUnit.DAYS).build()
        val certs = HandshakeCertificates.Builder().heldCertificate(held).build()
        val listener = certs.sslContext().serverSocketFactory.createServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
        listeners.add(listener)
        val arrived = AtomicInteger()
        thread(isDaemon = true) {
            while (true) {
                val socket = try { listener.accept() } catch (_: IOException) { break }
                thread(isDaemon = true) {
                    try {
                        socket.use { s ->
                            val input = s.getInputStream().bufferedReader(Charsets.ISO_8859_1)
                            var length = 0
                            while (true) {
                                val line = input.readLine() ?: return@use
                                if (line.isEmpty()) break
                                if (line.startsWith("content-length:", ignoreCase = true)) length = line.substringAfter(":").trim().toInt()
                            }
                            repeat(length) { input.read() }
                            if (arrived.incrementAndGet() == 1) return@use
                            val body = """{"ok":true}"""
                            s.getOutputStream().apply {
                                write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n$body".toByteArray())
                                flush()
                            }
                        }
                    } catch (_: IOException) {
                    }
                }
            }
        }
        return Triple(APIEndpoint(host = "127.0.0.1", port = listener.localPort, kind = EndpointKind.Lan), CertificatePin.fingerprint(held.certificate.encoded), arrived)
    }

    /** A read whose connection dies is asked once more, on a new one (HTTPTransport.kt, "Connections the Mac has closed"). */
    @Test
    fun aReadIsAskedAgainWhenItsConnectionDies() = runBlocking {
        val (endpoint, fingerprint, arrived) = startDroppingServer()
        val (data, response) = PinnedSessionTransport(fingerprint).send(get(endpoint, "healthz"))
        assertEquals(200, response.statusCode)
        assertEquals("""{"ok":true}""", data.decodeToString())
        assertEquals(2, arrived.get())
    }

    /** A stream's head likewise. */
    @Test
    fun aStreamIsAskedAgainWhenItsConnectionDies() = runBlocking {
        val (endpoint, fingerprint, arrived) = startDroppingServer()
        val (head, _) = PinnedSessionTransport(fingerprint).stream(get(endpoint, "events"))
        assertEquals(200, head.statusCode)
        assertEquals(2, arrived.get())
    }

    /** A write whose connection dies is not sent again: the Mac may have acted on the first. */
    @Test
    fun aWriteIsNeverSentTwice() = runBlocking {
        val (endpoint, fingerprint, arrived) = startDroppingServer()
        val request = HTTPRequest(method = "POST", url = endpoint.url(listOf("terminals", "t1", "input")), body = "{}".encodeToByteArray(), timeout = 15.seconds)
        assertFailsWith<APIError.Transport> { PinnedSessionTransport(fingerprint).send(request) }
        delay(300)
        assertEquals(1, arrived.get())
    }

    @Test
    fun streamYieldsLinesAndCapsChunksAt4096() = runBlocking {
        val (endpoint, fp) = startServer()
        val (head, body) = PinnedSessionTransport(fingerprint = fp).stream(get(endpoint, "events"))
        assertEquals(200, head.statusCode)
        val chunks = body.toList()
        assertContentEquals(streamBody.toByteArray(), chunks.fold(ByteArray(0)) { a, b -> a + b })
        for (chunk in chunks.dropLast(1)) {
            assertTrue(chunk.last() == '\n'.code.toByte() || chunk.size == 4096, "chunk of ${chunk.size}")
        }
        assertEquals(listOf("event: a\n", "data: 1\n", "\n"), chunks.take(3).map { it.decodeToString() })
        assertEquals(listOf(4096, 4096, 10_000 - 8192 + 1, 4), chunks.drop(3).map { it.size })
    }

    @Test
    fun uploadReportsProgressAsBytesGo() = runBlocking {
        val (endpoint, fp) = startServer()
        val file = File.createTempFile("as-upload", ".bin").also { tempFiles += it }
        file.writeBytes(ByteArray(300 * 1024) { (it % 251).toByte() })
        val seen = Collections.synchronizedList(mutableListOf<Double>())
        val request = HTTPRequest(method = "PUT", url = endpoint.url(listOf("upload")), timeout = 15.seconds)
        val (_, response) = PinnedSessionTransport(fingerprint = fp).upload(request, file) { seen.add(it) }
        assertEquals(201, response.statusCode)
        assertEquals(listOf(file.length()), bodySizes.toList())
        assertTrue(seen.size > 1, "progress as it goes: $seen")
        assertEquals(seen.sorted(), seen.toList())
        assertEquals(1.0, seen.last())
    }

    @Test
    fun cancellingASendCancelsTheCall() = runBlocking {
        val (endpoint, fp) = startServer()
        val transport = PinnedSessionTransport(fingerprint = fp)
        val outcome = CompletableDeferred<Throwable?>()
        val job = async {
            try { transport.send(get(endpoint, "slow")); outcome.complete(null) } catch (e: Throwable) { outcome.complete(e); throw e }
        }
        delay(300.milliseconds)
        job.cancel()
        val error = withTimeout(3.seconds) { outcome.await() }
        assertTrue(error is CancellationException, "got $error")
    }

    @Test
    fun streamTimeoutBoundsOnlyTheHead() = runBlocking {
        val (endpoint, fp) = startServer()
        val request = get(endpoint, "slow").copy(timeout = 300.milliseconds)
        val error = withTimeout(3.seconds) { assertFailsWith<APIError> { PinnedSessionTransport(fingerprint = fp).stream(request) } }
        assertEquals(APIError.Transport("timeout"), error)
        assertTrue(error.isNetworkFailure)
    }
}

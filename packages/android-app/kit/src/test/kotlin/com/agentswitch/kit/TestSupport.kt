package com.agentswitch.kit

import com.agentswitch.kit.pairing.GateKey
import com.agentswitch.kit.pairing.PairingPayload
import com.agentswitch.kit.secrets.BoxSealer
import com.agentswitch.kit.support.Base64URL
import com.agentswitch.kit.support.KitJson
import com.goterl.lazysodium.LazySodiumJava
import com.goterl.lazysodium.SodiumJava
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Fixtures from `src/test/resources/Fixtures/`. */
object Fixture {
    fun data(name: String): ByteArray =
        checkNotNull(Fixture::class.java.getResourceAsStream("/Fixtures/$name")) { "missing fixture $name" }.use { it.readBytes() }

    fun <T> decode(strategy: DeserializationStrategy<T>, name: String): T =
        KitJson.decodeFromString(strategy, String(data(name), Charsets.UTF_8))
}

/** JSON of a map / list / scalar, keys sorted (as `JSONSerialization` with `.sortedKeys`). */
fun json(value: Any?): ByteArray = toJsonElement(value).toString().toByteArray(Charsets.UTF_8)

private fun toJsonElement(value: Any?): JsonElement = when (value) {
    null -> JsonNull
    is JsonElement -> value
    is String -> JsonPrimitive(value)
    is Number -> JsonPrimitive(value)
    is Boolean -> JsonPrimitive(value)
    is Map<*, *> -> JsonObject(value.entries.map { it.key.toString() to toJsonElement(it.value) }.sortedBy { it.first }.toMap())
    is List<*> -> JsonArray(value.map(::toJsonElement))
    else -> error("not JSON: $value")
}

val PairingPayload.Companion.sampleKey: String get() = Base64URL.encode(ByteArray(32) { 7 })

fun PairingPayload.Companion.sample(
    gate: GateKey? = GateKey(publicKey = PairingPayload.sampleKey, keypair = "default"),
): PairingPayload = PairingPayload(
    name = "Mac mini", port = 4713, fp = "ab".repeat(32), code = "7K3M-9QZX",
    lan = listOf("192.168.1.5"), tailnet = listOf("100.101.102.103", "mac.tail1234.ts.net"),
    bonjour = "AgentSwitch on Mac mini", gate = gate,
)

/** libsodium (lazysodium-java over JNA) for the tests: the sealer the app would give the kit, and the opening side. */
object TestSodium {
    val sodium: LazySodiumJava by lazy { LazySodiumJava(SodiumJava()) }

    const val SEALBYTES = 48

    val sealer = BoxSealer { message, recipientPublicKey ->
        val cipher = ByteArray(message.size + SEALBYTES)
        check(sodium.cryptoBoxSeal(cipher, message, message.size.toLong(), recipientPublicKey)) { "crypto_box_seal failed" }
        cipher
    }

    class KeyPair(val publicKey: ByteArray, val secretKey: ByteArray)

    fun keyPair(): KeyPair {
        val pk = ByteArray(32)
        val sk = ByteArray(32)
        check(sodium.cryptoBoxKeypair(pk, sk))
        return KeyPair(pk, sk)
    }

    fun open(cipher: ByteArray, publicKey: ByteArray, secretKey: ByteArray): ByteArray? {
        val message = ByteArray(cipher.size - SEALBYTES)
        return if (sodium.cryptoBoxSealOpen(message, cipher, cipher.size.toLong(), publicKey, secretKey)) message else null
    }
}

// MARK: - fakes for the API, the prober and discovery (Swift's TestSupport.swift)

fun httpResponse(url: String? = null, status: Int = 200, contentType: String = "application/json"): com.agentswitch.kit.api.HTTPResponse =
    com.agentswitch.kit.api.HTTPResponse(status, mapOf("Content-Type" to contentType))

/** `url.path` as Foundation gives it: percent-decoded. */
val com.agentswitch.kit.api.HTTPRequest.path: String get() = java.net.URI(url).path ?: ""

/** `url.query` as Foundation gives it: still percent-encoded. */
val com.agentswitch.kit.api.HTTPRequest.query: String? get() = java.net.URI(url).rawQuery

val com.agentswitch.kit.api.HTTPRequest.host: String? get() = java.net.URI(url).host

/** The request body as a JSON object (Swift's `JSONSerialization.jsonObject(with: httpBody)`). */
val com.agentswitch.kit.api.HTTPRequest.jsonBody: JsonObject?
    get() = body?.let { runCatching { KitJson.parseToJsonElement(it.decodeToString()) as? JsonObject }.getOrNull() }

/** Scripted HTTP: a handler per call, every request recorded. */
class FakeTransport(
    private val handler: suspend (com.agentswitch.kit.api.HTTPRequest, Int) -> Pair<ByteArray, com.agentswitch.kit.api.HTTPResponse> = okHandler,
    private val streamHandler: (suspend (com.agentswitch.kit.api.HTTPRequest, Int) -> Triple<com.agentswitch.kit.api.HTTPResponse, List<ByteArray>, Throwable?>)? = null,
) : com.agentswitch.kit.api.HTTPTransport {
    companion object {
        val okHandler: suspend (com.agentswitch.kit.api.HTTPRequest, Int) -> Pair<ByteArray, com.agentswitch.kit.api.HTTPResponse> =
            { req, _ -> "{}".toByteArray() to httpResponse(req.url) }
    }

    private val log = java.util.Collections.synchronizedList(mutableListOf<com.agentswitch.kit.api.HTTPRequest>())
    private val streamCount = java.util.concurrent.atomic.AtomicInteger(0)

    val requests: List<com.agentswitch.kit.api.HTTPRequest> get() = synchronized(log) { log.toList() }
    val paths: List<String> get() = requests.map { it.path }

    override suspend fun send(request: com.agentswitch.kit.api.HTTPRequest): Pair<ByteArray, com.agentswitch.kit.api.HTTPResponse> {
        val n = synchronized(log) { log.add(request); log.size - 1 }
        return handler(request, n)
    }

    override suspend fun stream(request: com.agentswitch.kit.api.HTTPRequest): Pair<com.agentswitch.kit.api.HTTPResponse, kotlinx.coroutines.flow.Flow<ByteArray>> {
        log.add(request)
        val n = streamCount.getAndIncrement()
        val streamHandler = streamHandler ?: throw com.agentswitch.kit.api.APIError.Transport("no stream handler")
        val (response, chunks, failure) = streamHandler(request, n)
        return response to kotlinx.coroutines.flow.flow {
            for (chunk in chunks) emit(chunk)
            if (failure != null) throw failure
        }
    }
}

/** Canned Bonjour results. */
class FakeDiscovery(val services: List<com.agentswitch.kit.connection.DiscoveredService>) : com.agentswitch.kit.connection.ServiceDiscovery {
    override suspend fun discover(timeout: kotlin.time.Duration): List<com.agentswitch.kit.connection.DiscoveredService> = services
}

/** Probe outcomes by host, with a call counter and optional per-host delay. */
class FakeProber(
    outcomes: Map<String, com.agentswitch.kit.connection.ProbeOutcome>,
    private val delays: Map<String, kotlin.time.Duration> = emptyMap(),
) : com.agentswitch.kit.connection.EndpointProber {
    private val outcomes = java.util.concurrent.ConcurrentHashMap(outcomes)
    private val calls = java.util.Collections.synchronizedList(mutableListOf<String>())

    val probed: List<String> get() = synchronized(calls) { calls.toList() }

    fun set(host: String, outcome: com.agentswitch.kit.connection.ProbeOutcome) { outcomes[host] = outcome }

    override suspend fun probe(endpoint: com.agentswitch.kit.api.APIEndpoint, token: String?): com.agentswitch.kit.connection.ProbeOutcome {
        calls.add(endpoint.host)
        delays[endpoint.host]?.let { kotlinx.coroutines.delay(it) }
        return outcomes[endpoint.host] ?: com.agentswitch.kit.connection.ProbeOutcome.Unreachable("no route")
    }
}

package com.agentswitch.kit

import com.agentswitch.kit.api.APIEndpoint
import com.agentswitch.kit.api.CertificatePin
import com.agentswitch.kit.api.EndpointKind
import com.agentswitch.kit.api.HTTPRequest
import com.agentswitch.kit.api.PinnedSessionTransport
import com.agentswitch.kit.connection.DirectRoute
import com.agentswitch.kit.connection.LocalAddress
import java.net.ConnectException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketAddress
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import javax.net.SocketFactory
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.runBlocking
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate

/** Which hosts are a local network's (connection/DirectRoute.kt). */
class LocalAddressTests {
    @Test
    fun privateAndLinkLocalAddressesAreLocal() {
        for (host in listOf("10.17.211.155", "10.0.0.1", "172.16.0.9", "172.31.255.254", "192.168.1.20", "169.254.3.4",
            "fe80::1c2b:3aff:fe4d:5e6f", "[fe80::1%wlan0]", "fd12:3456:789a::1", "Mac-mini.local", "mac-mini.local.")) {
            assertTrue(LocalAddress.isLocal(host), host)
        }
    }

    @Test
    fun otherAddressesAreNot() {
        // A tailnet's and a mesh's addresses (100.64/10) are a VPN's own: the way there is through it.
        for (host in listOf("100.112.6.101", "100.64.0.1", "172.15.0.1", "172.32.0.1", "192.169.0.1", "8.8.8.8", "127.0.0.1",
            "2001:db8::1", "example.com", "local", "", "999.1.1.1", "10.0.0")) {
            assertFalse(LocalAddress.isLocal(host), host)
        }
    }
}

/**
 * The way around a VPN (HTTPTransport.kt, “A VPN on the phone”): tried first, used when the Mac answers there, left
 * for the usual way when it does not. Real TLS on 127.0.0.1; the “other network” is a socket factory of the test's.
 */
class DirectRouteTransportTests {
    private val servers = mutableListOf<MockWebServer>()

    @AfterTest
    fun tearDown() {
        servers.forEach { it.close() }
    }

    /** A server with a certificate of its own; returns its endpoint, its fingerprint and the count of its requests. */
    private fun startServer(): Triple<APIEndpoint, String, AtomicInteger> {
        val held = HeldCertificate.Builder().commonName("AgentSwitch").ecdsa256().duration(1, TimeUnit.DAYS).build()
        val served = AtomicInteger()
        val server = MockWebServer()
        server.useHttps(HandshakeCertificates.Builder().heldCertificate(held).build().sslSocketFactory())
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                served.incrementAndGet()
                return MockResponse.Builder().code(200).addHeader("Content-Type", "application/json").body("""{"ok":true}""").build()
            }
        }
        server.start(InetAddress.getByName("127.0.0.1"), 0)
        servers.add(server)
        return Triple(APIEndpoint(host = "127.0.0.1", port = server.port, kind = EndpointKind.Lan), CertificatePin.fingerprint(held.certificate.encoded), served)
    }

    private fun get(endpoint: APIEndpoint) = HTTPRequest(method = "GET", url = endpoint.url(listOf("healthz")), timeout = 15.seconds)

    /** A socket factory that counts the sockets it makes and makes them with `make`. */
    private class Counting(val made: AtomicInteger = AtomicInteger(), val make: () -> Socket) : SocketFactory() {
        override fun createSocket(): Socket { made.incrementAndGet(); return make() }
        override fun createSocket(host: String?, port: Int): Socket = createSocket().apply { connect(InetSocketAddress(host, port)) }
        override fun createSocket(host: String?, port: Int, localHost: InetAddress?, localPort: Int): Socket = createSocket(host, port)
        override fun createSocket(host: InetAddress?, port: Int): Socket = createSocket().apply { connect(InetSocketAddress(host, port)) }
        override fun createSocket(address: InetAddress?, port: Int, localAddress: InetAddress?, localPort: Int): Socket = createSocket(address, port)
    }

    @Test
    fun theWayAroundIsUsedWhenTheMacAnswersThere() = runBlocking {
        val (endpoint, fingerprint, served) = startServer()
        val factory = Counting { Socket() }
        val transport = PinnedSessionTransport(fingerprint, DirectRoute { factory })
        repeat(3) { assertEquals(200, transport.send(get(endpoint)).second.statusCode) }
        assertEquals(3, served.get())
        // Tried once (a connection and a handshake, no request), then the requests' own connection: not tried again
        // for every request.
        assertEquals(2, factory.made.get())
    }

    @Test
    fun theUsualWayIsTakenWhenNothingAnswersAround() = runBlocking {
        val (endpoint, fingerprint, served) = startServer()
        val factory = Counting {
            object : Socket() {
                override fun connect(endpoint: SocketAddress?, timeout: Int) = throw ConnectException("no route this way")
            }
        }
        val transport = PinnedSessionTransport(fingerprint, DirectRoute { factory })
        repeat(2) { assertEquals(200, transport.send(get(endpoint)).second.statusCode) }
        assertEquals(2, served.get())
        assertEquals(1, factory.made.get())
    }

    /** Another device has the Mac's address on this Wi-Fi: its certificate is not the paired one, and the VPN's way is taken. */
    @Test
    fun somethingElseAtTheAddressIsNotTakenForTheMac() = runBlocking {
        val (endpoint, fingerprint, served) = startServer()
        val (stranger, _, strangerServed) = startServer()
        val factory = Counting {
            object : Socket() {
                override fun connect(endpoint: SocketAddress?, timeout: Int) = super.connect(InetSocketAddress("127.0.0.1", stranger.port), timeout)
            }
        }
        val transport = PinnedSessionTransport(fingerprint, DirectRoute { factory })
        val (data, response) = transport.send(get(endpoint))
        assertEquals(200, response.statusCode)
        assertEquals("""{"ok":true}""", data.decodeToString())
        assertEquals(1, served.get())
        assertEquals(0, strangerServed.get())
    }

    @Test
    fun aStreamGoesTheSameWay() = runBlocking {
        val (endpoint, fingerprint, served) = startServer()
        val factory = Counting { Socket() }
        val transport = PinnedSessionTransport(fingerprint, DirectRoute { factory })
        assertEquals(200, transport.stream(get(endpoint)).first.statusCode)
        assertEquals(1, served.get())
        assertEquals(2, factory.made.get())
    }

    @Test
    fun noWayAroundNamedIsTheUsualWay() = runBlocking {
        val (endpoint, fingerprint, served) = startServer()
        val asked = AtomicInteger()
        val transport = PinnedSessionTransport(fingerprint, DirectRoute { asked.incrementAndGet(); null })
        assertEquals(200, transport.send(get(endpoint)).second.statusCode)
        assertEquals(1, served.get())
        assertTrue(asked.get() >= 1)
    }
}

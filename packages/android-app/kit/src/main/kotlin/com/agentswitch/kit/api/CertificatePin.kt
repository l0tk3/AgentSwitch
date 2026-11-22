package com.agentswitch.kit.api

import com.agentswitch.kit.support.hexString
import java.net.Socket
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.ConcurrentHashMap
import javax.net.ssl.SSLEngine
import javax.net.ssl.SSLSocket
import javax.net.ssl.X509ExtendedTrustManager

/**
 * Trust in the Mac is one fact learned at pairing: the SHA-256 of its certificate's DER. No CA, no hostname check
 * (the certificate is self-signed and the Mac is reached by LAN IP, Tailscale IP or MagicDNS name alike).
 */
object CertificatePin {
    sealed class Decision {
        data object Accept : Decision()

        /** The leaf's actual fingerprint (null when the server sent no certificate). */
        data class Reject(val seen: String?) : Decision()
    }

    /** SHA-256 of DER bytes, lowercase hex: the daemon's fingerprint format. */
    fun fingerprint(ofDER: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(ofDER).hexString

    /** Lowercase, `:` and spaces removed; null unless 64 hex digits remain. */
    fun normalize(fingerprint: String): String? {
        val s = fingerprint.lowercase().filter { it != ':' && it != ' ' }
        if (s.length != 64 || !s.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) return null
        return s
    }

    /** Constant-time comparison of the leaf's fingerprint with the pinned one. */
    fun matches(der: ByteArray, pinned: String): Boolean {
        val normalized = normalize(pinned) ?: return false
        val actual = fingerprint(der).toByteArray(Charsets.UTF_8)
        val expected = normalized.toByteArray(Charsets.UTF_8)
        if (actual.size != expected.size) return false
        var diff = 0
        for (i in actual.indices) diff = diff or (actual[i].toInt() xor expected[i].toInt())
        return diff == 0
    }

    /** The leaf certificate (first in the chain) as DER. */
    fun leafDER(chain: Array<out X509Certificate>?): ByteArray? = chain?.firstOrNull()?.encoded

    fun evaluate(chain: Array<out X509Certificate>?, pinned: String): Decision {
        val der = leafDER(chain) ?: return Decision.Reject(seen = null)
        return if (matches(der, pinned)) Decision.Accept else Decision.Reject(seen = fingerprint(der))
    }
}

/**
 * The trust manager of a pinned connection: it accepts a server only when its leaf certificate matches the paired
 * fingerprint (Swift: the URLSession delegate of the same name). There is no CA and no host name check; every overload
 * of [X509ExtendedTrustManager] ends in the same pin check, so neither the JVM's nor Android's host-aware path can
 * bypass it. A mismatch fails the handshake and is remembered per host so the transport can report it as a pin failure
 * rather than a generic network error. The phone is never a TLS server: every client check fails.
 */
class PinnedTrustDelegate(val fingerprint: String) : X509ExtendedTrustManager() {
    private val mismatches = ConcurrentHashMap<String, String>()

    /** What the handshake fails with on a mismatch; `seen` as in [CertificatePin.Decision.Reject]. */
    class PinRejection(val seen: String?) : CertificateException("server certificate does not match the paired fingerprint")

    private fun check(chain: Array<out X509Certificate>?, host: String?) {
        when (val decision = CertificatePin.evaluate(chain, fingerprint)) {
            CertificatePin.Decision.Accept -> return
            is CertificatePin.Decision.Reject -> {
                if (host != null) mismatches[bare(host)] = decision.seen ?: ""
                throw PinRejection(decision.seen)
            }
        }
    }

    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) = check(chain, null)

    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?, socket: Socket?) =
        check(chain, (socket as? SSLSocket)?.handshakeSession?.peerHost ?: socket?.inetAddress?.hostAddress)

    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?, engine: SSLEngine?) =
        check(chain, engine?.handshakeSession?.peerHost ?: engine?.peerHost)

    /**
     * The host-aware check Android's `X509TrustManagerExtensions` calls on a trust manager that has it; the same pin
     * check, the verified chain returned as it came.
     */
    fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?, host: String?): List<X509Certificate> {
        check(chain, host)
        return chain?.toList() ?: emptyList()
    }

    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) =
        throw CertificateException("client certificates are not accepted")

    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?, socket: Socket?) =
        throw CertificateException("client certificates are not accepted")

    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?, engine: SSLEngine?) =
        throw CertificateException("client certificates are not accepted")

    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()

    /** The fingerprint a host presented on its last rejected handshake, cleared on read. */
    fun takeMismatch(host: String): String? = mismatches.remove(bare(host))

    private fun bare(host: String): String = host.trim('[', ']').lowercase()
}

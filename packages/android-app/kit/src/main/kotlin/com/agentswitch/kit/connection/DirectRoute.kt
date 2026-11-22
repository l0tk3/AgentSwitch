package com.agentswitch.kit.connection

import javax.net.SocketFactory

/**
 * A way to the Mac around a VPN on the phone (docs/app-v0.md §5b “手机上的 VPN”, 2026-11-12).
 *
 * On Android a VPN app takes every app's traffic unless told otherwise, the Mac's LAN address included. A proxy
 * client — Clash and its kind, which many of this app's users keep on all day — then sends a connection meant for
 * `10.x.x.x` on the Wi-Fi to a proxy somewhere, which cannot reach it: the phone and the Mac are on one Wi-Fi and the
 * Mac is not found. (On the iPhone such apps leave the local network alone by default, so its app has nothing like
 * this.) Android lets an app bind a socket to the network under the VPN when the VPN allows it, which most do.
 *
 * The platform gives the way; the transport tries it first and falls back to the usual one
 * (`PinnedSessionTransport`). Not every VPN is to be gone around — one that leads to the Mac's own network (a
 * WireGuard home, a mesh) is the way there — which is why it is tried and not assumed.
 */
fun interface DirectRoute {
    /**
     * The socket factory of the network under the VPN — Wi-Fi or Ethernet — when a VPN carries this app's traffic and
     * `host` is an address of a local network; else null. The same object for as long as that network is the same
     * one: the transport keeps what it learnt about a factory by its identity.
     */
    fun socketFactory(host: String): SocketFactory?
}

/** Which hosts are a local network's (the ones a VPN should not have taken): RFC 1918, link-local, `.local` names. */
object LocalAddress {
    private val ipv4 = Regex("""^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$""")

    fun isLocal(host: String): Boolean {
        val bare = host.trim().removePrefix("[").substringBefore("]").substringBefore("%").lowercase()
        if (bare.isEmpty()) return false
        ipv4.matchEntire(bare)?.let { match ->
            val parts = match.groupValues.drop(1).map { it.toInt() }
            if (parts.any { it > 255 }) return false
            val (a, b) = parts
            return a == 10 || (a == 172 && b in 16..31) || (a == 192 && b == 168) || (a == 169 && b == 254)
        }
        if (bare.contains(':')) {
            // fe80::/10 (link-local) and fc00::/7 (unique local).
            return bare.startsWith("fe8") || bare.startsWith("fe9") || bare.startsWith("fea") || bare.startsWith("feb") ||
                bare.startsWith("fc") || bare.startsWith("fd")
        }
        return bare.endsWith(".local") || bare.endsWith(".local.")
    }
}

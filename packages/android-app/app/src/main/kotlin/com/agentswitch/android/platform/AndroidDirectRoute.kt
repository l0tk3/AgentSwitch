package com.agentswitch.android.platform

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import com.agentswitch.kit.connection.DirectRoute
import com.agentswitch.kit.connection.LocalAddress
import javax.net.SocketFactory

/**
 * The way to the Mac's LAN address around a VPN on this phone (kit `DirectRoute`; docs/app-v0.md §5b “手机上的 VPN”).
 *
 * While a VPN is the network this app's traffic takes — Clash and its kind — and the phone is also on Wi-Fi or
 * Ethernet, a socket bound to that network reaches the Mac beside it; the VPN's own route would hand the connection
 * to a proxy. Android allows the binding when the VPN lets apps go around it, which most do; where it does not, the
 * socket fails to connect and the transport goes the usual way.
 */
class AndroidDirectRoute(context: Context) : DirectRoute {
    private val connectivity: ConnectivityManager? = context.applicationContext.getSystemService(ConnectivityManager::class.java)

    /** The factory handed out last and the network it is bound to: the same object while the network is the same. */
    private var kept: Pair<Network, SocketFactory>? = null

    @Synchronized
    override fun socketFactory(host: String): SocketFactory? {
        if (!LocalAddress.isLocal(host)) return null
        val connectivity = connectivity ?: return null
        try {
            val active = connectivity.activeNetwork ?: return null
            if (connectivity.getNetworkCapabilities(active)?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) != true) return null
            @Suppress("DEPRECATION") // the networks there are now, asked as a request is made; no callback to keep
            val under = connectivity.allNetworks.firstOrNull { network ->
                val caps = connectivity.getNetworkCapabilities(network) ?: return@firstOrNull false
                !caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) &&
                    (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))
            } ?: return null
            kept?.takeIf { it.first == under }?.let { return it.second }
            return under.socketFactory.also { kept = under to it }
        } catch (_: SecurityException) {
            return null
        }
    }
}

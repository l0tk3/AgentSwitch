package com.agentswitch.android.platform

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import com.agentswitch.kit.connection.NetworkPathSnapshot
import com.agentswitch.kit.connection.PathMonitoring
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.conflate

/**
 * The phone's networks as a stream of snapshots (the iPhone's `NWPathMonitor`): which are up — Wi-Fi, cellular, a VPN
 * such as Tailscale — so the connection chooses its address again when that changes. Needs ACCESS_NETWORK_STATE.
 */
class AndroidPathMonitor(context: Context) : PathMonitoring {
    private val connectivity: ConnectivityManager? = context.applicationContext.getSystemService(ConnectivityManager::class.java)

    override fun changes(): Flow<NetworkPathSnapshot> = callbackFlow {
        val connectivity = connectivity
        if (connectivity == null) {
            trySend(NetworkPathSnapshot(satisfied = true, interfaces = emptyList()))
            awaitClose { }
            return@callbackFlow
        }
        val up = HashMap<Network, String>()
        fun describe(network: Network): String? {
            val caps = connectivity.getNetworkCapabilities(network) ?: return null
            val type = when {
                caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "other"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "wired"
                else -> "other"
            }
            val name = connectivity.getLinkProperties(network)?.interfaceName ?: "?"
            return "$type:$name"
        }
        fun tell() {
            val interfaces = synchronized(up) { up.values.sorted() }
            trySend(NetworkPathSnapshot(satisfied = interfaces.isNotEmpty(), interfaces = interfaces))
        }
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                describe(network)?.let { synchronized(up) { up[network] = it } }
                tell()
            }

            override fun onLost(network: Network) {
                synchronized(up) { up.remove(network) }
                tell()
            }

            override fun onLinkPropertiesChanged(network: Network, linkProperties: LinkProperties) {
                describe(network)?.let { synchronized(up) { up[network] = it } }
                tell()
            }
        }
        // Every network, a VPN's too (the default request leaves VPNs out; Tailscale is one).
        val request = NetworkRequest.Builder().removeCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN).build()
        val registered = try {
            connectivity.registerNetworkCallback(request, callback)
            true
        } catch (_: RuntimeException) {
            false
        }
        if (!registered) trySend(NetworkPathSnapshot(satisfied = true, interfaces = emptyList()))
        awaitClose { if (registered) try { connectivity.unregisterNetworkCallback(callback) } catch (_: RuntimeException) { /* gone already */ } }
    }.conflate()
}

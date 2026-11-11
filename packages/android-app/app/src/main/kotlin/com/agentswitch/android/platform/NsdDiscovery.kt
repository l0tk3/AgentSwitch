package com.agentswitch.android.platform

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import com.agentswitch.kit.connection.DiscoveredService
import com.agentswitch.kit.connection.ServiceDiscovery
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import java.net.Inet4Address
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.resume
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds

/**
 * Browses `_agentswitch._tcp` for a while, then resolves every service found to an address, its port and the `fp` it
 * advertises (the iPhone's `BonjourDiscovery`, over Android's own service discovery). An IPv4 address where there is
 * one, so the URL needs no zone id. Nothing found — a network that does not let devices see each other, or the
 * permission for nearby devices not given — is an empty list: the saved addresses are tried anyway.
 */
class NsdDiscovery(context: Context, private val resolveTimeout: Duration = 2.seconds) : ServiceDiscovery {
    private val nsd: NsdManager? = context.applicationContext.getSystemService(NsdManager::class.java)

    override suspend fun discover(timeout: Duration): List<DiscoveredService> {
        val nsd = nsd ?: return emptyList()
        val found = browse(nsd, timeout)
        // One at a time: before Android 14 the system resolves a single service at once and refuses a second.
        return found.mapNotNull { resolve(nsd, it) }.sortedBy { it.name }
    }

    private suspend fun browse(nsd: NsdManager, timeout: Duration): List<NsdServiceInfo> {
        val seen = ConcurrentHashMap<String, NsdServiceInfo>()
        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) = Unit
            override fun onDiscoveryStopped(serviceType: String) = Unit
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) = Unit
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) = Unit
            override fun onServiceFound(service: NsdServiceInfo) { seen[service.serviceName] = service }
            override fun onServiceLost(service: NsdServiceInfo) { seen.remove(service.serviceName) }
        }
        val started = try {
            nsd.discoverServices(ServiceDiscovery.serviceType, NsdManager.PROTOCOL_DNS_SD, listener)
            true
        } catch (_: RuntimeException) {
            false
        }
        if (!started) return emptyList()
        try {
            delay(timeout)
        } finally {
            try { nsd.stopServiceDiscovery(listener) } catch (_: RuntimeException) { /* never started, or stopped already */ }
        }
        return seen.values.toList()
    }

    @Suppress("DEPRECATION")
    private suspend fun resolve(nsd: NsdManager, service: NsdServiceInfo): DiscoveredService? =
        withTimeoutOrNull(resolveTimeout) {
            suspendCancellableCoroutine { cont: CancellableContinuation<DiscoveredService?> ->
                val listener = object : NsdManager.ResolveListener {
                    override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) {
                        if (cont.isActive) cont.resume(null)
                    }

                    override fun onServiceResolved(info: NsdServiceInfo) {
                        if (cont.isActive) cont.resume(service(info))
                    }
                }
                try {
                    nsd.resolveService(service, listener)
                } catch (_: RuntimeException) {
                    if (cont.isActive) cont.resume(null)
                }
            }
        }

    @Suppress("DEPRECATION")
    private fun service(info: NsdServiceInfo): DiscoveredService? {
        val addresses = if (Build.VERSION.SDK_INT >= 34) info.hostAddresses else listOfNotNull(info.host)
        val address = addresses.firstOrNull { it is Inet4Address } ?: addresses.firstOrNull() ?: return null
        val host = address.hostAddress?.substringBefore('%') ?: return null
        val fp = info.attributes["fp"]?.toString(Charsets.UTF_8)?.takeIf { it.isNotEmpty() }
        return DiscoveredService(name = info.serviceName, fingerprintPrefix = fp, host = host, port = info.port)
    }
}

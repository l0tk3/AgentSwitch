package com.agentswitch.kit.connection

import com.agentswitch.kit.api.APIEndpoint
import com.agentswitch.kit.api.APIError
import com.agentswitch.kit.api.AgentSwitchAPI
import com.agentswitch.kit.api.EndpointKind
import com.agentswitch.kit.api.FixedEndpoint
import com.agentswitch.kit.api.HTTPTransport
import com.agentswitch.kit.api.Health
import com.agentswitch.kit.pairing.HostAddress
import com.agentswitch.kit.pairing.ServerAddressBook
import kotlin.coroutines.cancellation.CancellationException
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import kotlin.time.DurationUnit
import kotlin.time.TimeSource
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch

/** A `_agentswitch._tcp` service seen on the local network, already resolved to an address. */
data class DiscoveredService(
    val name: String,
    /** TXT `fp`: the first 16 hex digits of the certificate fingerprint. */
    val fingerprintPrefix: String?,
    val host: String,
    val port: Int,
)

/** Finds AgentSwitch Macs on the local network (the app's NSD browser on Android, canned results in tests). */
interface ServiceDiscovery {
    suspend fun discover(timeout: Duration): List<DiscoveredService>

    companion object {
        /** The DNS-SD service type the Mac advertises (Swift keeps it on `BonjourDiscovery`, which is not ported). */
        const val serviceType = "_agentswitch._tcp"
    }
}

sealed class ProbeOutcome {
    data object Ok : ProbeOutcome()

    /** `/healthz` answered but `/me` said 401: the device was revoked. */
    data object Unauthorized : ProbeOutcome()
    data class PinMismatch(val seen: String?) : ProbeOutcome()
    data class Unreachable(val reason: String) : ProbeOutcome()
}

/** Checks one endpoint: `/healthz`, then (with a token) `/me`. */
interface EndpointProber {
    suspend fun probe(endpoint: APIEndpoint, token: String?): ProbeOutcome
}

/**
 * How one address fared in the last selection, for "why can't it connect" (2026-09-26: over Tailscale the phone
 * reached the Mac in Safari but the app did not connect, and nothing said why).
 */
data class ProbeReport(
    val endpoint: APIEndpoint,
    /** null: not waited for, a better-ranked address answered first. */
    val outcome: ProbeOutcome?,
    val seconds: Double,
)

sealed class SelectionResult {
    data class Selected(val endpoint: APIEndpoint) : SelectionResult()
    data object Unauthorized : SelectionResult()
    data class PinMismatch(val seen: String?) : SelectionResult()
    data object Unreachable : SelectionResult()
}

/**
 * Address choice (app-v0 §5): Bonjour services whose TXT `fp` matches the pinned fingerprint's prefix, then the LAN
 * addresses from pairing, then the Tailscale ones. All candidates are probed at once; the first in that order that
 * answers wins.
 */
object EndpointSelector {
    const val fingerprintPrefixLength = 16

    fun candidates(book: ServerAddressBook, discovered: List<DiscoveredService>): List<APIEndpoint> {
        val prefix = book.fingerprint.take(fingerprintPrefixLength).lowercase()
        val bonjour = discovered
            .filter { it.fingerprintPrefix?.lowercase() == prefix && HostAddress.isValid(it.host) && it.port in 1..65535 }
            .map { APIEndpoint(host = it.host, port = it.port, kind = EndpointKind.Bonjour) }
        val lan = book.lan.map { APIEndpoint(host = it, port = book.port, kind = EndpointKind.Lan) }
        val tailnet = book.tailnet.map { APIEndpoint(host = it, port = book.port, kind = EndpointKind.Tailnet) }
        val seen = HashSet<String>()
        return (bonjour + lan + tailnet).filter { seen.add(it.authority.lowercase()) }
    }

    suspend fun select(candidates: List<APIEndpoint>, token: String?, prober: EndpointProber): SelectionResult =
        selectReporting(candidates, token, prober).first

    /** The selection and how every address fared (the seconds each took to answer or fail). */
    suspend fun selectReporting(candidates: List<APIEndpoint>, token: String?, prober: EndpointProber): Pair<SelectionResult, List<ProbeReport>> {
        val start = TimeSource.Monotonic.markNow()
        val finished = arrayOfNulls<Pair<ProbeOutcome, Double>>(candidates.size)
        coroutineScope {
            val done = Channel<Triple<Int, ProbeOutcome, Double>>(Channel.UNLIMITED)
            val jobs = candidates.mapIndexed { i, endpoint ->
                launch {
                    val outcome = prober.probe(endpoint, token)
                    done.send(Triple(i, outcome, start.elapsedNow().toDouble(DurationUnit.SECONDS)))
                }
            }
            repeat(candidates.size) {
                val (i, outcome, seconds) = done.receive()
                finished[i] = outcome to seconds
                // Stop early once every better-ranked candidate has failed and this one answered.
                val first = finished.indexOfFirst { it == null || it.first == ProbeOutcome.Ok }
                if (first >= 0 && finished[first]?.first == ProbeOutcome.Ok) {
                    jobs.forEach { it.cancel() }
                    return@coroutineScope
                }
            }
        }
        val outcomes = finished.map { it?.first ?: ProbeOutcome.Unreachable("not needed") }
        val reports = candidates.mapIndexed { i, endpoint ->
            ProbeReport(endpoint = endpoint, outcome = finished[i]?.first, seconds = finished[i]?.second ?: 0.0)
        }
        return decide(candidates, outcomes) to reports
    }

    /** Best reachable endpoint in preference order; otherwise the most telling failure. */
    internal fun decide(candidates: List<APIEndpoint>, outcomes: List<ProbeOutcome>): SelectionResult {
        val i = outcomes.indexOf(ProbeOutcome.Ok)
        if (i >= 0) return SelectionResult.Selected(candidates[i])
        if (outcomes.contains(ProbeOutcome.Unauthorized)) return SelectionResult.Unauthorized
        outcomes.firstNotNullOfOrNull { it as? ProbeOutcome.PinMismatch }?.let { return SelectionResult.PinMismatch(seen = it.seen) }
        return SelectionResult.Unreachable
    }
}

/** The real prober: short-timeout requests through the pinned transport. */
class HTTPEndpointProber(val transport: HTTPTransport, val timeout: Duration = 4.seconds) : EndpointProber {
    override suspend fun probe(endpoint: APIEndpoint, token: String?): ProbeOutcome {
        val api = AgentSwitchAPI(endpoints = FixedEndpoint(endpoint), transport = transport, token = token)
        return try {
            val request = api.request("GET", endpoint, listOf("healthz"), emptyList(), null, timeout = timeout)
            val health = request.copy(headers = request.headers.filterKeys { !it.equals("Authorization", ignoreCase = true) })
            val (data, response) = transport.send(health)
            val reply = AgentSwitchAPI.decode(data, response, Health.serializer())
            if (!reply.ok) return ProbeOutcome.Unreachable("服务状态异常")
            if (token == null) return ProbeOutcome.Ok
            val (meData, meResponse) = transport.send(api.request("GET", endpoint, listOf("me"), emptyList(), null, timeout = timeout))
            AgentSwitchAPI.check(meData, meResponse)
            ProbeOutcome.Ok
        } catch (e: CancellationException) {
            throw e
        } catch (e: APIError.Unauthorized) {
            ProbeOutcome.Unauthorized
        } catch (e: APIError.PinMismatch) {
            ProbeOutcome.PinMismatch(seen = e.seen)
        } catch (e: Exception) {
            ProbeOutcome.Unreachable(e.message ?: e.toString())
        }
    }
}

package com.agentswitch.kit.connection

import com.agentswitch.kit.api.APIEndpoint
import com.agentswitch.kit.api.APIError
import com.agentswitch.kit.api.EndpointProviding
import com.agentswitch.kit.api.ReconnectPolicy
import com.agentswitch.kit.pairing.ServerAddressBook
import java.util.UUID
import kotlin.coroutines.cancellation.CancellationException
import kotlin.time.Duration
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.consumeAsFlow
import kotlinx.coroutines.flow.onCompletion
import kotlinx.coroutines.launch

/** A network path as far as re-selection cares: when this changes, the best address may have changed too. */
data class NetworkPathSnapshot(
    val satisfied: Boolean,
    /** "wifi:wlan0", "cellular:rmnet0", "other:tun0"… */
    val interfaces: List<String>,
)

/** Network path changes (the app's ConnectivityManager callback, a scripted flow in tests). */
interface PathMonitoring {
    fun changes(): Flow<NetworkPathSnapshot>
}

sealed class ConnectionState {
    data object Idle : ConnectionState()
    data object Selecting : ConnectionState()
    data class Connected(val value: APIEndpoint) : ConnectionState()

    /** The Mac rejected the device token: pair again. */
    data object Unauthorized : ConnectionState()

    /** Something answered with a different certificate. */
    data class PinMismatch(val seen: String?) : ConnectionState()
    data object Unreachable : ConnectionState()

    val endpoint: APIEndpoint? get() = (this as? Connected)?.value
}

/**
 * Owns "which address do we use now" for one paired Mac. Selection runs on first use, after a reported failure and
 * whenever the network path changes; concurrent callers share one selection. When no address answers it tries again
 * on its own, backing off to `retry.maximum` and never giving up (control-v0 §5: a Mac that sleeps for an hour must
 * be found again without the user doing anything); meanwhile callers fail at once instead of each starting a
 * selection of their own.
 *
 * Swift's is an actor. Here the state is guarded by one lock held only for short, non-suspending steps (as an actor
 * is reentrant at its suspension points); the selection, the retries and the path monitor run in [scope], which the
 * tests give a virtual-time scope.
 */
class ConnectionManager(
    book: ServerAddressBook,
    private val token: String?,
    private val discovery: ServiceDiscovery?,
    private val prober: EndpointProber,
    private val discoveryTimeout: Duration = 1500.milliseconds,
    private val settleDelay: Duration = 500.milliseconds,
    private val retry: ReconnectPolicy = standardRetry,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
    /** Milliseconds since 1970, for [lastReport]. */
    private val now: () -> Long = System::currentTimeMillis,
) : EndpointProviding {
    /** When the last selection ended (milliseconds since 1970) and how each address fared. */
    data class LastReport(val at: Long, val reports: List<ProbeReport>)

    companion object {
        /** Retry delays while unreachable: 2 s doubling to 30 s, then every 30 s for as long as it takes. */
        val standardRetry = ReconnectPolicy(initial = 2.seconds, maximum = 30.seconds)
    }

    private val lock = Any()
    private var book: ServerAddressBook = book
    private var state: ConnectionState = ConnectionState.Idle
    private var inflight: Deferred<ConnectionState>? = null
    private var monitor: Job? = null

    /** The next automatic selection while unreachable; `failures` drives its delay. */
    private var retryTask: Job? = null
    private var failures = 0

    /** After `stop()` nothing starts again (a selection that was running when it stopped schedules no retry). */
    private var stopped = false
    private val observers = LinkedHashMap<UUID, Channel<ConnectionState>>()

    /** The last selection: when it ended and how each address fared (settings › Mac shows it). */
    var lastReport: LastReport? = null
        get() = synchronized(lock) { field }
        private set

    val current: ConnectionState get() = synchronized(lock) { state }

    /** State changes, starting with the current one (the newest 8 kept for a slow collector). Collect it once. */
    fun states(): Flow<ConnectionState> {
        val id = UUID.randomUUID()
        val channel = Channel<ConnectionState>(8, BufferOverflow.DROP_OLDEST)
        synchronized(lock) {
            channel.trySend(state)
            if (stopped) channel.close() else observers[id] = channel
        }
        return channel.consumeAsFlow().onCompletion { synchronized(lock) { observers.remove(id) } }
    }

    override suspend fun endpoint(): APIEndpoint {
        synchronized(lock) {
            state.endpoint?.let { return it }
            // The automatic retry owns the next attempt; a poll or a stream asking now would only pile selections up.
            if (state == ConnectionState.Unreachable && retryTask != null) throw APIError.Unreachable
        }
        return when (val result = reselect()) {
            is ConnectionState.Connected -> result.value
            ConnectionState.Unauthorized -> throw APIError.Unauthorized
            is ConnectionState.PinMismatch -> throw APIError.PinMismatch(seen = result.seen)
            ConnectionState.Idle, ConnectionState.Selecting, ConnectionState.Unreachable -> throw APIError.Unreachable
        }
    }

    /** New addresses for the same Mac (it told us where it is now); the next selection uses them. */
    fun update(book: ServerAddressBook) {
        synchronized(lock) { this.book = book }
    }

    override suspend fun reportFailure(endpoint: APIEndpoint) {
        synchronized(lock) { if (state.endpoint == endpoint) set(ConnectionState.Idle) }
    }

    /** Runs a selection (or joins the one in progress). */
    suspend fun reselect(): ConnectionState {
        val task = synchronized(lock) {
            inflight ?: run {
                set(ConnectionState.Selecting)
                val book = this.book
                scope.async {
                    val result = try {
                        val found = discovery?.discover(discoveryTimeout) ?: emptyList()
                        val candidates = EndpointSelector.candidates(book, found)
                        val (selection, reports) = EndpointSelector.selectReporting(candidates, token, prober)
                        synchronized(lock) { lastReport = LastReport(now(), reports) }
                        when (selection) {
                            is SelectionResult.Selected -> ConnectionState.Connected(selection.endpoint)
                            SelectionResult.Unauthorized -> ConnectionState.Unauthorized
                            is SelectionResult.PinMismatch -> ConnectionState.PinMismatch(seen = selection.seen)
                            SelectionResult.Unreachable -> ConnectionState.Unreachable
                        }
                    } catch (e: CancellationException) {
                        // Stopped while selecting: what a cancelled selection finds is nothing.
                        finish(ConnectionState.Unreachable)
                        throw e
                    }
                    finish(result)
                    result
                }.also { inflight = it }
            }
        }
        return try {
            task.await()
        } catch (e: CancellationException) {
            currentCoroutineContext().ensureActive()
            ConnectionState.Unreachable
        }
    }

    private fun finish(result: ConnectionState) {
        synchronized(lock) {
            inflight = null
            set(result)
            scheduleRetry(result)
        }
    }

    /**
     * Back in the foreground (control-v0 §5): the address that worked before the phone slept may be gone (another
     * Wi-Fi, Tailscale switched off) while the state still says connected. A short `/healthz` on it; a new selection
     * when it does not answer, or when there was no address to check. A revoked pairing stays as it is.
     */
    suspend fun verify(): ConnectionState {
        val before = current
        if (before == ConnectionState.Unauthorized) return before
        val endpoint = before.endpoint ?: return reselect()
        if (prober.probe(endpoint, token = null) == ProbeOutcome.Ok) return current
        synchronized(lock) { if (state.endpoint == endpoint) set(ConnectionState.Idle) }
        return reselect()
    }

    /** Called with the lock held. */
    private fun scheduleRetry(result: ConnectionState) {
        retryTask?.cancel()
        retryTask = null
        if (result != ConnectionState.Unreachable || stopped) {
            failures = 0
            return
        }
        failures += 1
        val delay = retry.delay(afterFailures = failures)
        retryTask = scope.launch {
            delay(delay)
            retryNow()
        }
    }

    private suspend fun retryNow() {
        synchronized(lock) {
            retryTask = null
            if (state != ConnectionState.Unreachable) return
        }
        reselect()
    }

    /** Re-selects whenever the path changes (the first snapshot is the starting point, not a change). */
    fun startMonitoring(paths: PathMonitoring) {
        synchronized(lock) {
            monitor?.cancel()
            val delay = settleDelay
            monitor = scope.launch {
                var last: NetworkPathSnapshot? = null
                paths.changes().collect { snapshot ->
                    val previous = last
                    last = snapshot
                    if (previous == null || previous == snapshot) return@collect
                    delay(delay)
                    reselect()
                }
            }
        }
    }

    fun stop() {
        val running: Deferred<ConnectionState>?
        synchronized(lock) {
            stopped = true
            monitor?.cancel()
            monitor = null
            retryTask?.cancel()
            retryTask = null
            running = inflight
            for (channel in observers.values) channel.close()
            observers.clear()
        }
        running?.cancel()
    }

    /** Called with the lock held. */
    private fun set(new: ConnectionState) {
        if (new == state) return
        state = new
        for (channel in observers.values) channel.trySend(new)
    }
}

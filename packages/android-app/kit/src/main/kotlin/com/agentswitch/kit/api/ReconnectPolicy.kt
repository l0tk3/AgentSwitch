package com.agentswitch.kit.api

import kotlin.coroutines.cancellation.CancellationException
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Reconnect timing for a stream (a terminal's, a browser tab's) and for the connection itself: exponential from
 * `initial` to `maximum`, reset after any event arrives.
 */
data class ReconnectPolicy(
    val initial: Duration = 1.seconds,
    val maximum: Duration = 15.seconds,
    /**
     * Idle limit for one connection. The daemon sends `: ping` every 10 s (SSE_HEARTBEAT_MS), so 30 s without a byte
     * means a half-open connection (control-v0 §5: the phone changed networks and nothing said so), not a quiet stream.
     */
    val idleTimeout: Duration = 30.seconds,
) {
    fun delay(afterFailures: Int): Duration {
        if (afterFailures <= 0) return Duration.ZERO
        var d = initial
        for (i in 1 until afterFailures) if (d < maximum) d *= 2
        return minOf(d, maximum)
    }

    companion object {
        val standard = ReconnectPolicy()
    }
}

/**
 * The body, failing with a network error once `limit` passes without a byte. The request's own timeout is not
 * enough on its own: a half-open TCP connection can sit there without the HTTP client noticing. The terminal and
 * browser streams use it.
 */
fun AgentSwitchAPI.Companion.idleGuarded(body: Flow<ByteArray>, limit: Duration): Flow<ByteArray> = flow {
    coroutineScope {
        // The reader hands the body's own failure over in the channel (after what came before it), not by failing
        // this scope.
        val chunks = Channel<ByteArray>(Channel.BUFFERED)
        val reader = launch {
            try {
                body.collect { chunks.send(it) }
                chunks.close()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                chunks.close(e)
            }
        }
        try {
            while (true) {
                val next = withTimeoutOrNull(limit) { chunks.receiveCatching() } ?: throw APIError.Transport(idleMessage)
                if (next.isClosed) {
                    next.exceptionOrNull()?.let { throw it }
                    break
                }
                emit(next.getOrThrow())
            }
        } finally {
            reader.cancel()
            chunks.cancel()
        }
    }
}

val AgentSwitchAPI.Companion.idleMessage: String get() = "事件流 30 秒无数据，已重新连接"

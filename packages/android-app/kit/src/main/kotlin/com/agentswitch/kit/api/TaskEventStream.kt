package com.agentswitch.kit.api

import com.agentswitch.kit.support.KitJson
import java.io.ByteArrayOutputStream
import kotlin.coroutines.cancellation.CancellationException
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.buffer
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.transformWhile
import kotlinx.coroutines.withTimeoutOrNull

/** Reconnect timing for the event stream: exponential from `initial` to `maximum`, reset after any event arrives. */
data class ReconnectPolicy(
    val initial: Duration = 1.seconds,
    val maximum: Duration = 15.seconds,
    /**
     * Idle limit for one connection. The daemon sends `: ping` every 10 s (SSE_HEARTBEAT_MS), so 30 s without a byte
     * means a half-open connection (control-v0 §5: the phone changed networks and nothing said so), not a quiet task.
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
 * Live events of one task: `GET /tasks/:id/events?after=<seq>` (SSE, one event per engine event, `id` = seq).
 * Replays everything after `after`, then follows. On a dropped connection it reconnects from the last seq it
 * delivered, so nothing is missed or repeated. Ends after a terminal event (done, partial, blocked, failed,
 * cancelled) or when the task is already terminal; fails on 401/404.
 * `writing`: what its run is writing as it comes (docs/simple-view-v0.md §5.14), null once nothing is.
 */
fun AgentSwitchAPI.events(
    taskId: String,
    after: Long = 0,
    policy: ReconnectPolicy = ReconnectPolicy.standard,
    writing: ((AgentWriting?) -> Unit)? = null,
): Flow<TaskEvent> = channelFlow {
    var last = after
    var failures = 0
    while (true) {
        try {
            when (val result = followOnce(taskId, last, policy, deliver = { send(it) }, writing = writing)) {
                is FollowResult.Ended -> return@channelFlow
                is FollowResult.Dropped -> {
                    last = result.lastSeq
                    failures = if (result.delivered) 0 else failures + 1
                }
            }
        } catch (error: APIError) {
            if (!error.isNetworkFailure) throw error
            failures += 1
        }
        delay(policy.delay(afterFailures = maxOf(failures, 1)))
    }
}.buffer(Channel.UNLIMITED)

internal sealed class FollowResult {
    /** A terminal event arrived or the task was already over. */
    data class Ended(val lastSeq: Long) : FollowResult()

    /** The connection closed early; resume from `lastSeq`. */
    data class Dropped(val lastSeq: Long, val delivered: Boolean) : FollowResult()
}

/** One connection's worth of the stream. */
internal suspend fun AgentSwitchAPI.followOnce(
    taskId: String,
    after: Long,
    policy: ReconnectPolicy,
    deliver: suspend (TaskEvent) -> Unit,
    writing: ((AgentWriting?) -> Unit)? = null,
): FollowResult {
    // What was being written is not, once this connection is over (another one says again what is).
    try {
        val endpoint = endpoints.endpoint()
        val query = listOf(URLQueryItem("after", after.toString()))
        val req = request("GET", endpoint, listOf("tasks", taskId, "events"), query, null,
            accept = "text/event-stream", timeout = policy.idleTimeout)
        var last = after
        var delivered = false
        var ended = false
        try {
            val (response, body) = transport.stream(req)
            if (response.statusCode !in 200..299) {
                val data = ByteArrayOutputStream()
                body.collect { chunk -> if (data.size() < 64 * 1024) data.write(chunk) }
                AgentSwitchAPI.check(data.toByteArray(), response)
            }
            val parser = SSEParser()
            AgentSwitchAPI.idleGuarded(body, limit = policy.idleTimeout).transformWhile<ByteArray, Unit> { chunk ->
                for (message in parser.feed(chunk)) {
                    // What its run is writing: in no sequence, never replayed.
                    if (message.event == "writing") { writing?.invoke(AgentWriting.decode(message.data)); continue }
                    val event = AgentSwitchAPI.taskEvent(message, taskId) ?: continue
                    if (event.seq <= last) continue
                    last = event.seq
                    delivered = true
                    deliver(event)
                    if (event.endsStream) { ended = true; break }
                }
                !ended
            }.collect()
        } catch (error: APIError) {
            if (!error.isNetworkFailure) throw error
            endpoints.reportFailure(endpoint)
            if (delivered) return FollowResult.Dropped(lastSeq = last, delivered = true)
            throw error
        }
        if (ended) return FollowResult.Ended(lastSeq = last)
        // The daemon also closes right after the replay when the task is already over.
        if (task(taskId).task.status.isTerminal) return FollowResult.Ended(lastSeq = last)
        return FollowResult.Dropped(lastSeq = last, delivered = delivered)
    } finally {
        writing?.invoke(null)
    }
}

/**
 * The body, failing with a network error once `limit` passes without a byte. The request's own timeout is not
 * enough on its own: a half-open TCP connection can sit there without the HTTP client noticing. Terminal and browser
 * streams use it too.
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

/** The SSE `data` is the TaskEvent JSON; a frame that does not decode is skipped rather than ending the stream. */
fun AgentSwitchAPI.Companion.taskEvent(message: SSEMessage, taskId: String): TaskEvent? {
    val event = try { KitJson.decodeFromString(TaskEvent.serializer(), message.data) } catch (e: Exception) { return null }
    return if (event.taskId == taskId) event else null
}

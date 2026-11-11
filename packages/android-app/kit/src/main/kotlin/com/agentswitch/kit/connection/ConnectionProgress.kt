package com.agentswitch.kit.connection

import com.agentswitch.kit.api.APIEndpoint
import kotlin.time.Duration
import kotlin.time.Duration.Companion.minutes

/**
 * What the connection line says (control-v0 §5), from the state and how the attempts went: 连接中 → 重连中 →
 * 无法连接（第 N 次）→ 未找到 Mac → 配对已失效. "Cannot connect" alone said nothing about whether it was a blip or the
 * Mac being gone for good.
 */
sealed class ConnectionPhase {
    data class Connected(val endpoint: APIEndpoint) : ConnectionPhase()

    /** The first connection since the app started. */
    data object Connecting : ConnectionPhase()

    /** Connected before; looking for a way back, nothing failed yet. */
    data object Reconnecting : ConnectionPhase()

    /** `attempt` selections in a row found no address that answers. */
    data class Failing(val attempt: Int) : ConnectionPhase()

    /** Failing for `ConnectionProgress.lostAfter` or longer. */
    data object Lost : ConnectionPhase()

    /** The Mac refused the device token: pair again. */
    data object Unpaired : ConnectionPhase()
    data object CertificateChanged : ConnectionPhase()

    val text: String
        get() = when (this) {
            is Connected -> "Connected · ${endpoint.kind.lineTitle}"
            Connecting -> "Connecting"
            Reconnecting -> "Reconnecting"
            is Failing -> "Unreachable · Try $attempt"
            Lost -> "Mac Not Found"
            Unpaired -> "Unpaired"
            CertificateChanged -> "Certificate Changed · Refused"
        }

    /** Still trying on its own, no action needed yet. */
    val isTransient: Boolean get() = this == Connecting || this == Reconnecting

    /** A 重试 makes sense (the phone keeps retrying anyway). */
    val canRetry: Boolean get() = this is Failing || this == Lost
}

/** The history the phase needs, updated on every state change (a new copy each time). Times in milliseconds since 1970. */
data class ConnectionProgress(
    val everConnected: Boolean = false,
    /** Failed selections since the last connection. */
    val failures: Int = 0,
    /** Milliseconds since 1970. */
    val failingSince: Long? = null,
) {
    companion object {
        /** About six minutes of failures: long enough that the Mac is off, asleep or out of reach, not a network blip. */
        val lostAfter: Duration = 6.minutes
    }

    fun after(state: ConnectionState, at: Long = System.currentTimeMillis()): ConnectionProgress = when (state) {
        is ConnectionState.Connected -> ConnectionProgress(everConnected = true)
        ConnectionState.Unreachable -> ConnectionProgress(everConnected = everConnected, failures = failures + 1, failingSince = failingSince ?: at)
        ConnectionState.Idle, ConnectionState.Selecting, ConnectionState.Unauthorized, is ConnectionState.PinMismatch -> this
    }

    fun phase(state: ConnectionState, now: Long = System.currentTimeMillis()): ConnectionPhase = when (state) {
        is ConnectionState.Connected -> ConnectionPhase.Connected(state.value)
        ConnectionState.Unauthorized -> ConnectionPhase.Unpaired
        is ConnectionState.PinMismatch -> ConnectionPhase.CertificateChanged
        ConnectionState.Idle, ConnectionState.Selecting, ConnectionState.Unreachable -> {
            val since = failingSince
            when {
                failures <= 0 -> if (everConnected) ConnectionPhase.Reconnecting else ConnectionPhase.Connecting
                since != null && now - since >= lostAfter.inWholeMilliseconds -> ConnectionPhase.Lost
                else -> ConnectionPhase.Failing(attempt = failures)
            }
        }
    }
}

package com.agentswitch.kit.pairing

import com.agentswitch.kit.api.APIEndpoint
import com.agentswitch.kit.api.APIError
import com.agentswitch.kit.api.AgentSwitchAPI
import com.agentswitch.kit.api.FixedEndpoint
import com.agentswitch.kit.api.HTTPTransport
import com.agentswitch.kit.api.PairRequest
import com.agentswitch.kit.api.PairResult
import com.agentswitch.kit.connection.EndpointSelector
import com.agentswitch.kit.connection.HTTPEndpointProber
import com.agentswitch.kit.connection.SelectionResult
import com.agentswitch.kit.connection.ServiceDiscovery
import com.agentswitch.kit.secrets.trimmingWhitespacesAndNewlines
import java.text.BreakIterator
import kotlin.coroutines.cancellation.CancellationException
import kotlin.time.Duration
import kotlin.time.Duration.Companion.milliseconds

sealed class PairingError(message: String) : Exception(message) {
    /** Wrong, expired or already used code (the daemon answers all three the same way). */
    data object CodeRejected : PairingError("配对码无效、已过期或已被使用，请在 Mac 上重新生成二维码")

    /** More than 10 attempts a minute from this address (429, Retry-After: 60). */
    data object RateLimited : PairingError("配对尝试过于频繁，请一分钟后重试")
    data object Unreachable : PairingError("无法连接此 Mac。请确认手机与 Mac 在同一局域网，或均已登录 Tailscale。")
    data class PinMismatch(val seen: String?) : PairingError("Mac 的证书指纹与二维码不一致，已中止配对")

    /** [detail] is the cause; [message] adds "配对失败：". */
    class Failed(detail: String) : PairingError("配对失败：$detail") {
        val detail: String = detail
        override fun equals(other: Any?): Boolean = other is Failed && other.detail == detail
        override fun hashCode(): Int = detail.hashCode()
        override fun toString(): String = "Failed(message=$detail)"
    }
}

data class PairingOutcome(
    val profile: ServerProfile,
    val token: String,
    val endpoint: APIEndpoint,
)

/**
 * Pairing (app-v0 §2, §5): find a reachable address from the payload, `POST /pair` over the pinned connection, and
 * fill in the gate key from `GET /gate/pubkey` if the QR code had none (`gate: null` when the Mac could not read it;
 * the endpoint then answers 503 and the app asks again later).
 */
class PairingService(
    val transport: HTTPTransport,
    val discovery: ServiceDiscovery?,
    val discoveryTimeout: Duration = 1500.milliseconds,
) {
    companion object {
        const val maxDeviceNameLength = 64

        /**
         * What the daemon takes as a device name (1-64 characters without control characters): characters that hold a
         * control or format scalar dropped (as Swift's `CharacterSet.controlCharacters`, Cc and Cf), white space trimmed,
         * the first 64 characters (grapheme clusters, as Swift counts them).
         */
        internal fun deviceName(raw: String): String {
            val clusters = graphemes(raw).filter { cluster ->
                cluster.codePoints().noneMatch { cp ->
                    val type = Character.getType(cp)
                    type == Character.CONTROL.toInt() || type == Character.FORMAT.toInt()
                }
            }
            return graphemes(clusters.joinToString("").trimmingWhitespacesAndNewlines()).take(maxDeviceNameLength).joinToString("")
        }

        private fun graphemes(text: String): List<String> {
            val it = BreakIterator.getCharacterInstance()
            it.setText(text)
            val out = mutableListOf<String>()
            var start = it.first()
            var end = it.next()
            while (end != BreakIterator.DONE) {
                out.add(text.substring(start, end))
                start = end
                end = it.next()
            }
            return out
        }
    }

    suspend fun pair(payload: PairingPayload, deviceName: String, platform: String = "android"): PairingOutcome {
        val found = discovery?.discover(discoveryTimeout) ?: emptyList()
        val candidates = EndpointSelector.candidates(payload.addressBook, found)
        val endpoint = when (val selection = EndpointSelector.select(candidates, token = null, prober = HTTPEndpointProber(transport))) {
            is SelectionResult.Selected -> selection.endpoint
            is SelectionResult.PinMismatch -> throw PairingError.PinMismatch(seen = selection.seen)
            SelectionResult.Unauthorized, SelectionResult.Unreachable -> throw PairingError.Unreachable
        }

        val anonymous = AgentSwitchAPI(endpoints = FixedEndpoint(endpoint), transport = transport, token = null)
        // The daemon takes 1-64 characters without control characters.
        val name = deviceName(deviceName)
        val result = try {
            anonymous.post(listOf("pair"), PairRequest(code = payload.code, name = name.ifEmpty { "Android" }, platform = platform),
                PairRequest.serializer(), PairResult.serializer())
        } catch (e: CancellationException) {
            throw e
        } catch (e: APIError.Unauthorized) {
            throw PairingError.CodeRejected
        } catch (e: APIError.Http) {
            if (e.status == 429) throw PairingError.RateLimited
            throw PairingError.Failed(e.message ?: "")
        } catch (e: APIError.PinMismatch) {
            throw PairingError.PinMismatch(seen = e.seen)
        } catch (e: Exception) {
            throw PairingError.Failed(e.message ?: e.toString())
        }
        if (result.token.isEmpty() || result.deviceId.isEmpty()) throw PairingError.Failed("empty token")

        var gate = payload.gate
        if (gate == null) {
            val authed = AgentSwitchAPI(endpoints = FixedEndpoint(endpoint), transport = transport, token = result.token)
            gate = try { authed.gatePubkey() } catch (e: CancellationException) { throw e } catch (e: Exception) { null }
            if (gate != null && !gate.isValid) gate = null
        }
        val profile = ServerProfile(payload = payload, deviceId = result.deviceId, gate = gate)
        return PairingOutcome(profile = profile, token = result.token, endpoint = endpoint)
    }
}

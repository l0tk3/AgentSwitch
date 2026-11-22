package com.agentswitch.kit.api

import com.agentswitch.kit.browser.BrowserPageZoom
import com.agentswitch.kit.browser.BrowserSpeed
import com.agentswitch.kit.browser.roundedHalfAway
import kotlin.coroutines.cancellation.CancellationException
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import kotlin.time.TimeSource
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.transformWhile
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import java.io.ByteArrayOutputStream

// The browser routes a paired phone may use (docs/browser-v0.md §5; the daemon's remote allowlist). `screen` is this
// phone's own id (`phone-…`, the same as the terminals'): what it holds and the size it sets are its own.

private object BrowserTabEnvelopeSerializer : TreeReader<BrowserTabInfo>() {
    override fun read(element: JsonElement): BrowserTabInfo =
        BrowserTabInfoSerializer.read(element.obj()?.get("tab") ?: throw MalformedJSON())
}

private object BrowserServerListSerializer : TreeReader<List<BrowserLocalServer>>() {
    override fun read(element: JsonElement): List<BrowserLocalServer> =
        (element.obj()?.get("servers") as? JsonArray ?: throw MalformedJSON()).map { BrowserLocalServerSerializer.read(it) }
}

private fun browserScreenField(screen: String?): Map<String, JsonElement> = screen?.let { mapOf("screen" to JsonPrimitive(it)) } ?: emptyMap()

private class BrowserInputBody(val screen: String?, val events: List<BrowserInput>)
private val browserInputBody = ObjectWriter<BrowserInputBody> {
    browserScreenField(it.screen) + ("events" to JsonArray(it.events.map { e -> com.agentswitch.kit.support.KitJson.encodeToJsonElement(BrowserInputSerializer, e) }))
}

private class BrowserHoldBody(val screen: String?)
private val browserHoldBody = ObjectWriter<BrowserHoldBody> { browserScreenField(it.screen) }

private class BrowserHistoryBody(val action: BrowserHistoryAction, val screen: String?)
private val browserHistoryBody = ObjectWriter<BrowserHistoryBody> { mapOf("action" to JsonPrimitive(it.action.rawValue)) + browserScreenField(it.screen) }

private class BrowserViewportBody(val width: Int, val height: Int, val scale: Double, val mobile: Boolean, val screen: String?)
private val browserViewportBody = ObjectWriter<BrowserViewportBody> {
    mapOf("width" to JsonPrimitive(it.width), "height" to JsonPrimitive(it.height), "scale" to jsonNumber(it.scale),
        "mobile" to JsonPrimitive(it.mobile)) + browserScreenField(it.screen)
}

private class BrowserFillBody(val token: String, val screen: String?)
private val browserFillBody = ObjectWriter<BrowserFillBody> { mapOf("token" to JsonPrimitive(it.token)) + browserScreenField(it.screen) }

/** Where to navigate a tab, and from which screen: the target's one field beside `screen`. */
private class BrowserNavigateBody(val target: BrowserTarget, val screen: String?)
private val browserNavigateBody = ObjectWriter<BrowserNavigateBody> { BrowserTargetSerializer.fields(it.target) + browserScreenField(it.screen) }

/**
 * What a tab's stream asks of the Mac's screencast: JPEG quality, frames a second, an optional cap on the frame's
 * size in pixels (a slow link asks for less), and the frame pixels per CSS pixel the screen shows (`scale`, its device
 * pixels — times the zoom of a page this phone zoomed, BrowserPageZoom.streamScale; docs/browser-v0.md §5,
 * 2026-10-03 — a Mac from before ignores it and sends CSS-size frames).
 */
class BrowserStreamOptions(
    quality: Int,
    fps: Int,
    maxWidth: Int? = null,
    maxHeight: Int? = null,
    scale: Double? = null,
) {
    val quality: Int = minOf(maxOf(quality, 1), 100)
    val fps: Int = minOf(maxOf(fps, 1), 30)
    val maxWidth: Int? = maxWidth?.let { minOf(maxOf(it, 100), 8192) }
    val maxHeight: Int? = maxHeight?.let { minOf(maxOf(it, 100), 8192) }
    val scale: Double? = scale?.let { if (it > 1.0) minOf(it, maxScale) else 1.0 }

    val query: List<URLQueryItem>
        get() {
            val scaled = scale?.let { if (it > 1) URLQueryItem("scale", g((it * 100).roundedHalfAway() / 100)) else null }
            return listOf(URLQueryItem("quality", quality.toString()), URLQueryItem("fps", fps.toString())) +
                listOfNotNull(maxWidth?.let { URLQueryItem("maxWidth", it.toString()) },
                    maxHeight?.let { URLQueryItem("maxHeight", it.toString()) }, scaled)
        }

    override fun equals(other: Any?): Boolean =
        other is BrowserStreamOptions && other.quality == quality && other.fps == fps && other.maxWidth == maxWidth &&
            other.maxHeight == maxHeight && other.scale == scale

    override fun hashCode(): Int = listOf(quality, fps, maxWidth, maxHeight, scale).hashCode()
    override fun toString(): String = "BrowserStreamOptions(quality=$quality, fps=$fps, maxWidth=$maxWidth, maxHeight=$maxHeight, scale=$scale)"

    companion object {
        /**
         * The most `scale` the Mac takes: 8 since the page zoom (browser-v0 §1 页面缩放, 2026-10-03: a 3× screen at
         * 200% shows 6 frame pixels a CSS pixel), 3 before — a Mac from then cuts a larger ask to 3, and the zoomed
         * page still shows, short of the screen's pixels.
         */
        const val maxScale = 8.0

        /** C's `%g`: six significant digits, trailing zeros dropped. */
        private fun g(v: Double): String =
            java.math.BigDecimal(v).round(java.math.MathContext(6, java.math.RoundingMode.HALF_EVEN)).stripTrailingZeros().toPlainString()
    }
}

/**
 * A browser the Mac holds, to choose which one the Browser tab shows (docs/profiles-v0.md §5.4): the one everybody
 * shares (`key` null), or the own browser of a profile that has a proxy of its own.
 */
@Serializable
data class BrowserChoice(
    val key: String? = null,
    /** `Shared`, or the profile's name. */
    val name: String,
    /** Where its profile's proxy lets traffic out, as last found. */
    val exit: Exit? = null,
    val running: Boolean = false,
) {
    @Serializable
    data class Exit(val ip: String, val place: String? = null) {
        /** `Tokyo 203.0.113.9`. */
        val text: String get() = listOfNotNull(place, ip).filter { it.isNotEmpty() }.joinToString(" ")
    }

    val id: String get() = key ?: ""

    companion object {
        val shared = BrowserChoice(key = null, name = "Shared")
    }
}

@Serializable
private class BrowsersReply(val browsers: List<BrowserChoice>)

/** The same client, its browser routes those of profile `key`'s own browser; null: the shared browser's. */
fun AgentSwitchAPI.forBrowser(key: String?): AgentSwitchAPI = copy(browserKey = key)

/** Where the browser routes start: `browser/…` for the shared one, `profile-browser/<key>/browser/…` for a profile's. */
internal val AgentSwitchAPI.browserPath: List<String>
    get() = browserKey?.let { listOf("profile-browser", it, "browser") } ?: listOf("browser")

/**
 * The browsers there are: the shared one, then each profile's own. A Mac that does not say (an older one: 404)
 * has the shared one alone.
 */
suspend fun AgentSwitchAPI.browsers(): List<BrowserChoice> =
    try {
        get(listOf("browsers"), BrowsersReply.serializer()).browsers
    } catch (e: APIError.Http) {
        if (e.status == 404) listOf(BrowserChoice.shared) else throw e
    }

/**
 * Whether Chrome is up and the tabs by owner. A Mac without the browser (an older one, or `AGENTSWITCH_BROWSER_HOST=0`)
 * answers 404.
 */
suspend fun AgentSwitchAPI.browserTabs(): BrowserTabList = get(browserPath + "tabs", BrowserTabList.serializer())

suspend fun AgentSwitchAPI.browserTab(id: String): BrowserTabInfo = get(browserPath + listOf("tabs", id), BrowserTabEnvelopeSerializer)

/**
 * A new tab of yours; a refusal (403), a missing file (404) or an address the Mac cannot read (400) carries its
 * reason in words.
 */
suspend fun AgentSwitchAPI.openBrowserTab(target: BrowserTarget): BrowserTabInfo =
    send("POST", browserPath + "tabs", target, BrowserTargetSerializer, BrowserTabEnvelopeSerializer)

suspend fun AgentSwitchAPI.closeBrowserTab(id: String) {
    perform("DELETE", browserPath + listOf("tabs", id), emptyList(), null, OKReply.serializer())
}

/**
 * Input, in order (at most 50 events a request). A tab held by another screen, or an agent's tab not taken over,
 * answers 409.
 */
suspend fun AgentSwitchAPI.sendBrowserInput(id: String, events: List<BrowserInput>, screen: String?) {
    if (events.isEmpty()) return
    post(browserPath + listOf("tabs", id, "input"), BrowserInputBody(screen, events.take(BrowserInputQueue.batch)), browserInputBody, OKReply.serializer())
}

suspend fun AgentSwitchAPI.navigateBrowserTab(id: String, to: BrowserTarget, screen: String?): BrowserTabInfo =
    post(browserPath + listOf("tabs", id, "navigate"), BrowserNavigateBody(to, screen), browserNavigateBody, BrowserTabEnvelopeSerializer)

suspend fun AgentSwitchAPI.browserHistory(id: String, action: BrowserHistoryAction, screen: String?): BrowserTabInfo =
    post(browserPath + listOf("tabs", id, "navigate"), BrowserHistoryBody(action, screen), browserHistoryBody, BrowserTabEnvelopeSerializer)

/** This screen takes the tab over (from whoever had it); an agent's calls on it wait meanwhile. */
suspend fun AgentSwitchAPI.takeBrowserTab(id: String, screen: String?): BrowserTabInfo =
    post(browserPath + listOf("tabs", id, "take"), BrowserHoldBody(screen), browserHoldBody, BrowserTabEnvelopeSerializer)

/** Hands it back; the size goes back to the Mac's default. Another screen's hold answers 409. */
suspend fun AgentSwitchAPI.releaseBrowserTab(id: String, screen: String?): BrowserTabInfo =
    post(browserPath + listOf("tabs", id, "release"), BrowserHoldBody(screen), browserHoldBody, BrowserTabEnvelopeSerializer)

/** The holder's size for the tab (the phone's: its screen area in points, mobile layout); 409 unless held here. */
suspend fun AgentSwitchAPI.setBrowserViewport(id: String, width: Int, height: Int, scale: Double, mobile: Boolean, screen: String?): BrowserTabInfo {
    val body = BrowserViewportBody(minOf(maxOf(width, 200), 4096), minOf(maxOf(height, 200), 4096), minOf(maxOf(scale, 0.5), 4.0), mobile, screen)
    return post(browserPath + listOf("tabs", id, "viewport"), body, browserViewportBody, BrowserTabEnvelopeSerializer)
}

/** The servers listening on the Mac, for the new-tab sheet. */
suspend fun AgentSwitchAPI.browserServers(): List<BrowserLocalServer> = get(browserPath + "servers", BrowserServerListSerializer)

/**
 * The speed of the link to the Mac in megabits a second (`GET /browser/speed`, browser-v0 §5): `bytes` that do not
 * compress, timed from the first chunk (BrowserSpeed.Meter), for at most `limit`. Null when too little came to tell,
 * or the Mac has no such route (an older one answers 404).
 */
suspend fun AgentSwitchAPI.browserSpeed(bytes: Int = BrowserSpeed.bytes, limit: Duration = BrowserSpeed.limit): Double? {
    val endpoint = try {
        endpoints.endpoint()
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        return null
    }
    val req = request("GET", endpoint, browserPath + "speed", listOf(URLQueryItem("bytes", bytes.toString())), null,
        accept = "application/octet-stream", timeout = limit + 5.seconds)
    val began = TimeSource.Monotonic.markNow()
    val meter = BrowserSpeed.Meter()
    var complete = false
    withTimeoutOrNull(limit) {
        try {
            val (response, body) = transport.stream(req)
            if (response.statusCode in 200..299) {
                body.collect { chunk -> meter.add(chunk.size, began.elapsedNow().inWholeNanoseconds / 1e9) }
                complete = true
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // A failed read is cut short, not complete.
        }
    }
    if (!complete) meter.cut(began.elapsedNow().inWholeNanoseconds / 1e9)
    return meter.mbps
}

/**
 * A saved ciphertext into the field that has the focus; the gate checks it against the page's site and only the
 * Mac sees the value. Only on a person's own tab, and only into a password or one-time-code field (the Mac's 409
 * and 400 carry the reason in words). False: this Mac cannot fill yet — its fill route is missing (404) while the
 * tab itself is there; a 404 for a tab that is gone is thrown as such (`BrowserClosedReason.Closed`'s words).
 */
suspend fun AgentSwitchAPI.fillBrowserTab(id: String, token: String, screen: String?): Boolean {
    try {
        post(browserPath + listOf("tabs", id, "fill"), BrowserFillBody(token, screen), browserFillBody, OKReply.serializer())
        return true
    } catch (e: APIError.Http) {
        if (e.status != 404) throw e
        try {
            browserTab(id)
        } catch (gone: APIError.Http) {
            if (gone.status == 404) throw APIError.Http(status = 404, message = BrowserClosedReason.Closed.said)
            throw gone
        }
        return false
    }
}

/**
 * A tab's picture and what happens to it: `tab`, then frames and changes. Frames are the newest only twice over:
 * the Mac sends at the rate asked for, and a frame the page has not read yet when the next comes is dropped
 * (BrowserEventBuffer), so nothing piles up behind a page that draws slowly. On a dropped connection it says
 * `dropped` and connects again, backing off (the Mac starts each connection with the tab as it is and its latest
 * frame). Ends after `closed`, or with `closed` when the tab no longer exists. Cancelling the collector stops the
 * connection and the reconnecting.
 */
fun AgentSwitchAPI.browserEvents(
    id: String,
    options: BrowserStreamOptions,
    policy: ReconnectPolicy = ReconnectPolicy.standard,
): Flow<BrowserEvent> = flow {
    val buffer = BrowserEventBuffer()
    coroutineScope {
        val worker = launch {
            var failures = 0
            try {
                while (isActive) {
                    try {
                        val (ended, delivered) = followBrowserOnce(id, options, policy) { buffer.push(it) }
                        if (ended) break
                        failures = if (delivered) 0 else failures + 1
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: APIError) {
                        if (e.isNetworkFailure) {
                            failures += 1
                        } else if (e is APIError.Http && e.status == 404) {
                            buffer.push(BrowserEvent.Closed(BrowserClosedReason.Closed))
                            break
                        } else {
                            buffer.finish(e)
                            return@launch
                        }
                    } catch (e: Throwable) {
                        buffer.finish(e)
                        return@launch
                    }
                    if (!isActive) break
                    buffer.push(BrowserEvent.Dropped)
                    delay(policy.delay(afterFailures = maxOf(failures, 1)))
                }
            } catch (e: CancellationException) {
                // The reader went away: the stream ends quietly, as Swift's does.
            }
            buffer.finish()
        }
        buffer.whenCancelled { worker.cancel() }
        try {
            while (true) emit(buffer.next() ?: break)
        } finally {
            buffer.cancel()
            worker.cancel()
        }
    }
}

/** One connection: (closed, anything delivered). */
private suspend fun AgentSwitchAPI.followBrowserOnce(
    id: String,
    options: BrowserStreamOptions,
    policy: ReconnectPolicy,
    deliver: (BrowserEvent) -> Unit,
): Pair<Boolean, Boolean> {
    val endpoint = endpoints.endpoint()
    val req = request("GET", endpoint, browserPath + listOf("tabs", id, "stream"), options.query, null, accept = "text/event-stream",
        timeout = policy.idleTimeout)
    var delivered = false
    var closed = false
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
                val event = BrowserEvent.parse(message.event, message.data) ?: continue
                delivered = true
                deliver(event)
                if (event is BrowserEvent.Closed) { closed = true; break }
            }
            !closed
        }.collect()
    } catch (error: APIError) {
        if (!error.isNetworkFailure) throw error
        endpoints.reportFailure(endpoint)
        if (delivered) return false to true
        throw error
    }
    if (closed) return true to true
    return false to delivered
}

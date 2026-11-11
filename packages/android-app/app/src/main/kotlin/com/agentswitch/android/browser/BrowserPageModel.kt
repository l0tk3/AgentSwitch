package com.agentswitch.android.browser

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.agentswitch.android.demo.DemoBrowser
import com.agentswitch.kit.api.AgentSwitchAPI
import com.agentswitch.kit.api.BrowserBox
import com.agentswitch.kit.api.BrowserClosedReason
import com.agentswitch.kit.api.BrowserEvent
import com.agentswitch.kit.api.BrowserFrame
import com.agentswitch.kit.api.BrowserHeldReason
import com.agentswitch.kit.api.BrowserHistoryAction
import com.agentswitch.kit.api.BrowserInput
import com.agentswitch.kit.api.BrowserInputQueue
import com.agentswitch.kit.api.BrowserKey
import com.agentswitch.kit.api.BrowserMouseButton
import com.agentswitch.kit.api.BrowserStreamOptions
import com.agentswitch.kit.api.BrowserTabInfo
import com.agentswitch.kit.api.browserEvents
import com.agentswitch.kit.api.browserHistory
import com.agentswitch.kit.api.closeBrowserTab
import com.agentswitch.kit.api.fillBrowserTab
import com.agentswitch.kit.api.navigateBrowserTab
import com.agentswitch.kit.api.releaseBrowserTab
import com.agentswitch.kit.api.sendBrowserInput
import com.agentswitch.kit.api.setBrowserViewport
import com.agentswitch.kit.api.takeBrowserTab
import com.agentswitch.kit.browser.BrowserAddress
import com.agentswitch.kit.browser.BrowserDecodedFrame
import com.agentswitch.kit.browser.BrowserFrameDecoder
import com.agentswitch.kit.browser.BrowserHolder
import com.agentswitch.kit.browser.BrowserImageHeader
import com.agentswitch.kit.browser.BrowserLayout
import com.agentswitch.kit.browser.BrowserNotice
import com.agentswitch.kit.browser.BrowserPageZoom
import com.agentswitch.kit.browser.BrowserStreamPolicy
import com.agentswitch.kit.browser.BrowserZoom
import com.agentswitch.kit.browser.Point
import com.agentswitch.kit.browser.Size
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.time.TimeSource

/**
 * One tab on the phone (docs/browser-v0.md §1): its stream drawn into the screen, who holds it, and what the phone
 * sends. A tab has one size and one holder ("尺寸有主", as the terminals): your own tab is this phone's while its page is
 * open here and no other screen holds it; an agent's tab is only watched until `[ Take Over ]`. Holding a tab, the
 * phone sets the page to its own screen area (a phone's layout); handing it back, leaving the page or going to the
 * background gives it back, and the Mac puts its own size back — a take still on its way then is given back as it
 * lands, its size never set. The stream stops whenever the page is not seen. Frames are decoded off the main thread,
 * only the newest (BrowserFrameDecoder).
 *
 * The size carries the page's zoom (browser-v0 §1 页面缩放, 2026-10-03; user: 然后我发现agentswitch的浏览器页没有放大缩小的
 * 选项，加上 用来调节大小): the screen area over the zoom this phone remembers for the tab's site (BrowserPageZoom), set
 * again when the zoom or the site changes. So only while this phone sizes the tab does the zoom key zoom the page;
 * while it only watches, the key steps the picture on the phone, as two fingers do.
 *
 * Main thread only. `scope` is the page's (its dispatcher the main one); `screenId` is this phone as a screen
 * (`PhoneScreen.id`). Where the Swift's UIKit `BrowserScreenView` kept the picture, the layout and the agent's outline,
 * this model offers them as state for the view to draw: [picture], [layout], [actionShown].
 */
@Stable
class BrowserPageModel(
    tab: BrowserTabInfo,
    /** This phone as a screen. */
    val screenId: String,
    private val scope: CoroutineScope,
) {
    val id: String = tab.id

    var tab: BrowserTabInfo by mutableStateOf(tab)
        private set

    /** The latest frame's size in pixels (null before the first). */
    var frameSize: Size? by mutableStateOf(null)
        private set

    /** The latest frame's pixels per CSS pixel. */
    var frameScale: Double by mutableStateOf(1.0)
        private set

    /** The latest decoded picture, for the view to draw (the Swift's `screen.show(UIImage)`). */
    var picture: Bitmap? by mutableStateOf(null)
        private set

    /** The latest frame's page size in CSS pixels (a new one draws the picture in afresh; a new density does not). */
    private var pageSize: Size? = null

    /** Pictures drawn afresh (the first after connecting, the first at a new size): each comes in top down. */
    var refreshes: Int by mutableIntStateOf(0)
        private set
    var connection: Connection by mutableStateOf(Connection.Connecting)
        private set
    var closed: BrowserClosedReason? by mutableStateOf(null)
        private set

    /** A take-over or a hand-back on its way. */
    var holding: Boolean by mutableStateOf(false)
        private set
    var error: String? by mutableStateOf(null)

    /** A passing word about what just happened (a hold that ended, a refusal), gone after a few seconds. */
    var note: String? by mutableStateOf(null)
        private set

    private var areaState: Size by mutableStateOf(Size.zero)

    /** The screen area in points (set by the page). */
    var area: Size
        get() = areaState
        set(value) {
            val old = areaState
            if (value != old) { areaState = value; areaChanged(old) }
        }

    private var typingState: Boolean by mutableStateOf(false)

    /** The keyboard is up (the hidden field has it). */
    var typing: Boolean
        get() = typingState
        set(value) {
            if (value != typingState) { typingState = value; relift() }
        }

    /** The phone's own zoom of the picture. */
    var zoom: BrowserZoom by mutableStateOf(BrowserZoom.none)
        private set

    /** How far the picture is lifted so what was touched stays above the keyboard. */
    var lift: Double by mutableStateOf(0.0)
        private set

    /** The Browser tab's store, which keeps the page zoom this phone remembers by site (set by the page). */
    var store: BrowserStore? = null

    /** Device pixels per point of this screen (the Swift read `traitCollection.displayScale`; set by the page). */
    var screenScale: Double = 1.0

    /** The sample screen's name, for `browsertook` (the Swift read `UserDefaults`'s `uiDemoScreen`; set by the page). */
    var demoScreen: String? = null

    /** The agent behind the tab as people call it (`Codex`, `Claude Code`; the page sets it from the terminal or the task). */
    var agentName: String by mutableStateOf(tab.owner.agentName())

    enum class Connection { Connecting, Live, Reconnecting }

    /** The agent's outline over the picture: its box in CSS pixels, the frame's scale, and what it says. */
    class ActionShown(val box: BrowserBox, val frameScale: Double, val said: String)

    private var api: AgentSwitchAPI? = null
    private var options: BrowserStreamOptions = BrowserStreamPolicy.local
    private var follow: Job? = null

    /**
     * The stream that was followed before `follow` (`retune`): it goes on drawing until `follow` has brought its
     * first event, so the picture does not pause and the Mac never sees the tab without a stream.
     */
    private var outgoing: Job? = null

    /** Which `start` the stream task is (an old one's failure does not touch a newer one). */
    private var streamRun = 0

    /** Bumped when the streams end for good (`stop`, closed): a late event of an earlier stream is dropped. */
    private var epoch = 0

    /** The page is seen (from `start` to `stop`): a take that lands outside it is handed back at once. */
    private var active = false

    /** The hand-back sent on leaving; a take on coming back waits for it, so the two never cross. */
    private var leaving: Job? = null

    /** The take-over notice was said (once a visit to the tab). */
    private var noticed = false
    private var pending: Pair<BrowserFrame, Bitmap>? = null
    private val frames = BrowserFrameDecoder(scope, Dispatchers.Default, ::decodeFrame).also { it.onFrame = ::present }
    private val queue = BrowserInputQueue()
    private var sending: Job? = null
    private var sizing: Job? = null
    private var noteHides: Job? = null

    /** The frame the picture shows now: input is aimed at it. */
    private var seq: Int? = null

    /** Where the last touch fell, in the page's CSS pixels (what the keyboard must not cover; frames may change density). */
    private var touchedY: Double? = null

    /** Opened or back in front: your own tab is taken when the stream says nobody else holds it. */
    private var claimOnConnect = false

    /**
     * The roomiest the screen area has stood at this width (whole points): what the page is sized for, and what the
     * zoom's steps go by. Kept apart from the hold (review, 2026-10-03). Seen by what shows the zoom.
     */
    var roomiest: Size? by mutableStateOf(null)
        private set

    /** When the screen area last changed: an area is room the page has only if it stood (`noteRoom`). */
    private var areaSince = TimeSource.Monotonic.markNow()

    /** The area this phone last sized the page for; null while no size of this phone's is in force (the hold ended). */
    private var sizeSent: Size? = null

    /** The zoom the page was last sized at (percent), so another site's, or the key's, sends the size again. */
    private var zoomSent: Int? = null

    /** The size request sent last (the next waits for it), and how many were asked for. */
    private var sizeRequest: Job? = null
    private var sizeAsks = 0

    // MARK: who holds it

    /** This phone holds it. */
    val mine: Boolean get() = tab.heldBy == screenId

    /** This phone may click, type and navigate. */
    val canDrive: Boolean get() = tab.drivable(screenId)

    /** Another screen holds it. */
    val heldElsewhere: BrowserHolder? get() = tab.heldBy?.let { if (it == screenId) null else BrowserHolder(it) }

    /** The page is at this phone's size. */
    val phoneSized: Boolean get() = tab.viewport.by == screenId

    /**
     * `Fill Ciphertext` is offered: this phone drives one of your own tabs (never an agent's, even taken over: the
     * agent sees the page again after the hand-back, and the Mac refuses it).
     */
    val canFill: Boolean get() = canDrive && !tab.owner.isAgent

    val layout: BrowserLayout?
        get() {
            val frame = frameSize ?: return null
            if (!(area.width > 0 && area.height > 0)) return null
            return BrowserLayout(frame = frame, area = area, fillWidth = phoneSized, lift = lift, zoom = zoom)
        }

    /** The agent's last action, while it is the agent's turn (not over your own hands). */
    val actionShown: ActionShown?
        get() {
            if (!tab.owner.isAgent || mine) return null
            val action = tab.action ?: return null
            val box = action.box ?: return null
            return ActionShown(box, frameScale, action.said(agentName))
        }

    private fun applyTab(next: BrowserTabInfo) {
        val old = tab
        tab = next
        if (next.site != old.site) siteChanged()
    }

    // MARK: the stream

    /** Starts the stream (`api` null: the sample screen's picture). `options`: [BrowserStreamPolicy] for the link. */
    fun start(api: AgentSwitchAPI?, options: BrowserStreamOptions = this.options) {
        if (follow != null || closed != null) return
        this.api = api
        this.options = options
        if (api == null) {
            showDemo()
            return
        }
        // The page opens on the list's copy of the tab, read every 2 s: for that long after a page was left it may still
        // say this phone holds the tab it gave back on leaving. The stream's first word decides; until then the tab is
        // nobody's here, as after handBackQuietly (a zoom key pressed in that moment set a size the Mac refused).
        if (mine) applyTab(tab.applying(BrowserEvent.Held(null, BrowserHeldReason.HandBack)))
        claimOnConnect = true
        active = true
        connection = Connection.Connecting
        follow = openStream(api)
    }

    /**
     * The stream as `options` asks; a failure is said unless a newer stream took over. With its first event, and
     * whenever it ends, the stream it takes over from ends (`endOutgoing`).
     */
    private fun openStream(api: AgentSwitchAPI): Job {
        val id = id
        val options = options
        streamRun += 1
        val run = streamRun
        val mine = epoch
        return scope.launch {
            var heard = false
            try {
                api.browserEvents(id, options).collect { event ->
                    if (!currentCoroutineContext().isActive || epoch != mine) return@collect
                    if (!heard) {
                        heard = true
                        endOutgoing(run)
                    }
                    handle(event)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // The stream gave up (an answer that is no stream): said, and `resume()` starts it again.
                if (streamRun == run && epoch == mine) {
                    error = describe(e)
                    follow = null
                }
            } finally {
                endOutgoing(run)
            }
        }
    }

    /**
     * Another picture for the same tab: the link was measured (browser-v0 §1) and allows more, or less, or the page's
     * zoom changed what the stream asks (§1 页面缩放, 2026-10-03). The stream again with `options`, the new one opened
     * before the old one ends so the picture does not pause; the tab kept (nothing handed back or taken) and, the page
     * the same, not drawn in afresh. Not streaming: the next start asks for them.
     *
     * The old stream stays, drawing, until the new one has brought its first event. A new one replaced in its turn
     * before it has brought anything ends at once, and the one still drawing stays for the newest to take over from:
     * never more than one stream beside the one followed.
     */
    fun retune(options: BrowserStreamOptions) {
        if (options == this.options || closed != null) return
        this.options = options
        val old = follow
        val api = api
        if (old == null || api == null) return
        if (outgoing == null) outgoing = old else old.cancel()
        follow = openStream(api)
    }

    /** Stream `run` has brought its first event, or has ended: the stream it took over from ends. */
    private fun endOutgoing(run: Int) {
        if (streamRun != run) return
        outgoing?.cancel()
        outgoing = null
    }

    /** No stream from here on: the one followed and, where it had not taken over yet, the one still drawing. */
    private fun endStreams() {
        epoch += 1
        follow?.cancel()
        follow = null
        outgoing?.cancel()
        outgoing = null
    }

    /** The page is not seen (left, another tab, the background): the stream ends and the tab goes back. */
    fun stop() {
        active = false
        endStreams()
        frames.reset()
        sizing?.cancel()
        typing = false
        if (mine) handBackQuietly()
    }

    /** The app went to the background: the same as [stop] (the Swift's `stop()` is called for both). */
    fun suspend() = stop()

    /** Back in sight: the stream again; your own tab is taken again when nobody holds it. */
    fun resume() {
        if (follow != null || closed != null) return
        start(api, options)
    }

    fun handle(event: BrowserEvent) {
        when (event) {
            is BrowserEvent.Tab -> {
                applyTab(event.tab)
                if (connection == Connection.Reconnecting) connection = Connection.Live
                if (claimOnConnect) {
                    claimOnConnect = false
                    if (!event.tab.owner.isAgent && (event.tab.heldBy == null || event.tab.heldBy == screenId)) claim()
                }
            }
            // Decoded off the main thread; shown by `present`.
            is BrowserEvent.Frame -> frames.take(event.frame)
            is BrowserEvent.Held -> {
                val had = mine
                applyTab(tab.applying(event))
                if (had && event.holder != screenId) {
                    typing = false
                    sizeSent = null
                    if (event.reason == BrowserHeldReason.Idle) say(BrowserNotice.idleHandBack)
                    else event.holder?.let { say(BrowserHolder(it).said) }
                }
            }
            is BrowserEvent.Viewport -> applyTab(tab.applying(event))
            is BrowserEvent.Closed -> {
                closed = event.reason
                typing = false
                endStreams()
            }
            BrowserEvent.Dropped -> {
                connection = Connection.Reconnecting
                // The hold may have ended meanwhile; what the stream says on connecting decides.
                claimOnConnect = !tab.owner.isAgent
            }
            else -> applyTab(tab.applying(event))
        }
    }

    /** Off the main thread: the picture made from the frame's bytes (JPEG or PNG). */
    private fun decodeFrame(frame: BrowserFrame): BrowserDecodedFrame? {
        val header = BrowserImageHeader.read(frame.jpeg) ?: return null
        val bitmap = BitmapFactory.decodeByteArray(frame.jpeg, 0, frame.jpeg.size) ?: return null
        pending = frame to bitmap
        return BrowserDecodedFrame(frame, header)
    }

    /** A decoded frame on the screen: input is aimed at it from now on. */
    private fun present(decoded: BrowserDecodedFrame) {
        val frame = decoded.frame
        val shown = pending?.takeIf { it.first === frame }?.second
        pending = null
        if (shown != null) picture = shown
        seq = frame.seq
        val size = frame.size
        if (frameScale != frame.scale) frameScale = frame.scale
        // The first picture, or the page at a new size (it took the phone's size, or gave it back, or was zoomed) comes
        // in top down; the same page at another density (drawn at the phone's pixels, or at the CSS size while an agent
        // clicks) just replaces it. By the page's size alone: a zoom step lays the page out afresh and mostly leaves the
        // frame the screen's pixels as it was (review, 2026-10-03).
        if (pageSize != frame.pageSize) {
            refreshes += 1
            pageSize = frame.pageSize
        }
        if (frameSize != size) {
            frameSize = size
            relift()
        }
        if (connection != Connection.Live) connection = Connection.Live
    }

    // MARK: holding

    /**
     * `[ Take Over ]`: this phone holds the tab (from the agent, or from another screen) at its own size. An agent's
     * tab says once that it will see what is typed, and where passwords go.
     */
    suspend fun takeOver() {
        val api = api ?: return
        if (holding) return
        holding = true
        try {
            leaving?.join()
            try {
                val fresh = api.takeBrowserTab(id, screenId)
                if (!landed(fresh)) return
                if (fresh.owner.isAgent && !noticed) {
                    noticed = true
                    say(BrowserNotice.takeOver, durationMs = 10_000)
                }
                sendSize(force = true)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = describe(e)
            }
        } finally {
            holding = false
        }
    }

    /** `[ Hand Back ]`: the agent goes on; the page gets the Mac's size again. */
    suspend fun handBack() {
        val api = api ?: return
        if (holding) return
        holding = true
        typing = false
        try {
            applyTab(api.releaseBrowserTab(id, screenId))
            sizeSent = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = describe(e)
        } finally {
            holding = false
        }
    }

    /** Your own tab, nobody else holding it: this phone's, quietly. */
    private fun claim() {
        val api = api ?: return
        if (holding) return
        holding = true
        scope.launch {
            try {
                leaving?.join()
                val fresh = api.takeBrowserTab(id, screenId)
                if (!landed(fresh)) return@launch
                sendSize(force = true)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = describe(e)
            } finally {
                holding = false
            }
        }
    }

    /**
     * A take's answer: the tab while the page is seen; after `stop()` (the page left, the app in the background) the
     * hold is given back at once and no size is set (true: go on).
     */
    private fun landed(fresh: BrowserTabInfo): Boolean {
        if (!active) {
            if (fresh.heldBy == screenId) handBackQuietly()
            return false
        }
        applyTab(fresh)
        return true
    }

    /**
     * Leaving: given back whether or not anyone waits for the answer, and said here at once rather than left for the
     * next stream to say: from now the tab is nobody's. So back on the page, before that stream's first word, your own
     * tab is taken as the phone acts on it and an agent's is only watched.
     */
    private fun handBackQuietly() {
        val api = api ?: return
        val id = id
        val me = screenId
        sizeSent = null
        applyTab(tab.applying(BrowserEvent.Held(null, BrowserHeldReason.HandBack)))
        leaving = scope.launch {
            try { api.releaseBrowserTab(id, me) } catch (e: CancellationException) { throw e } catch (_: Exception) { /* nobody waits for it */ }
        }
    }

    /**
     * The page at this phone's screen area over the page zoom (BrowserPageZoom: points over the factor, the pixel
     * ratio times it, a phone's layout). A keyboard (the page's or the address bar's) does not shrink it: the picture
     * is lifted instead; so after the first, only another area to size the page for (`sizedArea`: the phone turned,
     * more room than there has been, or the first sent while the page was still being laid out) or another zoom is
     * sent. The requests go one at a time, in the order asked, and of those waiting only the newest.
     */
    private suspend fun sendSize(force: Boolean = false) {
        val api = api ?: return
        if (!active || !mine || area.width < 100 || area.height < 100) return
        val size = sizedArea
        val percent = pageZoom
        if (!(force || sizeSent != size || zoomSent != percent)) return
        sizeSent = size
        zoomSent = percent
        val page = BrowserPageZoom.viewport(area = size, screenScale = maxOf(screenScale, 1.0), percent = percent)
        sizeAsks += 1
        val ask = sizeAsks
        val earlier = sizeRequest
        val request = scope.launch {
            earlier?.join()
            // A newer size was asked for while this one waited, or the tab went back meanwhile (`sizeSent` is forgotten
            // then): nothing to set.
            if (sizeAsks != ask || !active || sizeSent == null) return@launch
            try {
                applyTab(api.setBrowserViewport(id, page.width.toInt(), page.height.toInt(), page.scale, page.mobile, screenId))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = describe(e)
            }
        }
        sizeRequest = request
        request.join()
    }

    /**
     * The area the page is sized for, in whole points: the screen area as it is, and no lower than it has stood at this
     * width — what a keyboard, a note or the zoom row takes of its height still counts.
     */
    val sizedArea: Size get() = BrowserPageZoom.sizedArea(area, roomiest)

    /**
     * The tab is on another site: while this phone holds it, the page at that site's zoom (browser-v0 §1 页面缩放) —
     * the size again when the zoom differs from the one last set.
     */
    private fun siteChanged() {
        if (!mine || sizeSent == null) return
        scope.launch { sendSize() }
    }

    private fun areaChanged(old: Size) {
        noteRoom(old)
        relift()
        zoom = zoom.clamped(area)
        // Turned, or more room: the page follows, once things settle (never for a keyboard; sendSize).
        if (!mine || old == Size.zero) return
        sizing?.cancel()
        sizing = scope.launch {
            delay(BrowserPageZoom.settle.inWholeMilliseconds)
            sendSize()
        }
    }

    /**
     * The area just replaced is room the page has if it stood (BrowserPageZoom.roomiest: not the passing ones of a page
     * being laid out as it opens): the roomiest of those is what the page is sized for when a keyboard, a note or the
     * zoom row takes part of the area.
     */
    private fun noteRoom(replaced: Size) {
        val now = TimeSource.Monotonic.markNow()
        val roomy = BrowserPageZoom.roomiest(roomiest, replaced, areaSince.elapsedNow())
        if (roomiest != roomy) roomiest = roomy
        areaSince = now
    }

    /** While the keyboard is up, what was last touched stays in sight; down, the picture sits at the top again. */
    private fun relift() {
        val frame = frameSize
        val y = touchedY
        if (frame == null || !phoneSized || !typing || y == null) {
            if (lift != 0.0) lift = 0.0
            return
        }
        lift = BrowserLayout.lift(toShow = y * frameScale, frame = frame, areaWidth = area.width, visible = area.height)
    }

    // MARK: input

    /** A tap clicks there; on your own tab nobody holds, the phone takes it as it acts. */
    fun tap(at: Point) {
        val aimed = aim(at) ?: return
        touchedY = aimed.y / frameScale
        send(BrowserInput.Click(aimed.x, aimed.y, seq = seq))
    }

    /** A long press is the right button (the page's own menu). */
    fun longPress(at: Point) {
        val aimed = aim(at) ?: return
        send(BrowserInput.Click(aimed.x, aimed.y, button = BrowserMouseButton.Right, seq = seq))
    }

    /** A drag scrolls the page under the finger. */
    fun drag(delta: Size, at: Point) {
        val layout = layout ?: return
        val aimed = aim(at, quiet = true) ?: return
        val wheel = layout.wheelDelta(delta)
        send(BrowserInput.Wheel(aimed.x, aimed.y, wheel.width, wheel.height, seq))
    }

    fun pinch(scale: Double, at: Point) {
        zoom = zoom.pinched(zoom.scale * scale, at, area)
    }

    fun pan(delta: Size) {
        if (!zoom.isZoomed) return
        zoom = zoom.panned(delta, area)
    }

    fun resetZoom() {
        zoom = BrowserZoom.none
    }

    // MARK: the zoom key

    /**
     * This phone sizes the tab: it holds it, or the tab is yours and nobody's for now (the phone takes it as it acts).
     * Then the zoom key zooms the page (browser-v0 §1 页面缩放: only the screen that sizes a tab can); otherwise — an
     * agent's tab not taken over, a tab held elsewhere — only the picture on the phone.
     */
    val zoomsPage: Boolean get() = canDrive

    /**
     * The page zoom in force (percent): what this phone remembers for the tab's site, as far as the area it sizes the
     * page for allows; 100 for a site not zoomed and on a blank tab.
     */
    val pageZoom: Int get() = BrowserPageZoom.inForce(store?.zoomMemory?.percent(tab.site), sizedArea)

    /** What the key says: the page's percent while this phone sizes the tab, the picture's while it only watches. */
    val zoomPercent: Int get() = if (zoomsPage) pageZoom else zoom.percent

    /**
     * What the stream's scale is multiplied by (BrowserStreamPolicy): the factor of the zoom this phone sets the page
     * at, 1 while it only watches. The page asks the stream again when it changes.
     */
    val streamZoom: Double get() = if (zoomsPage) BrowserPageZoom.factor(pageZoom) else 1.0

    /** A step further in, or out, is there: at the end of the range its cap is off. */
    val canZoomIn: Boolean get() = if (zoomsPage) pageStepIn != null else zoom.stepIn != null
    val canZoomOut: Boolean get() = if (zoomsPage) pageStepOut != null else zoom.stepOut != null

    fun zoomIn() {
        if (zoomsPage) {
            pageStepIn?.let { setPageZoom(it) }
        } else {
            zoom.stepIn?.let { stepPicture(it) }
        }
    }

    fun zoomOut() {
        if (zoomsPage) {
            pageStepOut?.let { setPageZoom(it) }
        } else {
            zoom.stepOut?.let { stepPicture(it) }
        }
    }

    /** The percent cap: back to 100% — the site's zoom forgotten, or the whole picture again. */
    fun zoomToStandard() {
        if (zoomsPage) setPageZoom(BrowserPageZoom.standard) else resetZoom()
    }

    /** The page's next step in and out; none at the end of what the area allows, nor on a blank tab (always 100%). */
    private val pageStepIn: Int? get() = BrowserPageZoom.stepIn(pageZoom, tab.site, sizedArea)
    private val pageStepOut: Int? get() = BrowserPageZoom.stepOut(pageZoom, tab.site, sizedArea)

    /**
     * The site's pages at `percent` from now on (remembered on this phone; 100% forgets it): the size again at once —
     * the area did not change — and the phone's own zoom of the picture put back, since the page is laid out afresh
     * and what was touched is no longer where it was. The stream is asked again by the page when its scale differs
     * (streamZoom). Your own tab that nobody holds is taken, as when the phone acts on it.
     */
    private fun setPageZoom(percent: Int) {
        val store = store ?: return
        try { store.rememberZoom(percent, tab.site) } catch (e: Exception) { error = describe(e) }
        zoom = BrowserZoom.none
        touchedY = null
        relift()
        if (api == null) drawDemo()
        if (mine) scope.launch { sendSize() } else claim()
    }

    /** While only watching: the picture on the phone at `scale`, as two fingers would leave it (not remembered). */
    private fun stepPicture(scale: Double) {
        val picture = layout?.picture ?: return
        zoom = zoom.stepped(scale, picture, area)
    }

    fun type(text: String) { if (canDrive) send(BrowserInput.Text(text)) else refuse() }

    fun press(key: BrowserKey) { if (canDrive) send(BrowserInput.Key(key)) else refuse() }

    /** The frame pixel under a point, when this phone may act there; else nothing is sent (and why is said once). */
    private fun aim(point: Point, quiet: Boolean = false): Point? {
        if (!canDrive) {
            if (!quiet) refuse()
            return null
        }
        return layout?.framePoint(point)
    }

    private fun refuse() {
        val holder = heldElsewhere
        if (holder != null) say(holder.said + "接手后才能操作。") else say("此标签由 agent 使用。接手后才能操作。")
    }

    /** In order, one request at a time; a drag's turns that pile up meanwhile go as one. */
    private fun send(event: BrowserInput) {
        val api = api ?: return
        queue.append(event)
        if (!mine && !tab.owner.isAgent && tab.heldBy == null) claim()
        if (sending != null) return
        val id = id
        val me = screenId
        sending = scope.launch {
            while (isActive && !queue.isEmpty) {
                val batch = queue.next()
                try {
                    api.sendBrowserInput(id, batch, me)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    queue.removeAll()
                    error = describe(e)
                }
            }
            sending = null
        }
    }

    // MARK: going places

    suspend fun navigate(typed: String) {
        val api = api ?: return
        val target = BrowserAddress.target(typed) ?: return
        if (!canDrive) { refuse(); return }
        try { applyTab(api.navigateBrowserTab(id, target, screenId)) } catch (e: CancellationException) { throw e } catch (e: Exception) { error = describe(e) }
    }

    suspend fun history(action: BrowserHistoryAction) {
        val api = api ?: return
        if (!canDrive) { refuse(); return }
        try { applyTab(api.browserHistory(id, action, screenId)) } catch (e: CancellationException) { throw e } catch (e: Exception) { error = describe(e) }
    }

    /**
     * A saved ciphertext into the focused field, checked by the gate against the page's site; your own tabs only, and
     * only a password or one-time-code field (the Mac's refusal is shown as it is). False: the Mac cannot do it yet.
     */
    suspend fun fill(token: String): Boolean {
        val api = api ?: return true
        if (!canDrive) { refuse(); return true }
        if (!canFill) { error = BrowserNotice.fillOwnTabsOnly; return true }
        try {
            if (!api.fillBrowserTab(id, token, screenId)) {
                error = "此 Mac 上的 AgentSwitch 版本尚不支持填入密文，请先更新。"
                return false
            }
            say("已填入密文。")
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = describe(e)
        }
        return true
    }

    suspend fun close(): Boolean {
        val api = api ?: return true
        return try {
            api.closeBrowserTab(id)
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = describe(e)
            false
        }
    }

    private fun say(words: String, durationMs: Long = 4_000) {
        note = words
        noteHides?.cancel()
        noteHides = scope.launch {
            delay(durationMs)
            note = null
        }
    }

    private fun describe(e: Throwable): String = e.message ?: e.javaClass.simpleName

    // MARK: the sample screens

    /**
     * The demo screens: a picture drawn on the phone in place of the Mac's (a tab at this phone's size, at the size of
     * its screen area, once that is known).
     */
    private fun showDemo() {
        scope.launch {
            while (phoneSized && area == Size.zero) delay(50)
            if (!drawDemo()) return@launch
            connection = Connection.Live
            if (demoScreen == "browsertook") {
                touchedY = 210.0   // the password field of the mock login page
                delay(1_500)
                typing = true
            }
        }
    }

    /**
     * The mock page as the Mac would send it now: a tab at this phone's size is its screen area over the page zoom
     * (drawn again when the zoom key changes it). False: no mock page for this tab.
     */
    private fun drawDemo(): Boolean {
        val page = BrowserPageZoom.viewport(area = area, screenScale = 1.0, percent = pageZoom)
        val frame = DemoBrowser.frame(tab, if (phoneSized) Size(page.width, page.height) else null) ?: return false
        handle(BrowserEvent.Frame(frame))
        return true
    }
}

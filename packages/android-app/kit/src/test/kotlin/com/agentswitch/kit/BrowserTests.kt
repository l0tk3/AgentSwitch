package com.agentswitch.kit

import com.agentswitch.kit.api.*
import com.agentswitch.kit.browser.*
import com.agentswitch.kit.design.PixelArt
import com.agentswitch.kit.support.KitJson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds
import kotlin.time.TimeSource

/** The Browser tab's client side (docs/browser-v0.md §5): the list, a tab's stream, and what the phone may send. */
class BrowserTests {
    private val lan = APIEndpoint(host = "192.168.1.5", port = 4713, kind = EndpointKind.Lan)

    private fun api(transport: HTTPTransport) = AgentSwitchAPI(endpoints = FixedEndpoint(lan), transport = transport, token = "tok")

    private fun parse(text: String): JsonElement = KitJson.parseToJsonElement(text)
    private fun jsonText(value: Any?): String = json(value).decodeToString()
    private fun body(request: HTTPRequest): JsonObject = assertNotNull(request.jsonBody)
    private fun expected(value: Map<String, Any?>): JsonObject = parse(jsonText(value)) as JsonObject

    companion object {
        val codexTab: Map<String, Any?>
            get() = mapOf(
                "id" to "a1", "owner" to mapOf("kind" to "terminal", "id" to "t9", "label" to "codex · AgentSwitch"), "title" to "Pull Request #128",
                "url" to "https://github.com/acme/app/pull/128", "site" to "github.com", "kind" to "web", "status" to "busy", "loading" to false,
                "heldBy" to null, "action" to mapOf("tool" to "browser_click", "description" to "click \"Merge\"",
                    "box" to mapOf("x" to 10, "y" to 20, "width" to 100, "height" to 30), "at" to 5),
                "viewport" to mapOf("width" to 1280, "height" to 800, "scale" to 1, "mobile" to false, "by" to null), "openedAt" to 1,
            )
    }

    @Test
    fun testTheListDecodesByOwnerAndLeniently() {
        val list = KitJson.decodeFromString(BrowserTabList.serializer(), jsonText(mapOf(
            "running" to true,
            "groups" to listOf(
                mapOf("owner" to mapOf("kind" to "terminal", "id" to "t9", "label" to "codex · AgentSwitch"), "tabs" to listOf(codexTab)),
                mapOf("owner" to mapOf("kind" to "task", "id" to "k1", "label" to "登录财务平台"),
                    "tabs" to listOf(mapOf("id" to "b2", "status" to "waiting", "owner" to mapOf("kind" to "task", "id" to "k1", "label" to "登录财务平台"),
                        "action" to mapOf("tool" to "needs_user", "description" to "等你：短信验证码")))),
                mapOf("owner" to mapOf("kind" to "you", "id" to "you", "label" to "You"),
                    "tabs" to listOf(mapOf("id" to "c3", "kind" to "file", "site" to "~/x/mesh.html", "status" to "someday",
                        "heldBy" to "phone-7c", "viewport" to mapOf("width" to 390, "height" to 600, "scale" to 3, "mobile" to true, "by" to "phone-7c")))),
                mapOf("owner" to mapOf("kind" to "you", "id" to "you", "label" to "You"), "tabs" to emptyList<Any>()),
            ),
        )))
        assertTrue(list.running)
        assertEquals(3, list.groups.size, "an empty group is not listed")
        val pr = list.groups[0].tabs[0]
        assertEquals(BrowserTabOwner.Kind.Terminal, pr.owner.kind)
        assertEquals("codex", pr.owner.namedHarness)
        assertEquals(BrowserTabStatus.Busy, pr.status)
        assertEquals(BrowserBox(x = 10.0, y = 20.0, width = 100.0, height = 30.0), pr.action?.box)
        assertEquals("codex · click \"Merge\"", pr.action?.said(by = "codex"))
        assertNull(pr.heldBy)
        assertNull(pr.viewport.by)
        assertEquals("等你：短信验证码", list.groups[1].tabs[0].waitingReason)
        assertEquals(1, list.waiting)
        val mine = list.groups[2].tabs[0]
        assertEquals(BrowserTabStatus.Other("someday"), mine.status)
        assertEquals(BrowserPlaceKind.File, mine.kind)
        assertEquals(BrowserViewport(width = 390.0, height = 600.0, scale = 3.0, mobile = true, by = "phone-7c"), mine.viewport)
        assertEquals("~/x/mesh.html", mine.displayTitle, "no title yet: where it is")
        assertEquals("Busy", BrowserTabStatus.Busy.label)
        assertEquals(2, list.removing("a1").groups.size)
        val added = list.adding(BrowserTabInfo(id = "d4", site = "localhost:5173", kind = BrowserPlaceKind.Local))
        assertEquals(listOf("c3", "d4"), added.groups.last().tabs.map { it.id }, "with your other tabs")
    }

    /** Who may drive a tab (host.ts mayDrive): its holder; nobody's is yours to drive, an agent's only once taken over. */
    @Test
    fun testOnlyTheHolderDrivesAndAnAgentsTabIsTakenOverFirst() {
        val agents = KitJson.decodeFromString(BrowserTabInfo.serializer(), jsonText(codexTab))
        assertFalse(agents.drivable("phone-1"))
        assertTrue(agents.applying(BrowserEvent.Held("phone-1", reason = BrowserHeldReason.Take)).drivable("phone-1"))
        assertFalse(agents.applying(BrowserEvent.Held("mac-2", reason = BrowserHeldReason.Take)).drivable("phone-1"))
        val yours = BrowserTabInfo(id = "y")
        assertTrue(yours.drivable("phone-1"))
        assertFalse(yours.applying(BrowserEvent.Held("mac-2", reason = BrowserHeldReason.Take)).drivable("phone-1"))
        assertEquals(BrowserHolder.Mac, BrowserHolder("mac-3f"))
        assertEquals(BrowserHolder.Mac, BrowserHolder("local"))
        // Swift: "On iPhone" (a phone's screen id; here the phone's own word).
        assertEquals("On Phone", BrowserHolder("phone-1").label)
        assertEquals(BrowserHolder.Web, BrowserHolder("web-9"))
        assertEquals("此标签正在另一台设备上使用。", BrowserHolder("dev-123").said)
    }

    @Test
    fun testStreamEventsParseAndChangeTheTab() {
        val jpeg = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xD9.toByte())
        val frame = BrowserEvent.parse("frame", jsonText(mapOf(
            "type" to "frame", "seq" to 42, "data" to java.util.Base64.getEncoder().encodeToString(jpeg), "format" to "jpeg", "width" to 640, "height" to 400,
            "scale" to 0.5, "viewport" to mapOf("width" to 1280, "height" to 800), "pageScale" to 1, "scrollX" to 0, "scrollY" to 120,
        )))
        assertEquals(BrowserEvent.Frame(BrowserFrame(seq = 42, jpeg = jpeg, width = 640.0, height = 400.0, scale = 0.5, viewportWidth = 1280.0, viewportHeight = 800.0)), frame)
        assertNull(BrowserEvent.parse("frame", """{"seq":1,"data":"%%%","width":1,"height":1}"""), "a picture it cannot read is skipped")
        assertEquals(BrowserEvent.Url("http://localhost:5173/", site = "localhost:5173", kind = BrowserPlaceKind.Local),
            BrowserEvent.parse("url", """{"type":"url","url":"http://localhost:5173/","site":"localhost:5173","kind":"local"}"""))
        assertEquals(BrowserEvent.Title("Acme · Dev"), BrowserEvent.parse("title", """{"title":"Acme · Dev"}"""))
        assertEquals(BrowserEvent.Loading(true), BrowserEvent.parse("loading", """{"loading":true}"""))
        assertEquals(BrowserEvent.Status(BrowserTabStatus.Waiting), BrowserEvent.parse("status", """{"status":"waiting"}"""))
        assertEquals(BrowserEvent.Held(null, reason = BrowserHeldReason.Idle), BrowserEvent.parse("held", """{"heldBy":null,"reason":"idle"}"""))
        assertEquals(BrowserEvent.Held("phone-1", reason = BrowserHeldReason.Take), BrowserEvent.parse("held", """{"heldBy":"phone-1","reason":"take"}"""))
        assertEquals(BrowserEvent.Action(null), BrowserEvent.parse("action", """{"action":null}"""))
        assertEquals(BrowserEvent.Viewport(BrowserViewport(width = 390.0, height = 700.0, scale = 3.0, mobile = true, by = "phone-1")),
            BrowserEvent.parse("viewport", """{"viewport":{"width":390,"height":700,"scale":3,"mobile":true,"by":"phone-1"}}"""))
        assertEquals(BrowserEvent.Closed(BrowserClosedReason.BrowserExited), BrowserEvent.parse("closed", """{"reason":"browser-exited"}"""))
        assertEquals("Mac 上的 AgentSwitch 服务已停止，标签已关闭。", BrowserClosedReason.Shutdown.said)
        assertNull(BrowserEvent.parse("future", "{}"))
        val tab = (BrowserEvent.parse("tab", jsonText(mapOf("type" to "tab", "tab" to codexTab))) as? BrowserEvent.Tab)?.tab ?: error("tab")
        val moved = tab.applying(BrowserEvent.Url("https://github.com/acme/app", site = "github.com", kind = BrowserPlaceKind.Web))
            .applying(BrowserEvent.Title("acme/app")).applying(BrowserEvent.Status(BrowserTabStatus.Idle)).applying(BrowserEvent.Action(null))
            .applying(BrowserEvent.Held("phone-1", reason = BrowserHeldReason.Take))
        assertEquals("https://github.com/acme/app", moved.url)
        assertEquals("acme/app", moved.title)
        assertEquals(BrowserTabStatus.Idle, moved.status)
        assertNull(moved.action)
        assertEquals("phone-1", moved.heldBy)
        assertNull(moved.applying(BrowserEvent.Held(null, reason = BrowserHeldReason.HandBack)).heldBy)
    }

    private val ownTab = jsonText(mapOf("tab" to mapOf("id" to "a1", "owner" to mapOf("kind" to "you", "id" to "you", "label" to "You"))))

    @Test
    fun testOpeningNavigatingAndHoldingSendWhatTheMacTakes() = runTest {
        val transport = FakeTransport({ req, _ ->
            ownTab.toByteArray() to httpResponse(req.url, status = if (req.method == "POST" && req.path == "/browser/tabs") 201 else 200)
        })
        val api = api(transport)
        val opened = api.openBrowserTab(BrowserTarget.Url("localhost:5173"))
        assertEquals("a1", opened.id)
        api.openBrowserTab(BrowserTarget.Port(3000))
        api.navigateBrowserTab("a1", to = BrowserTarget.Path("~/x/mesh.html"), screen = "phone-1")
        api.browserHistory("a1", BrowserHistoryAction.Back, screen = "phone-1")
        api.takeBrowserTab("a1", screen = "phone-1")
        api.setBrowserViewport("a1", width = 393, height = 120, scale = 3.0, mobile = true, screen = "phone-1")
        api.releaseBrowserTab("a1", screen = "phone-1")
        api.closeBrowserTab("a1")
        assertEquals(listOf("/browser/tabs", "/browser/tabs", "/browser/tabs/a1/navigate", "/browser/tabs/a1/navigate",
            "/browser/tabs/a1/take", "/browser/tabs/a1/viewport", "/browser/tabs/a1/release", "/browser/tabs/a1"), transport.paths)
        val r = transport.requests
        assertEquals(expected(mapOf("url" to "localhost:5173")), body(r[0]))
        assertEquals(expected(mapOf("port" to 3000)), body(r[1]))
        assertEquals(expected(mapOf("path" to "~/x/mesh.html", "screen" to "phone-1")), body(r[2]))
        assertEquals(expected(mapOf("action" to "back", "screen" to "phone-1")), body(r[3]))
        assertEquals(expected(mapOf("screen" to "phone-1")), body(r[4]))
        assertEquals(expected(mapOf("width" to 393, "height" to 200, "scale" to 3, "mobile" to true, "screen" to "phone-1")), body(r[5]),
            "a height under the Mac's 200 is raised to it")
        assertEquals("DELETE", r[7].method)
    }

    @Test
    fun testAProfilesOwnBrowserIsAskedByTheSameRoutesUnderItsAddress() = runTest {
        val listed = """{"browsers":[{"key":null,"name":"Shared","running":true},{"key":"claude-code.abc123def0","name":"cwork1","agent":"claude-code","exit":{"ip":"203.0.113.9","place":"Tokyo"},"running":false}]}"""
        val transport = FakeTransport({ req, _ ->
            if (req.path == "/browsers") return@FakeTransport listed.toByteArray() to httpResponse(req.url, status = 200)
            if (req.path.endsWith("/browser/tabs") && req.method == "GET") return@FakeTransport """{"running":false,"groups":[]}""".toByteArray() to httpResponse(req.url, status = 200)
            ownTab.toByteArray() to httpResponse(req.url, status = if (req.method == "POST" && req.path.endsWith("/browser/tabs")) 201 else 200)
        })
        val api = api(transport)
        // The browsers the Mac holds: the shared one, then each profile's own with where it leaves the Mac from.
        val browsers = api.browsers()
        assertEquals(listOf(BrowserChoice(key = null, name = "Shared", running = true),
            BrowserChoice(key = "claude-code.abc123def0", name = "cwork1", exit = BrowserChoice.Exit(ip = "203.0.113.9", place = "Tokyo"))), browsers)
        assertEquals(listOf("", "claude-code.abc123def0"), browsers.map { it.id })
        assertEquals("Tokyo 203.0.113.9", browsers[1].exit?.text)
        // The shared browser's routes as they are; a profile's own under its address; other routes untouched.
        val own = api.forBrowser("claude-code.abc123def0")
        api.browserTabs()
        own.browserTabs()
        own.openBrowserTab(BrowserTarget.Url("claude.ai"))
        own.takeBrowserTab("a1", screen = "phone-1")
        own.closeBrowserTab("a1")
        runCatching { own.browserServers() }
        own.forBrowser(null).browserTabs()
        assertEquals(listOf("/browsers", "/browser/tabs", "/profile-browser/claude-code.abc123def0/browser/tabs", "/profile-browser/claude-code.abc123def0/browser/tabs",
            "/profile-browser/claude-code.abc123def0/browser/tabs/a1/take", "/profile-browser/claude-code.abc123def0/browser/tabs/a1",
            "/profile-browser/claude-code.abc123def0/browser/servers", "/browser/tabs"), transport.paths)
        assertEquals(listOf(null, "claude-code.abc123def0"), listOf(api.browserKey, own.browserKey))
        // A Mac that does not list them (an older one) has the shared one alone.
        val older = api(FakeTransport({ req, _ -> """{"error":"not found"}""".toByteArray() to httpResponse(req.url, status = 404) }))
        assertEquals(listOf(BrowserChoice.shared), older.browsers())
    }

    @Test
    fun testARefusalCarriesItsReason() = runTest {
        val transport = FakeTransport({ req, _ ->
            """{"error":"~/x/.env 属于凭据文件（.env、私钥、证书、令牌配置等），不在浏览器中打开。"}""".toByteArray() to httpResponse(req.url, status = 403)
        })
        val error = assertFailsWith<APIError>("403 is an error") { api(transport).openBrowserTab(BrowserTarget.Url("~/x/.env")) }
        assertEquals("~/x/.env 属于凭据文件（.env、私钥、证书、令牌配置等），不在浏览器中打开。", error.message)
    }

    @Test
    fun testInputGoesInOrderAsFramePixels() = runTest {
        val transport = FakeTransport()
        val api = api(transport)
        api.sendBrowserInput("a1", listOf(BrowserInput.Click(x = 10.04, y = 20.06, seq = 7), BrowserInput.Click(x = 1.0, y = 2.0, button = BrowserMouseButton.Right, seq = null),
            BrowserInput.Wheel(x = 5.0, y = 6.0, deltaX = 0.0, deltaY = -120.55, seq = 7), BrowserInput.Text("你好"), BrowserInput.Key(BrowserKey.Backspace)), screen = "phone-1")
        api.sendBrowserInput("a1", emptyList(), screen = "phone-1")
        assertEquals(listOf("/browser/tabs/a1/input"), transport.paths, "nothing to send, nothing sent")
        val sent = body(transport.requests[0])
        assertEquals("phone-1", sent["screen"]?.jsonPrimitive?.content)
        val events = sent["events"]!!.jsonArray
        assertEquals(expected(mapOf("type" to "mouse", "action" to "click", "x" to 10, "y" to 20.1, "button" to "left", "clickCount" to 1, "seq" to 7)), events[0])
        assertEquals(expected(mapOf("type" to "mouse", "action" to "click", "x" to 1, "y" to 2, "button" to "right", "clickCount" to 1)), events[1])
        assertEquals(expected(mapOf("type" to "wheel", "x" to 5, "y" to 6, "deltaX" to 0, "deltaY" to -120.6, "seq" to 7)), events[2])
        assertEquals(expected(mapOf("type" to "text", "text" to "你好")), events[3])
        assertEquals(expected(mapOf("type" to "key", "key" to "Backspace")), events[4])
    }

    /** A drag's wheel turns go together; the order of everything else is kept; a request carries at most 50. */
    @Test
    fun testTheQueueJoinsWheelTurnsAndBatches() {
        val queue = BrowserInputQueue()
        queue.append(BrowserInput.Wheel(x = 1.0, y = 1.0, deltaX = 0.0, deltaY = 10.0, seq = 1))
        queue.append(BrowserInput.Wheel(x = 2.0, y = 3.0, deltaX = 1.0, deltaY = 15.0, seq = 2))
        queue.append(BrowserInput.Click(x = 4.0, y = 4.0, seq = 2))
        queue.append(BrowserInput.Wheel(x = 2.0, y = 3.0, deltaX = 0.0, deltaY = 5.0, seq = 2))
        assertEquals(listOf(BrowserInput.Wheel(x = 2.0, y = 3.0, deltaX = 1.0, deltaY = 25.0, seq = 2), BrowserInput.Click(x = 4.0, y = 4.0, seq = 2),
            BrowserInput.Wheel(x = 2.0, y = 3.0, deltaX = 0.0, deltaY = 5.0, seq = 2)), queue.events)
        for (i in 0 until 60) queue.append(BrowserInput.Text("$i"))
        assertEquals(50, queue.next().size)
        assertEquals(13, queue.next().size)
        assertTrue(queue.isEmpty)
    }

    @Test
    fun testFillingACiphertextAndAMacWithoutIt() = runTest {
        val tab = jsonText(mapOf("tab" to codexTab))
        val transport = FakeTransport({ req, n ->
            if (n == 0) return@FakeTransport """{"ok":true}""".toByteArray() to httpResponse(req.url)
            // An older Mac: no fill route, the tab itself there.
            if (req.path == "/browser/tabs/a1") return@FakeTransport tab.toByteArray() to httpResponse(req.url)
            """{"error":"not found"}""".toByteArray() to httpResponse(req.url, status = 404)
        })
        val api = api(transport)
        val filled = api.fillBrowserTab("a1", token = "enc:v1:abc", screen = "phone-1")
        assertTrue(filled)
        assertEquals(expected(mapOf("token" to "enc:v1:abc", "screen" to "phone-1")), body(transport.requests[0]))
        val older = api.fillBrowserTab("a1", token = "enc:v1:abc", screen = "phone-1")
        assertFalse(older, "404 while the tab is there: this Mac cannot fill yet")
        assertEquals(listOf("/browser/tabs/a1/fill", "/browser/tabs/a1/fill", "/browser/tabs/a1"), transport.paths)
    }

    /** 2026-10-02 review: a 404 from a tab closed meanwhile is not taken for an older Mac (which would hide the key). */
    @Test
    fun testFillingATabThatIsGoneSaysSo() = runTest {
        val transport = FakeTransport({ req, _ -> """{"error":"not found"}""".toByteArray() to httpResponse(req.url, status = 404) })
        val error = assertFailsWith<APIError>("a closed tab is an error, not an older Mac") {
            api(transport).fillBrowserTab("gone", token = "enc:v1:abc", screen = "phone-1")
        }
        assertEquals(APIError.Http(status = 404, message = "此标签已关闭。"), error)
        assertEquals(listOf("/browser/tabs/gone/fill", "/browser/tabs/gone"), transport.paths)
    }

    /** The Mac's refusals are shown in its words: 400 for a field that takes no ciphertext, 409 on an agent's tab. */
    @Test
    fun testAFillRefusalCarriesTheMacsWords() = runTest {
        val transport = FakeTransport({ req, _ -> """{"error":"只能填入密码或验证码输入框。"}""".toByteArray() to httpResponse(req.url, status = 400) })
        val error = assertFailsWith<APIError>("refused") { api(transport).fillBrowserTab("a1", token = "enc:v1:abc", screen = "phone-1") }
        assertEquals("只能填入密码或验证码输入框。", error.message)
    }

    @Test
    fun testLocalServersDecode() = runTest {
        val transport = FakeTransport({ req, _ ->
            """{"servers":[{"port":5173,"bind":"loopback","pid":42,"name":"vite","cwd":"/Users/me/Projects/site","url":"http://localhost:5173/"},{"port":3000}]}""".toByteArray() to httpResponse(req.url)
        })
        val servers = api(transport).browserServers()
        assertEquals(listOf(BrowserLocalServer(port = 5173, pid = 42, name = "vite", cwd = "/Users/me/Projects/site"),
            BrowserLocalServer(port = 3000, name = "", cwd = "")), servers)
    }

    @Test
    fun testTheStreamAsksForItsQualityReconnectsAndEndsWhenClosed() = runBlocking {
        val first = "event: tab\ndata: ${jsonText(mapOf("type" to "tab", "tab" to codexTab))}\n\n: ping\n\nevent: status\ndata: {\"status\":\"idle\"}\n\n"
        val transport = FakeTransport(streamHandler = { req, n ->
            if (n == 0) Triple(httpResponse(req.url, contentType = "text/event-stream"), listOf(first.toByteArray()), APIError.Transport("dropped"))
            else Triple(httpResponse(req.url, contentType = "text/event-stream"),
                listOf("event: closed\ndata: {\"reason\":\"closed\"}\n\nevent: title\ndata: {\"title\":\"x\"}\n\n".toByteArray()), null)
        })
        val got = mutableListOf<BrowserEvent>()
        api(transport).browserEvents("a1", options = BrowserStreamOptions(quality = 45, fps = 5, maxWidth = 1179),
            policy = ReconnectPolicy(initial = 1.milliseconds, maximum = 2.milliseconds)).collect { got.add(it) }
        assertEquals(4, got.size)
        assertTrue(got[0] is BrowserEvent.Tab, "the tab first")
        assertEquals(listOf(BrowserEvent.Status(BrowserTabStatus.Idle), BrowserEvent.Dropped, BrowserEvent.Closed(BrowserClosedReason.Closed)), got.drop(1), "nothing after closed")
        assertEquals("quality=45&fps=5&maxWidth=1179", transport.requests.first().query)
        assertEquals("text/event-stream", transport.requests.first().header("Accept"))
        assertEquals(2, transport.requests.size)
    }

    @Test
    fun testAStreamForATabThatIsGoneSaysClosed() = runBlocking {
        val transport = FakeTransport(streamHandler = { req, _ -> Triple(httpResponse(req.url, status = 404), listOf("""{"error":"not found"}""".toByteArray()), null) })
        val got = mutableListOf<BrowserEvent>()
        api(transport).browserEvents("gone", options = BrowserStreamPolicy.local).collect { got.add(it) }
        assertEquals(listOf<BrowserEvent>(BrowserEvent.Closed(BrowserClosedReason.Closed)), got)
    }

    // MARK: quality

    @Test
    fun testTheStreamAsksForLessOnASlowLink() {
        assertEquals(BrowserStreamOptions(quality = 70, fps = 15), BrowserStreamPolicy.options(kind = EndpointKind.Lan, mbps = null))
        assertEquals(BrowserStreamPolicy.local, BrowserStreamPolicy.options(kind = EndpointKind.Bonjour, mbps = 1.0), "the local network is not measured")
        assertEquals(BrowserStreamPolicy.local, BrowserStreamPolicy.options(kind = EndpointKind.Tailnet, mbps = 30.0))
        assertEquals(BrowserStreamOptions(quality = 60, fps = 10), BrowserStreamPolicy.options(kind = EndpointKind.Tailnet, mbps = 12.0))
        assertEquals(BrowserStreamOptions(quality = 45, fps = 5, maxWidth = 1179, maxHeight = 2556),
            BrowserStreamPolicy.options(kind = EndpointKind.Tailnet, mbps = 3.0, screenPixels = Size(1179.0, 2556.0)))
        assertEquals(5, BrowserStreamPolicy.options(kind = EndpointKind.Tailnet, mbps = null).fps, "not measured yet: the slow way")
        assertEquals(5, BrowserStreamPolicy.options(kind = null, mbps = null).fps, "no address")
        assertTrue(BrowserStreamPolicy.measures(EndpointKind.Tailnet))
        assertFalse(BrowserStreamPolicy.measures(EndpointKind.Lan))
        assertFalse(BrowserStreamPolicy.measures(EndpointKind.Bonjour))
        assertFalse(BrowserStreamPolicy.measures(null))
        assertEquals(listOf("1", "30", "100"), BrowserStreamOptions(quality = 0, fps = 99, maxWidth = 20).query.map { it.value })
    }

    @Test
    fun testTheStreamAsksForTheScreensDevicePixelsWhereTheLinkAllows() {
        val pixels = Size(1179.0, 2556.0)
        val local = BrowserStreamOptions(quality = 70, fps = 15, maxWidth = 1179, maxHeight = 2556, scale = 3.0)
        val fair = BrowserStreamOptions(quality = 60, fps = 10, maxWidth = 1179, maxHeight = 2556, scale = 2.0)
        val slow = BrowserStreamOptions(quality = 45, fps = 5, maxWidth = 1179, maxHeight = 2556)
        // The local network: the screen's scale, never larger than the screen (a desktop page across the phone's width).
        assertEquals(local, BrowserStreamPolicy.options(kind = EndpointKind.Lan, mbps = null, screenPixels = pixels, screenScale = 3.0))
        // Tailscale by the speed measured, direct or relayed alike: 25 Mbps and up as the local network, 8 and up at most 2,
        // slower (or not known) the CSS size; each at most the screen's pixels.
        for ((mbps, expected) in listOf(80.0 to local, 25.0 to local, 24.9 to fair, 8.0 to fair, 7.9 to slow, 0.5 to slow)) {
            assertEquals(expected, BrowserStreamPolicy.options(kind = EndpointKind.Tailnet, mbps = mbps, screenPixels = pixels, screenScale = 3.0), "$mbps Mbps")
        }
        assertEquals(slow, BrowserStreamPolicy.options(kind = EndpointKind.Tailnet, mbps = null, screenPixels = pixels, screenScale = 3.0))
        assertEquals(fair, BrowserStreamPolicy.options(kind = EndpointKind.Tailnet, mbps = 12.0, screenPixels = pixels, screenScale = 2.0), "a 2× screen: its own scale")
        // Without the screen's pixels or on a 1x screen: as before (no bound means no scale).
        assertEquals(BrowserStreamPolicy.local, BrowserStreamPolicy.options(kind = EndpointKind.Lan, mbps = null, screenScale = 3.0))
        assertEquals(BrowserStreamPolicy.local, BrowserStreamPolicy.options(kind = EndpointKind.Lan, mbps = null, screenPixels = pixels, screenScale = 1.0))
        assertEquals(listOf("quality", "fps", "maxWidth", "maxHeight", "scale"),
            BrowserStreamOptions(quality = 70, fps = 15, maxWidth = 1179, maxHeight = 2556, scale = 3.0).query.map { it.name })
        assertEquals("8", BrowserStreamOptions(quality = 70, fps = 15, scale = 9.0).query.last().value, "within what the Mac takes (8 since the page zoom)")
        assertEquals("2.5", BrowserStreamOptions(quality = 70, fps = 15, scale = 2.5).query.last().value)
        assertNull(BrowserStreamOptions(quality = 70, fps = 15, scale = 1.0).query.firstOrNull { it.name == "scale" }, "1 is the default: not sent")
    }

    // MARK: speed

    @Test
    fun testTheSpeedIsTheBytesAfterTheFirstChunkOverTheTimeBetween() {
        val meter = BrowserSpeed.Meter()
        assertNull(meter.mbps, "nothing yet")
        meter.add(64 * 1024, at = 0.10)
        assertNull(meter.mbps, "one chunk says nothing")
        meter.add(0, at = 0.2)
        meter.add(500_000, at = 0.30)
        meter.add(500_000, at = 0.50)
        assertEquals(1_000_000 * 8 / 0.4 / 1_000_000, meter.mbps!!, 0.001, "the time to the first chunk is not counted")
        // Cut short at the limit: the time waited counts, never less than the last chunk's.
        val cut = meter.copy()
        cut.cut(at = 2.1)
        assertEquals(1_000_000 * 8 / 2.0 / 1_000_000, cut.mbps!!, 0.001)
        val early = meter.copy()
        early.cut(at = 0.2)
        assertEquals(meter.mbps, early.mbps)
        val empty = BrowserSpeed.Meter()
        empty.cut(at = 2.0)
        assertNull(empty.mbps, "nothing came: not known")
        val little = BrowserSpeed.Meter()
        little.add(4096, at = 0.1)
        little.add(4096, at = 0.2)
        assertNull(little.mbps, "too little to tell")
    }

    @Test
    fun testTheSpeedIsMeasuredOnTheMacsSpeedRoute() = runBlocking {
        val transport = FakeTransport(streamHandler = { req, _ -> Triple(httpResponse(req.url), List(17) { ByteArray(64 * 1024) }, null) })
        api(transport).browserSpeed(bytes = 17 * 64 * 1024)
        assertEquals(listOf("/browser/speed"), transport.paths)
        assertEquals("bytes=1114112", transport.requests.first().query)
        assertEquals("application/octet-stream", transport.requests.first().header("Accept"))
        // An older Mac without the route: not known.
        val old = FakeTransport(streamHandler = { req, _ -> Triple(httpResponse(req.url, status = 404), listOf("""{"error":"not found"}""".toByteArray()), null) })
        assertNull(api(old).browserSpeed())
    }

    @Test
    fun testASpeedMeasureEndsAtItsLimitOnWhatCame() = runBlocking {
        val chunks = List(5) { ByteArray(64 * 1024) }
        // Sends its chunks, then nothing more and never ends (a stalled link).
        val transport = object : HTTPTransport {
            override suspend fun send(request: HTTPRequest) = throw APIError.Transport("no requests")
            override suspend fun stream(request: HTTPRequest) = httpResponse(request.url) to flow<ByteArray> {
                for (c in chunks) emit(c)
                awaitCancellation()
            }
        }
        val began = TimeSource.Monotonic.markNow()
        val mbps = api(transport).browserSpeed(limit = 300.milliseconds)
        val took = began.elapsedNow()
        assertTrue(took < 2.seconds, "ends at the limit, not when the bytes would come")
        val measured = assertNotNull(mbps, "what came counts")
        assertTrue(measured < BrowserStreamPolicy.fairMbps, "the time waited counts: 256 KiB in about 0.3 s")
    }

    @Test
    fun testTheSamePageAtAnotherDensityIsTheSamePage() {
        val css = BrowserFrame(seq = 1, jpeg = ByteArray(0), width = 390.0, height = 844.0, scale = 1.0, viewportWidth = 390.0, viewportHeight = 844.0)
        val sharp = BrowserFrame(seq = 2, jpeg = ByteArray(0), width = 1170.0, height = 2532.0, scale = 3.0, viewportWidth = 390.0, viewportHeight = 844.0)
        assertNotEquals(css.size, sharp.size)
        assertEquals(css.pageSize, sharp.pageSize)
        assertEquals(Size(640.0, 400.0), BrowserFrame(seq = 3, jpeg = ByteArray(0), width = 640.0, height = 400.0).pageSize, "an older Mac: the frame's own")
    }

    // MARK: the address bar

    @Test
    fun testWhatTheAddressBarSends() {
        assertEquals(BrowserTarget.Port(5173), BrowserAddress.target(" 5173 "))
        assertEquals(BrowserTarget.Port(3000), BrowserAddress.target(":3000"))
        assertEquals(BrowserTarget.Url("99999"), BrowserAddress.target("99999"), "not a port: the Mac says it cannot read it")
        assertEquals(BrowserTarget.Url("localhost:5173"), BrowserAddress.target("localhost:5173"))
        assertEquals(BrowserTarget.Url("~/Projects/x/index.html"), BrowserAddress.target("~/Projects/x/index.html"))
        assertNull(BrowserAddress.target("   "))
        assertEquals(listOf("github.com", "a", "b"), BrowserAddress.remember("github.com", recent = listOf("a", "github.com", "b")))
        assertEquals(8, BrowserAddress.remember("x", recent = (0 until 8).map { it.toString() }).size)
    }

    @Test
    fun testWhatTheAddressBarShows() {
        assertEquals("github.com/acme/app/pull/128", BrowserAddress.display("https://github.com/acme/app/pull/128").text)
        assertTrue(BrowserAddress.display("https://www.example.com/").secure)
        assertEquals("example.com", BrowserAddress.display("https://www.example.com/").text)
        assertFalse(BrowserAddress.display("http://localhost:5173/").secure)
        assertEquals("localhost:5173", BrowserAddress.display("http://localhost:5173/").text)
        assertEquals("file:///Users/me/My Site/index.html", BrowserAddress.display("file:///Users/me/My%20Site/index.html").text)
        assertEquals("about:blank", BrowserAddress.display("about:blank").text)
    }

    // MARK: the picture on the phone

    /** Watching: a desktop-sized frame fitted to the width, its top at the top; a touch maps back to frame pixels. */
    @Test
    fun testATouchMapsToTheFramePixelUnderIt() {
        val layout = BrowserLayout(frame = Size(1280.0, 800.0), area = Size(400.0, 600.0))
        assertEquals(Rect(0.0, 0.0, 400.0, 250.0), layout.picture)
        val p = assertNotNull(layout.framePoint(Point(200.0, 125.0)))
        assertEquals(640.0, p.x, 0.001)
        assertEquals(400.0, p.y, 0.001)
        assertNull(layout.framePoint(Point(200.0, 400.0)), "under the picture")
        // a tall frame fitted by its height sits in the middle of the width
        val tall = BrowserLayout(frame = Size(300.0, 1200.0), area = Size(400.0, 600.0))
        assertEquals(Rect(125.0, 0.0, 150.0, 600.0), tall.picture)
        assertEquals(600.0, assertNotNull(tall.framePoint(Point(125.0, 300.0))).y, 0.001)
    }

    /** Two fingers zoom the picture only: the point under them stays put, and a touch still lands on the same pixel. */
    @Test
    fun testZoomKeepsThePointUnderTheFingers() {
        val area = Size(400.0, 600.0)
        val zoom = BrowserZoom.none.pinched(2.0, around = Point(100.0, 100.0), area = area)
        assertEquals(Point(-100.0, -100.0), zoom.offset)
        val layout = BrowserLayout(frame = Size(400.0, 600.0), area = area, zoom = zoom)
        val under = assertNotNull(layout.framePoint(Point(100.0, 100.0)))
        assertEquals(100.0, under.x, 0.001)
        assertEquals(200.0, assertNotNull(layout.framePoint(Point(300.0, 100.0))).x, 0.001)
        assertEquals(2.0, layout.pointsPerPixel, 0.001)
        // the zoomed picture keeps covering the area
        assertEquals(Point(0.0, -600.0), zoom.panned(Size(500.0, -900.0), area = area).offset)
        assertEquals(4.0, BrowserZoom.none.pinched(9.0, around = Point.zero, area = area).scale)
        assertEquals(BrowserZoom.none, zoom.pinched(0.5, around = Point(50.0, 50.0), area = area), "back to the whole picture")
    }

    /** What the agent just did, outlined where it is: the box in CSS pixels, the frame `scale` pixels per CSS pixel. */
    @Test
    fun testTheAgentsBoxIsDrawnWhereItIs() {
        val layout = BrowserLayout(frame = Size(640.0, 400.0), area = Size(320.0, 600.0))
        val rect = layout.screenRect(BrowserBox(x = 100.0, y = 200.0, width = 300.0, height = 40.0), frameScale = 0.5)
        assertEquals(Rect(25.0, 50.0, 75.0, 10.0), rect)
        val zoomed = BrowserLayout(frame = Size(640.0, 400.0), area = Size(320.0, 600.0), zoom = BrowserZoom(scale = 2.0, offset = Point(-10.0, 0.0)))
        assertEquals(Rect(40.0, 100.0, 150.0, 20.0), zoomed.screenRect(BrowserBox(x = 100.0, y = 200.0, width = 300.0, height = 40.0), frameScale = 0.5))
    }

    /** A drag scrolls the page with the finger, in frame pixels. */
    @Test
    fun testADragIsTheWheelInFramePixels() {
        val layout = BrowserLayout(frame = Size(1280.0, 800.0), area = Size(400.0, 600.0))
        assertEquals(Size(0.0, 128.0), layout.wheelDelta(Size(0.0, -40.0)))
    }

    /**
     * Holding the tab at the phone's size, the keyboard up: the picture keeps its size and lifts what was touched into
     * sight; with the keyboard down it fits again.
     */
    @Test
    fun testTheKeyboardLiftsThePictureToWhatWasTouched() {
        val frame = Size(390.0, 700.0)
        assertEquals(400.0 - 152, BrowserLayout.lift(400.0, frame = frame, areaWidth = 390.0, visible = 380.0), 0.001)
        assertEquals(0.0, BrowserLayout.lift(100.0, frame = frame, areaWidth = 390.0, visible = 380.0), 0.001)
        assertEquals(320.0, BrowserLayout.lift(690.0, frame = frame, areaWidth = 390.0, visible = 380.0), 0.001, "no further than the bottom")
        val lifted = BrowserLayout(frame = frame, area = Size(390.0, 380.0), fillWidth = true, lift = 300.0)
        assertEquals(Rect(0.0, -300.0, 390.0, 700.0), lifted.picture)
        assertEquals(600.0, assertNotNull(lifted.framePoint(Point(10.0, 300.0))).y, 0.001)
        val down = BrowserLayout(frame = frame, area = Size(390.0, 700.0), fillWidth = true, lift = 300.0)
        assertEquals(0.0, down.picture.minY, "nothing to lift")
    }

    /** A globe (2026-10-03, user: 浏览器是不是可以再换个通用点的图标): a one-pixel circle, a meridian, the equator. */
    @Test
    fun testTheTabIconIsAGlobe() {
        assertEquals(11, PixelArt.globe.size)
        assertTrue(PixelArt.globe.all { it.length == 11 })
        assertEquals(PixelArt.globe, PixelArt.globe.map { it.reversed() }, "symmetric left and right")
        assertEquals(PixelArt.globe, PixelArt.globe.reversed(), "and top and bottom")
        assertEquals("###########", PixelArt.globe[5], "the equator")
    }

    // Kotlin only: the buffer and the stream's lifetime, by the reader's cancellation.
    @Test
    fun testTheStreamStopsConnectingWhenItsReaderGoes() = runBlocking {
        val transport = FakeTransport(streamHandler = { req, _ -> Triple(httpResponse(req.url, contentType = "text/event-stream"), emptyList(), APIError.Transport("dropped")) })
        val api = api(transport)
        val reader = launch(Dispatchers.Default) {
            api.browserEvents("a1", options = BrowserStreamPolicy.local, policy = ReconnectPolicy(initial = 5.milliseconds, maximum = 5.milliseconds)).collect { }
        }
        delay(60.milliseconds)
        reader.cancel()
        reader.join()
        // A connection already being made when the reader went may still go out; none after that.
        delay(30.milliseconds)
        val made = transport.requests.size
        delay(80.milliseconds)
        assertEquals(made, transport.requests.size, "no connection after the reader went")
    }
}


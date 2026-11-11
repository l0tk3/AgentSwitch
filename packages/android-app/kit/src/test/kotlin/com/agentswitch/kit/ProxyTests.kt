package com.agentswitch.kit

import com.agentswitch.kit.api.*
import com.agentswitch.kit.secrets.SecretUse
import com.agentswitch.kit.secrets.TokenMinter
import com.agentswitch.kit.support.KitJson
import java.time.ZoneId
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Proxies from the phone (docs/clash-v0.md §9, docs/profiles-v0.md §4.2, docs/browser-v0.md §7.6): the Clash page's
 * models, the proxy form, the password sealed here, and the calls as the Mac's service takes them.
 */
class ProxyTests {
    private val lan = APIEndpoint(host = "192.168.1.5", port = 4713, kind = EndpointKind.Lan)

    private fun api(transport: FakeTransport) = AgentSwitchAPI(endpoints = FixedEndpoint(lan), transport = transport, token = "tok")

    /** `GET /clash` as the service answers a phone (the address Clash Verge fetches by is empty). */
    private val clash = """
    {"found":true,"running":true,"version":"v1.19.31","mode":"rule","tun":false,
     "source":{"kind":"link","name":"Mine","host":"sub.example","updatedAt":1760000000000,"nodes":3,
               "providers":[{"name":"tgyun","host":"sub.example:9888","updatedAt":1,"nodes":3}],"traffic":{"used":3221225472,"total":107374182400,"expire":1893456000000}},
     "nodes":["🇯🇵 日本家宽-01","🇯🇵 日本家宽-02","🇺🇸 美国-01"],
     "profiles":[{"uid":"Lbw7BJYzpand","name":"mine.yaml","type":"local","file":"Lbw7BJYzpand.yaml"}],
     "settings":{"claude":{"nodes":["🇯🇵 日本家宽-01","gone"]},"openai":{"nodes":[]},"direct":["5.102.107.254"],"autoUpdateHours":24,
                 "templates":{"domestic":{"on":true,"rules":null},"block":{"on":false,"rules":["DOMAIN-SUFFIX,ads.example"]}},"renameDefault":false,"dns":{"on":false,"text":null}},
     "services":{"claude":{"group":"Claude","auto":"Claude自动选择","live":true,"now":"Claude自动选择","autoNow":"🇯🇵 日本家宽-01","missing":["gone"]},
                 "openai":{"group":"OpenAI","auto":"OpenAI自动选择","live":false,"now":null,"autoNow":null,"missing":[]}},
     "templates":{"domestic":{"on":true,"custom":false,"count":169},"block":{"on":false,"custom":true,"count":1}},
     "defaultGroup":null,"dns":{"on":false,"custom":false,"overridden":false},"active":true,"upToDate":false,"install":"","fetchedAt":null}
    """

    private fun decodeClash(change: (JsonObject) -> JsonObject = { it }): ClashView =
        KitJson.decodeFromJsonElement(ClashView.serializer(), change(KitJson.parseToJsonElement(clash).jsonObject))

    private fun JsonObject.with(key: String, value: kotlinx.serialization.json.JsonElement) = JsonObject(this + (key to value))

    @Test
    fun testTheClashPageIsReadAsTheServiceGivesIt() {
        val view = decodeClash()
        assertEquals("Set Up", view.word)
        assertEquals(2, view.todo.size) // Clash Verge has to fetch again; TUN is off
        assertTrue(view.todo[1].contains("TUN"))
        assertEquals(3, view.nodes.size)
        assertEquals(true, view.state(ClashService.Claude)?.automatic)
        assertEquals(listOf("gone"), view.state(ClashService.Claude)?.missing)
        assertEquals(false, view.state(ClashService.Openai)?.live)
        assertEquals(true, view.state(ClashTemplate.Block)?.custom)
        assertEquals(listOf("DOMAIN-SUFFIX,ads.example"), view.settings.templates.block.rules)
        val source = assertNotNull(view.source)
        assertEquals("sub.example", ClashText.origin(source))
        assertTrue(ClashText.traffic(source.traffic!!, ZoneId.of("UTC")).startsWith("3 / 100 GB · Expires 20"))
        assertEquals("3 / 100 GB · Expires 2030/1/1", ClashText.traffic(source.traffic!!, ZoneId.of("UTC")))
        assertEquals("428 ms", ClashText.delay(428))
        assertEquals("Timeout", ClashText.delay(null))
        assertEquals("", ClashText.delay(mapOf("a" to 1), "b"))
        assertEquals("Timeout", ClashText.delay(mapOf("b" to null), "b"))
        assertEquals("Off", ClashText.interval(hours = 0))

        // Nothing found, not running, all in order.
        assertEquals("Not Found", decodeClash { it.with("found", JsonPrimitive(false)) }.word)
        assertEquals("Not Running", decodeClash { it.with("running", JsonPrimitive(false)) }.word)
        assertEquals("Running", decodeClash { it.with("upToDate", JsonPrimitive(true)).with("tun", JsonPrimitive(true)) }.word)
        assertTrue(decodeClash { it.with("source", JsonNull) }.todo.first().contains("订阅"))
    }

    @Test
    fun testSettingsGoBackWithNullsSaid() {
        var settings = decodeClash().settings
        settings = settings.with(ClashService.Openai, ClashServiceNodes(listOf("🇺🇸 美国-01")))
        settings = settings.copy(templates = settings.templates.with(ClashTemplate.Block, settings.templates[ClashTemplate.Block].copy(rules = null)))
        val sent = KitJson.encodeToJsonElement(ClashSettings.serializer(), settings).jsonObject
        assertEquals(listOf("🇺🇸 美国-01"), sent["openai"]!!.jsonObject["nodes"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertTrue(sent["templates"]!!.jsonObject["block"]!!.jsonObject["rules"] is JsonNull)
        assertTrue(sent["dns"]!!.jsonObject["text"] is JsonNull)
        assertEquals("24", sent["autoUpdateHours"]!!.jsonPrimitive.content)
        // Only My Rules (§7.11): off when a Mac from before says nothing of it, sent either way.
        assertFalse(settings.ownRules)
        assertEquals(false, sent["ownRules"]!!.jsonPrimitive.booleanOrNull)
        settings = settings.copy(ownRules = true)
        val again = KitJson.decodeFromString(ClashSettings.serializer(), KitJson.encodeToString(ClashSettings.serializer(), settings))
        assertTrue(again.ownRules)
    }

    @Test
    fun testClashCallsAreWhatTheServiceTakes() = runTest {
        val transport = FakeTransport({ req, _ ->
            when (req.path) {
                "/clash/delays" -> """{"delays":{"a":428,"b":null}}""".toByteArray() to httpResponse(req.url)
                "/clash/check" -> """{"rows":[{"id":"claude","title":"Claude","host":"claude.ai","expect":{"kind":"group","group":"Claude"},"observed":{"outcome":"proxied","rule":"RuleSet as-claude","path":["Claude","日本家宽-02"],"exit":{"ip":"126.36.1.2","loc":"JP"},"ms":362},"ok":true}]}""".toByteArray() to httpResponse(req.url)
                else -> clash.toByteArray() to httpResponse(req.url)
            }
        })
        val api = api(transport)
        api.selectClash(ClashService.Claude, node = null)
        api.selectClash(ClashService.Openai, node = "🇺🇸 美国-01")
        api.setClashSource(link = "https://sub.example/a?token=s")
        api.setClashSourceVerge("Lbw7BJYzpand")
        api.removeClashSource()
        api.updateClash()
        val delays = api.clashDelays(ClashService.Claude, all = true)
        val rows = api.checkClash()
        assertEquals(428, delays["a"])
        assertTrue("b" in delays && delays["b"] == null)
        assertEquals("RuleSet as-claude → Claude → 日本家宽-02", rows.first().route)
        assertEquals("JP 126.36.1.2 · 362 ms", rows.first().seen)
        assertEquals(listOf("POST /clash/select", "POST /clash/select", "POST /clash/source", "POST /clash/source", "DELETE /clash/source",
            "POST /clash/update", "POST /clash/delays", "POST /clash/check"), transport.requests.map { "${it.method} ${it.path}" })
        fun body(n: Int) = assertNotNull(transport.requests[n].jsonBody)
        assertTrue(body(0)["node"] is JsonNull)
        assertEquals("🇺🇸 美国-01", body(1)["node"]!!.jsonPrimitive.content)
        assertEquals(JsonObject(mapOf("link" to JsonPrimitive("https://sub.example/a?token=s"))), body(2))
        assertEquals(JsonObject(mapOf("service" to JsonPrimitive("claude"), "scope" to JsonPrimitive("all"))), body(6))
    }

    @Test
    fun testAMacThatKeepsProxiesToItselfShowsNothing() = runTest {
        for (status in listOf(403, 404)) {
            val transport = FakeTransport({ req, _ -> """{"error":"Clash is set up on the Mac"}""".toByteArray() to httpResponse(req.url, status = status) })
            val api = api(transport)
            assertNull(api.clash())
            assertNull(api.browserProxy())
        }
    }

    // MARK: the form

    @Test
    fun testAProxyWrittenWholeIsTakenApart() {
        assertEquals(ProxyDraft(server = "http://proxy.example:8080", username = "me", password = "p@ss"), ProxyDraft(server = "http://me:p%40ss@proxy.example:8080/").split())
        assertEquals(ProxyDraft(server = "http://proxy.example:8080", username = "me", password = "word"), ProxyDraft(server = "proxy.example:8080:me:word").split())
        assertEquals(ProxyDraft(server = "socks5://10.0.0.2:1080"), ProxyDraft(server = "SOCKS5://10.0.0.2:1080").split())
        assertEquals("http://proxy.example:8080", ProxyDraft(server = "proxy.example:8080").split().server)
        assertEquals("ftp://proxy.example:21", ProxyDraft(server = "ftp://proxy.example:21").split().server)
    }

    @Test
    fun testWhatStandsInTheWayOfApply() {
        assertNull(ProxyDraft().problem)
        assertFalse(ProxyDraft().canApply)
        assertEquals(true, ProxyDraft(server = "proxy.example").problem?.contains("scheme://host:port"))
        assertEquals("带密码的代理需要用户名。", ProxyDraft(server = "http://proxy.example:8080", password = "x").problem)
        assertTrue(ProxyDraft(server = " http://proxy.example:8080 ", username = "me", password = "x").canApply)
        assertNull(ProxyText.site("http://proxy.example:99999"))
        assertEquals("[fd7a::1]:1080", ProxyText.site("socks5://[fd7a::1]:1080"))
    }

    @Test
    fun testThePasswordStaysWhenNoneIsTyped() {
        val current = ProxySetting(server = "http://proxy.example:8080", username = "me", sealed = true)
        val kept = ProxyDraft(current).request(ciphertext = null, current = current)
        assertEquals(ProxyRequest(server = "http://proxy.example:8080", username = "me", password = null, keepPassword = true), kept)
        val sent = KitJson.encodeToJsonElement(ProxyRequest.serializer(), kept).jsonObject
        assertEquals(setOf("server", "username", "keepPassword"), sent.keys)
        // A new one typed: it goes as a ciphertext and nothing is kept.
        val typed = ProxyDraft(current).copy(password = "hunter2")
        assertEquals(ProxyRequest(server = "http://proxy.example:8080", username = "me", password = "enc:v1:abc"), typed.request(ciphertext = "enc:v1:abc", current = current))
        // No user: nobody's password to keep.
        assertNull(ProxyDraft(server = "http://proxy.example:8080").request(ciphertext = null, current = current).keepPassword)
    }

    @Test
    fun testThePasswordIsSealedForTheProxyItselfAndNowhereElse() {
        val draft = ProxyDraft(server = "http://Proxy.Example:8080", username = "me", password = "hunter2")
        val payload = assertNotNull(draft.sealing(label = ProxyOwner.Profile(agent = "claude-code", id = "abc").sealLabel))
        assertEquals(listOf("proxy.example:8080"), payload.hosts)
        assertEquals(listOf(SecretUse.Fill, SecretUse.Http), payload.uses)
        assertEquals("profile/proxy", payload.label)
        assertEquals("hunter2", payload.value)
        assertEquals("browser/proxy", ProxyOwner.Browser.sealLabel)
        assertNull(ProxyDraft(server = "http://proxy.example:8080", username = "me").sealing(label = "browser/proxy"))
        // What it becomes is a ciphertext the gate's own format, and the value is not in it.
        val keys = TestSodium.keyPair()
        val token = TokenMinter(keys.publicKey, TestSodium.sealer).mint(payload)
        assertTrue(TokenMinter.looksLikeToken(token))
        assertFalse(token.contains("hunter2"))
    }

    // MARK: whose proxy

    @Test
    fun testAProfilesProxyAndTheSharedBrowsersAreRead() {
        val reply = KitJson.decodeFromString(ProfileProxyReply.serializer(), """
        {"agents":{"claude-code":{"current":"default","creatable":true,"profiles":[
          {"id":"default","name":"Default","kind":"subscription","createdAt":0},
          {"id":"abc123def0","name":"Work","kind":"subscription","createdAt":1,"color":"violet","proxy":{"server":"http://proxy.example:8080","username":"me","sealed":true},"exit":{"ip":"203.0.113.9","place":"Tokyo","checkedAt":5}},
          {"id":"abc123def1","name":"Side","kind":"subscription","createdAt":2,"proxy":{"server":"socks5://10.0.0.2:1080","sealed":false}}]}},
         "problem":"代理是通的，但几个出口查询都没有给出地址，所以不知道从哪里出去。"}
        """)
        val profiles = assertNotNull(reply.agents["claude-code"]?.profiles)
        assertEquals(listOf("This Mac", "Tokyo 203.0.113.9", "10.0.0.2:1080"), profiles.map { it.way })
        assertEquals(ProxySetting(server = "http://proxy.example:8080", username = "me", sealed = true), profiles[1].proxy)
        assertEquals(true, reply.problem?.startsWith("代理是通的"))

        // The shared browser, as a phone is told it: the fingerprint in a line, without its text.
        val found = KitJson.decodeFromString(BrowserProxyState.serializer(), """
        {"fingerprint":{"summary":{"system":"macOS","browser":"Firefox 156","cores":8,"language":"en-US","timezone":null,"timezoneFrom":"exit"},"since":1,"source":"generated"},
         "proxy":{"server":"socks5://proxy.example.net:1080","username":"me","sealed":true},"exit":{"ip":"203.0.113.9","place":"Tokyo","timezone":"Asia/Tokyo","checkedAt":5},"restartNeeded":true}
        """)
        assertEquals("macOS · Firefox 156", found.fingerprint)
        assertEquals("Tokyo 203.0.113.9", found.way)
        assertTrue(found.restartNeeded)
        val down = KitJson.decodeFromString(BrowserProxyState.serializer(),
            """{"fingerprint":{"summary":{"system":"macOS","browser":"Firefox 156"}},"proxy":{"server":"http://proxy.example:8080","sealed":false},"exit":{"problem":"代理没有回应。"},"restartNeeded":false}""")
        assertEquals(BrowserProxyState.Exit.Problem("代理没有回应。"), down.exit)
        assertEquals("proxy.example:8080", down.way)
        val direct = KitJson.decodeFromString(BrowserProxyState.serializer(),
            """{"fingerprint":{"summary":{"system":"macOS","browser":"Firefox 156"}},"proxy":null,"exit":null,"restartNeeded":false}""")
        assertEquals("Direct", direct.way)
        assertNull(direct.proxy)
    }

    @Test
    fun testProxyCallsAreWhatTheServiceTakes() = runTest {
        val transport = FakeTransport({ req, _ ->
            if (req.path.startsWith("/profiles/")) """{"agents":{}}""".toByteArray() to httpResponse(req.url)
            else """{"fingerprint":{"summary":{"system":"macOS","browser":"Firefox 156"}},"proxy":null,"exit":null,"restartNeeded":false}""".toByteArray() to httpResponse(req.url)
        })
        val api = api(transport)
        api.setProfileProxy(agent = "claude-code", id = "abc123def0", proxy = ProxyRequest(server = "http://proxy.example:8080", username = "me", password = "enc:v1:abc"))
        api.setProfileProxy(agent = "claude-code", id = "abc123def0", proxy = null)
        api.checkProfileExit(agent = "claude-code", id = "abc123def0")
        api.setBrowserProxy(ProxyRequest(server = "socks5://10.0.0.2:1080"))
        api.setBrowserProxy(null)
        api.restartBrowser()
        assertEquals(listOf("PUT /profiles/claude-code/abc123def0/proxy", "PUT /profiles/claude-code/abc123def0/proxy", "POST /profiles/claude-code/abc123def0/check",
            "PUT /browser/identity", "PUT /browser/identity", "POST /browser/identity/restart"), transport.requests.map { "${it.method} ${it.path}" })
        fun body(n: Int) = assertNotNull(transport.requests[n].jsonBody)
        assertEquals(mapOf("server" to "http://proxy.example:8080", "username" to "me", "password" to "enc:v1:abc"), body(0).mapValues { it.value.jsonPrimitive.content })
        assertTrue(body(1)["server"] is JsonNull)
        assertEquals(mapOf("server" to "socks5://10.0.0.2:1080"), body(3)["proxy"]!!.jsonObject.mapValues { it.value.jsonPrimitive.content })
        assertTrue(body(4)["proxy"] is JsonNull)
        // A phone changes no fingerprint: nothing but the proxy is ever in what it sends.
        assertEquals(setOf("proxy"), body(3).keys)
    }

    // MARK: the app's sample data (demo/DemoData.kt keeps the Clash values as JSON)

    @Test
    fun testTheSampleDataOfTheAppDecodes() {
        // The shapes of DemoData.swift's `clashObject`: times and sizes as doubles, `install` and `mode` unknown to us.
        val demo = """
        {"found":true,"running":true,"version":"v1.19.31","mode":"rule","tun":true,
         "source":{"kind":"link","name":"Mine","host":"sub.example.net","updatedAt":1.7628288E12,"nodes":42,"providers":[],
                   "traffic":{"used":13207024435.0,"total":107374182400.0,"expire":1793456000000.0}},
         "nodes":["🇯🇵 日本家宽-01","🇺🇸 美国-02"],
         "profiles":[{"uid":"Lbw7BJYzpand","name":"mine.yaml","type":"local"},{"uid":"Ro3yUVdr9kT1","name":"Other","type":"remote"}],
         "settings":{"claude":{"nodes":["🇯🇵 日本家宽-01"]},"openai":{"nodes":["🇺🇸 美国家宽-01","🇸🇬 新加坡-01"]},"direct":["5.102.107.254"],"autoUpdateHours":24,
                     "templates":{"domestic":{"on":true,"rules":null},"block":{"on":false,"rules":null}},"renameDefault":false,"dns":{"on":false,"text":null}},
         "services":{"claude":{"group":"Claude","auto":"Claude自动选择","live":true,"now":"Claude自动选择","autoNow":"🇯🇵 日本家宽-01","missing":[]},
                     "openai":{"group":"OpenAI","auto":"OpenAI自动选择","live":true,"now":"🇸🇬 新加坡-01","autoNow":"🇺🇸 美国家宽-01","missing":[]}},
         "templates":{"domestic":{"on":true,"custom":false,"count":169},"block":{"on":false,"custom":false,"count":27}},
         "defaultGroup":"节点选择","dns":{"on":false,"custom":false,"overridden":false},"active":true,"upToDate":true,"install":"","fetchedAt":1.7628E12}
        """
        val view = KitJson.decodeFromString(ClashView.serializer(), demo)
        assertEquals("Running", view.word)
        assertEquals(1762828800000L, view.source?.updatedAt)
        assertEquals(1762800000000L, view.fetchedAt)
        assertEquals("12.3 / 100 GB · Expires 2026/10/31", ClashText.traffic(view.source!!.traffic!!, ZoneId.of("UTC")).replace("2026/10/31", "2026/10/31"))
        assertEquals(false, view.state(ClashService.Openai)?.automatic)
        assertEquals("节点选择", view.defaultGroup)
        assertEquals(listOf("🇺🇸 美国家宽-01", "🇸🇬 新加坡-01"), view.settings[ClashService.Openai].nodes)
        // The page after a setting changed here: the settings go back in as JSON and read again.
        val changed = KitJson.encodeToJsonElement(ClashSettings.serializer(), view.settings.copy(ownRules = true))
        assertEquals(true, KitJson.decodeFromJsonElement(ClashSettings.serializer(), changed).ownRules)
        val rows = KitJson.decodeFromString(kotlinx.serialization.builtins.ListSerializer(ClashCheckRow.serializer()),
            """[{"id":"domestic","title":"Domestic","host":"www.baidu.com","expect":{"kind":"direct"},"observed":{"outcome":"direct","rule":"RuleSet as-domestic","path":["DIRECT"],"ms":41},"ok":true}]""")
        assertEquals("RuleSet as-domestic → DIRECT", rows[0].route)
        assertNull(rows[0].seen)
        assertEquals(listOf("DOMAIN-SUFFIX,cn", "", "GEOIP,CN"), ClashText.lines("DOMAIN-SUFFIX,cn\r\nGEOIP,CN"))
    }
}

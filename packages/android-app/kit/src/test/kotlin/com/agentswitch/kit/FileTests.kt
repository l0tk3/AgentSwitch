package com.agentswitch.kit

import com.agentswitch.kit.api.*
import com.agentswitch.kit.support.KitJson
import java.io.File
import java.time.ZoneId
import java.time.ZonedDateTime
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The Files tab's half in the kit (docs/files-v0.md §5, §7): what the Mac's `/files…` answers decode to, how they
 * are asked for, what a refusal says, and the pure parts the pages lean on. No Mac: a scripted transport.
 */
class FileTests {
    private val lan = APIEndpoint(host = "192.168.1.5", port = 4713, kind = EndpointKind.Lan)

    private fun api(transport: FakeTransport) = AgentSwitchAPI(endpoints = FixedEndpoint(lan), transport = transport, token = "tok")

    private val level = """
    {"path":"/Users/me/Projects/lumen","parent":"/Users/me/Projects","home":"/Users/me","more":0,"hiddenCount":2,
     "entries":[
      {"name":"docs-link","kind":"link","size":0,"mtime":1760600000000,"hidden":false,"link":{"target":"/Users/me/Documents","kind":"dir"}},
      {"name":"node_modules","kind":"dir","size":0,"mtime":1760600000000,"hidden":false,"dim":true},
      {"name":"src","kind":"dir","size":0,"mtime":1760600000000,"hidden":false},
      {"name":"token-copy","kind":"file","size":0,"mtime":0,"hidden":false,"locked":true},
      {"name":"app.ts","kind":"file","size":2140,"mtime":1760611320000,"hidden":false}
     ]}
    """

    @Test
    fun testALevelDecodesAndAsksWithTheVersionItHas() = runTest {
        val transport = FakeTransport({ req, n ->
            if (n == 0) level.toByteArray() to HTTPResponse(200, mapOf("ETag" to "\"v1\""))
            else ByteArray(0) to httpResponse(req.url, status = 304)
        })
        val api = api(transport)
        val first = api.folder("/Users/me/Projects/lumen", hidden = true, etag = null)
        val folder = assertNotNull(first?.folder)
        assertEquals("\"v1\"", first?.etag)
        assertEquals(listOf("docs-link", "node_modules", "src", "token-copy", "app.ts"), folder.entries.map { it.name })
        assertEquals(listOf(true, true, true, false, false), folder.entries.map { it.isFolder })
        assertTrue(folder.entries[1].dim)
        assertTrue(folder.entries[3].locked)
        assertEquals(2, folder.hiddenCount)
        assertFalse(folder.scoped)
        val first0 = assertNotNull(transport.requests.firstOrNull())
        assertEquals("/files", first0.path)
        assertEquals("path=/Users/me/Projects/lumen&hidden=1", first0.query)
        // Asked again with that version: unchanged is null.
        val again = api.folder("/Users/me/Projects/lumen", hidden = true, etag = "\"v1\"")
        assertNull(again)
        assertEquals("\"v1\"", transport.requests.last().header("If-None-Match"))
        // No path: where the Mac starts this device (its home, or its scope's first folder).
        runCatching { api.folder(null, hidden = false, etag = null) }
        assertNull(transport.requests.last().query)
    }

    @Test
    fun testAPathWithAPlusOrASpaceReachesTheMacAsWritten() {
        val url = lan.url(listOf("files", "stat"), listOf(URLQueryItem("path", "/Users/me/c++ notes/a&b=c.md")))
        assertEquals("path=/Users/me/c%2B%2B%20notes/a%26b%3Dc.md", java.net.URI(url).rawQuery)
        assertEquals("path=/Users/me/c++ notes/a&b=c.md", java.net.URI(url).query)
    }

    @Test
    fun testDetailsSayWhatMayHoldAPassword() {
        val env = KitJson.decodeFromString(MacFileDetails.serializer(),
            """{"name":".env","kind":"file","size":48,"mtime":1,"hidden":true,"path":"/Users/me/p/.env","type":"text","lines":3,"sensitive":{"reason":"env"}}""")
        assertEquals("env", env.sensitive)
        assertEquals(MacFileType.Text, env.type)
        assertEquals(3, env.lines)
        assertFalse(env.isFolder)
        val folder = KitJson.decodeFromString(MacFileDetails.serializer(),
            """{"name":"src","kind":"dir","size":0,"mtime":1,"hidden":false,"path":"/p/src","items":4}""")
        assertTrue(folder.isFolder)
        assertNull(folder.sensitive)
        assertNull(folder.type)
    }

    @Test
    fun testPreviewThumbnailAndRefusals() = runTest {
        val transport = FakeTransport({ req, _ ->
            when (req.path) {
                "/files/preview" -> """{"text":"a\nb\n","truncated":false,"lines":2,"size":4}""".toByteArray() to httpResponse(req.url)
                "/files/thumbnail" -> byteArrayOf(0xFF.toByte(), 0xD8.toByte()) to httpResponse(req.url, contentType = "image/jpeg")
                "/files/stat" -> """{"error":"scope"}""".toByteArray() to httpResponse(req.url, status = 403)
                else -> """{"error":"not found"}""".toByteArray() to httpResponse(req.url, status = 404)
            }
        })
        val api = api(transport)
        val preview = api.filePreview("/p/a.txt")
        assertEquals(MacFilePreview(text = "a\nb\n", truncated = false, lines = 2, size = 4), preview)
        val thumb = api.fileThumbnail("/p/a.png")
        assertContentEquals(byteArrayOf(0xFF.toByte(), 0xD8.toByte()), thumb)
        val refused = assertFailsWith<APIError> { api.fileDetails("/elsewhere") }
        assertEquals(FileRefusal.Scope, FileRefusal.of(refused))
        assertEquals("此文件夹不在 Mac mini 给这台设备的授权范围内。", FileRefusal.of(refused)?.sentence("Mac mini"))
        // A Mac from before the Files routes: the remote listener's own 404.
        val old = assertFailsWith<APIError> { api.folder("/p", hidden = false, etag = null) }
        assertEquals(FileRefusal.Unsupported, FileRefusal.of(old))
        assertNull(FileRefusal.of(APIError.Transport("offline")))
        assertEquals("Mac mini 不允许配对的设备读取文件。可在 Mac mini 的“设置 › Nodes”中打开。", FileRefusal.FilesOff.sentence("Mac mini"))
    }

    @Test
    fun testADownloadWritesTheBytesAndSaysHowFarItHasCome() = runTest {
        val body = ByteArray(10_000) { 7 }
        val transport = FakeTransport(streamHandler = { _, _ ->
            Triple(HTTPResponse(200, mapOf("Content-Length" to "10000")), listOf(body.copyOfRange(0, 4000), body.copyOfRange(4000, 10_000)), null)
        })
        val api = api(transport)
        val dir = kotlin.io.path.createTempDirectory("files-test").toFile()
        val file = File(dir, "files-test-${java.util.UUID.randomUUID()}.bin")
        try {
            val seen = CopyOnWriteArrayList<Double>()
            api.downloadFile("/p/big.bin", file) { seen.add(it) }
            assertContentEquals(body, file.readBytes())
            assertEquals(0.0, seen.first())
            assertEquals(1.0, seen.last())
            assertTrue(seen.contains(0.4))
            assertEquals("/files/content", transport.requests.first().path)
            // Refused: the error, and nothing left behind.
            val refusing = FakeTransport(streamHandler = { req, _ -> Triple(httpResponse(req.url, status = 413), listOf("""{"error":"too-large"}""".toByteArray()), null) })
            val api2 = api(refusing)
            val error = assertFailsWith<APIError> { api2.downloadFile("/p/huge.bin", file) { } }
            assertEquals(FileRefusal.TooLarge, FileRefusal.of(error))
            assertFalse(file.exists())
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun testAReplyNamesAMacFileByWhereItIs() = runTest {
        val transport = FakeTransport({ req, _ -> """{"ok":true,"sealed":0,"attached":2}""".toByteArray() to httpResponse(req.url) })
        val api = api(transport)
        api.sendTerminalInput("t1", text = "看 [File #1] 和 [Image #2]", sealed = false,
            attachments = listOf(TerminalAttachmentRef(token = "[File #1]", path = "/Users/me/p/app.ts"),
                TerminalAttachmentRef(token = "[Image #2]", upload = "abc123def456")))
        val attachments = assertNotNull(transport.requests.first().jsonBody)["attachments"]!!.jsonArray
        assertEquals(2, attachments.size)
        assertEquals(mapOf("token" to "[File #1]", "path" to "/Users/me/p/app.ts"), attachments[0].jsonObject.mapValues { it.value.jsonPrimitive.content })
        assertEquals(mapOf("token" to "[Image #2]", "upload" to "abc123def456"), attachments[1].jsonObject.mapValues { it.value.jsonPrimitive.content })
    }

    @Test
    fun testPathsAreTakenApartAsTheMacWritesThem() {
        assertEquals(listOf("/", "Users", "me", "p"), MacPath.levels("/Users/me/p").map { it.name })
        assertEquals(listOf("/", "/Users", "/Users/me", "/Users/me/p"), MacPath.levels("/Users/me/p").map { it.path })
        assertEquals(listOf("/"), MacPath.levels("/").map { it.path })
        assertEquals("/Users", MacPath.join("/", "Users"))
        assertEquals("/Users/me", MacPath.join("/Users", "me"))
        assertEquals("/Users", MacPath.parent("/Users/me"))
        assertEquals("/", MacPath.parent("/Users"))
        assertNull(MacPath.parent("/"))
        assertEquals("p", MacPath.name("/Users/me/p"))
        assertEquals("~/p", MacPath.short("/Users/me/p", home = "/Users/me"))
        assertEquals("/Users/meow", MacPath.short("/Users/meow", home = "/Users/me"))
        // The rest of the namespace.
        assertEquals("~/x", MacPath.tilde("/Users/me/x"))
        assertEquals("~", MacPath.tilde("/Users/me"))
        assertEquals("/Users/Shared/x", MacPath.tilde("/Users/Shared/x"))
    }

    @Test
    fun testSortingKeepsFoldersFirst() {
        val entries = listOf(MacFileEntry("src", MacFileEntry.Kind.Dir, mtime = 1), MacFileEntry("a.ts", MacFileEntry.Kind.File, size = 10, mtime = 5),
            MacFileEntry("b.md", MacFileEntry.Kind.File, size = 300, mtime = 9), MacFileEntry("c.ts", MacFileEntry.Kind.File, size = 20, mtime = 2))
        assertEquals(listOf("src", "a.ts", "b.md", "c.ts"), FileSort.Name.sorted(entries).map { it.name })
        assertEquals(listOf("src", "b.md", "a.ts", "c.ts"), FileSort.Modified.sorted(entries).map { it.name })
        assertEquals(listOf("src", "b.md", "c.ts", "a.ts"), FileSort.Size.sorted(entries).map { it.name })
        assertEquals(listOf("src", "b.md", "a.ts", "c.ts"), FileSort.Kind.sorted(entries).map { it.name })
    }

    @Test
    fun testTheWarningNamesWhatMayHoldAPassword() {
        assertEquals(".env 可能含有密码或密钥。交给 agent 后，它能读到其中的内容，并可能发给模型的服务商。", SensitiveWarning.message(listOf(".env")))
        assertEquals("这 2 个文件可能含有密码或密钥：.env、id_ed25519。交给 agent 后，它能读到其中的内容，并可能发给模型的服务商。",
            SensitiveWarning.message(listOf(".env", "id_ed25519")))
    }

    @Test
    fun testSizesAreShortInTheMacsUnits() {
        assertEquals("0 B", FileSize.short(0))
        assertEquals("238 B", FileSize.short(238))
        assertEquals("2.1 KB", FileSize.short(2140))
        assertEquals("39 KB", FileSize.short(40_000))
        assertEquals("1.2 MB", FileSize.short(1_240_000))
        assertEquals("46 MB", FileSize.short(48_200_000))
        assertEquals("2.8 GB", FileSize.short(3_000_000_000))
    }

    @Test
    fun testTimesAreShort() {
        val zone = ZoneId.of("Asia/Shanghai")
        fun at(y: Int, m: Int, d: Int, h: Int = 0, min: Int = 0): Long = ZonedDateTime.of(y, m, d, h, min, 0, 0, zone).toInstant().toEpochMilli()
        val now = at(2026, 10, 16, 21)
        assertEquals("Today 13:02", FileTime.short(at(2026, 10, 16, 13, 2), now = now, zone = zone))
        assertEquals("Yesterday", FileTime.short(at(2026, 10, 15, 9), now = now, zone = zone))
        assertEquals("9/2", FileTime.short(at(2026, 9, 2), now = now, zone = zone))
        assertEquals("2025/12/31", FileTime.short(at(2025, 12, 31), now = now, zone = zone))
        assertEquals("", FileTime.short(0, now = now, zone = zone))
    }

    // MARK: - changing files (docs/files-v0.md §12)

    @Test
    fun testAListingSaysWhatIsNeverRenamedOrMovedFromHere() {
        val level = KitJson.decodeFromString(MacFolder.serializer(),
            """{"path":"/Users","parent":"/","home":"/Users/me","entries":[{"name":"me","kind":"dir","size":0,"mtime":1,"hidden":false,"fixed":true},{"name":"Shared","kind":"dir","size":0,"mtime":1,"hidden":false}]}""")
        assertEquals(listOf(true, false), level.entries.map { it.fixed })
        assertEquals(listOf(false, true), level.entries.map { it.changeable })
        assertFalse(MacFileEntry(".secret-gate", MacFileEntry.Kind.Dir, locked = true).changeable)
        val home = KitJson.decodeFromString(MacFileDetails.serializer(),
            """{"name":"me","kind":"dir","size":0,"mtime":1,"path":"/Users/me","items":3,"fixed":true}""")
        assertTrue(home.fixed)
    }

    @Test
    fun testChangesAreAskedForAsTheMacTakesThem() = runTest {
        val transport = FakeTransport({ req, _ ->
            when (req.path) {
                "/files/folder" -> """{"path":"/p/fixtures/users","top":"/p/fixtures"}""".toByteArray() to httpResponse(req.url, status = 201)
                "/files/rename" -> """{"path":"/p/index.ts"}""".toByteArray() to httpResponse(req.url)
                "/files/trash" -> """{"moved":[{"path":"/p/a.md","trashed":"/Users/me/.Trash/a.md"},{"path":"/p/b.md","trashed":null}]}""".toByteArray() to httpResponse(req.url)
                else -> """{"path":"/p/docs/logo 2.png","name":"logo 2.png","size":3}""".toByteArray() to httpResponse(req.url, status = 201)
            }
        })
        val api = api(transport)
        val made = api.newFolder("/p/fixtures/users")
        assertEquals(MacMade(path = "/p/fixtures/users", top = "/p/fixtures"), made)
        val renamed = api.rename("/p/app.ts", to = "index.ts", force = false)
        assertEquals("/p/index.ts", renamed)
        val moved = api.trash(listOf("/p/a.md", "/p/b.md"), force = true, permanent = false)
        assertEquals(listOf(MacMoved(path = "/p/a.md", trashed = "/Users/me/.Trash/a.md"), MacMoved(path = "/p/b.md", trashed = null)), moved)
        val bodies = transport.requests.take(3).map { it.jsonBody }
        assertEquals(JsonObject(mapOf("path" to JsonPrimitive("/p/fixtures/users"))), bodies[0])
        assertEquals(JsonObject(mapOf("path" to JsonPrimitive("/p/app.ts"), "name" to JsonPrimitive("index.ts"))), bodies[1])
        assertEquals(JsonObject(mapOf("paths" to JsonArray(listOf(JsonPrimitive("/p/a.md"), JsonPrimitive("/p/b.md"))), "force" to JsonPrimitive(true))), bodies[2])
        // A file of this phone's: its bytes, the place and what to do with a name taken.
        val dir = kotlin.io.path.createTempDirectory("upload").toFile()
        val file = File(dir, "upload-${java.util.UUID.randomUUID()}.png")
        try {
            file.writeBytes(byteArrayOf(1, 2, 3))
            val seen = CopyOnWriteArrayList<Double>()
            val landed = api.upload(file, to = "/p/docs/logo.png", conflict = UploadConflict.Keep) { seen.add(it) }
            assertEquals("logo 2.png", landed.name)
            val put = transport.requests.last()
            assertEquals("PUT", put.method)
            assertEquals("/files/content", put.path)
            assertEquals("path=/p/docs/logo.png&conflict=keep", put.query)
            assertEquals("application/octet-stream", put.header("Content-Type"))
            assertContentEquals(byteArrayOf(1, 2, 3), put.body)
            assertEquals(1.0, seen.last())
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun testARefusalSaysWhatItNamed() = runTest {
        val transport = FakeTransport({ req, n ->
            when (n) {
                0 -> """{"error":"in-use","terminals":[{"id":"t1","name":"排序改成最近使用"}]}""".toByteArray() to httpResponse(req.url, status = 409)
                1 -> """{"error":"no-trash","paths":["/Volumes/NAS/big.iso"],"moved":[]}""".toByteArray() to httpResponse(req.url, status = 409)
                2 -> """{"error":"changes-off"}""".toByteArray() to httpResponse(req.url, status = 403)
                else -> "Not Found".toByteArray() to httpResponse(req.url, status = 404)
            }
        })
        val api = api(transport)
        val a = assertFailsWith<FileChangeError> { api.trash(listOf("/p/lumen"), force = false, permanent = false) }
        assertEquals(FileRefusal.InUse, a.refusal)
        assertEquals(listOf(FileChangeError.Terminal(id = "t1", name = "排序改成最近使用")), a.terminals)
        val b = assertFailsWith<FileChangeError> { api.trash(listOf("/Volumes/NAS/big.iso"), force = false, permanent = false) }
        assertEquals(FileRefusal.NoTrash, b.refusal)
        assertEquals(listOf("/Volumes/NAS/big.iso"), b.paths)
        val c = assertFailsWith<FileChangeError> { api.newFile("/p/x.md") }
        assertEquals(FileRefusal.ChangesOff, c.refusal)
        assertEquals("Mac mini 不允许配对的设备修改文件。可在 Mac mini 的“设置 › Nodes”中打开。", c.refusal?.sentence("Mac mini"))
        // A Mac from before these routes.
        val d = assertFailsWith<FileChangeError> { api.newFolder("/p/x") }
        assertEquals(FileRefusal.Unsupported, d.refusal)
    }

    @Test
    fun testANameIsCheckedAsTheMacsColumnChecksIt() {
        val taken = setOf("docs", "src", "app.ts")
        assertEquals(FileNames.Check.Ok, FileNames.check("fixtures", taken))
        assertEquals(FileNames.Check.Error("请输入名称。"), FileNames.check("", taken))
        assertEquals(FileNames.Check.Error("请输入名称。"), FileNames.check("   ", taken))
        assertEquals(FileNames.Check.Error("此位置已有“docs”。请换一个名称。"), FileNames.check("docs", taken))
        assertEquals(FileNames.Check.Error("此位置已有“docs”。请换一个名称。"), FileNames.check("Docs", taken))
        assertEquals(FileNames.Check.Ok, FileNames.check("docs/api.md", taken))
        assertEquals(FileNames.Check.Error("名称不能是“.”或“..”。"), FileNames.check("a/../b", taken))
        assertEquals(FileNames.Check.Warning("名称前后有空格。"), FileNames.check(" notes.md", taken))
        assertTrue(FileNames.check(" notes.md", taken).allowed)
        // Renaming: a slash is not a name; the same name in another case is a rename.
        assertEquals(FileNames.Check.Error("名称不能包含“/”。"), FileNames.check("x/y.ts", taken, renaming = "app.ts"))
        assertEquals(FileNames.Check.Ok, FileNames.check("App.ts", taken, renaming = "app.ts"))
        assertEquals(FileNames.Check.Error("此位置已有“src”。请换一个名称。"), FileNames.check("src", taken, renaming = "app.ts"))
    }

    @Test
    fun testTheSecondOfTwoIsNamedAsFinderNamesIt() {
        assertEquals("logo 2.png", FileNames.keepBoth("logo.png", setOf("logo.png")))
        assertEquals("logo 3.png", FileNames.keepBoth("logo.png", setOf("logo.png", "logo 2.png")))
        assertEquals("src 2", FileNames.keepBoth("src", setOf("src")))
        assertEquals("IMG_0412 2.HEIC", FileNames.keepBoth("IMG_0412.HEIC", emptySet()))
        assertEquals(".env 2", FileNames.keepBoth(".env", setOf(".env")))
    }
}

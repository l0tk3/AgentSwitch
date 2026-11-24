package com.agentswitch.kit

import com.agentswitch.kit.api.*
import com.agentswitch.kit.design.InterfaceLook
import com.agentswitch.kit.support.KitJson
import java.time.ZoneId
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Chat Room (docs/chatroom-v0.md): what the Mac sends decoded, and what the pages make of it. The iPhone's RoomTests. */
class RoomTests {
    private val lan = APIEndpoint(host = "192.168.1.5", port = 4713, kind = EndpointKind.Lan)
    private fun api(transport: FakeTransport) = AgentSwitchAPI(endpoints = FixedEndpoint(lan), transport = transport, token = "tok")

    private val detailJson = """
        {"room":{"id":"ab12cd34ef","name":"登录","topic":"先定接口","paused":false,"createdAt":1000,"createdBy":"you","lastSeq":3,"readSeq":1,"rounds":6,"roundsLimit":6},
         "seats":[
          {"handle":"you","kind":"user","terminal":null,"face":null,"joinedAt":1000,"addedBy":"you","canAdd":true,"byAgent":false,"left":null,"state":null,"card":null,"kit":null},
          {"handle":"daemon","kind":"session","terminal":"t1","face":{"rows":["#.#.#",".###.","##.##",".###.","#.#.#"],"color":13},"joinedAt":1001,"addedBy":"you","canAdd":true,"byAgent":false,"left":null,"state":"busy",
           "card":{"agent":"claude-code","name":"daemon","cwd":"/Users/x/proj","model":"opus","profile":"Work","color":"mint","mode":"default","node":null},"kit":true},
          {"handle":"web","kind":"session","terminal":"t2","face":{"rows":["##.##","#...#","..#..","#...#","##.##"],"color":2},"joinedAt":1002,"addedBy":"daemon","canAdd":false,"byAgent":true,"left":null,"state":"signed_out","card":null,"kit":false},
          {"handle":"old","kind":"session","terminal":"t3","face":null,"joinedAt":1003,"addedBy":"you","canAdd":false,"byAgent":false,"left":2000,"state":"exited","card":null,"kit":false},
          {"handle":"new","kind":"session","terminal":"t4","face":null,"joinedAt":1004,"addedBy":"you","canAdd":false,"byAgent":false,"left":null,"state":"hibernating","card":null,"kit":true}],
         "messages":[
          {"seq":1,"from":"you","to":["daemon"],"text":"@daemon 接口改完了吗","at":1700000000000},
          {"seq":2,"from":"daemon","to":["web","you"],"replyTo":1,"text":"改完了 @web @you，见 `api.md`","at":1700000060000,"files":["/Users/x/proj/api.md"]},
          {"seq":3,"from":"daemon","to":[],"text":"记一笔","at":1700000090000,"task":3}],
         "receipts":{"2":{"web":"ended","daemon":"nonsense"},"x":{"web":"sent"},"1":{"daemon":"queued"}},
         "notes":{"text":"接口：/login","at":1700000000000,"by":"daemon"},
         "problems":["这个会话已经结束，恢复之后再拉进来"]}
    """.trimIndent()

    private fun detail() = KitJson.decodeFromString(RoomDetail.serializer(), detailJson)

    @Test
    fun testARoomDecodesWithItsSeatsMessagesReceiptsAndNotes() {
        val d = detail()
        assertEquals("登录", d.room.name)
        assertEquals(6, d.room.rounds)
        assertEquals(listOf("daemon", "web", "new"), d.sessions.map { it.handle })
        val daemon = d.seat("daemon")!!
        assertEquals(SeatState.Busy, daemon.state)
        assertEquals(ProfileColor.Mint, daemon.card?.color)
        assertEquals(16, daemon.face?.cells?.size)
        // Ten colours: one past the end comes round.
        assertEquals(RoomFace.colorsDark[3], daemon.face?.rgb(dark = true))
        assertEquals(RoomFace.colorsLight[3], daemon.face?.rgb(dark = false))
        assertTrue(d.seat("you")!!.isUser)
        assertNull(d.seat("you")!!.state)
        // A state this app does not know is no state, not a failure.
        assertNull(d.seat("new")!!.state)
        assertEquals(mapOf(1 to mapOf("daemon" to RoomReceipt.Queued), 2 to mapOf("web" to RoomReceipt.Ended)), d.receipts)
        assertEquals("daemon", d.notes?.by)
        assertEquals(listOf("/Users/x/proj/api.md"), d.message(2)?.files)
        // A message's task (T3) is read; none when it is about no one task.
        assertEquals(3, d.message(3)?.task)
        assertNull(d.message(2)?.task)
        assertEquals(1, d.problems.size)
        // No Kit: it sits and goes on, without the Kit. Not one that left or ended.
        assertTrue(d.seat("web")!!.noKit)
        assertFalse(d.seat("old")!!.noKit)
        assertFalse(d.seat("daemon")!!.noKit)
    }

    @Test
    fun testTheListDecodesAndCountsWhatIsNotSeen() {
        val list = KitJson.decodeFromString(RoomList.serializer(), """
            {"rooms":[{"id":"a","name":"登录","topic":"t","paused":true,"createdAt":1,"members":3,"faces":[{"handle":"daemon","face":null}],
              "last":{"seq":4,"from":"you","text":"@all 停\n一下","at":5},"unread":2,"forYou":true,"rounds":7},
             {"id":"b","name":"空","topic":"","members":1,"faces":[],"last":null,"unread":1,"forYou":false,"rounds":null}]}
        """.trimIndent())
        assertEquals(3, list.unread)
        assertEquals("You: @all 停 一下", list.rooms[0].lastLine)
        assertEquals("还没有消息", list.rooms[1].lastLine)
        assertEquals(7, list.rooms[0].rounds)
        assertNull(list.rooms[1].rounds)
    }

    @Test
    fun testStateWordsMarksAndWhatAMessageMeets() {
        assertEquals("Working", SeatState.Busy.word(InterfaceLook.Classic))
        assertEquals("Busy", SeatState.Busy.word(InterfaceLook.Pixel))
        assertEquals("Needs You", SeatState.Waiting.word(InterfaceLook.Classic))
        assertEquals("Signed Out", SeatState.SignedOut.word(InterfaceLook.Classic))
        assertEquals(SeatState.Mark.Amber, SeatState.SignedOut.mark)
        assertEquals(SeatState.Mark.Red, SeatState.Blocked.mark)
        assertEquals(SeatState.Mark.Held, SeatState.Offline.mark)
        assertEquals(SeatState.Mark.Spinner, SeatState.Reconnecting.mark)
        assertNull(SeatState.Idle.says)
        assertTrue(SeatState.SignedOut.says!!.contains("重新登录"))
        assertEquals(SeatState.SignedOut, SeatState.of("signed_out"))
    }

    @Test
    fun testReceiptLinesSayWhereAMessageIsAndWhy() {
        val d = detail()
        assertEquals(listOf(RoomReceiptLine("daemon", "…", "Queued", false)), RoomReceiptLine.lines(d.message(1)!!, d))
        // One that can not be given says why: the seat's state.
        assertEquals(listOf(RoomReceiptLine("web", "×", "Signed Out", true)), RoomReceiptLine.lines(d.message(2)!!, d))
        assertEquals(emptyList(), RoomReceiptLine.lines(d.message(3)!!, d))
    }

    @Test
    fun testTimelineRowsRunTogetherUnderOneHead() {
        val utc = ZoneId.of("UTC")
        val day = 86_400_000L
        val ms = listOf(
            RoomMessage(1, "you", text = "a", at = day),
            RoomMessage(2, "you", text = "b", at = day + 60_000),
            RoomMessage(3, "you", text = "c", at = day + 60_000 + RoomRow.gapMs),
            RoomMessage(4, "daemon", text = "d", at = day + 2 * RoomRow.gapMs),
            RoomMessage(5, "daemon", replyTo = 1, text = "e", at = day + 2 * RoomRow.gapMs + 1),
            RoomMessage(6, "daemon", text = "f", at = 2 * day + 5),
        )
        val rows = RoomRow.rows(ms, utc)
        assertEquals(listOf(false, true, false, false, false, false), rows.map { it.continues })
        assertEquals(listOf(true, false, false, false, false, true), rows.map { it.newDay })
        assertEquals(1, rows[4].quoted?.seq)
        assertEquals("改完了 ，见 api.md", RoomRow.quote("改完了 @web，见 `api.md`"))
    }

    @Test
    fun testTimelineRowsByTask() {
        val utc = ZoneId.of("UTC")
        val day = 86_400_000L
        val ms = listOf(
            RoomMessage(1, "you", text = "a", at = day, task = 1),
            RoomMessage(2, "you", text = "b", at = day + 1, task = 1),
            RoomMessage(3, "you", text = "c", at = day + 2, task = 2),
            RoomMessage(4, "you", text = "d", at = day + 3),
            RoomMessage(5, "you", text = "e", at = day + 4, task = 1),
        )
        // A run breaks where the task changes.
        assertEquals(listOf(false, true, false, false, false), RoomRow.rows(ms, utc).map { it.continues })
        // Narrowed to T1: its messages alone, run together.
        val only = RoomRow.rows(ms, utc, task = 1)
        assertEquals(listOf(1, 2, 5), only.map { it.message.seq })
        assertEquals(listOf(false, true, true), only.map { it.continues })
        assertEquals("T3 登录接口", RoomTask.word(3, "登录接口"))
        assertEquals("T3", RoomTask.word(3, ""))
        assertEquals("T1 abcdefghijklmnopqrs…", RoomTask.word(1, "abcdefghijklmnopqrstuvwxyz"))
    }

    @Test
    fun testTextPiecesAndTheNameBeingTyped() {
        val handles = setOf("daemon", "you", "all")
        assertEquals(
            listOf(RoomText.Piece.Mention("daemon"), RoomText.Piece.Text(" 看 "), RoomText.Piece.Code("x@y"), RoomText.Piece.Text("，a@b.com @nobody "), RoomText.Piece.Mention("you")),
            RoomText.pieces("@Daemon 看 `x@y`，a@b.com @nobody @you", handles),
        )
        assertEquals("da", RoomMention.query("看一下 @da"))
        assertEquals("", RoomMention.query("@"))
        assertNull(RoomMention.query("a@b"))
        assertNull(RoomMention.query("@da 好"))
        val seats = detail().seats
        assertEquals(listOf("daemon"), RoomMention.offers("da", seats))
        assertEquals(listOf("daemon", "web", "new", "all"), RoomMention.offers("", seats))
        assertEquals("看一下 @daemon ", RoomMention.complete("看一下 @da", "daemon"))
        assertEquals("好", RoomMention.complete("好", "daemon"))
    }

    @Test
    fun testDeletedMessagesAndFolding() {
        val gone = KitJson.decodeFromString(RoomMessage.serializer(), """{"seq":3,"from":"you","to":[],"text":"","at":1,"deleted":{"at":2,"by":"you"}}""")
        assertTrue(gone.deleted)
        assertFalse(KitJson.decodeFromString(RoomMessage.serializer(), """{"seq":3,"from":"you","text":"x","deleted":null}""").deleted)
        assertFalse(KitJson.decodeFromString(RoomMessage.serializer(), """{"seq":3,"from":"you","text":"x"}""").deleted)
        assertFalse(RoomText.isLong("短"))
        assertFalse(RoomText.isLong(List(12) { "x" }.joinToString("\n")))
        assertTrue(RoomText.isLong(List(13) { "x" }.joinToString("\n")))
        assertTrue(RoomText.isLong("长".repeat(800)))
    }

    fun testRoutesSendOnlyWhatIsNamedAndReadAnOldMacAsNoRooms() = runTest {
        val transport = FakeTransport({ req, _ ->
            when {
                req.method == "GET" && req.path == "/rooms" && req.headers["If-None-Match"] == "\"v1\"" -> ByteArray(0) to HTTPResponse(304, emptyMap())
                req.method == "GET" && req.path == "/rooms" -> """{"rooms":[]}""".toByteArray() to HTTPResponse(200, mapOf("Content-Type" to "application/json", "ETag" to "\"v1\""))
                req.method == "PATCH" && req.path == "/rooms/a" -> """{"room":{"id":"a","name":"n","paused":true}}""".toByteArray() to httpResponse(req.url)
                req.method == "POST" && req.path == "/rooms/a/messages" -> """{"message":{"seq":4,"from":"you","to":["daemon"],"text":"hi","at":1},"receipts":{"daemon":"sent"}}""".toByteArray() to httpResponse(req.url, status = 201)
                req.method == "PUT" && req.path == "/rooms/a/notes" -> """{"notes":null}""".toByteArray() to httpResponse(req.url)
                else -> """{"ok":true}""".toByteArray() to httpResponse(req.url)
            }
        })
        val api = api(transport)
        val first = api.rooms(null)!!
        assertEquals("\"v1\"", first.second)
        assertNull(api.rooms(first.second))
        assertTrue(api.updateRoom("a", paused = true).paused)
        assertEquals("""{"paused":true}""", String(transport.requests.last().body!!))
        val said = api.say("hi", "a", replyTo = 2)
        assertEquals(mapOf("daemon" to RoomReceipt.Sent), said.reach)
        assertEquals("""{"text":"hi","replyTo":2}""", String(transport.requests.last().body!!))
        api.say("on it", "a", files = listOf("/x/a.md"), task = 3)
        assertEquals("""{"text":"on it","files":["/x/a.md"],"task":3}""", String(transport.requests.last().body!!))
        assertNull(api.setRoomNotes("a", ""))
        api.roundsSeen("a")
        assertEquals("/rooms/a/rounds/ok", transport.paths.last())
        api.unseat("daemon", "a")
        assertEquals("DELETE", transport.requests.last().method)
        // 删除消息 (user #278): `tell=1` only when asked for.
        api.deleteRoomMessage("a", 7)
        assertEquals("DELETE", transport.requests.last().method)
        assertEquals("/rooms/a/messages/7", transport.paths.last())
        assertTrue(transport.requests.last().url.contains("tell=1").not())
        api.deleteRoomMessage("a", 7, tell = true)
        assertTrue(transport.requests.last().url.contains("tell=1"))

        val old = api(FakeTransport({ req, _ -> """{"error":"not allowed"}""".toByteArray() to httpResponse(req.url, status = 403) }))
        assertFailsWith<RoomsUnsupported> { old.rooms(null) }
    }

    private val workJson = """
        {"room":{"id":"ab12cd34ef","name":"登录"},
         "seats":[{"handle":"you","kind":"user"},{"handle":"daemon","kind":"session","terminal":"t1","state":"busy"},{"handle":"web","kind":"session","terminal":"t2","state":"idle"}],
         "messages":[],"receipts":{},"notes":null,
         "folder":"/Users/x/.agentswitch/room-files/ab12cd34ef",
         "tasks":[
          {"n":1,"title":"定接口","state":"done","owner":"daemon","by":"you","createdAt":10,"updatedAt":50,"note":"见 api.md"},
          {"n":2,"title":"登录页","detail":"按 api.md","state":"doing","owner":"web","by":"daemon","createdAt":20,"updatedAt":40,"after":[1]},
          {"n":3,"title":"联调","state":"todo","by":"you","createdAt":30,"updatedAt":30,"after":[1,2,9]},
          {"n":4,"title":"上线","state":"later","by":"you","createdAt":31,"updatedAt":31,"after":[3]},
          {"n":5,"title":"写文档","state":"done","by":"web","createdAt":32,"updatedAt":60,"after":[3]}],
         "claims":[
          {"handle":"daemon","paths":["src/api/rooms.ts","src/rooms/","a.ts","b.ts"],"why":"加任务表","at":1000,"until":5000},
          {"handle":"web","paths":["web/login.tsx"],"at":1000,"until":2000}]}
    """.trimIndent()

    @Test
    fun testTheTaskListTheSharedFolderAndWhoIsChangingWhatDecode() {
        val d = KitJson.decodeFromString(RoomDetail.serializer(), workJson)
        assertEquals("/Users/x/.agentswitch/room-files/ab12cd34ef", d.folder)
        assertEquals(listOf(2), d.tasks(RoomTaskState.Doing).map { it.n })
        // A state this app does not know is one still to do.
        assertEquals(listOf(3, 4), d.tasks(RoomTaskState.Todo).map { it.n })
        // The ones done: the last-finished first.
        assertEquals(listOf(5, 1), d.tasks(RoomTaskState.Done).map { it.n })
        val two = d.task(2)!!
        assertEquals("T2", two.label)
        assertEquals("web", two.owner)
        assertEquals("按 api.md", two.detail)
        assertEquals("见 api.md", d.task(1)!!.note)
        assertNull(d.task(3)!!.owner)
        // Waiting only for what is not done; a task taken off the list holds nothing up, and one done waits for nothing.
        assertEquals(emptyList(), d.waitsFor(two))
        assertEquals(listOf(2), d.waitsFor(d.task(3)!!))
        assertEquals(listOf(3), d.waitsFor(d.task(4)!!))
        assertEquals(emptyList(), d.waitsFor(d.task(5)!!))
        val claim = d.claim("daemon", now = 1500)!!
        assertEquals(listOf("rooms.ts", "rooms/", "a.ts", "b.ts"), claim.names)
        assertEquals("rooms.ts, rooms/, a.ts +1", claim.summary())
        assertEquals("加任务表", claim.why)
        assertEquals("login.tsx", d.claim("web", now = 1500)!!.summary())
        // Past its time it is said no more, also before the Mac is asked again.
        assertNull(d.claim("web", now = 2000))
        assertNull(d.claim("you", now = 1500))

        val list = KitJson.decodeFromString(RoomList.serializer(), """{"rooms":[{"id":"a","tasks":{"todo":2,"doing":1,"done":4}},{"id":"b"}]}""")
        assertEquals(RoomTaskCounts(todo = 2, doing = 1, done = 4), list.rooms[0].tasks)
        assertEquals(RoomTaskCounts(), list.rooms[1].tasks)

        val files = KitJson.decodeFromString(RoomFiles.serializer(), """{"folder":"/r/ab","files":[{"path":"out/report.md","size":2150,"modifiedAt":1700000000000},{"path":"a.txt"}],"more":true}""")
        assertEquals("/r/ab/out/report.md", files.whole(files.files[0]))
        assertEquals(2150L, files.files[0].size)
        assertEquals(0L, files.files[1].size)
        assertTrue(files.more)
    }

    @Test
    fun testAMacFromBeforeTheTaskListDecodesWithNoneOfIt() {
        // The room as it was sent before tasks, the folder and the claims: none, not a failure.
        val d = detail()
        assertEquals("", d.folder)
        assertEquals(emptyList(), d.tasks)
        assertEquals(emptyList(), d.claims)
        assertNull(d.claim("daemon"))
        // Sent as null: the same.
        val nulls = KitJson.decodeFromString(RoomDetail.serializer(), """{"room":{"id":"a"},"folder":null,"tasks":null,"claims":null}""")
        assertEquals("", nulls.folder)
        assertEquals(emptyList(), nulls.tasks)
        assertEquals(emptyList(), nulls.claims)
        val files = KitJson.decodeFromString(RoomFiles.serializer(), "{}")
        assertEquals(emptyList(), files.files)
        assertFalse(files.more)
    }

    @Test
    fun testTaskAndFileRoutesSendOnlyWhatIsNamed() = runTest {
        val task = """{"task":{"n":3,"title":"联调","state":"todo","owner":"daemon","by":"you","createdAt":1,"updatedAt":2}}"""
        val transport = FakeTransport({ req, _ ->
            when {
                req.method == "POST" && req.path == "/rooms/a/tasks" -> task.toByteArray() to httpResponse(req.url, status = 201)
                req.method == "PATCH" && req.path == "/rooms/a/tasks/3" -> """{"task":{"n":3,"title":"联调","state":"done","by":"you"}}""".toByteArray() to httpResponse(req.url)
                req.method == "PATCH" && req.path == "/rooms/a/tasks/9" -> """{"error":"There is no task T9 in this room."}""".toByteArray() to httpResponse(req.url, status = 404)
                req.method == "GET" && req.path == "/rooms/a/files" -> """{"folder":"/r/a","files":[{"path":"report.md","size":10,"modifiedAt":5}],"more":false}""".toByteArray() to httpResponse(req.url)
                else -> """{"ok":true}""".toByteArray() to httpResponse(req.url)
            }
        })
        val api = api(transport)
        val made = api.addRoomTask("a", "联调", detail = "", owner = "daemon")
        assertEquals(3, made.n)
        assertEquals("daemon", made.owner)
        assertEquals("POST", transport.requests.last().method)
        assertEquals("""{"title":"联调","owner":"daemon"}""", String(transport.requests.last().body!!))
        api.addRoomTask("a", "联调", detail = "按 api.md", after = listOf(1, 2))
        assertEquals("""{"title":"联调","detail":"按 api.md","after":[1,2]}""", String(transport.requests.last().body!!))

        assertEquals(RoomTaskState.Done, api.setRoomTask("a", 3, state = RoomTaskState.Done).state)
        assertEquals("""{"state":"done"}""", String(transport.requests.last().body!!))
        api.setRoomTask("a", 3, owner = "web")
        assertEquals("""{"owner":"web"}""", String(transport.requests.last().body!!))
        // Nobody's any more: a null the Mac reads, not a field left out.
        api.setRoomTask("a", 3, clearOwner = true)
        assertEquals("""{"owner":null}""", String(transport.requests.last().body!!))
        api.setRoomTask("a", 3, state = RoomTaskState.Todo, title = "t", detail = "d", note = "n")
        assertEquals("""{"state":"todo","title":"t","detail":"d","note":"n"}""", String(transport.requests.last().body!!))
        assertEquals("/rooms/a/tasks/3", transport.paths.last())
        // What the Mac refuses is said in its own words.
        val refused = assertFailsWith<APIError.Http> { api.setRoomTask("a", 9, state = RoomTaskState.Done) }
        assertEquals(404, refused.status)
        assertTrue(refused.message!!.contains("T9"))

        api.deleteRoomTask("a", 3)
        assertEquals("DELETE", transport.requests.last().method)
        assertEquals("/rooms/a/tasks/3", transport.paths.last())

        val files = api.roomFiles("a")
        assertEquals("GET", transport.requests.last().method)
        assertEquals("/rooms/a/files", transport.paths.last())
        assertEquals("/r/a/report.md", files.whole(files.files[0]))
    }

    @Test
    fun testAFileOfTheSharedFolderIsNamedByItsPathUnderIt() {
        val folder = "/Users/x/.agentswitch/room-files/ab12"
        assertEquals("api.md", RoomFilePath.under(folder, "$folder/api.md"))
        assertEquals("screens/登录 页.png", RoomFilePath.under(folder, "$folder/screens/登录 页.png"))
        // The folder as written with its slash is the same folder.
        assertEquals("a.png", RoomFilePath.under("$folder/", "$folder/a.png"))
        // Elsewhere on the Mac, a folder whose name only begins the same, the folder itself: not in it.
        assertNull(RoomFilePath.under(folder, "/Users/x/proj/api.md"))
        assertNull(RoomFilePath.under(folder, "${folder}34/a.png"))
        assertNull(RoomFilePath.under(folder, folder))
        assertNull(RoomFilePath.under(folder, "$folder/"))
        // What the room's route would refuse is not asked of it.
        assertNull(RoomFilePath.under(folder, "$folder/../other/a.png"))
        assertNull(RoomFilePath.under(folder, "$folder/.hidden/a.png"))
        assertNull(RoomFilePath.under(folder, "$folder/a//b.png"))
        // A Mac from before the shared folder.
        assertNull(RoomFilePath.under("", "/a.png"))

        assertEquals("b.PNG", RoomFilePath.name("/a/b.PNG"))
        for (name in listOf("/a/b.PNG", "shot.jpg", "x.jpeg", "a.gif", "p.heic", "w.webp")) assertTrue(RoomFilePath.isPicture(name), name)
        for (name in listOf("/a/api.md", "/a/png", "/a/.png", "a.pdf", "a.svg", "/a.png/notes")) assertFalse(RoomFilePath.isPicture(name), name)
        assertEquals(10, RoomFilePath.maxPerMessage)
    }

    @Test
    fun testAPictureIsPutIntoTheSharedFolderReadFromItAndSentWithAMessage() = runTest {
        val transport = FakeTransport({ req, _ ->
            when {
                req.method == "PUT" && req.path == "/rooms/a/files/content" -> """{"path":"/r/a/photo 1-2.jpg","name":"photo 1-2.jpg","size":3}""".toByteArray() to httpResponse(req.url, status = 201)
                req.method == "GET" && req.path == "/rooms/a/files/content" && req.query == "path=big.bin" -> """{"error":"too-large","size":30000000,"limit":26214400}""".toByteArray() to httpResponse(req.url, status = 413)
                req.method == "GET" && req.path == "/rooms/a/files/content" -> byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 7) to httpResponse(req.url, contentType = "image/jpeg")
                req.method == "POST" && req.path == "/rooms/a/messages" -> """{"message":{"seq":4,"from":"you","to":["daemon"],"text":"@daemon 看图","at":5,"files":["/r/a/photo 1-2.jpg"]},"receipts":{"daemon":"queued"}}""".toByteArray() to httpResponse(req.url, status = 201)
                else -> """{"error":"not found"}""".toByteArray() to httpResponse(req.url, status = 404)
            }
        })
        val api = api(transport)

        val bytes = byteArrayOf(1, 2, 3)
        val put = api.putRoomFile("a", "photo 1&2.jpg", bytes)
        assertEquals(RoomPut(path = "/r/a/photo 1-2.jpg", name = "photo 1-2.jpg", size = 3), put)
        val sent = transport.requests.last()
        assertEquals("PUT", sent.method)
        assertEquals("/rooms/a/files/content", sent.path)
        // The name goes in the query, its `&` and space kept from the query's own.
        assertEquals("name=photo%201%262.jpg", java.net.URI(sent.url).rawQuery)
        assertEquals("application/octet-stream", sent.headers["Content-Type"])
        assertTrue(bytes.contentEquals(sent.body!!))

        val got = api.roomFileContent("a", "screens/登录 页+1.png")
        assertEquals(3, got.size)
        val asked = transport.requests.last()
        assertEquals("GET", asked.method)
        assertEquals("/rooms/a/files/content", asked.path)
        assertEquals("path=screens/登录 页+1.png", java.net.URI(asked.url).query)
        assertTrue(java.net.URI(asked.url).rawQuery.endsWith("%2B1.png"))
        assertNull(asked.body)
        // Too large for a phone: said as the Files routes say it.
        val refused = assertFailsWith<APIError.Http> { api.roomFileContent("a", "big.bin") }
        assertEquals(413, refused.status)
        assertEquals(FileRefusal.TooLarge, FileRefusal.of(refused))

        val said = api.say("@daemon 看图", "a", files = listOf(put.path))
        assertEquals(listOf("/r/a/photo 1-2.jpg"), said.message.files)
        assertEquals(mapOf("daemon" to RoomReceipt.Queued), said.reach)
        assertEquals("""{"text":"@daemon 看图","files":["/r/a/photo 1-2.jpg"]}""", String(transport.requests.last().body!!))
        // With nothing: no `files` at all, as before.
        api.say("好", "a", replyTo = 2)
        assertEquals("""{"text":"好","replyTo":2}""", String(transport.requests.last().body!!))
    }

    // MARK: - the second design (2026-11-24): task drawer, receipts as `2/3 已读`, search, 等你处理, a member's buttons

    @Test
    fun testReadersTaskStatsBlockedAndAMembersNewFieldsDecode() {
        val d = KitJson.decodeFromString(RoomDetail.serializer(), """
            {"room":{"id":"a","readSeq":2},
             "seats":[{"handle":"you","kind":"user"},
              {"handle":"api","kind":"session","terminal":"t1","state":"idle","muted":true,"mutedBy":"you","unread":3,"stats":{"wakes":4,"chars":1200,"posts":9,"calls":12},
               "asks":{"title":"Do you trust this folder?","options":["Yes","No"],"selected":0,"trust":true}},
              {"handle":"ios","kind":"session","terminal":"t2","state":"busy"},
              {"handle":"gone","kind":"session","terminal":"t3","left":5}],
             "messages":[
              {"seq":1,"from":"you","to":["api","ios","gone"],"text":"@api @ios @gone 看下","at":1,"expects":"answer"},
              {"seq":2,"from":"api","to":["you"],"text":"好","at":2,"task":4},
              {"seq":3,"from":"you","to":[],"text":"记一下","at":3}],
             "receipts":{"1":{"ios":"queued"}},
             "reads":{"1":["api","gone"],"2":["ios"]},
             "tasks":[{"n":4,"title":"iOS 表单","state":"blocked","owner":"ios","note":"等字段名"},{"n":5,"title":"文档","state":"todo"},{"n":6,"title":"接口","state":"doing"},{"n":1,"title":"定","state":"done"}],
             "taskStats":{"4":{"wakes":2,"chars":3400,"posts":5,"calls":1},"x":{"wakes":1}}}
        """.trimIndent())
        val api = d.seat("api")!!
        assertTrue(api.muted)
        assertEquals("you", api.mutedBy)
        assertEquals(3, api.unread)
        assertEquals(RoomStats(4, 1200, 9, 12), api.stats)
        assertEquals("唤醒 4 次 · 1.2k 字 · 9 条消息 · 12 次调用", api.stats!!.says)
        assertTrue(api.asks!!.trust)
        assertFalse(d.seat("ios")!!.muted)
        assertEquals("answer", d.message(1)?.expects)

        // The user's own message to others: who of those still seated has read it; one that left is not counted.
        val r = d.readers(d.message(1)!!)!!
        assertEquals(listOf("api"), r.read)
        assertEquals(listOf("ios"), r.unread)
        assertEquals("1/2 已读", r.word)
        assertEquals(listOf("@api 已读", "@ios 未读 · Queued"), r.lines)
        // Not for another's message, nor one written to nobody.
        assertNull(d.readers(d.message(2)!!))
        assertNull(d.readers(d.message(3)!!))
        assertEquals("已读", RoomReaders(listOf("a"), emptyList()).word)

        // Blocked is its own state, with its note; the drawer puts it first, then what is being done, then to do.
        assertEquals(RoomTaskState.Blocked, d.task(4)!!.state)
        assertEquals("卡住", RoomTaskState.Blocked.chinese)
        assertEquals(listOf(4, 6, 5), d.openTasks.map { it.n })
        assertEquals(RoomStats(2, 3400, 5, 1), d.taskStats(4))
        assertNull(d.taskStats(5))

        // A Mac from before: none of it, not a failure.
        val old = detail()
        assertEquals(emptyMap(), old.reads)
        assertNull(old.taskStats(3))
        assertFalse(old.seat("daemon")!!.muted)
        assertNull(old.seat("daemon")!!.stats)
    }

    @Test
    fun testAttentionDecodesAndSaysEachInALine() {
        val items = KitJson.decodeFromString(RoomAttention.serializer(), """
            {"items":[
             {"room":"a","roomName":"登录","kind":"permission","handle":"ios","terminal":"t2","text":"","at":9},
             {"room":"a","roomName":"登录","kind":"blocked","task":4,"handle":null,"text":"iOS 表单：等字段名","at":8},
             {"room":"b","roomName":"迁移","kind":"question","handle":"api","seq":12,"task":3,"text":"用哪个库？\n还是自己写","at":7},
             {"room":"b","roomName":"迁移","kind":"rounds","text":"7","at":6},
             {"room":"b","roomName":"迁移","kind":"trust","handle":"web","terminal":"t9","text":"Trust?","at":5},
             {"room":"b","roomName":"迁移","kind":"asks","handle":"web","text":"Pick a model","at":4},
             {"room":"b","kind":"someday","text":"新的","at":3}]}
        """.trimIndent()).items
        assertEquals("⚠ ios 等你确认权限", items[0].line)
        assertEquals("⚠ T4 卡住：iOS 表单：等字段名", items[1].line)
        assertEquals("api 问你：用哪个库？ 还是自己写", items[2].line)
        assertEquals(12, items[2].seq)
        assertEquals("会话间已聊 7 条，没有你的参与", items[3].line)
        assertEquals("⚠ web 问要不要信任这个文件夹", items[4].line)
        assertEquals("⚠ web 等你选：Pick a model", items[5].line)
        assertEquals("新的", items[6].line)
        assertTrue(items[0].urgent)
        assertFalse(items[2].urgent)

        val list = KitJson.decodeFromString(RoomList.serializer(), """{"rooms":[{"id":"a","attention":2},{"id":"b","attention":3},{"id":"c"}]}""")
        assertEquals(5, list.attention)
        assertEquals(0, list.rooms[2].attention)
    }

    @Test
    fun testQuoteLineKeepsMarkdownAndTheSearchSnippetMarksItsHits() {
        assertEquals("接口改好了， 字段见 **T3/api.md**", RoomRow.quoteLine("接口改好了，\n字段见 **T3/api.md**"))
        val long = "改了 `src/api/rooms.ts` 里的" + "很多".repeat(40)
        val cut = RoomRow.quoteLine(long, most = 12)
        assertEquals("改了 `src/api/`…", cut)
        assertEquals("**粗体没有结**…", RoomRow.quoteLine("**粗体没有结束的一句很长的话**", most = 7))

        val s = RoomSearch.snippet("前面有很多很多很多很多的字，然后是 Login 接口，再后面 login 又出现一次，还有很多很多的字在后面", "login", around = 16)
        assertTrue(s.text.startsWith("…"))
        assertTrue(s.text.endsWith("…"))
        assertEquals(listOf("Login", "login"), s.hits.map { s.text.substring(it.first, it.last + 1) })
        val none = RoomSearch.snippet("短的", "x")
        assertEquals("短的", none.text)
        assertEquals(emptyList(), none.hits)
    }

    @Test
    fun testMessagesSearchAttentionAndMemberRoutes() = runTest {
        val transport = FakeTransport({ req, _ ->
            when {
                req.method == "GET" && req.path == "/rooms/a/messages" -> """{"messages":[{"seq":7,"from":"api","text":"login","at":1,"task":3}],"byTask":{"3":2,"5":1}}""".toByteArray() to httpResponse(req.url)
                req.method == "GET" && req.path == "/rooms/attention" -> """{"items":[{"room":"a","kind":"permission","handle":"ios","at":1}]}""".toByteArray() to httpResponse(req.url)
                req.path == "/rooms/a/seats/ios/resume" -> """{"seat":{"handle":"ios","kind":"session","state":"busy"},"terminal":{"id":"t9"}}""".toByteArray() to httpResponse(req.url, status = 201)
                req.method == "PATCH" && req.path == "/rooms/a/seats/ios" -> """{"seat":{"handle":"ios","kind":"session","muted":true,"mutedBy":"you"}}""".toByteArray() to httpResponse(req.url)
                req.method == "POST" && req.path == "/rooms/a/messages" -> """{"message":{"seq":8,"from":"you","text":"看下","at":1,"task":2}}""".toByteArray() to httpResponse(req.url, status = 201)
                req.method == "DELETE" && req.query?.contains("close") == true -> """{"ok":true,"closed":false,"handingOver":true}""".toByteArray() to httpResponse(req.url)
                else -> """{"ok":true,"closed":false}""".toByteArray() to httpResponse(req.url)
            }
        })
        val api = api(transport)
        val page = api.roomMessages("a", task = 3, since = 2, limit = 200)
        assertEquals("task=3&since=2&limit=200", transport.requests.last().query)
        assertEquals(3, page.messages.single().task)
        assertEquals(mapOf(3 to 2, 5 to 1), page.byTask)
        api.roomMessages("a", q = " 登录 ", task = 3)
        assertEquals("task=3&q=%E7%99%BB%E5%BD%95", transport.requests.last().query)
        api.roomMessages("a", before = 50)
        assertEquals("before=50", transport.requests.last().query)

        assertEquals("ios", api.roomAttention().single().handle)
        assertEquals("/rooms/attention", transport.paths.last())

        assertEquals(SeatState.Busy, api.resumeSeat("ios", "a").state)
        assertEquals("POST", transport.requests.last().method)
        assertTrue(api.setSeatMuted("ios", "a", true).muted)
        assertEquals("""{"muted":true}""", String(transport.requests.last().body!!))
        api.renameSeat("ios", "a", "phone")
        assertEquals("""{"name":"phone"}""", String(transport.requests.last().body!!))

        val ending = api.endSeat("ios", "a")
        assertTrue(ending.handingOver)
        assertEquals("close=end", transport.requests.last().query)
        api.endSeat("ios", "a", now = true)
        assertEquals("close=end&now=1", transport.requests.last().query)
        api.unseat("ios", "a")
        assertNull(transport.requests.last().query)

        api.say("看下", "a", expects = "answer", task = 2)
        assertEquals("""{"text":"看下","expects":"answer","task":2}""", String(transport.requests.last().body!!))
    }

    @Test
    fun testAvatarsTheDeskAndTheLibraryDecode() {
        val d = KitJson.decodeFromString(RoomDetail.serializer(), """
            {"room":{"id":"d","name":"调度台","desk":true,"lastSeq":0,"readSeq":0},
             "seats":[
              {"handle":"you","kind":"user","avatar":null},
              {"handle":"api","kind":"session","face":{"rows":["#.#.#",".###.","##.##",".###.","#.#.#"],"color":2},
               "avatar":{"pixel":{"kind":"grid","id":"p1","palette":["ff0000","00ff00"],"rows":["0.1","..","a"]},"classic":{"kind":"emoji","id":"e1","emoji":"🦊","bg":4}}},
              {"handle":"web","kind":"session","avatar":{"pixel":{"kind":"face","id":"f2","rows":["#####","#...#","#...#","#...#","#####"],"color":7},"classic":null}},
              {"handle":"ios","kind":"session"}]}
        """.trimIndent())
        assertTrue(d.room.desk)
        val api = d.seat("api")!!.avatar!!
        assertTrue(api.pixel!!.isGrid)
        assertNull(api.pixel!!.face)
        // `a` is index 10: past the palette, not drawn; `.` is empty.
        assertEquals(listOf(Triple(0, 0, 0xff0000), Triple(2, 0, 0x00ff00)), api.pixel!!.pixels)
        assertEquals("🦊", api.classic?.emoji)
        assertEquals(4, api.classic?.bg)
        val web = d.seat("web")!!.avatar!!
        assertEquals(RoomFace(listOf("#####", "#...#", "#...#", "#...#", "#####"), 7), web.pixel?.face)
        assertNull(web.classic)
        assertNull(d.seat("ios")!!.avatar)
        assertEquals(10, PixelAvatar.paletteIndex('a'))
        assertEquals(36, PixelAvatar.paletteIndex('A'))
        assertNull(PixelAvatar.paletteIndex('.'))
        assertEquals("AP", RoomAvatar.initials("api"))
        assertEquals("IO", RoomAvatar.initials("io-s"))
        assertEquals("X", RoomAvatar.initials("x"))

        val list = KitJson.decodeFromString(RoomList.serializer(), """{"rooms":[{"id":"d","name":"调度台","desk":true},{"id":"a","name":"登录"}]}""")
        assertEquals(listOf(true, false), list.rooms.map { it.desk })

        val lib = KitJson.decodeFromString(RoomAvatarLibrary.serializer(), """
            {"faces":[{"id":"f1","rows":["#.#.#",".###.","##.##",".###.","#.#.#"],"color":3}],
             "art":[{"id":"p1","palette":["611c17"],"rows":["0..."]}],
             "emoji":[{"id":"e1","emoji":"🦊"}]}
        """.trimIndent())
        assertEquals("f1", lib.faces.single().avatar.id)
        assertEquals(listOf(Triple(0, 0, 0x611c17)), lib.art.single().avatar.pixels)
        assertEquals("🦊", lib.emoji.single().emoji)
    }

    @Test
    fun testAttentionNoticesOnlyWhatIsNew() {
        fun item(kind: String, handle: String? = null, task: Int? = null, seq: Int? = null, text: String = "") = RoomAttentionItem("a", "登录", kind, handle, task = task, seq = seq, text = text)
        val tracker = RoomAttentionTracker()
        val first = listOf(item("permission", "ios"))
        // What is there when the app starts is not news.
        assertTrue(tracker.fresh(first).isEmpty())
        assertTrue(tracker.fresh(first).isEmpty())
        val asked = item("question", "api", seq = 9, text = "字段名？")
        assertEquals(listOf(asked), tracker.fresh(first + asked))
        // Gone and back: new again.
        tracker.fresh(listOf(asked))
        assertEquals(first, tracker.fresh(first + asked))
        assertEquals("等你处理：@ios 等你确认权限", item("permission", "ios").notice)
        assertEquals("等你处理：@api 问你：字段名？", asked.notice)
        assertEquals("等你处理：T4 卡住：等字段名", item("blocked", task = 4, text = "等字段名").notice)
        assertEquals("a:question:api::9", asked.identity)
    }

    @Test
    fun testAvatarRoutesSendOnlyTheLooksGiven() = runTest {
        val transport = FakeTransport({ req, _ ->
            when {
                req.path == "/rooms/avatars" -> """{"faces":[],"art":[],"emoji":[{"id":"e2","emoji":"🐼"}]}""".toByteArray() to httpResponse(req.url)
                else -> """{"avatar":{"pixel":null,"classic":{"kind":"emoji","id":"e2","emoji":"🐼","bg":1}}}""".toByteArray() to httpResponse(req.url)
            }
        })
        val api = api(transport)
        assertEquals("🐼", api.roomAvatars().emoji.single().emoji)
        assertEquals("GET", transport.requests.last().method)
        val got = api.setSeatAvatar("a", "ios", classic = AvatarChoice.Library("e2", bg = 1))
        assertEquals("PUT", transport.requests.last().method)
        assertEquals("/rooms/a/seats/ios/avatar", transport.paths.last())
        assertEquals("""{"classic":{"id":"e2","bg":1}}""", String(transport.requests.last().body!!))
        assertEquals("🐼", got?.classic?.emoji)
        api.setSeatAvatar("a", "ios", pixel = AvatarChoice.Reset, classic = AvatarChoice.Reset)
        assertEquals("""{"pixel":null,"classic":null}""", String(transport.requests.last().body!!))
        api.setSeatAvatar("a", "ios", pixel = AvatarChoice.Library("p7"))
        assertEquals("""{"pixel":{"id":"p7"}}""", String(transport.requests.last().body!!))
        api.setSeatAvatar("a", "ios", pixel = AvatarChoice.Drawn(listOf("#####", "#...#", "#...#", "#...#", "#####"), 3), classic = AvatarChoice.Emoji("🦊"))
        assertEquals("""{"pixel":{"rows":["#####","#...#","#...#","#...#","#####"],"color":3},"classic":{"emoji":"🦊"}}""", String(transport.requests.last().body!!))
    }

    @Test
    fun testSecretsDecodeSayTheirKindAndRoutesReadAndDelete() = runTest {
        val tok = "enc:v1:" + "A".repeat(40)
        val transport = FakeTransport({ req, _ ->
            when (req.method) {
                "GET" -> """{"secrets":[{"id":"s1","name":"GitHub","kind":"site","url":"https://github.com","account":"me","token":"$tok","addedAt":5},
                    {"id":"s2","name":"OpenAI","kind":"api","token":"enc:v1:short","addedAt":6},{"id":"s3","name":"DB","kind":"exec","env":"PGPASSWORD","token":"$tok"}]}""".toByteArray() to httpResponse(req.url)
                else -> """{"ok":true}""".toByteArray() to httpResponse(req.url)
            }
        })
        val api = api(transport)
        val got = api.roomSecrets("a")
        assertEquals("/rooms/a/secrets", transport.paths.last())
        assertEquals(listOf("网站登录", "API Key", "命令用"), got.map { it.kindWord })
        assertEquals("https://github.com · me", got[0].details)
        assertEquals("", got[1].details)
        assertEquals("PGPASSWORD", got[2].details)
        assertEquals(28, got[0].shortToken().length)
        assertTrue(got[0].shortToken().endsWith("…"))
        assertEquals("enc:v1:short", got[1].shortToken())
        api.deleteRoomSecret("a", "s1")
        assertEquals("DELETE", transport.requests.last().method)
        assertEquals("/rooms/a/secrets/s1", transport.paths.last())
        assertEquals(3, KitJson.decodeFromString(RoomDetail.serializer(), """{"room":{"id":"a"},"secrets":3}""").secrets)
        assertEquals(0, detail().secrets)
    }
}

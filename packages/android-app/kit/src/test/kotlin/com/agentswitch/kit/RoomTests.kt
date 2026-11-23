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
          {"seq":3,"from":"daemon","to":[],"text":"记一笔","at":1700000090000}],
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
        assertNull(api.setRoomNotes("a", ""))
        api.roundsSeen("a")
        assertEquals("/rooms/a/rounds/ok", transport.paths.last())
        api.unseat("daemon", "a")
        assertEquals("DELETE", transport.requests.last().method)

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
}

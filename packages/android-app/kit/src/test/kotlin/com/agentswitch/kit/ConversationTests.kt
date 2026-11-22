package com.agentswitch.kit

import com.agentswitch.kit.api.*
import com.agentswitch.kit.assistant.*
import com.agentswitch.kit.support.KitJson
import kotlinx.serialization.json.*
import kotlin.test.*

/**
 * The home screen as a conversation with the assistant (assistant-v0 §1.1): the API calls, and how messages and tasks
 * merge into one timeline — a task under the reply that created it, other tasks on their own.
 */
class ConversationTests {
    private val lan = APIEndpoint(host = "192.168.1.5", port = 4713, kind = EndpointKind.Lan)

    private fun wire(seq: Int, role: String, text: String, kind: String = "reply", tasks: List<String> = emptyList(), ts: Long? = null, clientId: String? = null): Map<String, Any?> =
        mapOf("seq" to seq, "ts" to (ts ?: (seq * 1000L)), "role" to role, "text" to text, "kind" to kind, "taskIds" to tasks, "clientId" to clientId, "replyTo" to null)

    @Test
    fun sendIsOnePostWithTheClientIdAndAPatientTimeout() = kotlinx.coroutines.test.runTest {
        val transport = FakeTransport({ req, _ ->
            json(mapOf("user" to wire(1, "user", "整理下载目录", kind = "message"), "assistant" to wire(2, "assistant", "收到。", kind = "task", tasks = listOf("t1")),
                "task" to mapOf("id" to "t1", "createdAt" to 1, "updatedAt" to 1, "status" to "queued", "task" to "整理下载目录"))) to httpResponse(req.url)
        })
        val api = AgentSwitchAPI(endpoints = FixedEndpoint(lan), transport = transport, token = "tok")
        val reply = api.sendMessage(NewMessage(text = "整理下载目录", clientId = "client-0001"))
        assertEquals(AssistantMessage.Kind.Task, reply.assistant.kind)
        assertEquals("t1", reply.task?.id)
        val req = assertNotNull(transport.requests.firstOrNull())
        assertEquals("/assistant", req.path)
        assertEquals(AgentSwitchAPI.assistantTimeout, req.timeout)
        val body = assertNotNull(req.jsonBody)
        assertEquals("client-0001", body["client_id"]?.jsonPrimitive?.content)
        assertNull(body["attachments"], "no empty lists on the wire")
    }

    @Test
    fun messagesAfterASequenceNumber() = kotlinx.coroutines.test.runTest {
        val transport = FakeTransport({ req, _ -> json(mapOf("messages" to listOf(wire(3, "assistant", "好")))) to httpResponse(req.url) })
        val api = AgentSwitchAPI(endpoints = FixedEndpoint(lan), transport = transport, token = "tok")
        val list = api.assistantMessages(after = 2)
        assertEquals(listOf(3), list.map { it.seq })
        assertEquals("after=2", transport.requests.firstOrNull()?.query)
    }

    @Test
    fun firstLoadAsksForTheNewestMessages() = kotlinx.coroutines.test.runTest {
        val transport = FakeTransport({ req, _ -> json(mapOf("messages" to listOf(wire(9, "user", "x")))) to httpResponse(req.url) })
        val api = AgentSwitchAPI(endpoints = FixedEndpoint(lan), transport = transport, token = "tok")
        api.assistantMessagesLast(last = 60)
        assertEquals("last=60", transport.requests.firstOrNull()?.query)
    }

    @Test
    fun updateCalls() = kotlinx.coroutines.test.runTest {
        val transport = FakeTransport({ req, _ ->
            when (req.method to req.path) {
                "GET" to "/update" -> json(mapOf("running" to "2026-09-25T01:00:00Z", "staged" to "2026-09-25T03:00:00Z",
                    "last" to mapOf("ok" to false, "reverted" to true, "from" to "A", "to" to "B", "at" to 1, "reason" to "did not answer"))) to httpResponse(req.url)
                "POST" to "/update/install" -> json(mapOf("requested" to true, "staged" to "2026-09-25T03:00:00Z")) to httpResponse(req.url, status = 202)
                else -> json(mapOf("error" to "not found")) to httpResponse(req.url, status = 404)
            }
        })
        val api = AgentSwitchAPI(endpoints = FixedEndpoint(lan), transport = transport, token = "tok")
        val update = api.appUpdate()
        assertTrue(update.canInstall)
        assertEquals(true, update.last?.reverted)
        api.installUpdate()
        assertEquals("POST", transport.requests.lastOrNull()?.method)
    }

    private fun message(seq: Int, role: String, text: String, kind: String = "reply", tasks: List<String> = emptyList(), ts: Long? = null,
                        clientId: String? = null, replyTo: Int? = null): AssistantMessage =
        KitJson.decodeFromJsonElement(AssistantMessage.serializer(), buildJsonObject {
            put("seq", seq); put("ts", ts ?: (seq * 1000L)); put("role", role); put("text", text); put("kind", kind)
            put("taskIds", JsonArray(tasks.map { JsonPrimitive(it) }))
            put("clientId", clientId?.let { JsonPrimitive(it) } ?: JsonNull)
            put("replyTo", replyTo?.let { JsonPrimitive(it) } ?: JsonNull)
        })

    private fun task(id: String, at: Long): AgentTask =
        KitJson.decodeFromString(AgentTask.serializer(), """{"id":"$id","createdAt":$at,"updatedAt":$at,"status":"running","task":"x"}""")

    @Test
    fun reportsAreUnpromptedAndLinkTheirTask() {
        val notice = message(7, "assistant", "「整理下载目录」完成了", kind = "notice", tasks = listOf("t1"))
        val progress = message(8, "assistant", "还在进行", kind = "progress", tasks = listOf("t1"))
        val watch = message(9, "assistant", "每 10 分钟告诉你", kind = "watch", tasks = listOf("t1"))
        assertEquals(listOf(AssistantMessage.Kind.Notice, AssistantMessage.Kind.Progress, AssistantMessage.Kind.Watch), listOf(notice.kind, progress.kind, watch.kind))
        assertEquals(listOf(true, true, false), listOf(notice.unprompted, progress.unprompted, watch.unprompted))
        val other = message(6, "user", "另一件事", kind = "message", ts = 3000)
        val items = Conversation.timeline(messages = listOf(other, notice), tasks = listOf(task("t1", at = 1)))
        assertEquals(listOf("task-t1", "m6", "m7"), items.map { it.id }, "a report does not own the task: the task stays where it was made")
        assertEquals(listOf("t1"), items[2].mentions)
    }

    @Test
    fun unknownKindsStillDecode() {
        val m = message(1, "assistant", "x", kind = "brand-new")
        assertEquals(AssistantMessage.Kind.Other, m.kind)
    }

    @Test
    fun timelinePutsTasksUnderTheReplyThatMadeThem() {
        val messages = listOf(
            message(1, "user", "整理下载目录", kind = "message", ts = 1000),
            message(2, "assistant", "收到。", kind = "task", tasks = listOf("t1"), ts = 1100),
            message(3, "user", "刚才那个怎么样了", kind = "message", ts = 5000),
            message(4, "assistant", "还在跑。", kind = "status", tasks = listOf("t1"), ts = 5100),
        )
        val tasks = listOf(task("t1", at = 1050), task("web", at = 3000))
        val items = Conversation.timeline(messages = messages, tasks = tasks)
        assertEquals(listOf("m1", "m2", "task-web", "m3", "m4"), items.map { it.id })
        val reply = items[1] as? Conversation.Item.Assistant ?: fail("${items[1]}")
        assertEquals(2, reply.message.seq)
        assertEquals(listOf("t1"), reply.created.map { it.id }, "the created task hangs under its reply")
        val mentioned = (items[4] as? Conversation.Item.Assistant ?: fail()).created
        assertEquals(emptyList(), mentioned, "a status answer only mentions tasks, it does not own them")
        assertEquals(listOf("t1"), items[4].mentions)
    }

    @Test
    fun aTasksEndRightUnderItsCardIsNotSaidAgain() {
        val m = { seq: Int, role: String, kind: String, tasks: List<String>, ts: Long -> message(seq, role, "m$seq", kind = kind, tasks = tasks, ts = ts) }
        val messages = listOf(
            m(1, "user", "message", emptyList(), 1000), m(2, "assistant", "task", listOf("a"), 1100), m(3, "assistant", "task", listOf("b"), 1200),
            m(4, "assistant", "notice", listOf("a"), 2000),                     // b's card is between: said
            m(5, "assistant", "notice", listOf("b"), 2100),                     // right under b's card, only a's end line between: left out
            m(6, "user", "message", emptyList(), 3000), m(7, "assistant", "reply", emptyList(), 3100),
            m(8, "assistant", "notice", listOf("loose"), 4000),                  // the loose task's card is further up
            m(9, "assistant", "notice", listOf("gone"), 4100),                   // no card on the phone: said
        )
        val items = Conversation.timeline(messages = messages, tasks = listOf(task("a", at = 1050), task("b", at = 1150), task("loose", at = 2500)))
        assertEquals(listOf("m1", "m2", "m3", "m4", "task-loose", "m6", "m7", "m8", "m9"), items.map { it.id })
    }

    @Test
    fun timelineKeepsTheNewestItems() {
        val messages = (1..50).map { message(it, if (it % 2 == 1) "user" else "assistant", "m$it") }
        assertEquals("m41", Conversation.timeline(messages = messages, tasks = emptyList(), limit = 10).map { it.id }.first())
    }

    @Test
    fun theLogHoldsEachMessageOnceInOrderAndOnlyTheNewest() {
        val m = { seq: Int -> message(seq, if (seq % 2 == 1) "user" else "assistant", "m$seq") }
        val log = ConversationLog(listOf(m(3), m(1)), keep = 3)
        val merged = log.merging(listOf(m(2), m(3), m(4)))
        assertEquals(listOf(2, 3, 4), merged.messages.map { it.seq }, "sorted, de-duplicated, the newest three")
        assertEquals(listOf(1, 3), log.messages.map { it.seq }, "merging leaves the original as it was")
        assertEquals(4, merged.lastSeq)
        assertEquals(0, ConversationLog().lastSeq)
    }

    @Test
    fun anEntryIsAMessageWithItsAnswersOrOneLineOnItsOwn() {
        fun m(seq: Int, role: String, kind: String, tasks: List<String> = emptyList(), replyTo: Int? = null) =
            message(seq, role, "m$seq", kind = kind, tasks = tasks, replyTo = replyTo)
        val log = ConversationLog(listOf(
            m(1, "user", kind = "message"), m(2, "assistant", kind = "task", tasks = listOf("a"), replyTo = 1),
            m(3, "assistant", kind = "notice", tasks = listOf("a")),
            m(4, "user", kind = "message"), m(5, "assistant", kind = "status", tasks = listOf("a"), replyTo = 4),
        ))
        val asked = log.entry(log.messages[0])
        assertEquals(ConversationEntry(seq = 1, seqs = listOf(1, 2), exchange = true, createdTaskIds = listOf("a")), asked)
        assertEquals(listOf(1, 2), log.entry(log.messages[1]).seqs, "the answer takes its question along")
        assertEquals(ConversationEntry(seq = 3, seqs = listOf(3), exchange = false, createdTaskIds = emptyList()), log.entry(log.messages[2]),
            "a notice is one line and deletes no task")
        assertEquals(emptyList(), log.entry(log.messages[4]).createdTaskIds, "a status answer only names the task")
        assertEquals(listOf(3, 4, 5), log.removing(listOf(1, 2)).messages.map { it.seq })
        // What the Mac no longer has goes from here too (2026-10-07: a run of install notices it tidied to one; a line
        // deleted on the Mac's own page). The Mac's newest messages are read whole: a held line as new as the oldest
        // of them and not among them is gone; older ones were not read, and stay.
        val there = listOf(m(3, "assistant", kind = "notice", tasks = listOf("a")), m(5, "assistant", kind = "status", tasks = listOf("a"), replyTo = 4))
        assertEquals(listOf(1, 2, 3, 5), log.agreeing(there).messages.map { it.seq })
        assertEquals(log, log.agreeing(log.messages))
        assertEquals(log, log.agreeing(emptyList()), "nothing read is no news")
        // A line the phone has not got yet is not added this way (it comes with the next poll, and is announced then).
        assertEquals(listOf(1, 2, 3, 4, 5), log.agreeing(log.messages + m(6, "assistant", kind = "notice")).messages.map { it.seq })
    }

    @Test
    fun aLostAnswerIsFoundByTheClientIdAndNewRepliesAreSingledOut() {
        val sent = message(5, "user", "整理下载目录", kind = "message", clientId = "client-0001")
        val answer = message(6, "assistant", "收到。", kind = "task", tasks = listOf("t1"))
        val log = ConversationLog().merging(listOf(sent))
        assertTrue(log.contains("client-0001"))
        assertFalse(log.contains("client-0002"))
        assertEquals(listOf(6), log.newAssistantMessages(listOf(sent, answer)).map { it.seq }, "the user's own message is not read back")
        assertEquals(emptyList(), log.merging(listOf(answer)).newAssistantMessages(listOf(answer)))
    }

    @Test
    fun clientIdsAreFreshAndWellFormed() {
        val a = Conversation.newClientId()
        val b = Conversation.newClientId()
        assertNotEquals(a, b)
        assertTrue(Regex("^[A-Za-z0-9_-]{8,64}$").matches(a))
    }

    // Not in the Swift tests: the body of the send and the update model, which Swift reaches through the API.

    @Test
    fun sendBodyCarriesTheClientIdAndNoEmptyLists() {
        val body = KitJson.parseToJsonElement(KitJson.encodeToString(NewMessage.serializer(), NewMessage(text = "整理下载目录", clientId = "client-0001", attachments = emptyList()))).jsonObject
        assertEquals("client-0001", body["client_id"]?.jsonPrimitive?.content)
        assertNull(body["attachments"], "no empty lists on the wire")
        assertNull(body["pin"])
    }

    @Test
    fun updateInfoDecodes() {
        val update = KitJson.decodeFromString(AppUpdateInfo.serializer(),
            """{"running":"2026-09-25T01:00:00Z","staged":"2026-09-25T03:00:00Z","last":{"ok":false,"reverted":true,"from":"A","to":"B","at":1,"reason":"did not answer"}}""")
        assertTrue(update.canInstall)
        assertEquals(true, update.last?.reverted)
    }
}

package com.agentswitch.kit

import com.agentswitch.kit.api.AgentSwitchAPI
import com.agentswitch.kit.api.SSEMessage
import com.agentswitch.kit.api.taskEvent
import com.agentswitch.kit.api.SSEParser
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class SSEParserTests {
    @Test
    fun daemonStreamFixture() {
        val parser = SSEParser()
        val messages = parser.feed(Fixture.data("events.sse"))
        assertEquals(listOf("queued", "dispatched", "text", "approval_request", "done"), messages.map { it.event })
        assertEquals(listOf("1", "2", "3", "4", "5"), messages.map { it.id })
        val events = messages.mapNotNull { AgentSwitchAPI.taskEvent(it, taskId = "t_1") }
        assertEquals(listOf(1L, 2L, 3L, 4L, 5L), events.map { it.seq })
        assertEquals("第一行\n第二行 ✓", events[2].payload["text"]?.string)
        assertTrue(events[4].endsStream)
    }

    @Test
    fun anyChunkingGivesTheSameEvents() {
        val data = Fixture.data("events.sse")
        val expected = SSEParser().feed(data)
        for (size in listOf(1, 2, 3, 7, 64)) {
            val parser = SSEParser()
            val got = mutableListOf<SSEMessage>()
            var i = 0
            while (i < data.size) {
                val end = minOf(i + size, data.size)
                got += parser.feed(data, i, end)
                i = end
            }
            assertEquals(expected, got, "chunk size $size")
        }
    }

    @Test
    fun lineEndingsCommentsMultilineAndBOM() {
        val parser = SSEParser()
        val text = "\uFEFF: hello\r\nevent: a\r\ndata: one\r\ndata:two\r\ndata\r\nretry: 3000\r\n\r\n" + "id: 9\rdata: cr\r\r" + "data: lf\n\n"
        val messages = parser.feed(text.toByteArray(Charsets.UTF_8))
        assertEquals(
            listOf(
                SSEMessage(id = null, event = "a", data = "one\ntwo\n", retry = 3000),
                SSEMessage(id = "9", event = "message", data = "cr", retry = 3000),
                SSEMessage(id = "9", event = "message", data = "lf", retry = 3000),
            ),
            messages,
        )
    }

    @Test
    fun crlfSplitAcrossChunks() {
        val parser = SSEParser()
        assertEquals(emptyList(), parser.feed("data: x\r".toByteArray()))
        assertEquals(listOf(SSEMessage(id = null, event = "message", data = "x")), parser.feed("\n\r\n".toByteArray()))
    }

    @Test
    fun incompleteEventIsNotDispatchedAndEmptyDataIsSkipped() {
        val parser = SSEParser()
        assertEquals(emptyList(), parser.feed("event: only\n\ndata: half".toByteArray()))
        assertNull(parser.lastId)
    }

    @Test
    fun foreignOrBrokenFramesAreSkipped() {
        assertNull(AgentSwitchAPI.taskEvent(SSEMessage(id = "1", event = "text", data = "{bad"), taskId = "t"))
        val other = """{"taskId":"other","seq":1,"ts":1,"type":"text","payload":{}}"""
        assertNull(AgentSwitchAPI.taskEvent(SSEMessage(id = "1", event = "text", data = other), taskId = "t"))
    }
}

package com.agentswitch.kit.api

import java.io.ByteArrayOutputStream

/** One dispatched server-sent event. */
data class SSEMessage(val id: String?, val event: String, val data: String, val retry: Int? = null)

/**
 * Incremental parser for `text/event-stream` (WHATWG HTML §9.2.6): feed arbitrary byte chunks, get whole events.
 * Handles LF, CRLF and CR line ends (including a CRLF split across chunks), comments, multi-line `data`, the leading
 * BOM, and `id`/`retry`. An event cut off by the end of the stream is dropped, as the spec says.
 */
class SSEParser {
    private val line = ByteArrayOutputStream()
    private var afterCR = false
    private var atStart = true
    private val data = StringBuilder()
    private var hasData = false
    private var eventType = ""
    private var lastEventId: String? = null
    private var retry: Int? = null

    fun feed(bytes: ByteArray, from: Int = 0, to: Int = bytes.size): List<SSEMessage> {
        val out = mutableListOf<SSEMessage>()
        for (i in from until to) {
            val byte = bytes[i].toInt() and 0xff
            if (afterCR) {
                afterCR = false
                if (byte == 0x0A) continue
            }
            when (byte) {
                0x0A -> endLine(out)
                0x0D -> { endLine(out); afterCR = true }
                else -> line.write(byte)
            }
        }
        return out
    }

    /** The id of the last event seen (what a reconnect would send as Last-Event-ID). */
    val lastId: String? get() = lastEventId

    private fun endLine(out: MutableList<SSEMessage>) {
        var bytes = line.toByteArray()
        line.reset()
        if (atStart) {
            atStart = false
            if (bytes.size >= 3 && bytes[0] == 0xEF.toByte() && bytes[1] == 0xBB.toByte() && bytes[2] == 0xBF.toByte()) {
                bytes = bytes.copyOfRange(3, bytes.size)
            }
        }
        if (bytes.isEmpty()) { dispatch(out); return }
        val text = String(bytes, Charsets.UTF_8)
        if (text.startsWith(":")) return
        val field: String
        var value: String
        val colon = text.indexOf(':')
        if (colon >= 0) {
            field = text.substring(0, colon)
            value = text.substring(colon + 1)
            if (value.startsWith(" ")) value = value.substring(1)
        } else {
            field = text
            value = ""
        }
        when (field) {
            "data" -> {
                data.append(value).append('\n')
                hasData = true
            }
            "event" -> eventType = value
            "id" -> if (!value.contains('\u0000')) lastEventId = value
            "retry" -> if (value.isNotEmpty() && value.all { it in '0'..'9' }) retry = value.toIntOrNull()
        }
    }

    private fun dispatch(out: MutableList<SSEMessage>) {
        try {
            if (!hasData) return
            if (data.endsWith("\n")) data.setLength(data.length - 1)
            out.add(SSEMessage(id = lastEventId, event = eventType.ifEmpty { "message" }, data = data.toString(), retry = retry))
        } finally {
            data.setLength(0)
            hasData = false
            eventType = ""
        }
    }
}

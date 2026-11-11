package com.agentswitch.kit

import com.agentswitch.kit.api.*
import com.agentswitch.kit.browser.BrowserDecodedFrame
import com.agentswitch.kit.browser.BrowserFrameDecoder
import com.agentswitch.kit.browser.BrowserImageHeader
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.coroutines.EmptyCoroutineContext
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * A tab's frames on their way to the phone's screen (docs/browser-v0.md §1 画面流; 2026-10-02 review): only the newest
 * waits, between the connection and the page and again while one is decoded; decoding is off the main thread.
 */
class BrowserFrameTests {
    private fun frame(seq: Int, jpeg: ByteArray = ByteArray(0)): BrowserEvent = BrowserEvent.Frame(BrowserFrame(seq = seq, jpeg = jpeg, width = 4.0, height = 3.0))

    private fun seqs(events: List<BrowserEvent?>): List<String> = events.map { event ->
        when (event) {
            is BrowserEvent.Frame -> "f${event.frame.seq}"
            is BrowserEvent.Title -> event.title
            null -> "end"
            else -> "other"
        }
    }

    // MARK: the buffer

    @Test
    fun testOnlyTheNewestFrameWaitsAndChangesKeepTheirOrder() = runTest {
        val buffer = BrowserEventBuffer()
        for (n in 1..5) buffer.push(frame(n))
        buffer.push(BrowserEvent.Title("a"))
        buffer.push(frame(6))
        buffer.push(frame(7))
        buffer.push(BrowserEvent.Title("b"))
        assertEquals(3, buffer.count)
        buffer.finish()
        val got = mutableListOf<BrowserEvent?>()
        repeat(4) { got.add(buffer.next()) }
        assertEquals(listOf("a", "f7", "b", "end"), seqs(got))
    }

    @Test
    fun testAtMostTheLimitWaitsTheOldestGoing() = runTest {
        val buffer = BrowserEventBuffer(limit = 3)
        for (t in listOf("a", "b", "c", "d", "e")) buffer.push(BrowserEvent.Title(t))
        buffer.finish()
        val got = mutableListOf<BrowserEvent?>()
        repeat(4) { got.add(buffer.next()) }
        assertEquals(listOf("c", "d", "e", "end"), seqs(got))
    }

    @Test
    fun testAWaitingReaderGetsTheEventAtOnceAndAnErrorComesAfterWhatWaits() = runTest {
        val buffer = BrowserEventBuffer()
        val reader = async { buffer.next() }
        runCurrent()
        buffer.push(frame(1))
        val first = reader.await()
        assertEquals(listOf("f1"), seqs(listOf(first)))
        buffer.push(BrowserEvent.Title("last"))
        buffer.finish(APIError.Http(status = 500, message = "x"))
        buffer.push(BrowserEvent.Title("after the end"))
        val last = buffer.next()
        assertEquals(listOf("last"), seqs(listOf(last)))
        val error = assertFailsWith<APIError>("the error after what was waiting") { buffer.next() }
        assertEquals(APIError.Http(status = 500, message = "x"), error)
        val after = buffer.next()
        assertNull(after, "thrown once")
    }

    /** Kotlin: the cancelled reader gets `CancellationException` where Swift's `next()` returns nil. */
    @Test
    fun testACancelledReaderEndsAndStopsTheConnection() = runTest {
        val buffer = BrowserEventBuffer()
        var stopped = false
        buffer.whenCancelled { stopped = true }
        val reader = async { buffer.next() }
        runCurrent()
        reader.cancel()
        assertFailsWith<CancellationException> { reader.await() }
        runCurrent()
        assertTrue(stopped, "the producer is told")
        buffer.push(frame(1))
        assertEquals(0, buffer.count, "nothing kept once the reader is gone")
        var late = false
        buffer.whenCancelled { late = true }
        assertTrue(late, "told at once")
    }

    // MARK: decoding

    /** A JPEG's header (SOI, JFIF, SOF0 of this size, EOI): all the kit reads of a picture. */
    private fun jpeg(width: Int, height: Int): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        fun u8(v: Int) = out.write(v)
        fun u16(v: Int) { out.write(v shr 8); out.write(v and 0xff) }
        u8(0xFF); u8(0xD8)
        u8(0xFF); u8(0xE0); u16(16); out.write("JFIF".toByteArray()); u8(0); u16(0x0101); u8(0); u16(1); u16(1); u8(0); u8(0)
        u8(0xFF); u8(0xC0); u16(17); u8(8); u16(height); u16(width); u8(3); for (c in 1..3) { u8(c); u8(0x11); u8(0) }
        u8(0xFF); u8(0xD9)
        return out.toByteArray()
    }

    private fun png(width: Int, height: Int): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        fun u32(v: Int) { for (s in listOf(24, 16, 8, 0)) out.write((v shr s) and 0xff) }
        out.write(byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A))
        u32(13); out.write("IHDR".toByteArray()); u32(width); u32(height); out.write(byteArrayOf(8, 2, 0, 0, 0)); u32(0)
        return out.toByteArray()
    }

    /** Swift decodes with ImageIO; here the picture's size is read from its header bytes. */
    @Test
    fun testAFrameDecodesToItsPicture() {
        val decoded = assertNotNullFrame(BrowserDecodedFrame.decode(BrowserFrame(seq = 3, jpeg = jpeg(40, 30), width = 40.0, height = 30.0)))
        assertEquals(40, decoded.width)
        assertEquals(30, decoded.height)
        assertEquals(3, decoded.frame.seq)
        assertEquals(BrowserImageHeader.Format.Jpeg, decoded.header.format)
        val p = assertNotNullFrame(BrowserDecodedFrame.decode(BrowserFrame(seq = 5, jpeg = png(1170, 2532), width = 390.0, height = 844.0)))
        assertEquals(1170, p.width)
        assertEquals(2532, p.height)
        assertEquals(BrowserImageHeader.Format.Png, p.header.format)
        assertNull(BrowserDecodedFrame.decode(BrowserFrame(seq = 4, jpeg = "not a picture".toByteArray(), width = 1.0, height = 1.0)))
        assertNull(BrowserDecodedFrame.decode(BrowserFrame(seq = 6, jpeg = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xD9.toByte()), width = 1.0, height = 1.0)))
    }

    private fun assertNotNullFrame(f: BrowserDecodedFrame?): BrowserDecodedFrame = f ?: error("not decoded")

    @Test
    fun testFramesThatComeWhileOneIsDecodedOnlyTheNewestIsShown() = runTest {
        val data = jpeg(64, 48)
        val decoder = BrowserFrameDecoder(this, EmptyCoroutineContext)
        val shown = mutableListOf<Int>()
        decoder.onFrame = { shown.add(it.frame.seq) }
        for (n in 1..5) decoder.take(BrowserFrame(seq = n, jpeg = data, width = 64.0, height = 48.0))
        advanceUntilIdle()
        assertEquals(listOf(5), shown, "the ones waiting were replaced before the decode began")
        decoder.take(BrowserFrame(seq = 6, jpeg = data, width = 64.0, height = 48.0))
        advanceUntilIdle()
        // A reset drops a decode under way: the frame from before it never shows.
        decoder.take(BrowserFrame(seq = 7, jpeg = data, width = 64.0, height = 48.0))
        decoder.reset()
        decoder.take(BrowserFrame(seq = 8, jpeg = data, width = 64.0, height = 48.0))
        advanceUntilIdle()
        assertEquals(listOf(5, 6, 8), shown)
    }

    // MARK: names

    @Test
    fun testAgentsAreCalledByTheirNames() {
        val codex = BrowserTabOwner(kind = BrowserTabOwner.Kind.Terminal, id = "t9", label = "codex · AgentSwitch")
        assertEquals("Codex", codex.agentName())
        assertEquals("Claude Code", BrowserTabOwner(kind = BrowserTabOwner.Kind.Terminal, id = "t1", label = "claude · site").agentName())
        assertEquals("OpenCode", BrowserTabOwner(kind = BrowserTabOwner.Kind.Terminal, id = "t1", label = "opencode · site").agentName())
        assertEquals("Claude Code", BrowserTabOwner(kind = BrowserTabOwner.Kind.Task, id = "k", label = "登录财务平台").agentName(harness = "claude-code"),
            "the task's own agent")
        assertEquals("登录财务平台", BrowserTabOwner(kind = BrowserTabOwner.Kind.Task, id = "k", label = "登录财务平台").agentName())
    }
}

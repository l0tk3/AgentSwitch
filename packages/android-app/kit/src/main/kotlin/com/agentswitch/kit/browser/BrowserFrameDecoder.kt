package com.agentswitch.kit.browser

import com.agentswitch.kit.api.BrowserFrame
import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.EmptyCoroutineContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * What the kit knows of a picture's header: its format and its size in pixels. Swift learns the size by decoding with
 * ImageIO; there is none on the JVM or Android's kit (and `java.awt` / `javax.imageio` are on neither), so the size is
 * read from the header bytes themselves: a PNG's IHDR, a JPEG's start-of-frame marker.
 */
data class BrowserImageHeader(val format: Format, val width: Int, val height: Int) {
    enum class Format { Jpeg, Png }

    companion object {
        private val pngSignature = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)

        /** Null for bytes that are no picture (or whose header does not say a size). */
        fun read(bytes: ByteArray): BrowserImageHeader? = png(bytes) ?: jpeg(bytes)

        private fun u8(b: ByteArray, i: Int): Int = b[i].toInt() and 0xff
        private fun u16(b: ByteArray, i: Int): Int = (u8(b, i) shl 8) or u8(b, i + 1)
        private fun u32(b: ByteArray, i: Int): Long = (u16(b, i).toLong() shl 16) or u16(b, i + 2).toLong()

        private fun png(b: ByteArray): BrowserImageHeader? {
            if (b.size < 24) return null
            for (i in pngSignature.indices) if (b[i] != pngSignature[i]) return null
            // The first chunk is IHDR: length (13), "IHDR", width, height.
            if (u32(b, 8) != 13L || String(b, 12, 4, Charsets.US_ASCII) != "IHDR") return null
            val w = u32(b, 16)
            val h = u32(b, 20)
            if (w <= 0 || h <= 0 || w > Int.MAX_VALUE || h > Int.MAX_VALUE) return null
            return BrowserImageHeader(Format.Png, w.toInt(), h.toInt())
        }

        private fun jpeg(b: ByteArray): BrowserImageHeader? {
            if (b.size < 4 || u8(b, 0) != 0xFF || u8(b, 1) != 0xD8) return null
            var i = 2
            while (i + 1 < b.size) {
                if (u8(b, i) != 0xFF) return null
                // Fill bytes before a marker.
                while (i + 1 < b.size && u8(b, i + 1) == 0xFF) i++
                if (i + 1 >= b.size) return null
                val marker = u8(b, i + 1)
                i += 2
                // Markers that stand alone, without a length.
                if (marker == 0x01 || marker in 0xD0..0xD9) {
                    if (marker == 0xD9) return null
                    continue
                }
                if (marker == 0xDA) return null // the scan: no frame header came before it
                if (i + 2 > b.size) return null
                val length = u16(b, i)
                if (length < 2) return null
                val sof = marker in 0xC0..0xCF && marker != 0xC4 && marker != 0xC8 && marker != 0xCC
                if (sof) {
                    // length, precision, height, width
                    if (i + 7 > b.size) return null
                    val h = u16(b, i + 3)
                    val w = u16(b, i + 5)
                    if (w == 0 || h == 0) return null
                    return BrowserImageHeader(Format.Jpeg, w, h)
                }
                i += length
            }
            return null
        }
    }
}

/**
 * A tab's frame as the kit hands it over (docs/browser-v0.md §1 画面流): the bytes (JPEG, or PNG) with their header.
 * Swift decodes the picture here (ImageIO, `kCGImageSourceShouldCacheImmediately`) into a `CGImage`; the pixels are
 * the app's to make (Android's `BitmapFactory.decodeByteArray`), off the main thread, from `frame.jpeg`.
 */
class BrowserDecodedFrame(val frame: BrowserFrame, val header: BrowserImageHeader) {
    /** The picture's size in pixels, as its header says (Swift's `image.width`). */
    val width: Int get() = header.width
    val height: Int get() = header.height

    companion object {
        /** Null for bytes that are no picture. */
        fun decode(frame: BrowserFrame): BrowserDecodedFrame? =
            BrowserImageHeader.read(frame.jpeg)?.let { BrowserDecodedFrame(frame, it) }
    }
}

/**
 * Decodes a tab's frames off the main thread, one at a time, keeping only the newest waiting: a frame that comes while
 * one is being decoded replaces the one waiting, so the picture never falls behind the Mac. `reset()` drops what is
 * under way (another visit, another tab).
 *
 * Swift's is `@MainActor`: here [take], [reset] and [onFrame] are used from one thread (the app's main one), where
 * `scope` runs its coroutines (`Dispatchers.Main`); `decode` runs on `decodeContext`. The app passes its own `decode`
 * to make the bitmap; the default reads the header only.
 */
class BrowserFrameDecoder(
    private val scope: CoroutineScope,
    private val decodeContext: CoroutineContext = Dispatchers.Default,
    private val decode: (BrowserFrame) -> BrowserDecodedFrame? = BrowserDecodedFrame::decode,
) {
    /** A frame ready to show, on the scope's thread. */
    var onFrame: (BrowserDecodedFrame) -> Unit = { }
    private var waiting: BrowserFrame? = null
    private var decoding = false
    private var generation = 0

    fun take(frame: BrowserFrame) {
        waiting = frame
        if (decoding) return
        decoding = true
        val started = generation
        scope.launch {
            while (generation == started) {
                val next = waiting ?: break
                waiting = null
                val decoded = withContext(decodeContext) { decode(next) }
                if (generation == started && decoded != null) onFrame(decoded)
            }
            // After `reset()` the flag is the next run's.
            if (generation != started) return@launch
            decoding = false
        }
    }

    fun reset() {
        generation += 1
        waiting = null
        decoding = false
    }
}

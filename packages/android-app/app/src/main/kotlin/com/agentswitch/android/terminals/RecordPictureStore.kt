package com.agentswitch.android.terminals

import android.graphics.Bitmap
import android.util.LruCache
import com.agentswitch.android.platform.ImagePrep
import com.agentswitch.kit.api.APIError
import com.agentswitch.kit.api.AgentSwitchAPI
import com.agentswitch.kit.feed.RecordDisplay
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

// The pictures you sent with a message, in a session's record (docs/simple-view-v0.md §4, §5.1): small under the message,
// one opened whole with the system's viewer.

/** Which session a record's pictures are asked of. */
data class RecordPictureSource(val harness: String, val session: String) {
    fun key(item: String, n: Int): String = "$harness/$session/$item/$n"

    /**
     * The `n`-th picture of `item`: one sent with a message, or — `step` given — one the step of that place in a run
     * of work brought back.
     */
    fun key(item: String, step: Int?, n: Int): String = if (step != null) "$harness/$session/$item/s$step/$n" else key(item, n)
}

/**
 * The pictures read so far, small: a message's pictures never change (an item's id is its place in a file that only
 * grows), so each is asked of the Mac once. One for the app ([com.agentswitch.android.AgentSwitchApp.pictures]); main
 * thread, decoding and files off it.
 *
 * `cacheDir`: the app's cache directory; the whole pictures are written under `record-pictures/` in it.
 * The thumbnails are kept by their size in memory (the iPhone kept 200 by count; a phone's heap is smaller): at most an
 * eighth of the heap, and no more than 48 MB.
 */
class RecordPictureStore(cacheDir: File) {
    private val dir = File(cacheDir, "record-pictures")
    private val small = object : LruCache<String, Bitmap>(memoryBudget()) {
        override fun sizeOf(key: String, value: Bitmap): Int = value.allocationByteCount
    }
    private val missing = HashSet<String>()

    /** What a store without a Mac shows (the iPhone's `DemoData.picture(n)` in a debug build); null in the app. */
    var demo: ((Int) -> ByteArray?)? = null

    fun held(key: String): Bitmap? = small.get(key)

    /** The picture small, read once; null when the Mac has none (an older Mac, an agent read coarsely, a file moved). */
    suspend fun thumbnail(api: AgentSwitchAPI?, source: RecordPictureSource, item: String, step: Int? = null, n: Int): Bitmap? {
        val key = source.key(item, step, n)
        held(key)?.let { return it }
        if (key in missing) return null
        return when (val read = read(api, source, item, step, n)) {
            is Read.Picture -> {
                val image = withContext(Dispatchers.Default) { ImagePrep.decode(read.data, side = THUMBNAIL_SIDE) }
                if (image == null) { missing.add(key); null } else { small.put(key, image); image }
            }
            Read.None -> { missing.add(key); null }
            // Not reaching the Mac is not the picture missing: asked again when the row shows next.
            Read.Unreachable -> null
        }
    }

    /** The picture whole, in a file for the system's viewer (named by what it is). */
    suspend fun file(api: AgentSwitchAPI?, source: RecordPictureSource, item: String, step: Int? = null, n: Int): File? {
        val read = read(api, source, item, step, n) as? Read.Picture ?: return null
        return withContext(Dispatchers.IO) {
            dir.mkdirs()
            val file = File(dir, "Image ${n + 1}.${RecordDisplay.pictureExtension(read.data)}")
            val part = File(dir, file.name + ".part")
            try {
                part.writeBytes(read.data)
                if (!part.renameTo(file)) { file.delete(); if (!part.renameTo(file)) return@withContext null }
                file
            } catch (_: java.io.IOException) {
                part.delete()
                null
            }
        }
    }

    private sealed class Read {
        class Picture(val data: ByteArray) : Read()

        /** The Mac answered: it has no such picture. */
        data object None : Read()
        data object Unreachable : Read()
    }

    private suspend fun read(api: AgentSwitchAPI?, source: RecordPictureSource, item: String, step: Int?, n: Int): Read {
        if (api == null) return demo?.invoke(n)?.let { Read.Picture(it) } ?: Read.None
        return try {
            if (step != null) Read.Picture(api.sessionStepImage(source.harness, source.session, work = item, n = step, k = n))
            else Read.Picture(api.sessionImage(source.harness, source.session, item = item, n = n))
        } catch (e: CancellationException) {
            throw e
        } catch (_: APIError.Http) {
            Read.None
        } catch (_: Exception) {
            Read.Unreachable
        }
    }

    companion object {
        /** A thumbnail's long side, pixels. */
        const val THUMBNAIL_SIDE = 480

        private fun memoryBudget(): Int = minOf(Runtime.getRuntime().maxMemory() / 8, 48L * 1024 * 1024).toInt()

        /** `data` decoded no larger than `side`, upright. */
        fun image(data: ByteArray, side: Int): Bitmap? = ImagePrep.decode(data, side)
    }
}

package com.agentswitch.android.platform

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.webkit.MimeTypeMap
import com.agentswitch.kit.files.UploadFile
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Images are prepared on the phone before they are sent (app-v0 §5): the long side at most [maxPixel], turned upright,
 * re-encoded without the original's metadata (so no location leaves the phone), JPEG — except a PNG, which stays PNG so
 * a screenshot's text stays sharp. Anything else passes as is.
 *
 * The iPhone's is in its Kit (ImageIO); this one is the app's, with Android's [BitmapFactory], [ExifInterface] and
 * [Bitmap.compress]. Decoding and encoding take a moment for a large photo: call it off the main thread where that
 * matters.
 */
object ImagePrep {
    const val maxPixel = 2048
    const val jpegQuality = 0.8

    /** The file to upload, or null when it claims to be an image but cannot be read. */
    fun prepare(file: UploadFile): UploadFile? {
        if (!isImage(file)) return file
        val bounds = bounds(file.data) ?: return null
        val png = bounds.outMimeType == "image/png"
        val image = decode(file.data, side = minOf(max(bounds.outWidth, bounds.outHeight), maxPixel)) ?: return null
        val out = ByteArrayOutputStream()
        val format = if (png) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG
        val ok = image.compress(format, if (png) 100 else (jpegQuality * 100).roundToInt(), out)
        image.recycle()
        if (!ok) return null
        return UploadFile(name = renamed(file.name, if (png) "png" else "jpg"), type = if (png) "image/png" else "image/jpeg", data = out.toByteArray())
    }

    /** A still raster image this can shrink; a GIF (animation) and vector images pass as they are. */
    fun isImage(file: UploadFile): Boolean {
        val ext = extension(file.name).lowercase()
        // The MIME type when it names one (Swift: `UTType(mimeType:) ?? UTType(filenameExtension:)`), else the extension's.
        val given = file.type.trim().lowercase().takeIf { it.contains('/') }
        val type = given ?: MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: return false
        if (!type.startsWith("image/")) return false
        return type != "image/gif" && !type.startsWith("image/svg")
    }

    /**
     * `data` decoded no larger than `side` on its long side, upright (its EXIF orientation applied); null when it is not
     * a picture Android can read. Read at a fraction of its size where that is enough (`inSampleSize`), then scaled to
     * fit exactly, as ImageIO's thumbnail does.
     */
    fun decode(data: ByteArray, side: Int): Bitmap? {
        val bounds = bounds(data) ?: return null
        val long = max(bounds.outWidth, bounds.outHeight)
        var sample = 1
        while (long / (sample * 2) >= side) sample *= 2
        val options = BitmapFactory.Options().apply { inSampleSize = sample }
        var image = BitmapFactory.decodeByteArray(data, 0, data.size, options) ?: return null
        val now = max(image.width, image.height)
        if (now > side && side > 0) {
            val scale = side.toFloat() / now
            val scaled = Bitmap.createScaledBitmap(image, max(1, (image.width * scale).roundToInt()), max(1, (image.height * scale).roundToInt()), true)
            if (scaled !== image) image.recycle()
            image = scaled
        }
        val turn = orientation(data)
        if (turn.isIdentity) return image
        val upright = Bitmap.createBitmap(image, 0, 0, image.width, image.height, turn, true)
        if (upright !== image) image.recycle()
        return upright
    }

    private fun bounds(data: ByteArray): BitmapFactory.Options? {
        val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(data, 0, data.size, options)
        return if (options.outWidth > 0 && options.outHeight > 0) options else null
    }

    /** What turns the picture as its EXIF says it was taken. */
    private fun orientation(data: ByteArray): Matrix {
        val m = Matrix()
        val o = try {
            ExifInterface(ByteArrayInputStream(data)).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
        } catch (_: Exception) {
            ExifInterface.ORIENTATION_NORMAL
        }
        when (o) {
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> m.setScale(-1f, 1f)
            ExifInterface.ORIENTATION_ROTATE_180 -> m.setRotate(180f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> m.setScale(1f, -1f)
            ExifInterface.ORIENTATION_TRANSPOSE -> { m.setRotate(90f); m.postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_ROTATE_90 -> m.setRotate(90f)
            ExifInterface.ORIENTATION_TRANSVERSE -> { m.setRotate(-90f); m.postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_ROTATE_270 -> m.setRotate(-90f)
        }
        return m
    }

    private fun extension(name: String): String {
        val base = name.substringAfterLast('/')
        val dot = base.lastIndexOf('.')
        return if (dot > 0) base.substring(dot + 1) else ""
    }

    private fun renamed(name: String, ext: String): String {
        val dot = name.lastIndexOf('.')
        val stem = if (dot > 0 && name.lastIndexOf('/') < dot) name.substring(0, dot) else name
        return "${stem.ifEmpty { "image" }}.$ext"
    }
}

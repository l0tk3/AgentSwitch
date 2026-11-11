package com.agentswitch.android.onboarding

import com.google.zxing.BarcodeFormat
import com.google.zxing.DecodeHintType
import com.google.zxing.LuminanceSource
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.BinaryBitmap
import com.google.zxing.ReaderException
import com.google.zxing.common.HybridBinarizer

/**
 * Reads a QR code from a camera frame's luminance plane (the Y plane of a YUV_420_888 image), with no Android in it so
 * it runs in a plain unit test.
 *
 * [luma] holds [height] rows of [rowStride] bytes of which the first [width] are pixels (a camera's rows are padded);
 * [rotation] is how many degrees clockwise the frame must turn to be upright (CameraX's `rotationDegrees`). A QR code
 * reads the same turned, but the frame is turned upright anyway so the reader sees what the person sees. When the
 * first try finds nothing the inverted image is tried too (a light code on a dark ground). Returns the text, or null.
 * ZXing's readers keep state, so a call makes its own.
 */
fun decodeQr(luma: ByteArray, width: Int, height: Int, rowStride: Int, rotation: Int): String? {
    if (width <= 0 || height <= 0 || rowStride < width || luma.size < (height - 1) * rowStride + width) return null
    val turned = ((rotation % 360) + 360) % 360
    val source: LuminanceSource = if (turned == 0) {
        PlanarYUVLuminanceSource(luma, rowStride, height, 0, 0, width, height, false)
    } else {
        val (data, w, h) = upright(luma, width, height, rowStride, turned)
        PlanarYUVLuminanceSource(data, w, h, 0, 0, w, h, false)
    }
    val reader = MultiFormatReader().apply {
        setHints(mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE), DecodeHintType.TRY_HARDER to true))
    }
    return try {
        reader.decodeWithState(BinaryBitmap(HybridBinarizer(source))).text
    } catch (_: ReaderException) {
        try {
            reader.reset()
            reader.decodeWithState(BinaryBitmap(HybridBinarizer(source.invert()))).text
        } catch (_: ReaderException) {
            null
        }
    }
}

/** The frame turned clockwise by [degrees] (90, 180 or 270), as tight rows: data, width, height. */
private fun upright(luma: ByteArray, width: Int, height: Int, rowStride: Int, degrees: Int): Triple<ByteArray, Int, Int> {
    val quarter = degrees == 90 || degrees == 270
    val w = if (quarter) height else width
    val h = if (quarter) width else height
    val out = ByteArray(w * h)
    for (y in 0 until height) {
        val row = y * rowStride
        for (x in 0 until width) {
            val (nx, ny) = when (degrees) {
                90 -> (height - 1 - y) to x
                180 -> (width - 1 - x) to (height - 1 - y)
                else -> y to (width - 1 - x)
            }
            out[ny * w + nx] = luma[row + x]
        }
    }
    return Triple(out, w, h)
}

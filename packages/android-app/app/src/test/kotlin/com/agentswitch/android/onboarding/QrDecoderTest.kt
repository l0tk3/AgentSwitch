package com.agentswitch.android.onboarding

import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class QrDecoderTest {
    private val text = "agentswitch://pair?p=eyJob3N0IjoiMTkyLjE2OC4xLjIiLCJwb3J0Ijo4NDQzfQ"

    /** A dark code on a light ground as a camera's luminance rows: padded to [stride], and optionally inverted. */
    private fun frame(content: String, size: Int, stride: Int, invert: Boolean = false): ByteArray {
        val matrix = QRCodeWriter().encode(content, BarcodeFormat.QR_CODE, size, size, mapOf(EncodeHintType.MARGIN to 4))
        val out = ByteArray(stride * size) { 77 }
        for (y in 0 until size) for (x in 0 until size) {
            val dark = matrix.get(x, y) != invert
            out[y * stride + x] = if (dark) 20 else 235.toByte()
        }
        return out
    }

    @Test
    fun readsEachRotationWithPaddedRows() {
        val luma = frame(text, 300, 320)
        for (rotation in listOf(0, 90, 180, 270)) assertEquals(text, decodeQr(luma, 300, 300, 320, rotation), "rotation $rotation")
    }

    @Test
    fun readsANonSquareFrame() {
        // 400 x 300 with the code in the middle of a light ground.
        val code = frame(text, 260, 260)
        val stride = 432
        val luma = ByteArray(stride * 300) { 235.toByte() }
        for (y in 0 until 260) for (x in 0 until 260) luma[(y + 20) * stride + x + 70] = code[y * 260 + x]
        for (rotation in listOf(0, 90, 180, 270)) assertEquals(text, decodeQr(luma, 400, 300, stride, rotation), "rotation $rotation")
    }

    @Test
    fun readsTheInvertedImage() {
        val luma = frame(text, 300, 352, invert = true)
        for (rotation in listOf(0, 90, 180, 270)) assertEquals(text, decodeQr(luma, 300, 300, 352, rotation), "rotation $rotation")
    }

    @Test
    fun aBlankFrameReadsNothing() {
        assertNull(decodeQr(ByteArray(320 * 240) { 128.toByte() }, 300, 240, 320, 0))
        assertNull(decodeQr(ByteArray(0), 0, 0, 0, 0))
    }
}

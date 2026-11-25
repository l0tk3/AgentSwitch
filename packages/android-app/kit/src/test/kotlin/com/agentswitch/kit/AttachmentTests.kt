package com.agentswitch.kit

import com.agentswitch.kit.files.*
import kotlin.test.*

/**
 * The cases of Swift's AttachmentTests about [UploadFile], [Multipart] and the upload route.
 * Left out (types outside these slices): testPhotosShrinkToJPEGWithoutLocation,
 * testScreenshotsStayPNGAndSmallOnesKeepTheirSize, testGIFsAndVectorImagesPassUntouched (ImagePrep), testSpeakableText
 * (Speech).
 */
class AttachmentTests {
    private val lan = com.agentswitch.kit.api.APIEndpoint(host = "192.168.1.5", port = 4713, kind = com.agentswitch.kit.api.EndpointKind.Lan)

    @Test
    fun uploadIsOneMultipartPost() = kotlinx.coroutines.test.runTest {
        val transport = FakeTransport({ req, _ ->
            json(mapOf("files" to listOf(mapOf("id" to "u1", "name" to "a.png", "size" to 2, "type" to "image/png")))) to httpResponse(req.url)
        })
        val api = com.agentswitch.kit.api.AgentSwitchAPI(endpoints = com.agentswitch.kit.api.FixedEndpoint(lan), transport = transport, token = "tok")
        val staged = api.upload(listOf(UploadFile(name = "a.png", type = "image/png", data = byteArrayOf(1, 2))))
        assertEquals(listOf("u1"), staged.map { it.id })

        val upload = assertNotNull(transport.requests.firstOrNull())
        assertEquals("POST", upload.method)
        assertEquals(com.agentswitch.kit.api.AgentSwitchAPI.uploadTimeout, upload.timeout)
        val type = assertNotNull(upload.header("Content-Type"))
        assertTrue(type.startsWith("multipart/form-data; boundary="))
        assertEquals("/uploads", upload.path)
    }

    @Test
    fun uploadIsNeverResent() = kotlinx.coroutines.test.runTest {
        val transport = FakeTransport({ _, _ -> throw com.agentswitch.kit.api.APIError.Transport("timed out") })
        val api = com.agentswitch.kit.api.AgentSwitchAPI(endpoints = com.agentswitch.kit.api.FixedEndpoint(lan), transport = transport, token = "tok")
        assertFails { api.upload(listOf(UploadFile(name = "a", type = "", data = byteArrayOf(1)))) }
        assertEquals(1, transport.requests.size)
    }

    @Test
    fun multipartBody() {
        val body = Multipart.body(
            listOf(
                UploadFile(name = "shot \"1\".png", type = "image/png", data = byteArrayOf(1, 2)),
                UploadFile(name = "a\r\nb.txt", type = "", data = "x".toByteArray()),
            ),
            boundary = "B",
        )
        val text = String(body, Charsets.UTF_8)
        assertTrue(text.startsWith("--B\r\nContent-Disposition: form-data; name=\"files\"; filename=\"shot %221%22.png\"\r\nContent-Type: image/png\r\n\r\n\u0001\u0002\r\n"))
        assertTrue(text.contains("filename=\"ab.txt\"\r\nContent-Type: application/octet-stream\r\n\r\nx\r\n"), "no header injection, a default type")
        assertTrue(text.endsWith("--B--\r\n"))
    }

    @Test
    fun uploadFilesCompareByContent() {
        assertEquals(UploadFile("a", "t", byteArrayOf(1)), UploadFile("a", "t", byteArrayOf(1)))
        assertNotEquals(UploadFile("a", "t", byteArrayOf(1)), UploadFile("a", "t", byteArrayOf(2)))
    }
}

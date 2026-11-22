package com.agentswitch.kit

import com.agentswitch.kit.files.*
import kotlin.test.*

/**
 * The cases of Swift's AttachmentTests about [UploadFile], [Multipart], [TaskFile] and the upload and download routes.
 * Left out (types outside these slices): testPhotosShrinkToJPEGWithoutLocation,
 * testScreenshotsStayPNGAndSmallOnesKeepTheirSize, testGIFsAndVectorImagesPassUntouched (ImagePrep), testSpeakableText
 * (Speech).
 */
class AttachmentTests {
    private val lan = com.agentswitch.kit.api.APIEndpoint(host = "192.168.1.5", port = 4713, kind = com.agentswitch.kit.api.EndpointKind.Lan)

    @Test
    fun uploadIsOneMultipartPostAndCreateCarriesTheIds() = kotlinx.coroutines.test.runTest {
        val transport = FakeTransport({ req, _ ->
            if (req.path == "/uploads") json(mapOf("files" to listOf(mapOf("id" to "u1", "name" to "a.png", "size" to 2, "type" to "image/png")))) to httpResponse(req.url)
            else Fixture.data("task.json") to httpResponse(req.url, status = 201)
        })
        val api = com.agentswitch.kit.api.AgentSwitchAPI(endpoints = com.agentswitch.kit.api.FixedEndpoint(lan), transport = transport, token = "tok")
        val staged = api.upload(listOf(UploadFile(name = "a.png", type = "image/png", data = byteArrayOf(1, 2))))
        assertEquals(listOf("u1"), staged.map { it.id })
        api.createTask(com.agentswitch.kit.api.NewTaskRequest(task = "看图", attachments = staged.map { it.id }))

        val upload = assertNotNull(transport.requests.firstOrNull())
        assertEquals("POST", upload.method)
        assertEquals(com.agentswitch.kit.api.AgentSwitchAPI.uploadTimeout, upload.timeout)
        val type = assertNotNull(upload.header("Content-Type"))
        assertTrue(type.startsWith("multipart/form-data; boundary="))
        val body = assertNotNull(transport.requests.lastOrNull()?.jsonBody)
        assertEquals(listOf("u1"), (body["attachments"] as? kotlinx.serialization.json.JsonArray)?.map { (it as kotlinx.serialization.json.JsonPrimitive).content })
    }

    @Test
    fun uploadIsNeverResent() = kotlinx.coroutines.test.runTest {
        val transport = FakeTransport({ _, _ -> throw com.agentswitch.kit.api.APIError.Transport("timed out") })
        val api = com.agentswitch.kit.api.AgentSwitchAPI(endpoints = com.agentswitch.kit.api.FixedEndpoint(lan), transport = transport, token = "tok")
        assertFails { api.upload(listOf(UploadFile(name = "a", type = "", data = byteArrayOf(1)))) }
        assertEquals(1, transport.requests.size)
    }

    @Test
    fun taskFilesAndDownloadPaths() = kotlinx.coroutines.test.runTest {
        val transport = FakeTransport({ req, _ ->
            if (req.path == "/tasks/t1/files") {
                json(mapOf("root" to "cwd", "files" to listOf(mapOf("path" to "in/a.png", "size" to 2, "mtime" to 1), mapOf("path" to "out/报告 1.pdf", "size" to 9, "mtime" to 2)))) to httpResponse(req.url)
            } else {
                byteArrayOf(7, 8, 9) to httpResponse(req.url, contentType = "application/pdf")
            }
        })
        val api = com.agentswitch.kit.api.AgentSwitchAPI(endpoints = com.agentswitch.kit.api.FixedEndpoint(lan), transport = transport, token = "tok")
        val files = api.taskFiles("t1")
        assertEquals(listOf("in/a.png", "out/报告 1.pdf"), files.map { it.path })
        assertEquals(listOf(false, true), files.map { it.isDeliverable })
        assertEquals("报告 1.pdf", files[1].name)
        val data = api.download(taskId = "t1", path = "out/报告 1.pdf")
        assertContentEquals(byteArrayOf(7, 8, 9), data)
        assertEquals("https://192.168.1.5:4713/tasks/t1/files/out/%E6%8A%A5%E5%91%8A%201.pdf", transport.requests.lastOrNull()?.url)
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
    fun cachePathsStayInsideTheTaskFolder() {
        assertEquals(listOf("t1", "out", "sub", "报告.pdf"), TaskFile.cacheSegments(taskId = "t1", path = "out/sub/报告.pdf"))
        assertEquals(listOf("t1", "etc", "passwd"), TaskFile.cacheSegments(taskId = "t1", path = "../../etc/./passwd"))
        assertEquals(listOf("x", "file"), TaskFile.cacheSegments(taskId = "../x", path = ""))
    }

    @Test
    fun previewableAndSourceOnlyFiles() {
        assertTrue(TaskFile(path = "out/a.pdf", size = 1, isDeliverable = true).opensInPreview)
        assertFalse(TaskFile(path = "out/page.html", size = 1, isDeliverable = true).opensInPreview, "HTML/SVG could load remote resources")
        assertFalse(TaskFile(path = "out/logo.SVG", size = 1, isDeliverable = true).opensInPreview)
    }

    // Not in the Swift tests: the parts of testTaskFilesAndDownloadPaths that need no transport.
    @Test
    fun taskFileListReadsDeliverablesAndNames() {
        val list = com.agentswitch.kit.support.KitJson.decodeFromString(TaskFileList.serializer(),
            """{"root":"cwd","files":[{"path":"in/a.png","size":2,"mtime":1},{"path":"out/报告 1.pdf","size":9,"mtime":2}]}""")
        val files = list.taskFiles
        assertEquals(listOf("in/a.png", "out/报告 1.pdf"), files.map { it.path })
        assertEquals(listOf(false, true), files.map { it.isDeliverable })
        assertEquals("报告 1.pdf", files[1].name)
    }

    @Test
    fun uploadFilesCompareByContent() {
        assertEquals(UploadFile("a", "t", byteArrayOf(1)), UploadFile("a", "t", byteArrayOf(1)))
        assertNotEquals(UploadFile("a", "t", byteArrayOf(1)), UploadFile("a", "t", byteArrayOf(2)))
    }
}

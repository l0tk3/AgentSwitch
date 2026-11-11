package com.agentswitch.kit

import com.agentswitch.kit.files.ByteCountFormatter
import com.agentswitch.kit.files.KeptFiles
import com.agentswitch.kit.files.KeptWords
import com.agentswitch.kit.support.KitJson
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class KeptFilesTests {
    @Test
    fun testTheListAsTheMacGivesIt() {
        val json = """{"tasks":[{"id":"t2","title":"导出报表","createdAt":1762828800000,"known":true,"files":[{"path":"in/a.csv","size":10,"mtime":1},{"path":"out/report.xlsx","size":2048,"mtime":2}]},{"id":"t1","title":"","createdAt":1,"known":false,"files":[{"path":"old.zip","size":5}]}],"bytes":2063,"keptDays":7}"""
        val kept = KitJson.decodeFromString(KeptFiles.serializer(), json)
        assertEquals(3, kept.count)
        assertEquals(7, kept.keptDays)
        assertEquals("3 Files · ${ByteCountFormatter.file(2063)}", kept.summary)
        assertEquals("3 Files · 2 KB", kept.summary)
        // What was handed back first, what was attached after it.
        assertEquals(listOf("out/report.xlsx", "in/a.csv"), kept.tasks[0].files.map { it.path })
        assertEquals(listOf(true, false), kept.tasks[0].files.map { it.isDeliverable })
        assertEquals("导出报表", kept.tasks[0].heading)
        // A task no longer in the list: its id; a kept copy from before has no `out/` in front and is handed back.
        assertEquals("Task t1", kept.tasks[1].heading)
        assertFalse(kept.tasks[1].known)
        assertTrue(kept.tasks[1].files[0].isDeliverable)
        assertTrue(KitJson.decodeFromString(KeptFiles.serializer(), "{}").isEmpty)
    }

    @Test
    fun testWhatARemovalLeft() {
        assertNull(KeptWords.left(0))
        assertEquals("2 个进行中的任务的文件未删除。", KeptWords.left(2))
    }

    @Test
    fun testTheByteCountsAreWrittenAsFoundationWritesThem() {
        // Read off the real `ByteCountFormatter` (`.file`).
        val expected = listOf(0L to "Zero KB", 1L to "1 byte", 999L to "999 bytes", 1000L to "1 KB", 1500L to "2 KB", 999_499L to "999 KB",
            999_500L to "1 MB", 1_240_000L to "1.2 MB", 1_250_000L to "1.3 MB", 12_345_678L to "12.3 MB", 123_456_789L to "123.5 MB",
            999_999_999L to "1 GB", 1_234_567_890L to "1.23 GB", 12_345_678_901L to "12.35 GB", 1_500_000_000_000L to "1.5 TB")
        for ((bytes, text) in expected) assertEquals(text, ByteCountFormatter.file(bytes), "$bytes")
    }
}

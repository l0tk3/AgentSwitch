package com.agentswitch.android.terminals

import android.graphics.Bitmap
import com.agentswitch.android.platform.ImagePrep
import com.agentswitch.kit.files.UploadFile
import java.util.UUID

/** A file chosen for the next task, prepared and waiting in the input bar. */
class PendingAttachment(val file: UploadFile) {
    val id: UUID = UUID.randomUUID()

    /** A small preview for images (120 px on its long side); null for other files. Decoded at once. */
    val thumbnail: Bitmap? = if (file.type.startsWith("image/")) ImagePrep.decode(file.data, side = 120) else null

    companion object {
        const val maxCount = 20
        const val maxFileBytes = 50 * 1024 * 1024
        const val maxTotalBytes = 100 * 1024 * 1024

        /** Why `file` cannot join `current`, or null when it can. */
        fun problem(adding: UploadFile, to: List<PendingAttachment>): String? {
            if (to.size >= maxCount) return "每次最多 $maxCount 个附件"
            if (adding.data.size > maxFileBytes) return "${adding.name} 超过 50 MB"
            val total = to.sumOf { it.file.data.size.toLong() } + adding.data.size
            return if (total > maxTotalBytes) "附件总大小不可超过 100 MB" else null
        }
    }
}

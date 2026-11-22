package com.agentswitch.kit.files

import com.agentswitch.kit.api.AgentSwitchAPI
import com.agentswitch.kit.api.ObjectReader
import com.agentswitch.kit.api.compareScalars
import com.agentswitch.kit.api.lenient
import com.agentswitch.kit.api.lenientBool
import com.agentswitch.kit.api.lenientDouble
import com.agentswitch.kit.api.lenientLong
import com.agentswitch.kit.api.lenientString
import com.agentswitch.kit.api.lenientWhole
import com.agentswitch.kit.api.requireString
import java.math.BigDecimal
import java.math.RoundingMode
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonObject

/**
 * Every task's files kept in the Mac's data folder (`GET /attachments`; docs/dispatch-v0.md “任务的文件”, 2026-11-11,
 * user: dispatch里加一个入口显示所有历史附件…集中查看和清理): what each task handed back and what was attached to it,
 * newest task first, with the room they take and how long they are kept.
 *
 * Swift's `init(tasks:bytes:keptDays:)` with an optional `bytes` is [invoke] here.
 */
@Serializable(with = KeptFilesSerializer::class)
data class KeptFiles(
    val tasks: List<TaskFiles>,
    val bytes: Long,
    val keptDays: Int = 7,
) {
    @Serializable(with = KeptTaskFilesSerializer::class)
    data class TaskFiles(
        val id: String,
        /** The first line of what was asked; empty for a task no longer in the list. */
        val title: String,
        /** Milliseconds since 1970. */
        val createdAt: Long,
        val known: Boolean = true,
        val files: List<TaskFile>,
    ) {
        val heading: String get() = if (title.isEmpty()) "Task $id" else title
        val bytes: Long get() = files.sumOf { it.size }
    }

    val count: Int get() = tasks.sumOf { it.files.size }
    val isEmpty: Boolean get() = count == 0

    /** `12 Files · 3.4 MB`. */
    val summary: String
        get() = "$count ${if (count == 1) "File" else "Files"} · ${ByteCountFormatter.file(bytes)}"

    companion object {
        /** `bytes` null: the sum of the tasks' files. */
        operator fun invoke(tasks: List<TaskFiles>, bytes: Long? = null, keptDays: Int = 7): KeptFiles =
            KeptFiles(tasks, bytes ?: tasks.sumOf { it.bytes }, keptDays)
    }
}

@Serializable
private class KeptEntry(val path: String, val size: Long? = null)

internal object KeptTaskFilesSerializer : ObjectReader<KeptFiles.TaskFiles>("TaskFiles") {
    override fun read(o: JsonObject): KeptFiles.TaskFiles {
        // `in/` is what the user attached; anything else was handed back. Those first, then by path.
        val files = (o.lenient("files", ListSerializer(KeptEntry.serializer())) ?: emptyList())
            .map { TaskFile(path = it.path, size = it.size ?: 0, isDeliverable = !it.path.startsWith("in/")) }
            .sortedWith(Comparator { a, b ->
                val rank = (if (a.isDeliverable) 0 else 1).compareTo(if (b.isDeliverable) 0 else 1)
                if (rank != 0) rank else compareScalars(a.path, b.path)
            })
        return KeptFiles.TaskFiles(
            id = o.requireString("id"),
            title = o.lenientString("title") ?: "",
            createdAt = o.lenientWhole("createdAt") ?: 0,
            known = o.lenientBool("known") ?: false,
            files = files,
        )
    }
}

internal object KeptFilesSerializer : ObjectReader<KeptFiles>("KeptFiles") {
    override fun read(o: JsonObject): KeptFiles {
        val tasks = o.lenient("tasks", ListSerializer(KeptTaskFilesSerializer)) ?: emptyList()
        val days = o.lenientDouble("keptDays") ?: 7.0
        return KeptFiles(tasks, o.lenientLong("bytes"), com.agentswitch.kit.api.roundAway(days).toInt())
    }
}

/** `DELETE /attachments[/:id]` → `{removed, busy}`. */
@Serializable
data class KeptRemoval(val removed: Int, val busy: Int)

/** The page's sentences (the Mac's DispatchKeptWords). */
object KeptWords {
    const val none = "还没有文件。任务交回的文件和你发送的附件会列在这里。"
    fun kept(days: Int): String = "文件保存在 Mac 上 AgentSwitch 的数据文件夹中，$days 天后自动清理。删除文件不会删除任务。"
    fun deleteAll(count: Int): String = "删除全部 $count 个文件？所有任务交回的文件和附件都将从 Mac 上删除，无法恢复。任务本身保留，进行中的任务的文件不会删除。"
    fun deleteTask(heading: String): String = "删除「$heading」的文件？这个任务交回的文件和附件都将从 Mac 上删除，无法恢复。任务本身保留。"
    fun left(busy: Int): String? = if (busy > 0) "$busy 个进行中的任务的文件未删除。" else null
    const val unsupported = "此 Mac 上的 AgentSwitch 版本较旧，不支持集中查看文件。"
}

/** Every task's kept files together. */
suspend fun AgentSwitchAPI.keptFiles(): KeptFiles = get(listOf("attachments"), KeptFiles.serializer())

/** One task's kept files (409 while it is at work), or with null everyone's. */
suspend fun AgentSwitchAPI.deleteKeptFiles(taskId: String?): KeptRemoval =
    perform("DELETE", listOf("attachments") + listOfNotNull(taskId), emptyList(), null, KeptRemoval.serializer())

/**
 * Foundation's `ByteCountFormatter.string(fromByteCount:countStyle: .file)` as macOS and iOS write it (read off the
 * real formatter): decimal units; `Zero KB`, `1 byte`, `999 bytes`; then `KB` whole, `MB` with at most one decimal, `GB`
 * and up with at most two, a trailing zero left off (`1 MB`, `1.2 MB`, `1.23 GB`); halves round up, and a value that
 * rounds to 1000 is written in the next unit.
 */
object ByteCountFormatter {
    private val units = listOf("KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB")

    fun file(bytes: Long): String {
        if (bytes == 0L) return "Zero KB"
        if (bytes == 1L) return "1 byte"
        if (bytes < 1000) return "$bytes bytes"
        var unit = 0
        var divisor = BigDecimal(1000)
        while (true) {
            val digits = if (unit == 0) 0 else if (unit == 1) 1 else 2
            val rounded = BigDecimal(bytes).divide(divisor).setScale(digits, RoundingMode.HALF_UP)
            if (rounded >= BigDecimal(1000) && unit < units.size - 1) {
                unit += 1
                divisor = divisor.multiply(BigDecimal(1000))
                continue
            }
            return rounded.stripTrailingZeros().toPlainString() + " " + units[unit]
        }
    }
}

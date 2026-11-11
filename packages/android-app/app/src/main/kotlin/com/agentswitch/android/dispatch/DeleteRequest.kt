package com.agentswitch.android.dispatch

import com.agentswitch.kit.api.APIError
import com.agentswitch.kit.api.AgentTask
import com.agentswitch.kit.assistant.ConversationEntry

/**
 * What a delete removes — only what the user sees (threads-v0 手动删除; ui-v0 §4: a thread is a "topic"): one entry
 * of the home screen (a message with its answers and the tasks they created, or one line on its own), one task, one
 * topic with all its tasks (from the topic page), or all history. Every delete is confirmed first; the Mac refuses
 * (409) while something in it still runs.
 *
 * Only the type and its words are here. The Swift file also holds the `deleteConfirmation` modifier, which shows the
 * confirmation dialog with [question], [action] (destructive) and [detail], then calls `DispatchStore.delete` and
 * hands the result to the page: that half is the screens'.
 */
sealed class DeleteRequest {
    data class Entry(val entry: ConversationEntry) : DeleteRequest()
    data class Task(val task: AgentTask) : DeleteRequest()
    data class Topic(val topicId: String, val title: String?) : DeleteRequest()
    data object History : DeleteRequest()

    val id: String
        get() = when (this) {
            is Entry -> "entry:${entry.seq}"
            is Task -> "task:${task.id}"
            is Topic -> "topic:$topicId"
            History -> "history"
        }

    /** The dialog's title. */
    val question: String
        get() = when (this) {
            is Entry -> if (entry.exchange) "删除这段对话？" else "删除这条提示？"
            is Task -> "删除此任务？"
            is Topic -> "删除话题「${title ?: "未命名话题"}」？"
            History -> "清空全部记录？"
        }

    /** The destructive button's words. */
    val action: String
        get() = when (this) {
            is Entry -> if (entry.createdTaskIds.isEmpty()) "删除" else "删除对话和任务"
            is Task -> "删除任务"
            is Topic -> "删除话题和其中所有任务"
            History -> "清空记录"
        }

    /** The dialog's message. */
    val detail: String
        get() = when (this) {
            is Entry -> when {
                !entry.exchange -> "此提示将被删除，且无法恢复。"
                entry.createdTaskIds.isEmpty() -> "你的话和助理的回答将被删除，且无法恢复。"
                else -> "你的话、助理的回答，以及由此创建的任务（结果和文件）将一并删除，且无法恢复。"
            }
            is Task -> "任务的结果和文件，以及对话中关于它的内容将一并删除，且无法恢复。"
            is Topic -> "话题中所有任务的结果和文件，以及对话中关于它们的内容将一并删除，且无法恢复。"
            History -> "首页的对话和所有任务（结果、文件）将全部删除，且无法恢复。环境说明、密文、配对和终端不受影响。"
        }

    companion object {
        /** 409 means something in it still runs; say what to do instead of the raw reply. */
        fun message(error: Throwable): String {
            if (error is APIError.Http && error.status == 409) {
                return "有任务正在进行或等你处理，暂无法删除。请取消任务，或等待任务结束后重试。" + (if (error.detail.isEmpty()) "" else "（${error.detail}）")
            }
            return error.message ?: error.javaClass.simpleName
        }
    }
}

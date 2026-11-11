package com.agentswitch.android.dispatch

import com.agentswitch.android.terminals.PendingAttachment
import com.agentswitch.kit.api.TargetRef
import com.agentswitch.kit.assistant.Conversation

/**
 * A message on its way to the assistant (assistant-v0 §1.1): shown as a bubble until the Mac's answer arrives. It keeps
 * its client id, files and pin, so a resend is the same message to the Mac, answered once, never a second task.
 */
data class OutgoingMessage(
    val text: String,
    val attachments: List<PendingAttachment>,
    val pin: TargetRef?,
    val clientId: String = Conversation.newClientId(),
    /** Upload ids once the files are on the Mac; a resend does not upload them again. */
    val staged: List<String>? = null,
    /** Why the last attempt did not get an answer; null while sending. */
    val failure: String? = null,
) {
    val id: String get() = clientId

    fun staging(ids: List<String>): OutgoingMessage = copy(staged = ids)

    fun failing(reason: String?): OutgoingMessage = copy(failure = reason)
}

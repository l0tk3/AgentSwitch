package com.agentswitch.android.dispatch

import androidx.compose.runtime.Composable
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.design.PixelBox
import com.agentswitch.android.design.PixelBoxEffect
import kotlinx.coroutines.launch

/**
 * The one confirmation every delete button goes through (the iPhone's `deleteConfirmation`): the question, what goes
 * with it and cannot come back, and the word that does it. While `request` is set the box is up; `onDismiss` clears
 * it. `onError`: what the Mac said when it refused (a task still runs), or null once it is done; `done` gets what was
 * deleted, after it was.
 */
@Composable
fun DeleteConfirmation(request: DeleteRequest?, onDismiss: () -> Unit, onError: (String?) -> Unit, done: (DeleteRequest) -> Unit = {}) {
    val model = LocalAppModel.current
    PixelBoxEffect(request, onDismiss) { pending ->
        PixelBox(
            head = pending.question, tone = PixelBox.Tone.Red, message = pending.detail,
            actions = listOf(
                PixelBox.Action(pending.action, PixelBox.Action.Role.Destructive) {
                    model.scope.launch {
                        val problem = model.dispatch.delete(pending)
                        if (problem != null) onError(problem) else { onError(null); done(pending) }
                    }
                },
            ),
        )
    }
}

package com.agentswitch.android.components

import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import com.agentswitch.android.design.StatusSquare
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain

/** Dismissable error line: nothing while `message` is null. */
@Composable
fun ErrorText(message: String?, onClose: () -> Unit, modifier: Modifier = Modifier) {
    if (message == null) return
    Row(modifier, verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        StatusSquare(Theme.failed, Modifier.padding(top = 5.dp))
        Text(message, Modifier.weight(1f), color = Theme.ink, style = plain(13))
        Text("×", Modifier.minimumInteractiveComponentSize().clickable(role = Role.Button, onClickLabel = "close", onClick = onClose).padding(horizontal = 6.dp), color = Theme.secondaryInk, style = mono(15))
    }
}

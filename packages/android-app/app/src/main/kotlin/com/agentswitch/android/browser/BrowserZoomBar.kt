package com.agentswitch.android.browser

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.android.terminals.KeyCapBox

/**
 * The zoom row over the browser page's bar (browser-v0 §1 页面缩放, 2026-10-03; user: 然后我发现agentswitch的浏览器页没有放大缩小的
 * 选项，加上 用来调节大小): `−` `100%` `+`, looking as the key bar shown while typing, opened and closed by the bar's zoom
 * key. The percent cap goes back to 100%; a cap at the end of the range is off. While this phone sizes the tab the caps
 * zoom the page; while it only watches, the picture on the phone, and the row says so at its end.
 *
 * `percent`: the percent in force (the page's, or the picture's while only watching); `pictureOnly`: the phone only
 * watches the tab.
 */
@Composable
fun BrowserZoomBar(
    percent: Int, canZoomOut: Boolean, canZoomIn: Boolean, pictureOnly: Boolean,
    onOut: () -> Unit, onReset: () -> Unit, onIn: () -> Unit, modifier: Modifier = Modifier,
) {
    // The caps at their full width (the terminal page's): all three as wide as `100%`, so `+` stays under the finger as
    // the percent goes from two digits to three.
    Row(
        modifier.fillMaxWidth().background(Theme.raised.copy(alpha = 0.5f)).padding(horizontal = Theme.Space.m, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        Cap("−", "缩小", canZoomOut, onOut)
        Cap("$percent%", "恢复 100%", true, onReset, value = "$percent%")
        Cap("+", "放大", canZoomIn, onIn)
        Spacer(Modifier.width(Theme.Space.s))
        if (pictureOnly) Text("仅放大手机上的画面", color = Theme.secondaryInk, style = plain(13), maxLines = 1)
    }
}

/** One cap, as the key bar's; off (dim, not to be pressed) when there is no step that way. */
@Composable
private fun Cap(text: String, label: String, on: Boolean, action: () -> Unit, value: String? = null) {
    KeyCapBox(action, Modifier.semantics { contentDescription = label + (value?.let { " $it" } ?: "") }, enabled = on) {
        Text(text, Modifier.width(34.dp), color = if (on) Theme.ink else Theme.inkDim, style = mono(13), textAlign = TextAlign.Center, maxLines = 1)
    }
}

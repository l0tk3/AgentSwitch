package com.agentswitch.android.demo

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.mono
import com.agentswitch.android.terminal.TerminalDisplayView

/** A terminal's screen fed with made-up output (`--es uiDemoScreen terminalscreen`): colours, boxes, wide characters. */
@Composable
fun TerminalScreenDemo() {
    var said by remember { mutableStateOf("") }
    Column(Modifier.fillMaxSize().background(Color.Black).systemBarsPadding()) {
        Text(said.ifEmpty { "grid ?" }, Modifier.fillMaxWidth().padding(8.dp), color = Theme.secondaryInk, style = mono(12))
        AndroidView(
            factory = { context ->
                TerminalDisplayView(context, 11f).apply {
                    onGrid = { cols, rows -> said = "grid ${cols}x$rows" }
                    onTap = { x, y -> said = "tap ${x.toInt()},${y.toInt()}" }
                    onHold = { x, y -> said = "hold ${x.toInt()},${y.toInt()}" }
                    onWheel = { up, n -> said = "wheel ${if (up) "↑" else "↓"} $n" }
                    onPinchEnded = { said = "font $it" }
                    snapshot(SAMPLE)
                }
            },
            modifier = Modifier.fillMaxSize(),
        )
    }
}

private val ESC = "\u001b"
private val SAMPLE = buildString {
    append("$ESC[1;38;2;255;46;136m✻ Welcome to Claude Code$ESC[0m\r\n\r\n")
    append("╭──────────────────────────────────────────╮\r\n")
    append("│ $ESC[1mBash$ESC[0m  swift test --filter TerminalTests │\r\n")
    append("│ $ESC[2mRun the terminal tests$ESC[0m                   │\r\n")
    append("╰──────────────────────────────────────────╯\r\n")
    append("$ESC[32m●$ESC[0m 改好了：换成应用里已有的红字删除按钮。\r\n")
    append("  $ESC[36m⎿$ESC[0m  $ESC[4msrc/api/terminals.ts$ESC[0m $ESC[32m+14$ESC[0m $ESC[31m-2$ESC[0m\r\n\r\n")
    for (i in 0 until 8) append("$ESC[4${i}m  $ESC[0m")
    append("  ")
    for (i in 0 until 8) append("$ESC[10${i}m  $ESC[0m")
    append("\r\n")
    for (i in 0 until 16) append("$ESC[38;5;${196 + i}m█$ESC[0m")
    append(" $ESC[7m reverse $ESC[0m $ESC[3mitalic$ESC[0m $ESC[9mstruck$ESC[0m\r\n\r\n")
    for (i in 1..40) append("line $i  ████░░░░ ${i * 2}%  ⠋ ⠙ ⠹ 日本語 한국어\r\n")
    append("$ESC[38;2;255;176;0m? for shortcuts$ESC[0m ")
}

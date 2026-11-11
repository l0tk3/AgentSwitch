package com.agentswitch.android.demo

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.key
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import com.agentswitch.android.components.MarkdownView
import com.agentswitch.android.design.ClassicBar
import com.agentswitch.android.design.ClassicSpinner
import com.agentswitch.android.design.ClassicWaitingDot
import com.agentswitch.android.design.PixelBox
import com.agentswitch.android.design.PixelBoxEffect
import com.agentswitch.android.design.PixelBoxHost
import com.agentswitch.android.design.Scanlines
import com.agentswitch.android.design.SectionLabel
import com.agentswitch.android.design.Wordmark
import com.agentswitch.android.design.dithered
import com.agentswitch.android.design.glitch
import com.agentswitch.android.design.runningGlitch
import com.agentswitch.android.design.shimmer
import com.agentswitch.kit.design.symbols
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.agentswitch.android.design.BarBack
import com.agentswitch.android.design.BarWord
import com.agentswitch.android.design.BrailleSpinner
import com.agentswitch.android.design.CharMeter
import com.agentswitch.android.design.FormPage
import com.agentswitch.android.design.FormRow
import com.agentswitch.android.design.FormSection
import com.agentswitch.android.design.LabeledRow
import com.agentswitch.android.design.PixelMarkView
import com.agentswitch.android.design.PixelSprite
import com.agentswitch.android.design.ShadedSpriteView
import com.agentswitch.android.design.SquareButton
import com.agentswitch.android.design.SquareIconButton
import com.agentswitch.android.design.StatusSquare
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.WaitingSquare
import com.agentswitch.android.design.card
import com.agentswitch.android.design.code
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.kit.design.PixelArt
import com.agentswitch.kit.live.ShadedSprite

/** Every shared part on one page, to look at beside the iPhone's (a debug screen: `--es uiDemoScreen design`). */
@Composable
fun DesignGallery(open: String? = null) {
    var confirm by remember { mutableStateOf(open == "confirm") }
    var menuAt by remember { mutableStateOf<Rect?>(null) }
    var menu by remember { mutableStateOf(false) }
    var replays by remember { mutableIntStateOf(0) }
    var glitches by remember { mutableIntStateOf(0) }
    var picked by remember { mutableStateOf("") }
    // `--es uiDemoOpen menu`: opens the menu once its anchor has been placed.
    LaunchedEffect(menuAt) { if (open == "menu" && menuAt != null && !menu) menu = true }
    PixelBoxHost { FormPage("Design", leading = { BarBack({}) }, trailing = { BarWord("New", {}) }) {
        Row(Modifier.padding(bottom = 4.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            SquareButton("Confirm", { confirm = true }, expand = false)
            SquareButton("Menu", { menu = true }, Modifier.onGloballyPositioned { menuAt = it.boundsInRoot() }, expand = false)
        }
        Row(Modifier.padding(vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(18.dp), verticalAlignment = Alignment.CenterVertically) {
            for (state in PixelArt.MarkState.entries) PixelMarkView(state, pixel = 3.dp)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
            for ((_, sprite) in ShadedSprite.all.take(9)) ShadedSpriteView(sprite, cell = 2.0)
        }
        Row(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
            for ((_, sprite) in ShadedSprite.all.drop(9)) ShadedSpriteView(sprite, cell = 2.0)
        }
        Row(Modifier.padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            StatusSquare(Theme.done); WaitingSquare(); StatusSquare(Theme.failed); StatusSquare(Theme.secondaryInk, hollow = true); BrailleSpinner()
            for ((_, rows) in PixelArt.agents) PixelSprite(rows, pixel = 3.dp)
            CharMeter(0.62); Text("62%", color = Theme.secondaryInk, style = mono(11))
        }
        Column(Modifier.padding(top = 16.dp).card().padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Permission · Bash", color = Theme.waiting, style = mono(13))
            Text("swift test --filter TerminalTests", color = Theme.ink, style = code(15))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                SquareButton("Deny", {}, Modifier.weight(1f), destructive = true)
                SquareButton("Allow", {}, Modifier.weight(1f), prominent = true)
            }
        }
        Row(Modifier.padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            SquareIconButton({}, "Add") { Text("+", color = it, style = mono(20)) }
            SquareIconButton({}, "Send", active = false) { Text("↑", color = it, style = mono(18)) }
            Text("改好了：换成应用里已有的红字删除按钮，禁用时变淡。", Modifier.weight(1f), color = Theme.ink, style = plain(16))
        }
        FormSection("Mac") {
            LabeledRow("Name", "Mac mini", first = true)
            LabeledRow("Code", "7K3M-9QZX", monoValue = true)
            FormRow { Text("证书指纹（与 Mac 上显示的一致时再继续）", color = Theme.secondaryInk, style = plain(12)) }
        }
        FormSection("Addresses", footer = "手机与 Mac 需在同一局域网，或登录同一 Tailscale 网络。") {
            LabeledRow("LAN", "192.168.1.5:4713", first = true, monoValue = true)
            LabeledRow("Tailscale", "100.101.102.103:4713", monoValue = true)
        }
        Text("AgentSwitch", Modifier.padding(top = 16.dp).background(Theme.raised).padding(10.dp), color = Theme.ink, style = plain(17))
        SectionLabel("Effects", Modifier.padding(top = 20.dp, bottom = 8.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Row(Modifier.dithered(), horizontalArrangement = Arrangement.spacedBy(8.dp)) { for ((_, rows) in PixelArt.agents) PixelSprite(rows, pixel = 3.dp) }
            Text("dithered", color = Theme.secondaryInk, style = mono(11))
            Box(Modifier.size(width = 70.dp, height = 28.dp).background(Theme.raised)) { Scanlines(Modifier.matchParentSize()) }
            Text("scanlines", color = Theme.secondaryInk, style = mono(11))
        }
        Row(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
            key(replays) { Wordmark(Modifier.clickable { replays++ }, reveal = true) }
            Wordmark(cell = 2.dp)
        }
        Row(Modifier.padding(top = 12.dp)) { ClassicIcons() }
        Text(
            "Tap to glitch  ·  $picked", Modifier.padding(top = 14.dp).glitch(glitches).clickable { glitches++ }.background(Theme.raised).padding(12.dp),
            color = Theme.ink, style = mono(13),
        )
        Text("Thinking about the next step", Modifier.padding(top = 14.dp).shimmer(), color = Theme.secondaryInk, style = plain(15))
        Text("Something running", Modifier.padding(top = 8.dp).runningGlitch(true), color = Theme.busy, style = mono(13))
        SectionLabel("Markdown", Modifier.padding(top = 20.dp, bottom = 8.dp))
        MarkdownView(MarkdownSample)
    }
    PixelBoxEffect(confirm, { confirm = false }) {
        PixelBox(
            head = "Delete Record", tone = PixelBox.Tone.Red, message = "确定要删除这条记录吗？删除后无法恢复。",
            actions = listOf(PixelBox.Action("Delete", PixelBox.Action.Role.Destructive) { picked = "deleted" }),
        )
    }
    PixelBoxEffect(menu, { menu = false }) {
        PixelBox(
            cancel = null, anchor = menuAt,
            actions = listOf("Resume", "Show in Files", "Select").map { label -> PixelBox.Action(label) { picked = label } },
        )
    }
    }
}

private const val MarkdownSample = """# 结果
已完成：**登录** x.com，*斜体*、~~删除线~~、`inline code` 与 [说明](https://example.com)。

- 第一条
  - 嵌套
1. 一
2. 二

> 引用一段话

| 模型 | 结果 |
|---|---|
| sonnet | ok |
| opus | 通过 |

```bash
# build it
swift test --filter TerminalTests && echo "done"
```

```kotlin
fun greet(name: String): String = "Hello, ${'$'}name — a long line that scrolls sideways rather than wrapping on a phone"
```
"""

/** The classic look's icons beside the pixel ones, to compare. */
@Composable
private fun ClassicIcons() {
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
        for (entry in PixelArt.symbols) PixelSprite(entry.rows, pixel = 2.dp)
        ClassicWaitingDot()
        ClassicSpinner()
        ClassicBar(0.62)
    }
}

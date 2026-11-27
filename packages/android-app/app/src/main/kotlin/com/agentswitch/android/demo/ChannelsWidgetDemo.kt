package com.agentswitch.android.demo

import android.widget.FrameLayout
import android.widget.RemoteViews
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.glance.appwidget.GlanceRemoteViews
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.mono
import com.agentswitch.android.widget.ChannelsContent
import com.agentswitch.android.widget.ChannelsDrawing
import com.agentswitch.kit.widget.ChannelsSnapshot
import com.agentswitch.kit.widget.ChannelsSnapshot.Channel

/**
 * The Channels widget as the launcher would draw it (debug builds: `--es uiDemoScreen widget [--es appearance classic]`):
 * the widget's own RemoteViews at a small, a medium and a large size, from sample rooms, on a wallpaper-ish ground. The
 * phone's light or dark picks the colours, as on the home screen. The iPhone's `ChannelsWidgetDemo`.
 */
@Composable
fun ChannelsWidgetDemo(classic: Boolean) {
    val now = remember { System.currentTimeMillis() }
    val snapshot = remember { sample(now) }
    Column(
        Modifier.fillMaxSize().background(if (Theme.base.luminanceIsDark()) Color(0xFF2B3A4A) else Color(0xFF9DB4C8))
            .verticalScroll(rememberScrollState()).windowInsetsPadding(WindowInsets.safeDrawing).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text(if (classic) "Classic" else "Pixel", color = Color.White, style = mono(13))
        Widget(DpSize(160.dp, 160.dp), ChannelsDrawing(snapshot, ChannelsSnapshot.Choice.Recent, emptyList(), classic, now))
        Widget(DpSize(340.dp, 200.dp), ChannelsDrawing(snapshot, ChannelsSnapshot.Choice.Recent, emptyList(), classic, now))
        Widget(DpSize(340.dp, 420.dp), ChannelsDrawing(snapshot, ChannelsSnapshot.Choice.Recent, emptyList(), classic, now))
    }
}

private fun Color.luminanceIsDark(): Boolean = (0.299 * red + 0.587 * green + 0.114 * blue) < 0.5

@OptIn(androidx.glance.appwidget.ExperimentalGlanceRemoteViewsApi::class)
@Composable
private fun Widget(size: DpSize, drawing: ChannelsDrawing) {
    val context = LocalContext.current
    var views by remember { mutableStateOf<RemoteViews?>(null) }
    LaunchedEffect(size, drawing) {
        views = GlanceRemoteViews().compose(context, size) { ChannelsContent(drawing) }.remoteViews
    }
    Box(Modifier.size(size.width, size.height).then(if (drawing.classic) Modifier.clip(RoundedCornerShape(22.dp)) else Modifier)) {
        views?.let { rv -> AndroidView(factory = { c -> FrameLayout(c) }, update = { frame -> frame.removeAllViews(); frame.addView(rv.apply(context, frame)) }) }
    }
}

/** Sample rooms with neutral names (no one's real work). */
private fun sample(now: Long): ChannelsSnapshot = ChannelsSnapshot(listOf(
    Channel(id = "d", name = "调度台", desk = true, unread = 1, forYou = true, from = "dispatch", text = "@you 开了 2 个会话去做登录页", at = now - 60_000),
    Channel(id = "a", name = "接口联调", unread = 2, forYou = true, attention = 2, from = "daemon", text = "@you 两个版本都验过了，等你选一个", at = now - 120_000),
    Channel(id = "b", name = "文档整理", from = "web", text = "过期的段落都标出来了", at = now - 3_600_000),
    Channel(id = "c", name = "demo-app 发布", paused = true, from = "You", text = "先停一下，等我看完迁移脚本", at = now - 7_200_000),
    Channel(id = "e", name = "notes", unread = 3, from = "codex", text = "整理好了本周的笔记，放在 notes/week48.md", at = now - 10_800_000),
    Channel(id = "f", name = "demo-site", from = "claude", text = "首页的图换成了新的截图", at = now - 86_400_000),
    Channel(id = "g", name = "测试机", from = "You", text = "明天再跑一遍", at = now - 2 * 86_400_000),
), savedAt = now)

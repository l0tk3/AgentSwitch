package com.agentswitch.android.demo

import android.content.Context
import android.util.Log
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.code
import com.agentswitch.kit.api.EventDescriber
import com.agentswitch.kit.feed.LinkText
import com.agentswitch.kit.feed.Markdown
import com.agentswitch.kit.feed.RecordDisplay
import com.agentswitch.kit.feed.ShellHighlight
import com.agentswitch.kit.feed.Speech
import com.agentswitch.kit.feed.SecretHint
import com.agentswitch.kit.feed.TerminalTree
import com.agentswitch.kit.feed.Usage
import com.agentswitch.kit.pairing.GateKey
import com.agentswitch.kit.pairing.PairingLink
import com.agentswitch.kit.pairing.PairingPayload
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * The kit on a real Android (a debug screen: `--es uiDemoScreen selfcheck`). Its tests run on the Mac's JVM, which is
 * not the phone's runtime: a regular expression flag or a class the JVM has and Android lacks passes every test there
 * and fails here (2026-11-11: `Pattern.UNICODE_CHARACTER_CLASS` crashed the Markdown parser on the phone). So: every
 * class of the kit is loaded, which runs its initialisers — every pattern compiled when its file loads — and a few of
 * its paths are walked over the sample data. What fails is listed on screen and in the log under `KitSelfCheck`.
 */
object KitSelfCheck {
    fun run(context: Context): List<String> {
        val failures = ArrayList<String>()
        var loaded = 0
        try {
            @Suppress("DEPRECATION")
            val dex = dalvik.system.DexFile(context.packageCodePath)
            val names = dex.entries().toList().filter { it.startsWith("com.agentswitch.kit.") }
            for (name in names) {
                try {
                    Class.forName(name, true, context.classLoader)
                    loaded += 1
                } catch (e: Throwable) {
                    failures.add("load $name: ${(e.cause ?: e).javaClass.simpleName}: ${(e.cause ?: e).message}")
                }
            }
        } catch (e: Throwable) {
            failures.add("listing the classes: $e")
        }
        fun walk(what: String, body: () -> Unit) {
            try { body() } catch (e: Throwable) { failures.add("$what: ${e.javaClass.simpleName}: ${e.message}") }
        }
        walk("pairing link") {
            val payload = PairingPayload(name = "Mac mini", port = 4713, fp = "ab".repeat(32), code = "7K3M-9QZX", lan = listOf("192.168.1.5"),
                tailnet = listOf("mac.tail1234.ts.net", "fd7a:115c:a1e0::1"), bonjour = "AgentSwitch on Mac mini", gate = GateKey("A".repeat(43), "default"))
            check(PairingLink.parse("看这个 " + PairingLink.make(payload) + " 好了").name == "Mac mini")
        }
        walk("markdown") {
            val text = "# 结果\n\n已完成：**登录** x.com，_斜体_、~~删除~~、`code` 与 [说明](https://example.com/a?b=1)。\n\n- 第一条\n  - 嵌套\n1. 一\n\n> 引用\n\n| 模型 | 结果 |\n|---|---|\n| opus | 通过 |\n\n```bash\nswift test && echo \"done\"\n```\n"
            check(Markdown.blocks(text).size >= 6)
            check(Markdown.readableBlocks(text).isNotEmpty())
            check(Markdown.inline("**粗体**，然后 www.example.com 和 enc:v1:AAAA").runs.isNotEmpty())
            check(Markdown.flattened(text).runs.isNotEmpty())
            Markdown.links(text)
        }
        walk("speech, replies, shell") {
            Speech.speakable("已完成 **登录**，见 https://example.com/x 与 enc:v1:AAAAAAAAAAAA。")
            SecretHint.looksSecret("my password is hunter2 sk-ant-abcdefghijklmnop")
            ShellHighlight.runs("FOO=1 git diff --stat 'a b' # 注释")
            LinkText.webAddresses("见 https://example.com/a（说明）。还有 http://localhost:3000/x.")
        }
        walk("sample data") {
            check(DemoData.tasks.isNotEmpty() && DemoData.threads.isNotEmpty() && DemoData.approvals.isNotEmpty())
            check(DemoData.messages.isNotEmpty() && DemoData.sessions.isNotEmpty() && DemoData.quota.isNotEmpty())
            for (events in DemoData.events.values) for (event in events) { EventDescriber.line(event); EventDescriber.tone(event) }
            val list = DemoData.terminalList(null)
            check(TerminalTree.build(list.terminals, DemoData.sessions, DemoData.git).isNotEmpty())
            check(TerminalTree.build(TerminalsListProbe.list(0).terminals, TerminalsListProbe.sessions(0)).isNotEmpty())
            Usage.rows(DemoData.quota)
            for (screen in listOf(null, "simplebusy", "simplecompact", "simplestep", "simpledaybreak")) {
                val record = DemoData.sessionRecord("claude-code", "demo", screen)
                for (item in record.items) RecordDisplay.summary(item)
                RecordDisplay.plan(record.plan)
                RecordDisplay.context(record.usage)
            }
            DemoData.terminalScreen("terminallink")
            DemoData.routeReport
            DemoData.clash
        }
        walk("libsodium on this device") { check(com.agentswitch.android.platform.SodiumSealer.selfCheck()) { "a sealed message did not open to itself" } }
        Log.i("KitSelfCheck", "loaded $loaded classes, ${failures.size} failures")
        for (failure in failures) Log.e("KitSelfCheck", failure)
        return listOf("loaded $loaded classes") + failures
    }
}

@Composable
fun KitSelfCheckScreen() {
    val context = LocalContext.current
    var lines by remember { mutableStateOf(listOf("checking…")) }
    LaunchedEffect(Unit) { lines = withContext(Dispatchers.Default) { KitSelfCheck.run(context.applicationContext) } }
    Column(Modifier.fillMaxSize().background(Theme.base).systemBarsPadding().padding(16.dp).verticalScroll(rememberScrollState())) {
        Text(if (lines.size == 1 && lines[0] != "checking…") "OK" else if (lines[0] == "checking…") "…" else "${lines.size - 1} FAILED", color = if (lines.size == 1) Theme.done else Theme.failed, style = code(16))
        for (line in lines) Text(line, Modifier.padding(top = 6.dp), color = Theme.ink, style = code(11))
    }
}

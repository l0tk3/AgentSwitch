package com.agentswitch.android.dispatch

import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.agentswitch.android.demo.LocalDemoOpenTools
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.code
import com.agentswitch.android.design.lookShape
import com.agentswitch.android.design.plain
import com.agentswitch.android.terminals.FoldGlyph
import com.agentswitch.kit.api.EventDescriber
import com.agentswitch.kit.api.TaskEvent
import com.agentswitch.kit.api.ToolDisplay
import com.agentswitch.kit.feed.MessageDisplay
import com.agentswitch.kit.feed.ProcessFolding

/**
 * A tool call in the process list (2026-09-25, like Claude's own remote view): one line — the tool as a verb and what
 * it works on — that opens to the input field by field and what came back. The result is the `tool_result` event with
 * the same id (Claude, Codex) or the call's own `output` (OpenCode, which reports a call once it finished).
 */
@Composable
fun ToolCallRow(event: TaskEvent, result: TaskEvent?, modifier: Modifier = Modifier, active: Boolean = false) {
    // `--ez uiDemoOpenTools true`: every call (and every fold of calls) open, for looking at the screen.
    val demoOpen = LocalDemoOpenTools.current
    var open by remember { mutableStateOf(demoOpen) }
    val failed = result?.payload?.get("ok")?.bool == false || event.payload["error"]?.string != null
    Column(modifier, verticalArrangement = Arrangement.spacedBy(Theme.Space.s)) {
        Row(
            Modifier.fillMaxWidth()
                .clickable(remember { MutableInteractionSource() }, null, role = Role.Button, onClickLabel = if (open) "收起" else "展开以查看输入和结果") { open = !open },
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            EventTime(event)
            Text(
                MessageDisplay.readable(EventDescriber.line(event)), Modifier.weight(1f),
                color = if (failed) Theme.failed else Theme.secondaryInk, style = plain(13), maxLines = if (open) Int.MAX_VALUE else 2, overflow = TextOverflow.Ellipsis,
            )
            // ▸ / ▾ mean folded / open, as the system uses them (§7.2.6).
            FoldGlyph(open, Modifier.padding(top = 2.dp))
        }
        if (open) ToolCallDetails(event, result, failed, active, Modifier.padding(start = EventRowTimeWidth + 10.dp))
    }
}

@Composable
private fun ToolCallDetails(event: TaskEvent, result: TaskEvent?, failed: Boolean, active: Boolean, modifier: Modifier) {
    val fields = remember(event) {
        val input = ToolDisplay.fields(event.payload["input"])
        if (input.isNotEmpty()) input.map { it.name to it.value }
        else event.payload["command"]?.string?.let { listOf("command" to EventDescriber.unwrapShell(it)) } ?: emptyList()
    }
    val outcome = remember(event, result, active, failed) {
        val error = event.payload["error"]?.string
        val output = result?.payload?.get("output")?.string ?: event.payload["output"]?.string
        when {
            error != null -> Outcome("Error", MessageDisplay.readable(error), false)
            output != null -> Outcome(if (failed) "Result · Failed" else "Result", if (output.isEmpty()) "No Output" else MessageDisplay.readable(output), output.isEmpty())
            else -> Outcome("Result", if (active) "Busy" else "None", true)
        }
    }
    SelectionContainer {
        Column(
            modifier.fillMaxWidth().border(1.dp, Theme.line, lookShape(8.dp)).padding(Theme.Space.m),
            verticalArrangement = Arrangement.spacedBy(Theme.Space.m),
        ) {
            for ((key, value) in fields) FieldView(ToolCallNames.name(key), MessageDisplay.readable(value))
            FieldView(outcome.title, outcome.text, tint = if (failed) Theme.failed else null, faint = outcome.faint)
        }
    }
}

private class Outcome(val title: String, val text: String, val faint: Boolean)

/** One labelled value of an opened call. */
@Composable
private fun FieldView(name: String, value: String, tint: Color? = null, faint: Boolean = false) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(name, color = tint ?: Theme.secondaryInk, style = plain(11, FontWeight.Medium))
        Text(value, Modifier.fillMaxWidth(), color = if (faint) Theme.inkDim else tint ?: Theme.ink, style = code(12))
    }
}

/** Input keys as words; unknown ones stay as the tool named them. Short words in English (docs/ui-v0.md §7.2.7). */
object ToolCallNames {
    fun name(key: String): String = names[key] ?: key

    private val names = mapOf(
        "command" to "Command", "description" to "About", "file_path" to "File", "filePath" to "File", "notebook_path" to "File", "path" to "Path",
        "url" to "URL", "pattern" to "Pattern", "query" to "Query", "element" to "Element", "ref" to "Ref", "text" to "Text", "timeout" to "Timeout",
        "content" to "Content", "old_string" to "Old", "new_string" to "New", "replace_all" to "Replace All", "offset" to "From Line",
        "limit" to "Lines", "glob" to "Files", "output_mode" to "Output", "prompt" to "Prompt", "subagent_type" to "Agent Type",
        "files" to "Files", "key" to "Key", "values" to "Values", "time" to "Time", "filename" to "File", "skill" to "Skill",
    )
}

/** A call with something to show: its input or command (not a refused one, not an old bare count). */
fun toolCallOpens(event: TaskEvent): Boolean =
    event.type == "tool_call" && event.payload["denied"] == null && (event.payload["input"] != null || event.payload["command"]?.string != null)

/**
 * Tool calls in a row, as one line of the process (control-v0 §5): "读取 3 个文件，运行 5 条命令" (正在… while it is the
 * task's latest work), with how many failed; a tap opens the calls one by one, as [ToolCallRow] shows them.
 * `ongoing`: the task still runs and nothing came after these calls.
 */
@Composable
fun ToolGroupRow(calls: List<TaskEvent>, results: Map<String, TaskEvent>, modifier: Modifier = Modifier, active: Boolean = false, ongoing: Boolean = false) {
    val demoOpen = LocalDemoOpenTools.current
    var open by remember { mutableStateOf(demoOpen) }
    val failures = calls.count { call ->
        call.payload["error"]?.string != null || call.payload["id"]?.string?.let { results[it] }?.payload?.get("ok")?.bool == false
    }
    val secondary = Theme.secondaryInk
    val failed = Theme.failed
    val summary: AnnotatedString = remember(calls, ongoing, failures, secondary, failed) {
        buildAnnotatedString {
            withStyle(SpanStyle(color = secondary)) { append(ProcessFolding.summary(calls, ongoing)) }
            if (failures > 0) withStyle(SpanStyle(color = failed)) { append("，$failures 次失败") }
        }
    }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(
            Modifier.fillMaxWidth()
                .clickable(remember { MutableInteractionSource() }, null, role = Role.Button, onClickLabel = if (open) "收起" else "展开以逐条查看") { open = !open },
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            calls.firstOrNull()?.let { EventTime(it) }
            Text(summary, Modifier.weight(1f), style = plain(13))
            FoldGlyph(open, Modifier.padding(top = 2.dp))
        }
        if (open) for (call in calls) ProcessEventRow(call, results, active = active)
    }
}

/** One line of the process: a tool call that opens to its input and result, or any other event. */
@Composable
fun ProcessEventRow(event: TaskEvent, results: Map<String, TaskEvent>, modifier: Modifier = Modifier, active: Boolean = false) {
    if (toolCallOpens(event)) ToolCallRow(event, event.payload["id"]?.string?.let { results[it] }, modifier, active)
    else EventRow(event, modifier)
}

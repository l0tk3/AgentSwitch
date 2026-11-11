package com.agentswitch.kit.feed

import com.agentswitch.kit.api.PlanEntry
import com.agentswitch.kit.api.RecordItem
import com.agentswitch.kit.api.RecordStep
import com.agentswitch.kit.api.RecordUsage
import com.agentswitch.kit.api.TerminalModelOption
import com.agentswitch.kit.api.ToolDisplay
import com.agentswitch.kit.api.TurnProgress
import com.agentswitch.kit.api.cFixed
import com.agentswitch.kit.api.graphemeCount
import com.agentswitch.kit.api.graphemePrefix
import com.agentswitch.kit.api.isHorizontalSpace

/**
 * How the simple view words a session's record (docs/simple-view-v0.md §2, §5): a run of work as one line, each step's
 * label, how full the context is, the mode. Short English words in title case (ui-v0 §7.2.7).
 */
object RecordDisplay {
    /** What a picture is, by its first bytes: the extension the system's viewer opens it by (`png` when unknown). */
    fun pictureExtension(data: ByteArray): String {
        val head = data.take(12).map { it.toInt() and 0xFF }
        fun starts(bytes: List<Int>, at: Int = 0): Boolean = head.size >= at + bytes.size && head.subList(at, at + bytes.size) == bytes
        if (starts(listOf(0xFF, 0xD8, 0xFF))) return "jpg"
        if (starts(listOf(0x47, 0x49, 0x46, 0x38))) return "gif"
        if (starts(listOf(0x52, 0x49, 0x46, 0x46)) && starts(listOf(0x57, 0x45, 0x42, 0x50), at = 8)) return "webp"
        if (starts(listOf(0x66, 0x74, 0x79, 0x70), at = 4)) return "heic"
        return "png"
    }

    /**
     * A run of work on one line: `Worked 1m 12s · Read 1 · Searched 1 · Ran 2 · Edited 1`, the kinds in the order they
     * first came. Thinking and updates of the task list are not counted. `running`: it is the one still going.
     */
    fun summary(item: RecordItem, running: Boolean = false): String {
        val counts = mutableListOf<Pair<String, Int>>()
        for (step in item.steps) {
            val word = counted(step.kind) ?: continue
            val i = counts.indexOfFirst { it.first == word }
            if (i >= 0) counts[i] = word to counts[i].second + 1 else counts.add(word to 1)
        }
        val lead = if (running) "Working" else "Worked"
        val head = if (item.seconds > 0) "$lead ${duration(item.seconds)}" else lead
        return (listOf(head) + counts.map { (word, n) -> "${plural(word, n)} $n" }).joinToString(" · ")
    }

    private fun counted(kind: RecordStep.Kind): String? = when (kind) {
        RecordStep.Kind.Read -> "Read"
        RecordStep.Kind.Search -> "Searched"
        RecordStep.Kind.List -> "Listed"
        RecordStep.Kind.Run -> "Ran"
        RecordStep.Kind.Edit, RecordStep.Kind.Write -> "Edited"
        RecordStep.Kind.Web -> "Web"
        RecordStep.Kind.Agent -> "Agent"
        RecordStep.Kind.Tool -> "Tool"
        RecordStep.Kind.Todo, RecordStep.Kind.Think -> null
    }

    private fun plural(word: String, n: Int): String = if (n > 1 && (word == "Agent" || word == "Tool")) word + "s" else word

    private fun two(n: Int): String = n.toString().padStart(2, '0')

    /** `8s`, `1m 12s`, `1h 03m`. */
    fun duration(seconds: Int): String {
        val s = maxOf(0, seconds)
        if (s < 60) return "${s}s"
        if (s < 3600) return "${s / 60}m ${two(s % 60)}s"
        return "${s / 3600}h ${two(s % 3600 / 60)}m"
    }

    /** The turn's tokens as its line says them: `↓ 250 tokens`, `↓ 1.3k tokens`, `↑ 12k tokens`. Null for none. */
    fun turnTokens(progress: TurnProgress?): String? {
        if (progress == null || progress.tokens <= 0) return null
        val n = progress.tokens
        val count: String = if (n < 1000) {
            "$n"
        } else if (n < 100_000) {
            val k = roundAway(n.toDouble() / 100) / 10
            if (k == roundAway(k)) "${k.toInt()}k" else "${k.cFixed(1)}k"
        } else if (n < 1_000_000) {
            "${roundAway(n.toDouble() / 1000).toInt()}k"
        } else {
            val m = roundAway(n.toDouble() / 100_000) / 10
            if (m == roundAway(m)) "${m.toInt()}M" else "${m.cFixed(1)}M"
        }
        return "${if (progress.way == "up") "↑" else "↓"} $count ${if (n == 1) "token" else "tokens"}"
    }

    /** Swift's `rounded()`: halves away from zero. */
    private fun roundAway(x: Double): Double = if (x < 0) -Math.floor(-x + 0.5) else Math.floor(x + 0.5)

    /** A clock for what is going on now: `0:41`, `12:05`, `1:02:25`. */
    fun clock(seconds: Int): String {
        val s = maxOf(0, seconds)
        return if (s < 3600) "${s / 60}:${two(s % 60)}" else "${s / 3600}:${two(s % 3600 / 60)}:${two(s % 60)}"
    }

    /** Lines in and out over a run's steps (Swift's `(added:, removed:)`). */
    data class Stat(val added: Int, val removed: Int)

    /** Lines in and out over a run's steps; null when it changed no file. */
    fun stat(steps: List<RecordStep>): Stat? {
        val added = steps.sumOf { it.added ?: 0 }
        val removed = steps.sumOf { it.removed ?: 0 }
        return if (steps.any { it.added != null || it.removed != null }) Stat(added, removed) else null
    }

    /** What a step is, before what it worked on: `Read`, `Run`, or the tool's own name. */
    fun label(step: RecordStep): String = when (step.kind) {
        RecordStep.Kind.Read -> "Read"
        RecordStep.Kind.Search -> "Search"
        RecordStep.Kind.List -> "List"
        RecordStep.Kind.Run -> "Run"
        RecordStep.Kind.Edit -> "Edit"
        RecordStep.Kind.Write -> "Write"
        RecordStep.Kind.Web -> "Web"
        RecordStep.Kind.Agent -> "Agent"
        RecordStep.Kind.Todo -> "Tasks"
        RecordStep.Kind.Think -> "Thought"
        RecordStep.Kind.Tool -> step.tool?.let { it.ifEmpty { "Tool" } } ?: "Tool"
    }

    /**
     * A kind of step as a small picture before its line, in the classic look (the pixel look says it in its word): one
     * picture, one kind (2026-10-07, user, of Codex's own app: 这种小图标…能不能加上). The system's symbol names.
     */
    fun symbol(kind: RecordStep.Kind): String = when (kind) {
        RecordStep.Kind.Read -> "doc.text"
        RecordStep.Kind.Search -> "magnifyingglass"
        RecordStep.Kind.List -> "folder"
        RecordStep.Kind.Run -> "terminal"
        RecordStep.Kind.Edit -> "pencil"
        RecordStep.Kind.Write -> "doc.badge.plus"
        RecordStep.Kind.Web -> "globe"
        RecordStep.Kind.Agent -> "arrow.triangle.branch"
        RecordStep.Kind.Todo -> "checklist"
        RecordStep.Kind.Think -> "sparkle" // not a brain: it stood out of the line (2026-10-07, user: 这个脑子太突兀了)
        RecordStep.Kind.Tool -> "wrench.and.screwdriver"
    }

    /**
     * The picture for what the agent is doing now, by the tool it uses: the one a step of that kind has. None while
     * it uses no tool — at work, and no more to say: the star that stood there read as another product's mark
     * (2026-10-07, user: Work提示的星星图标去掉吧，看上去像是gemini，work这个动作就别加图标了).
     */
    fun toolSymbol(tool: String?): String? {
        if (tool == null) return null
        return when (ToolDisplay.word(tool)) {
            "Run" -> symbol(RecordStep.Kind.Run)
            "Read" -> symbol(RecordStep.Kind.Read)
            "Edit" -> symbol(RecordStep.Kind.Edit)
            "Search" -> symbol(RecordStep.Kind.Search)
            "Web" -> symbol(RecordStep.Kind.Web)
            "Agents" -> symbol(RecordStep.Kind.Agent)
            "Plan" -> symbol(RecordStep.Kind.Todo)
            "Compact" -> compactSymbol
            else -> symbol(RecordStep.Kind.Tool)
        }
    }

    /** It compacts its context (docs/simple-view-v0.md §5.7): two arrows meeting, for that alone. */
    const val compactSymbol = "arrow.down.right.and.arrow.up.left"

    /** The steps a run shows when opened: its thinking only in the verbose transcript. */
    fun shown(steps: List<RecordStep>, verbose: Boolean): List<RecordStep> =
        if (verbose) steps else steps.filter { it.kind != RecordStep.Kind.Think }

    /** How full the context is: `62%` when the record says how much it holds, else the tokens in it (`238k`). */
    fun context(usage: RecordUsage?): String? {
        val used = usage?.used
        if (used == null || used <= 0) return null
        val window = usage.window
        if (window != null && window > 0) return "${minOf(100, roundAway(used.toDouble() / window.toDouble() * 100).toInt())}%"
        return if (used >= 1_000_000) "${(used.toDouble() / 1_000_000).cFixed(1)}M" else "${maxOf(1, roundAway(used.toDouble() / 1000).toInt())}k"
    }

    /** The agent's own word for how it asks, as the screens say it; null for one this app does not know. */
    fun mode(raw: String?): String? = when (raw) {
        "default", "manual", "untrusted" -> "Ask"
        "acceptEdits" -> "Edits"
        "plan" -> "Plan"
        "auto" -> "Auto"
        "bypassPermissions", "bypass" -> "Bypass"
        "dontAsk" -> "Don't Ask"
        "on-request" -> "On Request"
        "on-failure" -> "On Failure"
        "never" -> "Never Ask"
        else -> null
    }

    /** The task list on one line (Swift's `(done:, total:, now:)`). */
    data class PlanLine(val done: Int, val total: Int, val now: String)

    /** The task list on one line: how many are done, and the one in progress (else the next). */
    fun plan(plan: List<PlanEntry>): PlanLine? {
        if (plan.isEmpty()) return null
        val now = plan.firstOrNull { it.state == PlanEntry.State.Doing } ?: plan.firstOrNull { it.state == PlanEntry.State.Todo }
        return PlanLine(plan.count { it.state == PlanEntry.State.Done }, plan.size, now?.text ?: "")
    }

    /** A tool's kind by its name alone, for a record read coarsely (OpenCode, pi, an older Mac). */
    fun coarseKind(tool: String): RecordStep.Kind = when (tool.lowercase()) {
        "read", "view", "cat", "notebookread" -> RecordStep.Kind.Read
        "grep", "glob", "search", "find", "rg" -> RecordStep.Kind.Search
        "ls", "list" -> RecordStep.Kind.List
        "bash", "shell", "exec", "run", "local_shell", "exec_command", "commandexecution" -> RecordStep.Kind.Run
        "edit", "multiedit", "patch", "apply_patch", "notebookedit", "filechange" -> RecordStep.Kind.Edit
        "write" -> RecordStep.Kind.Write
        "webfetch", "websearch", "web_search", "fetch" -> RecordStep.Kind.Web
        "task", "agent" -> RecordStep.Kind.Agent
        "todowrite", "todoread", "update_plan" -> RecordStep.Kind.Todo
        else -> RecordStep.Kind.Tool
    }

    /** Characters of a long answer shown before `Show More`, and how long one is before it is folded at all. */
    const val previewChars = 1600
    const val foldChars = 2400

    /**
     * The start of a long text, cut where a paragraph ends when one does near the limit, with a code fence left open
     * by the cut closed; null when the text is short enough to show whole.
     */
    fun preview(text: String, fold: Int = foldChars, keep: Int = previewChars): String? {
        if (text.graphemeCount() <= fold) return null
        var head = text.graphemePrefix(keep)
        val paragraph = head.lastIndexOf("\n\n")
        if (paragraph >= 0 && head.substring(0, paragraph).graphemeCount() > keep / 2) {
            head = head.substring(0, paragraph)
        } else {
            // Swift's `lastIndex(of: "\n")`: a "\r\n" is one Character and no "\n".
            var cut = head.lastIndexOf('\n')
            while (cut > 0 && head[cut - 1] == '\r') cut = head.lastIndexOf('\n', cut - 1)
            if (cut >= 0 && head.substring(0, cut).graphemeCount() > keep / 2) head = head.substring(0, cut)
        }
        val fences = head.split("\n").count { it.trim { c -> c.isHorizontalSpace() }.startsWith("```") }
        return if (fences % 2 == 1) head + "\n```" else head
    }

    /**
     * Claude Code's command for another model, typed as a reply: `/model opus`. A model id is letters, digits and
     * `. _ : / [ ] -` (what the Mac lists); anything else is left out, so nothing after it reads as more input.
     */
    fun modelCommand(model: String): String {
        val kept = StringBuilder()
        model.codePoints().forEach { cp ->
            val ascii = cp < 0x80
            if ((ascii && (cp.toChar().isLetterOrDigit())) || (cp < 0x80 && "._:/[]-".indexOf(cp.toChar()) >= 0)) kept.appendCodePoint(cp)
        }
        return "/model $kept"
    }

    /** The command that opens an agent's own model picker, typed for the user who then chooses on its screen. */
    fun modelPicker(harness: String): String = if (harness == "opencode") "/models" else "/model"

    /**
     * The model a terminal is on, as far as anything says: what the agent last reported, else the model of its last
     * answer in the record, else the one it was started with.
     */
    fun model(now: String?, record: String?, started: String?): String? = now ?: record ?: started

    /**
     * Which of the listed models is the one in use: by its id, else by the name people read (`opus` is listed for
     * `claude-opus-5-5`, both read "Opus 5.5").
     */
    fun isCurrent(option: TerminalModelOption, model: String?): Boolean {
        if (model == null) return false
        return option.id == model || option.name == ModelName.display(model)
    }
}

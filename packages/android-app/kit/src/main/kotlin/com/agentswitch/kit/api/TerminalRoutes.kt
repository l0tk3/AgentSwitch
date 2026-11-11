package com.agentswitch.kit.api

import com.agentswitch.kit.feed.EffortDisplay
import com.agentswitch.kit.feed.QuestionPicks
import com.agentswitch.kit.feed.RecordDisplay
import com.agentswitch.kit.feed.SlashCommand
import com.agentswitch.kit.support.KitJson
import java.io.ByteArrayOutputStream
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.buffer
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.transformWhile
import kotlinx.serialization.Serializable

// The terminal routes a paired phone may use (docs/terminal-v0.md §4; the daemon's remote allowlist): not the hook and
// not raw keystrokes (`/write`) — a reply goes through the sealer, keys go by name.

@Serializable
internal class TerminalEnvelope(val terminal: TerminalInfo, val existing: Boolean? = null)

@Serializable
internal class ElsewhereReply(val elsewhere: Place? = null) {
    @Serializable
    class Place(val app: String? = null, val pid: Int? = null)
}

@Serializable
internal class GoneReply(val folderGone: String? = null, val alike: List<String>? = null, val near: String? = null)

@Serializable
internal class InputBody(val text: String, val submit: Boolean, val seal: Boolean, val attachments: List<TerminalAttachmentRef>? = null)

/**
 * A file for the reply and the placeholder that says where it goes in it (docs/terminal-v0.md §4): one staged from the
 * phone (`upload`), or one on the Mac by where it is (`path`, from the Files tab, docs/files-v0.md §5) — not copied, its
 * path typed as a terminal types a dropped file. Give one of `upload` and `path`.
 */
@Serializable
data class TerminalAttachmentRef(
    val token: String,
    val upload: String? = null,
    val path: String? = null,
)

@Serializable
internal class CommandList(val commands: List<SlashCommand>)

@Serializable
internal class ModelBody(val model: String)

@Serializable
internal class EffortBody(val effort: String)

@Serializable
internal class DaybreakBody(val on: Boolean)

@Serializable
internal class DaybreakReply(val on: Boolean? = null)

@Serializable
internal class KeysBody(val keys: List<TerminalKey>)

@Serializable
internal class SizeBody(val cols: Int, val rows: Int, val screen: String? = null)

@Serializable
internal class ClickBody(val keys: List<String>)

@Serializable
internal class DecisionBody(val decision: String)

@Serializable
internal class AnswerBody(val answers: Map<String, QuestionPicks.Answer>) {
    /** Constant: sent as Swift's `let decision = "allow"` is. */
    val decision: String = "allow"
}

@Serializable
internal class AnswerReply(val sealed: Int? = null)

@Serializable
internal class RenameBody(val name: String? = null)

@Serializable
internal class AttachBody(val uploads: List<String>)

@Serializable
internal class AttachReply(val files: List<AttachedFile>)

@Serializable
internal class ProfilesReply(val agents: Map<String, ProfileChoices>)

@Serializable
internal class ChoiceBody(val pick: Int, val label: String)

/** A file put in a terminal (`POST /terminals/:id/attach`): where it went on the Mac. */
@Serializable
data class AttachedFile(
    val name: String,
    val path: String,
)

/** How a change of model reached the agent (Swift's `AgentSwitchAPI.ModelChange`). */
enum class ModelChange {
    /** The Mac typed the agent's command and lets the change through. */
    Asked,

    /** A Mac from before the route: the command was typed as a reply. Claude Code may ask about it on its screen. */
    Typed,
}

suspend fun AgentSwitchAPI.terminals(): TerminalList = get(listOf("terminals"), TerminalList.serializer())

/** Each agent's profiles, by the agent's id (`GET /profiles`); none from a Mac that has no profiles (an older one). */
suspend fun AgentSwitchAPI.profiles(): Map<String, ProfileChoices> =
    try {
        get(listOf("profiles"), ProfilesReply.serializer()).agents
    } catch (e: APIError.Http) {
        if (e.status == 404) emptyMap() else throw e
    }

suspend fun AgentSwitchAPI.terminalStyle(): TerminalStyle = get(listOf("terminals", "style"), TerminalStyle.serializer())

/** The tree's folders' git (`GET /folders/git`); none from a Mac that does not say. */
suspend fun AgentSwitchAPI.folderGit(): Map<String, GitSummary> =
    try {
        get(listOf("folders", "git"), FolderGitList.serializer()).folders
    } catch (e: APIError.Http) {
        if (e.status == 404) emptyMap() else throw e
    }

suspend fun AgentSwitchAPI.createTerminal(body: NewTerminalRequest): TerminalInfo =
    send("POST", listOf("terminals"), body, NewTerminalRequest.serializer(), TerminalEnvelope.serializer()).terminal

/** Resuming a session: started, or the terminal that already has it; a 409 names the program that has it open. */
suspend fun AgentSwitchAPI.resumeTerminal(body: ResumeTerminalRequest): ResumeOutcome {
    val data = try {
        KitJson.encodeToString(ResumeTerminalRequest.serializer(), body).toByteArray(Charsets.UTF_8)
    } catch (e: Exception) {
        throw APIError.Decoding("request body: $e")
    }
    val endpoint = endpoints.endpoint()
    val (reply, response) = try {
        transport.send(request("POST", endpoint, listOf("terminals", "resume"), emptyList(), data))
    } catch (error: APIError) {
        if (error.isNetworkFailure) endpoints.reportFailure(endpoint)
        throw error
    }
    val text = String(reply, Charsets.UTF_8)
    if (response.statusCode == 409) {
        val place = try { KitJson.decodeFromString(ElsewhereReply.serializer(), text).elsewhere } catch (e: Exception) { null }
        if (place != null) return ResumeOutcome.Elsewhere(app = place.app, pid = place.pid)
    }
    if (response.statusCode == 422) {
        val gone = try { KitJson.decodeFromString(GoneReply.serializer(), text) } catch (e: Exception) { null }
        val cwd = gone?.folderGone
        if (gone != null && cwd != null) return ResumeOutcome.FolderGone(cwd = cwd, alike = gone.alike ?: emptyList(), near = gone.near)
    }
    val envelope = AgentSwitchAPI.decode(reply, response, TerminalEnvelope.serializer())
    return if (envelope.existing == true) ResumeOutcome.Existing(envelope.terminal) else ResumeOutcome.Started(envelope.terminal)
}

/**
 * A reply: sealed on the Mac first (the sealer may take a while), or `sealed: false` typed as it is; `submit` presses
 * return after it. Credentials reach the agent as ciphertext.
 * `attachments`: files staged with `upload`, each where its placeholder stands in `text`.
 */
suspend fun AgentSwitchAPI.sendTerminalInput(
    id: String,
    text: String,
    submit: Boolean = true,
    sealed: Boolean = true,
    attachments: List<TerminalAttachmentRef> = emptyList(),
): TerminalInputResult =
    send("POST", listOf("terminals", id, "input"),
        InputBody(text = text, submit = submit, seal = sealed, attachments = attachments.ifEmpty { null }),
        InputBody.serializer(), TerminalInputResult.serializer(),
        timeout = if (sealed) AgentSwitchAPI.createTaskTimeout else requestTimeout)

/**
 * Another model for the agent in a terminal (docs/simple-view-v0.md §5.4; Claude Code: `/model <id>`, which also
 * becomes its default for new sessions). Refused while it works or waits for an answer (409), and for an agent that
 * chooses in a picker of its own (400).
 */
suspend fun AgentSwitchAPI.setTerminalModel(id: String, model: String): ModelChange =
    try {
        post(listOf("terminals", id, "model"), ModelBody(model), ModelBody.serializer(), OKReply.serializer())
        ModelChange.Asked
    } catch (e: APIError.Http) {
        if (e.status != 404) throw e
        sendTerminalInput(id, text = RecordDisplay.modelCommand(model), sealed = false)
        ModelChange.Typed
    }

/**
 * Takes row `pick` of the list the agent's own screen shows (it must still read `label` there).
 */
suspend fun AgentSwitchAPI.chooseOnTerminal(id: String, pick: Int, label: String) {
    post(listOf("terminals", id, "choices"), ChoiceBody(pick, label), ChoiceBody.serializer(), OKReply.serializer())
}

/**
 * Codex's Daybreak switch turned for the session a terminal is on: the Mac types Codex's own command when the
 * switch stands otherwise, and waits until Codex says so (docs/simple-view-v0.md §5.8). How it stands after.
 */
suspend fun AgentSwitchAPI.setTerminalDaybreak(id: String, on: Boolean): Boolean {
    val reply = post(listOf("terminals", id, "daybreak"), DaybreakBody(on), DaybreakBody.serializer(), DaybreakReply.serializer())
    return reply.on ?: on
}

/**
 * Another thinking level for the agent in a terminal (Claude Code: `/effort <level>`, which it also keeps as that
 * model's default, `max` excepted). Refused while it waits for an answer (409), and for an agent that chooses in a
 * picker of its own (400).
 */
suspend fun AgentSwitchAPI.setTerminalEffort(id: String, effort: String): ModelChange =
    try {
        post(listOf("terminals", id, "effort"), EffortBody(effort), EffortBody.serializer(), OKReply.serializer())
        ModelChange.Asked
    } catch (e: APIError.Http) {
        if (e.status != 404) throw e
        sendTerminalInput(id, text = EffortDisplay.command(effort), sealed = false)
        ModelChange.Typed
    }

/**
 * Files staged with `upload` into the terminal: their paths are pasted into the agent's prompt, nothing is sent
 * (Claude Code shows an image's as [Image #n]; the user writes on and sends).
 */
suspend fun AgentSwitchAPI.attachToTerminal(id: String, uploads: List<String>): List<AttachedFile> =
    send("POST", listOf("terminals", id, "attach"), AttachBody(uploads), AttachBody.serializer(), AttachReply.serializer(),
        timeout = requestTimeout).files

/** The slash commands this terminal's agent takes in its folder; null from a Mac too old to say (404). */
suspend fun AgentSwitchAPI.terminalCommands(id: String): List<SlashCommand>? =
    try {
        get(listOf("terminals", id, "commands"), CommandList.serializer()).commands
    } catch (e: APIError.Http) {
        if (e.status == 404) null else throw e
    }

suspend fun AgentSwitchAPI.sendTerminalKeys(id: String, keys: List<TerminalKey>) {
    post(listOf("terminals", id, "keys"), KeysBody(keys), KeysBody.serializer(), OKReply.serializer())
}

/**
 * A left click on a cell (from 0), for a program that tracks the mouse: the Mac sends it the way the program asked
 * (docs/terminal-v0.md §4 `click:<col>:<row>`). A Mac that predates it answers 400.
 */
suspend fun AgentSwitchAPI.clickTerminal(id: String, col: Int, row: Int) {
    post(listOf("terminals", id, "keys"), ClickBody(listOf("click:$col:$row")), ClickBody.serializer(), OKReply.serializer())
}

/** `screen`: this phone's screen, which owns the size from now on (docs/terminal-v0.md §1 "尺寸有主"). */
suspend fun AgentSwitchAPI.resizeTerminal(id: String, cols: Int, rows: Int, screen: String? = null) {
    post(listOf("terminals", id, "resize"), SizeBody(cols, rows, screen), SizeBody.serializer(), OKReply.serializer())
}

/** Has the agent draw its screen again (its links and status line are not in a snapshot). */
suspend fun AgentSwitchAPI.redrawTerminal(id: String) {
    post(listOf("terminals", id, "redraw"), EmptyBody(), EmptyBody.serializer(), OKReply.serializer())
}

/** False: it was answered already, on the Mac or in the terminal itself (404) — the card just goes, no error. */
suspend fun AgentSwitchAPI.decideTerminalPermission(id: String, permissionId: String, allow: Boolean): Boolean =
    try {
        post(listOf("terminals", id, "permissions", permissionId), DecisionBody(if (allow) "allow" else "deny"),
            DecisionBody.serializer(), OKReply.serializer())
        true
    } catch (e: APIError.Http) {
        if (e.status == 404) false else throw e
    }

/**
 * A question's answers (docs/terminal-v0.md §3 "选择题"): what was picked for each, Other's words sealed on the Mac
 * first. Null: answered already, on the Mac or in the terminal (404) — the card just goes; else how many secrets
 * the sealer put in its place.
 */
suspend fun AgentSwitchAPI.answerTerminalQuestion(id: String, permissionId: String, answers: Map<String, QuestionPicks.Answer>): Int? =
    try {
        send("POST", listOf("terminals", id, "permissions", permissionId), AnswerBody(answers), AnswerBody.serializer(),
            AnswerReply.serializer(), timeout = AgentSwitchAPI.createTaskTimeout).sealed ?: 0
    } catch (e: APIError.Http) {
        if (e.status == 404) null else throw e
    }

/** The user's own name; null or "" goes back to the derived one. */
suspend fun AgentSwitchAPI.renameTerminal(id: String, name: String?): TerminalInfo =
    send("PATCH", listOf("terminals", id), RenameBody(name), RenameBody.serializer(), TerminalEnvelope.serializer()).terminal

/**
 * Ends the terminal and takes it off the list; the agent's own record of the session stays (it can be resumed).
 * `deleteRecord` deletes the session it wrote too (not a session it continued in place: 409).
 */
suspend fun AgentSwitchAPI.closeTerminal(id: String, deleteRecord: Boolean = false) {
    perform("DELETE", listOf("terminals", id), if (deleteRecord) listOf(URLQueryItem("transcript", "1")) else emptyList(), null,
        OKReply.serializer())
}

/**
 * A terminal's screen and what happens to it: the snapshot, then output, status, name, permission requests. On a
 * dropped connection it reconnects after the last seq it delivered (the daemon replays what was missed, or sends a
 * new snapshot when that is gone). Ends when the terminal is removed or no longer exists.
 * `screen`: the drawing screen's id; the size it owns goes back when this stream ends (the page closed, the app
 * went to the background).
 */
fun AgentSwitchAPI.terminalEvents(
    id: String,
    screen: String? = null,
    record: Boolean = false,
    policy: ReconnectPolicy = ReconnectPolicy.standard,
): Flow<TerminalEvent> = channelFlow {
    var last: Long? = null
    var failures = 0
    while (true) {
        try {
            val once = followTerminalOnce(id, last, screen, record, policy) { send(it) }
            if (once.ended) break
            last = once.last ?: last
            failures = if (once.delivered) 0 else failures + 1
        } catch (error: APIError) {
            if (error.isNetworkFailure) {
                failures += 1
            } else if (error is APIError.Http && error.status == 404) {
                send(TerminalEvent.Removed)
                break
            } else {
                throw error
            }
        }
        delay(policy.delay(afterFailures = maxOf(failures, 1)))
    }
}.buffer(Channel.UNLIMITED)

/** One connection: (removed, last seq delivered, anything delivered). */
internal class TerminalFollow(val ended: Boolean, val last: Long?, val delivered: Boolean)

private suspend fun AgentSwitchAPI.followTerminalOnce(
    id: String,
    after: Long?,
    screen: String?,
    record: Boolean,
    policy: ReconnectPolicy,
    deliver: suspend (TerminalEvent) -> Unit,
): TerminalFollow {
    val endpoint = endpoints.endpoint()
    // `view=record`: the stream of a screen that shows the session's record, not the terminal — no screen content, and
    // what the agent is doing and when its record changed instead. It draws nothing, so it names no screen (the
    // size is never its own). A Mac from before this still sends the screen: its frames are skipped here.
    val query = if (record) listOf(URLQueryItem("view", "record"))
    else listOfNotNull(after?.let { URLQueryItem("after", it.toString()) }, screen?.let { URLQueryItem("screen", it) })
    val req = request("GET", endpoint, listOf("terminals", id, "stream"), query, null, accept = "text/event-stream",
        timeout = policy.idleTimeout)
    var last = after
    var delivered = false
    var ended = false
    try {
        val (response, body) = transport.stream(req)
        if (response.statusCode !in 200..299) {
            val data = ByteArrayOutputStream()
            body.collect { chunk -> if (data.size() < 64 * 1024) data.write(chunk) }
            AgentSwitchAPI.check(data.toByteArray(), response)
        }
        val parser = SSEParser()
        AgentSwitchAPI.idleGuarded(body, limit = policy.idleTimeout).transformWhile<ByteArray, Unit> { chunk ->
            for (message in parser.feed(chunk)) {
                val event = TerminalEvent.parse(message.event, message.data) ?: continue
                if (record && event.seq != null) continue
                // Output already shown (a replay after a reconnect) is skipped; a snapshot always draws.
                val seen = last
                if (event is TerminalEvent.Output && seen != null && event.seq <= seen) continue
                event.seq?.let { last = it }
                delivered = true
                deliver(event)
                if (event is TerminalEvent.Removed) { ended = true; break }
            }
            !ended
        }.collect()
    } catch (error: APIError) {
        if (!error.isNetworkFailure) throw error
        endpoints.reportFailure(endpoint)
        if (delivered) return TerminalFollow(false, last, true)
        throw error
    }
    if (ended) return TerminalFollow(true, last, true)
    return TerminalFollow(false, last, delivered)
}

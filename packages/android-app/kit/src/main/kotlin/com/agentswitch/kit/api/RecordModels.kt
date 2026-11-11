package com.agentswitch.kit.api

import com.agentswitch.kit.feed.MessageDisplay
import com.agentswitch.kit.feed.RecordDisplay
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

// A session's record for the simple view (docs/simple-view-v0.md §2): what the user said, what the agent answered, and
// each run of work between two answers as its steps. The Mac reads it from what the agent itself writes as it goes.

/** One thing the agent did in a run of work. */
@Serializable(with = RecordStepSerializer::class)
data class RecordStep(
    /** A kind this app does not know is shown as a tool by its name. */
    val kind: Kind,
    /** One line: the file, the command, the query, what a sub-agent was sent to do. */
    val text: String,
    /** The tool's own name, for a step that is none of the kinds. */
    val tool: String? = null,
    /** What the agent said the step is for, in its own words (Claude Code's description of a command). */
    val note: String? = null,
    /** The end of what a command printed. */
    val out: String? = null,
    val failed: Boolean = false,
    val added: Int? = null,
    val removed: Int? = null,
    /** Pictures the step brought back (a picture file read, a screenshot taken): how many (never below 0 when read). */
    val images: Int = 0,
) {
    enum class Kind(val rawValue: String) {
        Read("read"), Search("search"), List("list"), Run("run"), Edit("edit"), Write("write"), Web("web"), Agent("agent"),
        Todo("todo"), Think("think"), Tool("tool");

        companion object {
            fun fromRaw(raw: String): Kind? = entries.firstOrNull { it.rawValue == raw }
        }
    }
}

internal object RecordStepSerializer : ObjectReader<RecordStep>("RecordStep") {
    override fun read(o: JsonObject): RecordStep {
        val raw = o.lenientString("kind") ?: ""
        val known = RecordStep.Kind.fromRaw(raw)
        return RecordStep(
            kind = known ?: RecordStep.Kind.Tool,
            text = o.lenientString("text") ?: "",
            tool = o.lenientString("tool") ?: (if (known == null && raw.isNotEmpty()) raw else null),
            note = o.lenientString("note")?.takeIf { it.isNotEmpty() },
            out = o.lenientString("out"),
            failed = o.lenientBool("failed") ?: false,
            added = o.lenientInt("added"),
            removed = o.lenientInt("removed"),
            images = maxOf(0, o.lenientInt("images") ?: 0),
        )
    }
}

/**
 * What the agent's own screen said to a command sent from a screen (`/daybreak` → `Daybreak off. Applies to new
 * turns.`): it is in no record, so the service reads it off the screen.
 */
@Serializable(with = ScreenNoticeSerializer::class)
data class ScreenNotice(
    val id: String,
    val text: String,
    /** Milliseconds since 1970. */
    val at: Long,
) {
    companion object {
        /** The record with these, each a note where its time puts it. */
        fun placed(items: List<RecordItem>, notices: List<ScreenNotice>): List<RecordItem> {
            if (notices.isEmpty()) return items
            val out = items.toMutableList()
            for (notice in notices) {
                val note = RecordItem(id = "notice-${notice.id}", kind = RecordItem.Kind.Note, at = notice.at, text = notice.text)
                // Older than all of it (a record begun after it, as by `/clear`): first, not last (2026-10-14).
                val last = out.indexOfLast { it.at <= notice.at }
                out.add(if (last >= 0) last + 1 else 0, note)
            }
            return out
        }
    }
}

// Swift's synthesized `Decodable`: every field required and strict.
internal object ScreenNoticeSerializer : ObjectReader<ScreenNotice>("ScreenNotice") {
    override fun read(o: JsonObject) = ScreenNotice(
        id = o.requireString("id"),
        text = o.requireString("text"),
        at = o.lenientLong("at") ?: throw SerializationException("at missing or not an integer"),
    )
}

/** A question at the end of an answer and the answers it offers. */
@Serializable
data class RecordQuestion(
    val title: String,
    val options: List<String>,
) {
    companion object {
        /**
         * The questions still open at the record's end: those of its last answer, while nothing of yours comes after it
         * (in the record, or sent and not there yet).
         */
        fun open(items: List<RecordItem>, sent: List<SentReply>): List<RecordQuestion> {
            if (sent.isNotEmpty()) return emptyList()
            val last = items.lastOrNull { it.kind == RecordItem.Kind.User || it.kind == RecordItem.Kind.Answer } ?: return emptyList()
            if (last.kind != RecordItem.Kind.Answer) return emptyList()
            return last.questions.filter { it.options.isNotEmpty() }
        }
    }
}

/**
 * A file an answer points at (docs/simple-view-v0.md §5.16): its whole path on the node, and what kind of thing it is
 * in the agent's word (`workbook`, `document`…) when it says.
 */
@Serializable
data class RecordFile(
    val path: String,
    val kind: String? = null,
) {
    val id: String get() = path

    /** The last component of [path], as `NSString.lastPathComponent` gives it. */
    val name: String get() = lastPathComponent(path)

    /** Its folder, for a Files browser to open at. */
    val folder: String get() = deletingLastPathComponent(path)

    /** The kind as a word on the screen (`Workbook`), from the agent's (`workbook`, `source_code`); none, nothing. */
    val kindWord: String?
        get() {
            val k = kind
            if (k == null || k.isEmpty()) return null
            return k.split('_', '-').filter { it.isNotEmpty() }.joinToString(" ") { word ->
                val head = word.graphemePrefix(1)
                head.uppercase(java.util.Locale.ROOT) + word.substring(head.length)
            }
        }
}

private fun pathComponents(path: String): List<String> = path.split("/").filter { it.isNotEmpty() }

private fun lastPathComponent(path: String): String {
    val parts = pathComponents(path)
    if (parts.isEmpty()) return if (path.startsWith("/")) "/" else ""
    return parts.last()
}

private fun deletingLastPathComponent(path: String): String {
    val parts = pathComponents(path)
    if (parts.isEmpty()) return if (path.startsWith("/")) "/" else ""
    val rest = parts.dropLast(1).joinToString("/")
    return if (path.startsWith("/")) "/$rest" else rest
}

/**
 * A list the agent draws on its own screen and waits on (Codex's `/model`, a question whether to trust a folder):
 * its rows, and where the selection stands. Taking a row moves the selection there and enters it, as in the terminal.
 */
@Serializable
data class ScreenChoices(
    val title: String,
    val options: List<Option>,
    val selected: Int,
    /**
     * All its screen says above the rows, a paragraph a line (a folder's question is several); null when the title is
     * all of it, and from a Mac that does not say.
     */
    val text: String? = null,
) {
    @Serializable
    data class Option(
        val label: String,
        val detail: String? = null,
    )

    /** One line of what the list's card says over its rows; `asks`: the one that is the question. */
    data class Line(val id: Int, val text: String, val asks: Boolean)

    /**
     * What the card says over the rows: the screen's own lines with the question marked among them, or the title
     * alone. Lines that say nothing are left out; when none of them is the title, the first stands for it.
     */
    val said: List<Line> get() = said(title, text)

    companion object {
        fun said(title: String, text: String?): List<Line> {
            val lines = (text ?: "").splitNewlines().map { it.trim { c -> c.isHorizontalSpace() } }.filter { it.isNotEmpty() }
            if (lines.isEmpty()) return if (title.isEmpty()) emptyList() else listOf(Line(0, title, true))
            val asks = lines.indexOf(title).let { if (it >= 0) it else 0 }
            return lines.mapIndexed { i, line -> Line(i, line, i == asks) }
        }
    }
}

/**
 * How far a turn has come, as the agent's own screen counts it (the service reads Claude Code's working line): the
 * tokens come from the model (`down`) or gone to it (`up`). Beside "Working": a number that moves says it is not stuck.
 */
@Serializable(with = TurnProgressSerializer::class)
data class TurnProgress(
    val tokens: Int,
    val way: String = "down",
)

internal object TurnProgressSerializer : ObjectReader<TurnProgress>("TurnProgress") {
    override fun read(o: JsonObject) = TurnProgress(
        tokens = o.lenientInt("tokens") ?: throw SerializationException("tokens missing or not an integer"),
        way = o.strictString("way") ?: "down",
    )
}

/**
 * A reply a screen sent that the agent's record does not hold yet: the service keeps it, and it is shown at the
 * record's end meanwhile (the agent writes a message down only as its turn begins, and one sent while it works not
 * until it is taken).
 */
@Serializable(with = SentReplySerializer::class)
data class SentReply(
    val id: String,
    val text: String,
    /** Milliseconds since 1970. */
    val at: Long,
    /** Files that went with it (their places in its text read otherwise in the record). */
    val files: Int = 0,
) {
    companion object {
        /**
         * The record with the replies sent and not yet in it at its end, each as a message of yours — said `Queued`
         * while the agent works (it has not taken it yet). One the items already hold is left out: the record's page and
         * the service's word that it is there do not arrive together. Held: a message of yours no older than the reply
         * (a moment's slack) that begins with the same words; one that went with files reads otherwise in the record, so
         * for it the time decides.
         */
        fun appended(items: List<RecordItem>, sent: List<SentReply>, working: Boolean): List<RecordItem> {
            if (sent.isEmpty()) return items
            // Another session's message is not one of yours, whenever it came.
            val recent = items.takeLast(12).filter { it.kind == RecordItem.Kind.User && it.from == null }
            val words = { text: String ->
                text.split(Regex("[\\u0009-\\u000D \\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000]")).filter { it.isNotEmpty() }
                    .joinToString(" ").graphemePrefix(24)
            }
            val waiting = sent.filter { reply ->
                recent.none { it.at >= reply.at - 3000 && (reply.files > 0 || words(it.text) == words(reply.text)) }
            }
            return items + waiting.map { RecordItem(id = "sent-${it.id}", kind = RecordItem.Kind.User, at = it.at, text = it.text, queued = working) }
        }
    }
}

internal object SentReplySerializer : ObjectReader<SentReply>("SentReply") {
    override fun read(o: JsonObject) = SentReply(
        id = o.requireString("id"),
        text = o.requireString("text"),
        at = o.strictLong("at") ?: 0,
        files = o.strictInt("files") ?: 0,
    )
}

/** One item of the record, oldest first on the screen. */
@Serializable(with = RecordItemSerializer::class)
data class RecordItem(
    /** Where its first line begins in the agent's file: the same item keeps its id as the record grows. */
    val id: String,
    val kind: Kind,
    /** Milliseconds since 1970. */
    val at: Long = 0,
    /** What was said (user, answer, note); empty for a run of work. */
    val text: String = "",
    /** Pictures that came with a message of the user's. */
    val images: Int = 0,
    /** Typed while the agent worked, and not read by it yet. */
    val queued: Boolean = false,
    /** The Mac cut a very long text. */
    val clipped: Boolean = false,
    /** An answer that is what the agent thought on the way (where it wrote that down), not what it has to say to you. */
    val thinking: Boolean = false,
    /** A run of work: how long it took, and what it did. */
    val seconds: Int = 0,
    val steps: List<RecordStep> = emptyList(),
    /** What an answer asks at its end, each with the answers it offers (Codex): taking one sends it as your reply. */
    val questions: List<RecordQuestion> = emptyList(),
    /** The files an answer points at (Codex's file citations, taken out of its text): each shown as a file to open. */
    val files: List<RecordFile> = emptyList(),
    /** Sent by another session, not typed by you: the name it gave ("" when it gave none); null for yours. */
    val from: String? = null,
) {
    enum class Kind(val rawValue: String) {
        User("user"), Answer("answer"), Work("work"), Note("note");

        companion object {
            fun fromRaw(raw: String): Kind? = entries.firstOrNull { it.rawValue == raw }
        }
    }

    /** [at], milliseconds since 1970. */
    val date: Long get() = at

    /** Where it begins in the agent's file, when its id says (a record read coarsely numbers its items instead). */
    val offset: Long? get() = (id.split(".").firstOrNull { it.isNotEmpty() } ?: "").toLongOrNull()
}

internal object RecordItemSerializer : ObjectReader<RecordItem>("RecordItem") {
    override fun read(o: JsonObject): RecordItem {
        val id = o.requireString("id")
        val kind = RecordItem.Kind.fromRaw(o.requireString("type")) ?: throw SerializationException("an item this app does not know")
        return RecordItem(
            id = id,
            kind = kind,
            // A file's time may carry a fraction of a millisecond.
            at = o.lenientDouble("ts")?.toLong() ?: 0,
            text = o.lenientString("text") ?: "",
            images = o.lenientInt("images") ?: 0,
            queued = o.lenientBool("queued") ?: false,
            from = o.lenientString("from"),
            clipped = o.lenientBool("clipped") ?: false,
            thinking = o.lenientBool("thinking") ?: false,
            seconds = o.lenientInt("secs") ?: 0,
            steps = o.lenient("steps", ListSerializer(RecordStep.serializer())) ?: emptyList(),
            questions = o.lenient("questions", ListSerializer(RecordQuestion.serializer())) ?: emptyList(),
            files = o.lenient("files", ListSerializer(RecordFile.serializer())) ?: emptyList(),
        )
    }
}

/** One entry of the agent's own task list. */
@Serializable(with = PlanEntrySerializer::class)
data class PlanEntry(
    val text: String,
    val state: State,
) {
    enum class State(val rawValue: String) {
        Todo("todo"), Doing("doing"), Done("done");

        companion object {
            fun fromRaw(raw: String): State? = entries.firstOrNull { it.rawValue == raw }
        }
    }
}

internal object PlanEntrySerializer : ObjectReader<PlanEntry>("PlanEntry") {
    override fun read(o: JsonObject) = PlanEntry(
        text = o.requireString("text"),
        state = o.lenientString("state")?.let { PlanEntry.State.fromRaw(it) } ?: PlanEntry.State.Todo,
    )
}

/** How full the agent's context is: tokens in it at the last turn, and how many it holds when the record says. */
@Serializable
data class RecordUsage(
    val model: String? = null,
    val used: Int? = null,
    val window: Int? = null,
    /** How hard it thought at the last turn, in the agent's word (Claude Code, Codex). */
    val effort: String? = null,
)

/** `GET /sessions/:harness/:id/record`. */
@Serializable(with = SessionRecordSerializer::class)
data class SessionRecord(
    val session: SessionSummary,
    val items: List<RecordItem>,
    /** There is more before `cursor`. */
    val more: Boolean = false,
    val cursor: Long = 0,
    val rev: String = "",
    val plan: List<PlanEntry> = emptyList(),
    val usage: RecordUsage? = null,
    /** The permission mode the record last named, as the agent writes it. */
    val mode: String? = null,
) {
    companion object {
        /** A Mac from before the record route still gives the session's messages: the same record, one line per tool. */
        fun coarse(detail: SessionDetail): SessionRecord {
            val items = mutableListOf<RecordItem>()
            var steps = mutableListOf<RecordStep>()
            var began = 0L
            var n = 0
            fun close() {
                if (steps.isEmpty()) return
                items.add(RecordItem(id = "m$n", kind = RecordItem.Kind.Work, at = began, steps = steps))
                n += 1
                steps = mutableListOf()
            }
            for (m in detail.messages) {
                when (m.role) {
                    SessionMessage.Role.User, SessionMessage.Role.Assistant -> {
                        close()
                        items.add(RecordItem(id = "m$n", kind = if (m.role == SessionMessage.Role.User) RecordItem.Kind.User else RecordItem.Kind.Answer, at = m.ts, text = m.text))
                        n += 1
                    }
                    SessionMessage.Role.Tool, SessionMessage.Role.Other -> {
                        if (steps.isEmpty()) began = m.ts
                        steps.add(RecordStep(
                            kind = RecordDisplay.coarseKind(m.tool ?: ""),
                            text = MessageDisplay.readable(m.text).splitNewlines().firstOrNull() ?: "",
                            tool = m.tool,
                        ))
                    }
                }
            }
            close()
            return SessionRecord(session = detail.session, items = items, rev = "u${detail.session.updatedAt}")
        }
    }
}

internal object SessionRecordSerializer : ObjectReader<SessionRecord>("SessionRecord") {
    /** An item of a kind a newer Mac added is left out, not fatal. */
    private fun <T : Any> lossy(element: JsonElement, serializer: KSerializer<T>): List<T> {
        val array = element as? JsonArray ?: throw SerializationException("not an array")
        return array.mapNotNull {
            try {
                com.agentswitch.kit.support.KitJson.decodeFromJsonElement(serializer, it)
            } catch (_: SerializationException) {
                null
            } catch (_: IllegalArgumentException) {
                null
            }
        }
    }

    override fun read(o: JsonObject): SessionRecord {
        val session = com.agentswitch.kit.support.KitJson.decodeFromJsonElement(SessionSummary.serializer(), o["session"] ?: throw SerializationException("session missing"))
        val items = lossy(o["items"] ?: throw SerializationException("items missing"), RecordItem.serializer())
        return SessionRecord(
            session = session,
            items = items,
            more = o.lenientBool("more") ?: false,
            cursor = o.lenientDouble("cursor")?.toLong() ?: 0,
            rev = o.lenientString("rev") ?: "",
            plan = o["plan"]?.let { try { lossy(it, PlanEntry.serializer()) } catch (_: SerializationException) { null } } ?: emptyList(),
            usage = o.lenient("usage", RecordUsage.serializer()),
            mode = o.lenientString("mode"),
        )
    }
}

/** What a run of work, or the last turn, changed in one file. */
@Serializable(with = FileDiffSerializer::class)
data class FileDiff(
    val path: String,
    val added: Int,
    val removed: Int,
    val hunks: List<Hunk>,
    /** The Mac cut a very long change. */
    val clipped: Boolean = false,
) {
    @Serializable
    data class Hunk(
        val header: String,
        /** Each with its mark first: `+` added, `-` taken away, a space unchanged. */
        val lines: List<String>,
    )

    val id: String get() = path
}

internal object FileDiffSerializer : ObjectReader<FileDiff>("FileDiff") {
    override fun read(o: JsonObject) = FileDiff(
        path = o.requireString("path"),
        added = o.lenientInt("added") ?: 0,
        removed = o.lenientInt("removed") ?: 0,
        hunks = o.lenient("hunks", ListSerializer(FileDiff.Hunk.serializer())) ?: emptyList(),
        clipped = o.lenientBool("clipped") ?: false,
    )
}

@Serializable
internal data class FileDiffList(val files: List<FileDiff>)

/**
 * One step of a run of work, whole (`GET /sessions/:harness/:id/steps/:item/:n`): a command as it was written, its
 * lines kept, and all it printed — the record itself carries one line and the end of the output.
 */
@Serializable
data class RecordStepDetail(
    val text: String,
    val note: String? = null,
    val out: String? = null,
    val failed: Boolean? = null,
    /** Longer than is sent: the command's start, the output's end. */
    val clipped: Boolean? = null,
)

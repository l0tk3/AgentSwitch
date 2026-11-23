package com.agentswitch.kit.api

import com.agentswitch.kit.design.ClassicWords
import com.agentswitch.kit.design.InterfaceLook
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient

// Chat Room as the Mac gives it (docs/chatroom-v0.md; the service's `api/rooms.ts`): the rooms, a room with its seats
// and what was said, and what the pages make of them — a seat's state in the room's words, who a message still has to
// reach, how the timeline is laid out, the `@name` being typed. The iPhone's `RoomModels.swift`, in Kotlin.

/**
 * A seat's face (§1 头像): five rows of five, `#` lit; one of ten colours. Made on the Mac from the seat's name, so
 * every screen draws the same one.
 */
@Serializable
data class RoomFace(val rows: List<String> = emptyList(), val color: Int = 0) {
    /** The lit cells, column and row. */
    val cells: List<Pair<Int, Int>>
        get() = rows.take(5).flatMapIndexed { y, row -> row.take(5).mapIndexedNotNull { x, c -> if (c == '#') x to y else null } }

    fun rgb(dark: Boolean): Int {
        val set = if (dark) colorsDark else colorsLight
        return set[((color % set.size) + set.size) % set.size]
    }

    companion object {
        /**
         * The ten face colours, on a dark and on a light ground (the concept page's `--f0…--f9`): none of them a
         * state's colour, the signal pink or the accent blue.
         */
        val colorsDark = listOf(0xB18CFF, 0xE2C48D, 0x7FE3C0, 0xE08CE8, 0xC3C95A, 0x9DB2D9, 0xF0A585, 0xA3A9F5, 0xEDA0B8, 0x86BFC9)
        val colorsLight = listOf(0x7A4FE0, 0x9A7B3F, 0x1F9A75, 0xB043BC, 0x7C8220, 0x5A719F, 0xC0623A, 0x5560D6, 0xC2557A, 0x2F8496)

        /** What is drawn for a seat that came without one. */
        val fallback = RoomFace(listOf("#.#.#", ".###.", "##.##", ".###.", "#.#.#"), 5)
    }
}

/** A seat's state in the room (§6.1). The first four are the terminal's own; the rest say what is wrong with it. */
enum class SeatState(val rawValue: String, /** The pixel look's word. */ val word: String) {
    Busy("busy", "Busy"), Waiting("waiting", "Waiting"), Idle("idle", "Idle"), Exited("exited", "Exited"),
    Reconnecting("reconnecting", "Reconnecting"), Limited("limited", "Limited"), SignedOut("signed_out", "Signed Out"),
    Blocked("blocked", "Blocked"), Error("error", "Error"), Offline("offline", "Offline");

    /**
     * How its mark is drawn. Amber is what needs the user's hands, red what went wrong; what mends itself has no
     * colour (a spinner while it tries, a dim key while it only waits).
     */
    enum class Mark { Spinner, Amber, Ready, Ended, Red, Held }

    val mark: Mark
        get() = when (this) {
            Busy, Reconnecting -> Mark.Spinner
            Waiting, SignedOut -> Mark.Amber
            Idle -> Mark.Ready
            Exited -> Mark.Ended
            Blocked, Error -> Mark.Red
            Limited, Offline -> Mark.Held
        }

    /** The classic look's word where it differs (`ClassicWords`: Working, Needs You, Ready, Ended). */
    fun word(look: InterfaceLook): String = ClassicWords.word(word, look)

    /** What becomes of a message sent to a seat in this state; null for the four everyday ones. */
    val says: String?
        get() = when (this) {
            Reconnecting -> "连不上它的服务，正在重试。发给它的消息先留着，连上之后交给它。"
            Limited -> "额度用完或被限速。发给它的消息留到恢复之后。"
            SignedOut -> "登录失效，需要你重新登录。发给它的消息交不了。"
            Blocked -> "这一轮被模型的安全措施拦下了。发给它的那一条它没能处理。"
            Error -> "这一轮出错结束。发给它的消息会再试一次。"
            Offline -> "它所在的节点连不上。发给它的消息留到节点回来。"
            else -> null
        }

    /** A message for it is kept until it mends itself. */
    val holds: Boolean get() = this == Reconnecting || this == Limited || this == Offline || this == Error

    companion object {
        fun of(raw: String?): SeatState? = entries.firstOrNull { it.rawValue == raw }
    }
}

/** A seat's card (§1 名片): no account, no address. */
@Serializable
data class SeatCard(
    val agent: String = "",
    val name: String = "",
    val cwd: String = "",
    val model: String? = null,
    /** The profile's name; null: the Mac's own (`Default`). */
    val profile: String? = null,
    @SerialName("color") val colorName: String? = null,
    /** How it asks, in its agent's own word. */
    val mode: String? = null,
    /** The node it runs on; null: the one asked. */
    val node: String? = null,
) {
    val color: ProfileColor? get() = ProfileColor.entries.firstOrNull { it.rawValue == colorName }
}

@Serializable
data class RoomSeat(
    /** What others write after `@`; never changes. */
    val handle: String,
    val kind: String = "session",
    /** The terminal behind it, on the Mac asked. */
    val terminal: String? = null,
    val face: RoomFace? = null,
    val joinedAt: Long = 0,
    val addedBy: String = you,
    /** Chatroom Kit's one switch (§6). */
    val canAdd: Boolean = false,
    /** Started by another session: its switch stays off. */
    val byAgent: Boolean = false,
    /** When it left; null while it sits. */
    val left: Long? = null,
    @SerialName("state") val stateName: String? = null,
    val card: SeatCard? = null,
    /** Its session has the Chatroom Kit (§6); false for one started before there was a Kit, until it is resumed. */
    val kit: Boolean? = null,
) {
    val isUser: Boolean get() = kind == "user"
    val here: Boolean get() = left == null

    /** Null for the user, and for a state this app does not know (shown as it is, no mark). */
    val state: SeatState? get() = SeatState.of(stateName)

    /** It sits, its session goes on, and it has no Kit: it can neither speak in the room nor be woken (`No Kit`). */
    val noKit: Boolean get() = !isUser && here && kit == false && state != SeatState.Exited

    companion object {
        /** The user's own seat, in every room. */
        const val you = "you"

        /** Everyone in the room; only the user may write it. */
        const val all = "all"
    }
}

@Serializable
data class RoomMessage(
    val seq: Int,
    val from: String,
    /** The seats it is for, by handle; empty: written into the room, waking nobody. */
    val to: List<String> = emptyList(),
    val replyTo: Int? = null,
    val text: String = "",
    /** Milliseconds since 1970. */
    val at: Long = 0,
    /** Files it comes with, by where they are on the Mac. */
    val files: List<String> = emptyList(),
)

/** Where a message is on its way to a seat (§5). Dealt with, there is no receipt. */
enum class RoomReceipt(val rawValue: String, val word: String, val tick: String) {
    Sent("sent", "Sent", "·"), Queued("queued", "Queued", "…"), Delivered("delivered", "Delivered", "✓"), Ended("ended", "Ended", "×");

    companion object {
        fun of(raw: String?): RoomReceipt? = entries.firstOrNull { it.rawValue == raw }
    }
}

/** The room's pinned notes (§9): one text every member reads and writes. */
@Serializable
data class RoomNotes(val text: String = "", val at: Long = 0, val by: String = RoomSeat.you)

/** How far a task is (§9 任务表). */
enum class RoomTaskState(val rawValue: String, val word: String) {
    Todo("todo", "To Do"), Doing("doing", "Doing"), Done("done", "Done");

    companion object {
        fun of(raw: String?): RoomTaskState? = entries.firstOrNull { it.rawValue == raw }
    }
}

/** One piece of the room's work (§9 任务表): who does what, and how far it is, where every member sees it. */
@Serializable
data class RoomTask(
    /** Its number in this room (`T3`); never used again. */
    val n: Int,
    val title: String = "",
    val detail: String? = null,
    @SerialName("state") val stateName: String = "todo",
    /** The seat doing it (done it), by handle. */
    val owner: String? = null,
    /** Who added it. */
    val by: String = RoomSeat.you,
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
    /** Tasks that come first, by number. */
    val after: List<Int> = emptyList(),
    /** How it ended, in a line: the result, or the file that holds it. */
    val note: String? = null,
) {
    /** A state this app does not know is one still to do. */
    val state: RoomTaskState get() = RoomTaskState.of(stateName) ?: RoomTaskState.Todo

    /** As it is called in the room: `T3`. */
    val label: String get() = "T$n"
}

/** How a room's work stands, in the list: how many tasks of each state. */
@Serializable
data class RoomTaskCounts(val todo: Int = 0, val doing: Int = 0, val done: Int = 0)

/** A member saying which files it is changing (§9): a word to the others, not a lock, and gone by itself at `until`. */
@Serializable
data class RoomClaim(
    val handle: String,
    /** Files or folders, as the member named them. */
    val paths: List<String> = emptyList(),
    val why: String? = null,
    val at: Long = 0,
    /** Milliseconds since 1970. */
    val until: Long = 0,
) {
    /** The paths by their last part; a folder keeps its `/`. */
    val names: List<String>
        get() = paths.map { p -> p.trimEnd('/').substringAfterLast('/').ifEmpty { p } + if (p.length > 1 && p.endsWith("/")) "/" else "" }

    /** The first few names in one line, and how many more there are (`api.ts, store.ts +2`). */
    fun summary(most: Int = 3): String {
        val names = names
        return names.take(most).joinToString(", ") + if (names.size > most) " +${names.size - most}" else ""
    }
}

/** A file in a room's shared folder (§9): its path under the folder. */
@Serializable
data class RoomFile(val path: String, val size: Long = 0, /** Milliseconds since 1970. */ val modifiedAt: Long = 0)

/** What is in a room's shared folder, the newest first; `more`: there is more than is listed. */
@Serializable
data class RoomFiles(val folder: String = "", val files: List<RoomFile> = emptyList(), val more: Boolean = false) {
    /** Where a listed file is on the Mac. */
    fun whole(file: RoomFile): String = "${folder.trimEnd('/')}/${file.path}"
}

@Serializable
data class RoomInfo(
    val id: String,
    val name: String = "",
    val topic: String = "",
    val paused: Boolean = false,
    val createdAt: Long = 0,
    val lastSeq: Int = 0,
    val readSeq: Int = 0,
    /** Messages from one session to another in a row with no word from the user, once at the room's limit (§7). */
    val rounds: Int? = null,
    val roundsLimit: Int = 6,
)

/** A room as its page has it: the seats as they are now, the last messages, and what has not arrived. */
@Serializable
data class RoomDetail(
    val room: RoomInfo,
    val seats: List<RoomSeat> = emptyList(),
    val messages: List<RoomMessage> = emptyList(),
    @SerialName("receipts") private val rawReceipts: Map<String, Map<String, String>> = emptyMap(),
    val notes: RoomNotes? = null,
    /** The room's shared folder (§9), by where it is on the Mac; empty from a Mac that has none. */
    val folder: String = "",
    /** The task list (§9), in the order the tasks were added. */
    val tasks: List<RoomTask> = emptyList(),
    /** Who is changing which files (§9): only what is still in force. */
    val claims: List<RoomClaim> = emptyList(),
    /** Why a session named when the room was made could not be seated. */
    val problems: List<String> = emptyList(),
) {
    /** Message number → handle → where it is. */
    @Transient
    val receipts: Map<Int, Map<String, RoomReceipt>> = rawReceipts.entries.mapNotNull { (seq, of) ->
        val n = seq.toIntOrNull() ?: return@mapNotNull null
        val kept = of.entries.mapNotNull { (h, r) -> RoomReceipt.of(r)?.let { h to it } }.toMap()
        if (kept.isEmpty()) null else n to kept
    }.toMap()

    fun seat(handle: String): RoomSeat? = seats.firstOrNull { it.handle == handle }

    /** The sessions sitting now, in the order they sat down. */
    val sessions: List<RoomSeat> get() = seats.filter { !it.isUser && it.here }

    fun message(seq: Int): RoomMessage? = messages.firstOrNull { it.seq == seq }

    fun task(n: Int): RoomTask? = tasks.firstOrNull { it.n == n }

    /** The tasks of one state: by number, the ones done the last-finished first. */
    fun tasks(state: RoomTaskState): List<RoomTask> =
        tasks.filter { it.state == state }.let { of -> if (state == RoomTaskState.Done) of.sortedByDescending { it.updatedAt } else of.sortedBy { it.n } }

    /** The tasks this one waits for: those that come first and are not done. One taken off the list holds nothing up. */
    fun waitsFor(task: RoomTask): List<Int> =
        if (task.state == RoomTaskState.Done) emptyList() else task.after.filter { n -> task(n)?.let { it.state != RoomTaskState.Done } ?: false }

    /** What a seat says it is changing now; null when nothing, or when its time has passed. */
    fun claim(handle: String, now: Long = System.currentTimeMillis()): RoomClaim? =
        claims.firstOrNull { it.handle == handle && it.until > now && it.paths.isNotEmpty() }
}

/** A room as the list has it. */
@Serializable
data class RoomSummary(
    val id: String,
    val name: String = "",
    val topic: String = "",
    val paused: Boolean = false,
    val createdAt: Long = 0,
    /** Seats taken, the user's among them. */
    val members: Int = 1,
    val faces: List<Sitter> = emptyList(),
    val last: Last? = null,
    /** Messages after what the user has seen; `forYou`: one of them names the user. */
    val unread: Int = 0,
    val forYou: Boolean = false,
    /** The sessions have been talking among themselves this long (§7); null under the room's limit. */
    val rounds: Int? = null,
    /** How the room's work stands (§9). */
    val tasks: RoomTaskCounts = RoomTaskCounts(),
) {
    @Serializable
    data class Last(val seq: Int = 0, val from: String = "", val text: String = "", val at: Long = 0)

    @Serializable
    data class Sitter(val handle: String = "", val face: RoomFace? = null)

    /** The list's second line: who said the last thing and what; the topic before anything was said. */
    val lastLine: String
        get() {
            val last = last ?: return topic.ifEmpty { "还没有消息" }
            return "${if (last.from == RoomSeat.you) "You" else last.from}: ${last.text.replace("\n", " ")}"
        }
}

@Serializable
data class RoomList(val rooms: List<RoomSummary> = emptyList()) {
    /** Messages not seen yet, in all rooms: the tab's badge. */
    val unread: Int get() = rooms.sumOf { it.unread }
}

// MARK: - what the pages make of them

/** One line under a message: a seat it has not reached, and where it is. */
data class RoomReceiptLine(
    val handle: String,
    val tick: String,
    /** `Sent`, `Queued`, `Delivered`, `Ended` — or the seat's own state where that says why (`Reconnecting`, `Signed Out`). */
    val word: String,
    /** It can not be given at all. */
    val failed: Boolean,
) {
    companion object {
        /**
         * The lines for one message, in the order its seats sat down. Said only while it matters: a message everyone
         * has taken has none.
         */
        fun lines(message: RoomMessage, room: RoomDetail): List<RoomReceiptLine> {
            val of = room.receipts[message.seq] ?: return emptyList()
            val order = room.seats.map { it.handle }
            fun place(h: String) = order.indexOf(h).let { if (it < 0) Int.MAX_VALUE else it }
            return of.keys.sortedWith(compareBy<String> { place(it) }.thenBy { it }).map { handle ->
                val receipt = of.getValue(handle)
                val state = room.seat(handle)?.state
                var word = receipt.word
                // One that waits says what for; one that could not be handed over says why — the seat's state, in its word.
                if (receipt == RoomReceipt.Queued && state != null && state.holds) word = state.word
                if (receipt == RoomReceipt.Ended && state != null && state != SeatState.Idle && state != SeatState.Busy && state != SeatState.Waiting) word = state.word
                RoomReceiptLine(handle, receipt.tick, word, receipt == RoomReceipt.Ended)
            }
        }
    }
}

/**
 * The timeline's rows: a speaker's consecutive messages run together under one head; a reply, a new day and a long
 * pause start a new one.
 */
data class RoomRow(
    val message: RoomMessage,
    /** It goes on under the head of the one before: no face, no name. */
    val continues: Boolean,
    /** The first of its day: the day is written above it. */
    val newDay: Boolean,
    /** The message it answers, when the page has it. */
    val quoted: RoomMessage?,
) {
    companion object {
        /** Messages further apart than this do not run together. */
        const val gapMs: Long = 5 * 60_000

        fun day(at: Long, zone: ZoneId = ZoneId.systemDefault()): LocalDate = Instant.ofEpochMilli(at).atZone(zone).toLocalDate()

        fun rows(messages: List<RoomMessage>, zone: ZoneId = ZoneId.systemDefault()): List<RoomRow> {
            val rows = ArrayList<RoomRow>(messages.size)
            var before: RoomMessage? = null
            for (m in messages) {
                val b = before
                val newDay = b == null || day(b.at, zone) != day(m.at, zone)
                val continues = !newDay && m.replyTo == null && b?.from == m.from && m.at - (b?.at ?: m.at) < gapMs
                rows += RoomRow(m, continues, newDay, m.replyTo?.let { n -> messages.firstOrNull { it.seq == n } })
                before = m
            }
            return rows
        }

        /** A quoted message in one line: no code marks, no `@names`. */
        fun quote(text: String): String =
            RoomText.pieces(text, null).mapNotNull { p -> when (p) { is RoomText.Piece.Text -> p.text; is RoomText.Piece.Code -> p.text; is RoomText.Piece.Mention -> null } }
                .joinToString("").replace("\n", " ").replace("  ", " ").trim()
    }
}

/** A message's text in pieces: plain words, `code` between backticks, and the `@names` that are seats of the room. */
object RoomText {
    sealed class Piece {
        data class Text(val text: String) : Piece()
        data class Code(val text: String) : Piece()

        /** A seat's handle (or `all`), without the `@`. */
        data class Mention(val name: String) : Piece()
    }

    private fun wordly(c: Int): Boolean = Character.isLetter(c) || Character.isDigit(c) || c == '_'.code

    /**
     * `handles`: the names that count, lower case; null: every `@name` does. As the service reads them: the `@` stands
     * at the start or after something that is not part of a word (an e-mail address is not a mention).
     */
    fun pieces(text: String, handles: Set<String>?): List<Piece> {
        val pieces = ArrayList<Piece>()
        val plain = StringBuilder()
        fun flush() { if (plain.isNotEmpty()) { pieces += Piece.Text(plain.toString()); plain.setLength(0) } }
        val chars = text.codePoints().toArray()
        fun str(from: Int, to: Int) = String(chars, from, to - from)
        var i = 0
        var before: Int? = null
        while (i < chars.size) {
            val c = chars[i]
            if (c == '`'.code) {
                var end = i + 1
                while (end < chars.size && chars[end] != '`'.code && chars[end] != '\n'.code) end++
                if (end < chars.size && chars[end] == '`'.code && end > i + 1) {
                    flush()
                    pieces += Piece.Code(str(i + 1, end))
                    before = '`'.code
                    i = end + 1
                    continue
                }
            }
            val b = before
            if (c == '@'.code && (b == null || (!wordly(b) && b != '@'.code && b != '.'.code && b != '-'.code)) && i + 1 < chars.size &&
                (Character.isLetter(chars[i + 1]) || Character.isDigit(chars[i + 1]))
            ) {
                var j = i + 1
                while (j < chars.size && (wordly(chars[j]) || chars[j] == '-'.code)) j++
                val name = str(i + 1, j).lowercase()
                if (handles?.contains(name) ?: true) {
                    flush()
                    pieces += Piece.Mention(name)
                    before = chars[j - 1]
                    i = j
                    continue
                }
            }
            plain.appendCodePoint(c)
            before = c
            i++
        }
        flush()
        return pieces
    }

    /** The names a room's messages may mention: its seats and `all`. */
    fun handles(seats: List<RoomSeat>): Set<String> = (seats.map { it.handle } + RoomSeat.all).toSet()
}

/** The `@name` being typed at the end of the reply box, and the seats it may become. */
object RoomMention {
    private fun namely(c: Char) = c.isLetterOrDigit() || c == '_' || c == '-'

    /**
     * What stands after the last `@` when the text ends in one being typed (`"看一下 @da"` → `"da"`, `"@"` → `""`);
     * null when it does not.
     */
    fun query(text: String): String? {
        val at = text.lastIndexOf('@')
        if (at < 0) return null
        if (at > 0) {
            val before = text[at - 1]
            if (before.isLetterOrDigit() || before == '_' || before == '@' || before == '.' || before == '-') return null
        }
        val typed = text.substring(at + 1)
        if (!typed.all(::namely)) return null
        return typed.lowercase()
    }

    /** The seats to offer: the sessions sitting whose name starts with what was typed, then `all` (the user's alone). */
    fun offers(query: String, seats: List<RoomSeat>): List<String> =
        (seats.filter { !it.isUser && it.here }.map { it.handle } + RoomSeat.all).filter { it.startsWith(query) }

    /** The text with the `@name` being typed made whole, a space after it. */
    fun complete(text: String, handle: String): String {
        if (query(text) == null) return text
        return "${text.substring(0, text.lastIndexOf('@'))}@$handle "
    }
}

package com.agentswitch.kit.api

import com.agentswitch.kit.feed.ModelName
import com.agentswitch.kit.support.KitJson
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// AgentSwitch's own terminals, the manual entry (docs/terminal-v0.md §4): what `GET /terminals` lists, what the phone
// may send (a sealed reply, named keys, a resize, a permission decision) and what the stream brings. Unknown fields and
// values decode leniently, so a newer Mac never empties the list.

/** A terminal's state: an agent at work, waiting for the user, idle, or ended. */
@Serializable(with = TerminalStatusSerializer::class)
sealed class TerminalStatus {
    data object Working : TerminalStatus()
    data object Waiting : TerminalStatus()
    data object Idle : TerminalStatus()
    data object Exited : TerminalStatus()
    data class Other(val value: String) : TerminalStatus()

    val rawValue: String
        get() = when (this) {
            Working -> "working"
            Waiting -> "waiting"
            Idle -> "idle"
            Exited -> "exited"
            is Other -> value
        }

    /** The word on screen (docs/ui-v0.md §7.2.7: Busy · Waiting · Idle · Exited). */
    val label: String
        get() = when (this) {
            Working -> "Busy"
            Waiting -> "Waiting"
            Idle -> "Idle"
            Exited -> "Exited"
            is Other -> value
        }

    companion object {
        /** `TerminalStatus(rawValue:)`: the case of that wire word, [Other] for one not known. */
        operator fun invoke(rawValue: String): TerminalStatus = when (rawValue) {
            "working" -> Working
            "waiting" -> Waiting
            "idle" -> Idle
            "exited" -> Exited
            else -> Other(rawValue)
        }
    }
}

object TerminalStatusSerializer : KSerializer<TerminalStatus> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("TerminalStatus", PrimitiveKind.STRING)
    override fun deserialize(decoder: Decoder): TerminalStatus = TerminalStatus(decoder.decodeString())
    override fun serialize(encoder: Encoder, value: TerminalStatus) = encoder.encodeString(value.rawValue)
}

/**
 * One question the agent asks (Claude Code's AskUserQuestion, docs/terminal-v0.md §3 "选择题"): its chip, the question,
 * its options; one to pick or several. One without options takes words only.
 */
@Serializable(with = TerminalQuestionSerializer::class)
data class TerminalQuestion(
    val question: String,
    val header: String = "",
    val multiSelect: Boolean = false,
    val options: List<Option>,
) {
    @Serializable(with = TerminalQuestionOptionSerializer::class)
    data class Option(
        val label: String,
        val description: String = "",
    )
}

internal object TerminalQuestionOptionSerializer : ObjectReader<TerminalQuestion.Option>("TerminalQuestion.Option") {
    override fun read(o: JsonObject) = TerminalQuestion.Option(
        label = o.requireString("label"),
        description = o.lenientString("description") ?: "",
    )
}

internal object TerminalQuestionSerializer : ObjectReader<TerminalQuestion>("TerminalQuestion") {
    override fun read(o: JsonObject) = TerminalQuestion(
        question = o.requireString("question"),
        header = o.lenientString("header") ?: "",
        multiSelect = o.lenientBool("multiSelect") ?: false,
        options = o.lenient("options", ListSerializer(TerminalQuestion.Option.serializer())) ?: emptyList(),
    )
}

/** A permission request from the agent's hook, waiting for a screen's answer. */
@Serializable(with = TerminalPermissionSerializer::class)
data class TerminalPermission(
    val id: String,
    val tool: String,
    /** "Bash: rm -rf build", as the Mac shows it; a question's own words for a question. */
    val summary: String,
    /** Milliseconds since 1970. */
    val at: Long = 0,
    /**
     * The agent asks these (AskUserQuestion): answered with picks, not allow / deny. Empty for any other request, and
     * from a Mac that predates question cards (it shows as a permission then).
     */
    val questions: List<TerminalQuestion> = emptyList(),
) {
    /** The agent asks (a question card), rather than asks leave (allow / deny). */
    val isQuestion: Boolean get() = questions.isNotEmpty()

    /** What it asks, without the tool's name in front ("rm -rf build"). */
    val detail: String
        get() = if (summary.startsWith("$tool: ")) summary.substring(characterIndexAfter(tool.graphemeCount() + 2)) else summary

    // Swift's `dropFirst(n)` counts characters (graphemes); the UTF-16 index of the end of the first n of them.
    private fun characterIndexAfter(n: Int): Int = summary.graphemePrefix(n).length
}

internal object TerminalPermissionSerializer : ObjectReader<TerminalPermission>("TerminalPermission") {
    override fun read(o: JsonObject) = TerminalPermission(
        id = o.requireString("id"),
        tool = o.lenientString("tool") ?: "",
        summary = o.lenientString("summary") ?: "",
        at = o.lenientLong("at") ?: 0,
        questions = o.lenient("questions", ListSerializer(TerminalQuestion.serializer())) ?: emptyList(),
    )
}

/** The tool a terminal's agent is using now and what on (a command, a file, a page), as it reported it before use. */
@Serializable
data class TerminalActivity(
    val tool: String,
    val target: String,
    /** What the agent says this is for, in its own words; the record's line says that in place of the command. */
    val note: String? = null,
) {
    /** As people say it: `运行 npm test`, `修改 /w/a.ts` (the Live Activity's step). */
    val phrase: String
        get() {
            val label = ToolDisplay.label(tool)
            val what = EventDescriber.unwrapShell(target).splitNewlines().firstOrNull() ?: ""
            return if (what.isEmpty()) label else "$label $what"
        }
}

/**
 * A profile's colour (docs/profiles-v0.md §3.2): the lit dot its terminals are marked with. The Mac keeps it by name;
 * what each looks like is here. None is a colour a state is said in (busy, waiting, done, failed), the signal or
 * the accent.
 */
enum class ProfileColor(val rawValue: String, val dark: Int, val light: Int) {
    Violet("violet", 0xB18CFF, 0x7A4FE0),
    Sand("sand", 0xE2C48D, 0x9A7B3F),
    Mint("mint", 0x7FE3C0, 0x1F9A75),
    Orchid("orchid", 0xE08CE8, 0xB043BC),
    Olive("olive", 0xC3C95A, 0x7C8220),
    Slate("slate", 0x9DB2D9, 0x5A719F);

    companion object {
        /** `ProfileColor(rawValue:)`: null for a name not known. */
        fun fromRaw(raw: String): ProfileColor? = entries.firstOrNull { it.rawValue == raw }
    }
}

/**
 * One of an agent's profiles, as much as choosing between them takes (docs/profiles-v0.md §3.3): its name, who is
 * signed in to it, its colour. The Mac's own is `default`.
 */
@Serializable(with = ProfileChoiceSerializer::class)
data class ProfileChoice(
    val id: String,
    val name: String,
    /** Who is signed in, as the agent's own files say; null: nobody yet (or the Mac does not say). */
    val account: String? = null,
    val color: ProfileColor? = null,
    /** Its own proxy (the password is never told, only that it has one); null: this Mac's own way out. */
    val proxy: ProxySetting? = null,
    /** Where that proxy lets traffic out, as last found. */
    val exit: ProxyExit? = null,
    /** It pays by a key (`kind` is `api`): nobody signs in to it. */
    val paysByKey: Boolean = false,
) {
    val isDefault: Boolean get() = id == "default"

    /**
     * Where what runs under it leaves from, in a few words: `This Mac`; with a proxy of its own, where that proxy
     * lets traffic out (`Tokyo 203.0.113.9`), or the proxy's own place while that is not known.
     */
    val way: String get() = ProxyText.way(proxy, exit = exit, none = "This Mac")

    /**
     * `This Mac’s own` for the Mac's own, the account once somebody is signed in, `Not Signed In` till then; `API Key`
     * for one that pays by a key (docs/profiles-v0.md §3.6: nobody signs in to it).
     */
    val who: String get() = if (paysByKey) "API Key" else account ?: (if (isDefault) "This Mac’s own" else "Not Signed In")
}

internal object ProfileChoiceSerializer : ObjectReader<ProfileChoice>("ProfileChoice") {
    override fun read(o: JsonObject): ProfileChoice {
        val id = o.requireString("id")
        return ProfileChoice(
            id = id,
            name = o.lenientString("name") ?: id,
            account = o.lenientString("account")?.takeIf { it.isNotEmpty() },
            color = o.lenientString("color")?.let(ProfileColor::fromRaw),
            proxy = o.lenient("proxy", ProxySetting.serializer()),
            exit = o.lenient("exit", ProxyExit.serializer()),
            paysByKey = o.lenientString("kind") == "api",
        )
    }
}

/** An agent's profiles and the one last chosen for a new terminal. */
@Serializable(with = ProfileChoicesSerializer::class)
data class ProfileChoices(
    val current: String,
    val profiles: List<ProfileChoice>,
) {
    /** There is something to choose between: more than the Mac's own. */
    val several: Boolean get() = profiles.size > 1

    /** What a new terminal is offered first: the one last chosen, while it is still there. */
    val offered: ProfileChoice? get() = profiles.firstOrNull { it.id == current } ?: profiles.firstOrNull()
}

// Swift's synthesized `Decodable`: both fields are required and strict.
internal object ProfileChoicesSerializer : ObjectReader<ProfileChoices>("ProfileChoices") {
    override fun read(o: JsonObject): ProfileChoices {
        val current = o.requireString("current")
        val list = o["profiles"] ?: throw SerializationException("profiles missing")
        return ProfileChoices(current, KitJson.decodeFromJsonElement(ListSerializer(ProfileChoice.serializer()), list))
    }
}

/** The profile a terminal runs under, when it is not the Mac's own (docs/profiles-v0.md §3): its name and its colour. */
@Serializable(with = TerminalProfileSerializer::class)
data class TerminalProfile(
    val name: String,
    /** Null: it has none, or one this app does not know yet. */
    val color: ProfileColor? = null,
)

internal object TerminalProfileSerializer : ObjectReader<TerminalProfile>("TerminalProfile") {
    override fun read(o: JsonObject) = TerminalProfile(
        name = o.lenientString("name") ?: "",
        color = o.lenientString("color")?.let(ProfileColor::fromRaw),
    )
}

@Serializable(with = TerminalInfoSerializer::class)
data class TerminalInfo(
    val id: String,
    val harness: String,
    val cwd: String,
    /**
     * Where the agent is now: the `cwd` its hook calls carry, which follows a `cd` (Claude Code, Codex); the starting
     * folder for the others and from services before 2026-10-01. (The `invoke` below, as Swift's init, takes a null
     * `workdir` as `cwd`.)
     */
    val workdir: String,
    val model: String? = null,
    /**
     * The model the agent says it is on now (Claude Code, each time it changes); null until it has said, and from a Mac
     * that does not ask it. `model` is what the terminal was started with.
     */
    val modelNow: String? = null,
    /** What Claude Code offers as your next message (its prompt suggestion), while it rests and shows one. */
    val suggestion: String? = null,
    /**
     * Codex's Daybreak switch for the session it is on (docs/simple-view-v0.md §5.8); null: this terminal has none
     * (and from a Mac that does not say).
     */
    val daybreak: Boolean? = null,
    /**
     * The Mac can set its model and its level from a screen (`POST …/model`, `…/effort`): its agent takes a command
     * for them, or the terminal's own server does. Null from a Mac that does not say (then Claude Code alone).
     */
    val sets: Boolean? = null,
    /** The thinking level it was started at, in the agent's own word; null: the agent's default. */
    val effort: String? = null,
    /** manual · auto · bypass */
    val mode: String = "manual",
    val name: String,
    val customName: Boolean = false,
    val status: TerminalStatus,
    val cols: Int = 80,
    val rows: Int = 24,
    /** Milliseconds since 1970. */
    val createdAt: Long,
    /** Milliseconds since 1970. */
    val lastOutputAt: Long,
    val exitCode: Int? = null,
    val agentSessionId: String? = null,
    val resumedFrom: String? = null,
    val forked: Boolean = false,
    val permissions: List<TerminalPermission> = emptyList(),
    /** What it is using now, while it works (a service from before 2026-09-30 does not say). */
    val activity: TerminalActivity? = null,
    /** When its status last changed, in milliseconds (older services: null). */
    val statusSince: Long? = null,
    /** Its sub-agents at work, in the order they started (docs/terminal-v0.md §1; older services: none). */
    val subagents: List<TerminalSubagent> = emptyList(),
    /** How far its turn has come, as its own screen counts it (null: it says nothing, or an older service). */
    val progress: TurnProgress? = null,
    /** Replies sent to it that its record does not hold yet (older services: none). */
    val sent: List<SentReply> = emptyList(),
    /** The list its own screen shows to choose from (null: none, or an older service). */
    val choices: ScreenChoices? = null,
    /** What its screen said to commands sent from a screen (older services: none). */
    val notices: List<ScreenNotice> = emptyList(),
    /** The profile it runs under; null: the Mac's own (and from a Mac that does not say). */
    val profile: TerminalProfile? = null,
) {
    /** [createdAt], milliseconds since 1970. */
    val created: Long get() = createdAt

    /** [lastOutputAt], milliseconds since 1970. */
    val lastOutput: Long get() = lastOutputAt
    val isRunning: Boolean get() = status != TerminalStatus.Exited
    val harnessName: String get() = ModelName.harness(harness)

    companion object {
        /** Swift's memberwise `init`: a `workdir` left out (null) is the `cwd`. */
        operator fun invoke(
            id: String, harness: String, cwd: String, workdir: String? = null, model: String? = null, mode: String = "manual", name: String,
            customName: Boolean = false, status: TerminalStatus, cols: Int = 80, rows: Int = 24, createdAt: Long,
            lastOutputAt: Long, exitCode: Int? = null, agentSessionId: String? = null, resumedFrom: String? = null,
            forked: Boolean = false, permissions: List<TerminalPermission> = emptyList(), activity: TerminalActivity? = null, statusSince: Long? = null,
            subagents: List<TerminalSubagent> = emptyList(), modelNow: String? = null, effort: String? = null, suggestion: String? = null,
            daybreak: Boolean? = null, sets: Boolean? = null, progress: TurnProgress? = null, sent: List<SentReply> = emptyList(),
            choices: ScreenChoices? = null, notices: List<ScreenNotice> = emptyList(), profile: TerminalProfile? = null,
        ): TerminalInfo = TerminalInfo(
            id = id, harness = harness, cwd = cwd, workdir = workdir ?: cwd, model = model, modelNow = modelNow, suggestion = suggestion,
            daybreak = daybreak, sets = sets, effort = effort, mode = mode, name = name, customName = customName, status = status,
            cols = cols, rows = rows, createdAt = createdAt, lastOutputAt = lastOutputAt, exitCode = exitCode,
            agentSessionId = agentSessionId, resumedFrom = resumedFrom, forked = forked, permissions = permissions,
            activity = activity, statusSince = statusSince, subagents = subagents, progress = progress, sent = sent,
            choices = choices, notices = notices, profile = profile,
        )
    }
}

internal object TerminalInfoSerializer : ObjectReader<TerminalInfo>("TerminalInfo") {
    override fun read(o: JsonObject): TerminalInfo {
        val id = o.requireString("id")
        val cwd = o.lenientString("cwd") ?: ""
        val createdAt = o.lenientLong("createdAt") ?: 0
        return TerminalInfo(
            id = id,
            harness = o.lenientString("harness") ?: "",
            cwd = cwd,
            workdir = o.lenientString("workdir") ?: cwd,
            model = o.lenientString("model"),
            modelNow = o.lenientString("modelNow"),
            suggestion = o.lenientString("suggestion")?.takeIf { it.isNotEmpty() },
            daybreak = o.lenientBool("daybreak"),
            sets = o.lenientBool("sets"),
            effort = o.lenientString("effort"),
            mode = o.lenientString("mode") ?: "manual",
            name = o.lenientString("name") ?: "",
            customName = o.lenientBool("customName") ?: false,
            status = o.lenientString("status")?.let { TerminalStatus(it) } ?: TerminalStatus.Idle,
            cols = o.lenientInt("cols") ?: 80,
            rows = o.lenientInt("rows") ?: 24,
            createdAt = createdAt,
            lastOutputAt = o.lenientLong("lastOutputAt") ?: createdAt,
            exitCode = o.lenientInt("exitCode"),
            agentSessionId = o.lenientString("agentSessionId"),
            resumedFrom = o.lenientString("resumedFrom"),
            forked = o.lenientBool("forked") ?: false,
            permissions = o.lenient("permissions", ListSerializer(TerminalPermission.serializer())) ?: emptyList(),
            activity = o.lenient("activity", TerminalActivity.serializer()),
            statusSince = o.lenientLong("statusSince"),
            subagents = o.lenient("subagents", ListSerializer(TerminalSubagent.serializer())) ?: emptyList(),
            progress = o.lenient("progress", TurnProgress.serializer()),
            sent = o.lenient("sent", ListSerializer(SentReply.serializer())) ?: emptyList(),
            choices = o.lenient("choices", ScreenChoices.serializer()),
            notices = o.lenient("notices", ListSerializer(ScreenNotice.serializer())) ?: emptyList(),
            profile = o.lenient("profile", TerminalProfile.serializer()),
        )
    }
}

/**
 * A model the new-terminal menu offers, as the agent itself lists it: the id `--model` takes (Claude's `opus` follows
 * the next Opus), the agent's name for it, and whether a newer model of its family superseded it (the menu folds those
 * under `older`, as the agent's own picker does).
 */
@Serializable(with = TerminalModelOptionSerializer::class)
data class TerminalModelOption(
    val id: String,
    val name: String,
    val description: String? = null,
    val older: Boolean = false,
    /**
     * How hard it can be asked to think, lowest first, in the agent's own words (`low … max`; OpenCode: the model's
     * variants). Empty: it takes no level. Null: the Mac does not say (an older Mac, or the agent's list was not read).
     */
    val efforts: List<String>? = null,
    /** The level it uses unless told, when the agent says. */
    val defaultEffort: String? = null,
    /**
     * Codex: whether it runs with Daybreak on and off (`also`), on alone (`only`), off alone (`never`); null when Codex
     * does not say (docs/simple-view-v0.md §5.8).
     */
    val daybreak: String? = null,
)

/** A field Swift reads with `try c.decodeIfPresent`: missing or null is absent, a value of the wrong type fails. */
internal fun JsonObject.strictString(key: String): String? {
    val v = this[key] ?: return null
    if (v is JsonNull) return null
    return (v as? JsonPrimitive)?.takeIf { it.isString }?.content ?: throw SerializationException("$key is not a string")
}

internal fun JsonObject.strictBool(key: String): Boolean? {
    val v = this[key] ?: return null
    if (v is JsonNull) return null
    return lenientBool(key) ?: throw SerializationException("$key is not a bool")
}

internal object TerminalModelOptionSerializer : ObjectReader<TerminalModelOption>("TerminalModelOption") {
    override fun read(o: JsonObject) = TerminalModelOption(
        id = o.requireString("id"),
        name = o.requireString("name"),
        description = o.strictString("description"),
        older = o.strictBool("older") ?: false,
        efforts = o.lenient("efforts", ListSerializer(String.serializer())),
        defaultEffort = o.lenientString("defaultEffort"),
        daybreak = o.lenientString("daybreak"),
    )
}

/**
 * `GET /terminals`: the terminals, the agents this Mac can start, each one's models, and what "default" is today for
 * the agents that say (a Mac that predates it sends none).
 */
@Serializable(with = TerminalListSerializer::class)
data class TerminalList(
    val terminals: List<TerminalInfo>,
    val agents: List<String>,
    val models: Map<String, List<TerminalModelOption>> = emptyMap(),
    val defaults: Map<String, String> = emptyMap(),
    /**
     * Per agent, the thinking levels when no model is chosen (its default model's; pi's one list). None for an agent
     * whose levels belong to a model (OpenCode's variants).
     */
    val efforts: Map<String, List<String>> = emptyMap(),
    /** Per agent, the level its default model uses unless told, when the agent says. */
    val effortDefaults: Map<String, String> = emptyMap(),
    /** Per agent with a Daybreak switch (Codex), how its new sessions start; an agent without one is not named. */
    val daybreak: Map<String, Boolean> = emptyMap(),
)

internal object TerminalListSerializer : ObjectReader<TerminalList>("TerminalList") {
    override fun read(o: JsonObject) = TerminalList(
        terminals = o.lenient("terminals", ListSerializer(TerminalInfo.serializer())) ?: emptyList(),
        agents = o.lenient("agents", ListSerializer(String.serializer())) ?: emptyList(),
        models = o.lenient("models", MapSerializer(String.serializer(), ListSerializer(TerminalModelOption.serializer()))) ?: emptyMap(),
        defaults = o.lenient("defaults", MapSerializer(String.serializer(), String.serializer())) ?: emptyMap(),
        efforts = o.lenient("efforts", MapSerializer(String.serializer(), ListSerializer(String.serializer()))) ?: emptyMap(),
        effortDefaults = o.lenient("effortDefaults", MapSerializer(String.serializer(), String.serializer())) ?: emptyMap(),
        daybreak = o.lenient("daybreak", MapSerializer(String.serializer(), Boolean.serializer())) ?: emptyMap(),
    )
}

/**
 * What the model control under a terminal's reply box opens (docs/simple-view-v0.md §5.4): the agent's models where
 * the Mac can set one for it — Claude Code by its own command, another where the terminal says so (`sets`: a Codex or
 * an OpenCode behind its own server, pi) — else the agent's own picker on its own screen. The phone listed models for
 * Claude Code alone until 2026-10-07 (user, of a Codex terminal: 手机上怎么还是不能选模型).
 */
sealed class TerminalModelMenu {
    /** The terminal has ended. */
    data object Ended : TerminalModelMenu()

    /** Choose one of these (as Codex's Daybreak switch stands, where it has one). */
    data class Models(val options: List<TerminalModelOption>) : TerminalModelMenu()

    /** It takes a model from here, but not while it works or waits for an answer. */
    data object Busy : TerminalModelMenu()

    /** Its own picker, in the terminal view. */
    data object Picker : TerminalModelMenu()

    companion object {
        fun offer(harness: String, sets: Boolean?, exited: Boolean, resting: Boolean, options: List<TerminalModelOption>, daybreak: Boolean?): TerminalModelMenu {
            if (exited) return Ended
            val offered = TerminalDaybreak.offered(options, on = daybreak)
            if (!(sets ?: (harness == "claude-code")) || offered.isEmpty()) return Picker
            return if (resting) Models(offered) else Busy
        }

        /**
         * Whether its level is chosen on the slider here, and when: Claude Code takes one while it works too (the next
         * request of the turn runs at it), the others only at rest. Null: not from here.
         */
        fun levelTakenWhileWorking(harness: String, sets: Boolean?): Boolean? {
            if (!(sets ?: (harness == "claude-code"))) return null
            return harness == "claude-code"
        }
    }
}

/**
 * Codex's Daybreak switch and its models (docs/simple-view-v0.md §5.8; the Mac app has the same rules): with the
 * switch on a turn goes out under the model's Daybreak program, off under its standard one — a model without the one
 * in force cannot run, so it is not offered.
 */
object TerminalDaybreak {
    /**
     * The models to choose from as the switch stands (null: no switch — all of them). One Codex says nothing of
     * stays either way.
     */
    fun offered(options: List<TerminalModelOption>, on: Boolean?): List<TerminalModelOption> {
        if (on == null) return options
        return options.filter { it.daybreak != (if (on) "never" else "only") }
    }

    /**
     * Why the model it is on cannot run as the switch stands, as a line for the user; null when it can (or nothing
     * says otherwise). `name`: the model as the control beside the line writes it.
     */
    fun clash(model: TerminalModelOption?, on: Boolean?, name: String? = null): String? {
        if (on == null || model == null) return null
        val shown = name ?: model.name
        if (on && model.daybreak == "never") return "Codex 的模型列表里 $shown 不支持 Daybreak，开着时它的下一轮会被 Codex 拒绝。换一个模型，或关掉 Daybreak。"
        if (!on && model.daybreak == "only") return "Codex 的模型列表里 $shown 只在 Daybreak 开着时可用，下一轮会被 Codex 拒绝。换一个模型，或打开 Daybreak。"
        return null
    }

    /** The switch as its control's words. */
    fun word(on: Boolean): String = if (on) "Daybreak On" else "Daybreak Off"

    /** What turning it does beyond this session, said in its menu. */
    const val note = "对之后的新一轮生效；Codex 会把它记成新会话的默认"
}

/** `POST /terminals`. Bypass is chosen on the Mac only (the daemon answers 403 to a phone). */
@Serializable
data class NewTerminalRequest(
    val harness: String,
    val cwd: String,
    val model: String? = null,
    /** How hard it thinks, one of the levels the Mac lists for the model; null: the agent's own default. */
    val effort: String? = null,
    val mode: String? = null,
    val cols: Int? = null,
    val rows: Int? = null,
    /**
     * The profile it starts under, by its id (`default`: the Mac's own); null: the one last chosen for a new terminal
     * (docs/profiles-v0.md §3.3).
     */
    val profile: String? = null,
)

/** `POST /terminals/resume`: go on with a session (the same record), or `fork` a new one with its history. */
@Serializable
data class ResumeTerminalRequest(
    val harness: String,
    val cwd: String,
    val agentSessionId: String,
    val title: String? = null,
    val mode: String? = null,
    val fork: Boolean? = null,
    val cols: Int? = null,
    val rows: Int? = null,
    /** The profile it goes on under, by its id (`Resume As`); null: the one it last ran under. */
    val profile: String? = null,
) {
    /** The same, going on in `folder` (the session's own folder is gone). */
    fun continuing(folder: String): ResumeTerminalRequest = copy(cwd = folder)
}

/**
 * What resuming gave: a new terminal, the one already open here, the program that has the session open (only one
 * may write it; the caller may fork instead), or the session's folder gone — moved, renamed or deleted — with folders
 * of the same name the Mac knows and the nearest folder above it still there (the caller picks one and asks again,
 * docs/terminal-v0.md §5).
 */
sealed class ResumeOutcome {
    data class Started(val terminal: TerminalInfo) : ResumeOutcome()
    data class Existing(val terminal: TerminalInfo) : ResumeOutcome()
    data class Elsewhere(val app: String?, val pid: Int?) : ResumeOutcome()
    data class FolderGone(val cwd: String, val alike: List<String>, val near: String?) : ResumeOutcome()
}

/** The named keys `POST /terminals/:id/keys` takes (daemon terminals/keys.ts). */
@Serializable
enum class TerminalKey(val rawValue: String) {
    @SerialName("esc") Esc("esc"),
    @SerialName("tab") Tab("tab"),
    @SerialName("shift-tab") ShiftTab("shift-tab"),
    @SerialName("enter") Enter("enter"),
    @SerialName("backspace") Backspace("backspace"),
    @SerialName("up") Up("up"),
    @SerialName("down") Down("down"),
    @SerialName("left") Left("left"),
    @SerialName("right") Right("right"),
    @SerialName("pgup") PageUp("pgup"),
    @SerialName("pgdn") PageDown("pgdn"),

    /** One notch of the wheel: the Mac sends it the way the program asked (a mouse report, an arrow, or nothing). */
    @SerialName("wheel-up") WheelUp("wheel-up"),
    @SerialName("wheel-down") WheelDown("wheel-down"),
    @SerialName("ctrl-c") CtrlC("ctrl-c"),
    @SerialName("ctrl-d") CtrlD("ctrl-d"),
    @SerialName("ctrl-l") CtrlL("ctrl-l"),
    @SerialName("ctrl-r") CtrlR("ctrl-r"),
    @SerialName("y") Y("y"),
    @SerialName("n") N("n"),
    @SerialName("1") One("1"),
    @SerialName("2") Two("2"),
    @SerialName("3") Three("3"),
    @SerialName("4") Four("4"),
    @SerialName("5") Five("5"),
    @SerialName("6") Six("6"),
    @SerialName("7") Seven("7"),
    @SerialName("8") Eight("8"),
    @SerialName("9") Nine("9"),
}

/** The reply's result: how many credentials the sealer turned into ciphertext on the way in. */
@Serializable(with = TerminalInputResultSerializer::class)
data class TerminalInputResult(
    val sealed: Int,
    /** Files sent with it; null from a Mac that predates attachments (it sent the placeholders as text). */
    val attached: Int? = null,
)

internal object TerminalInputResultSerializer : KSerializer<TerminalInputResult> {
    override val descriptor: SerialDescriptor = JsonElement.serializer().descriptor

    // `try? decoder.container(...)`: anything but an object reads as `{}`.
    override fun deserialize(decoder: Decoder): TerminalInputResult {
        val json = decoder as? kotlinx.serialization.json.JsonDecoder ?: throw SerializationException("JSON only")
        val o = json.decodeJsonElement() as? JsonObject ?: JsonObject(emptyMap())
        return TerminalInputResult(sealed = o.lenientInt("sealed") ?: 0, attached = o.lenientInt("attached"))
    }

    override fun serialize(encoder: Encoder, value: TerminalInputResult) {
        val m = linkedMapOf<String, JsonElement>("sealed" to JsonPrimitive(value.sealed))
        value.attached?.let { m["attached"] = JsonPrimitive(it) }
        encoder.encodeObject(m)
    }
}

/** `GET /terminals/style`: the user's iTerm2 colours (or the built-in set), as CSS colours. */
@Serializable(with = TerminalStyleSerializer::class)
data class TerminalStyle(val theme: Map<String, String>) {
    /** The 16 ANSI colours in order, as 8-bit RGB; null when any is missing or not a #rrggbb colour. */
    val ansi: List<RGB>?
        get() {
            val names = listOf(
                "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed", "brightGreen",
                "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
            )
            val colors = names.mapNotNull { n -> theme[n]?.let { RGB.fromHex(it) } }
            return if (colors.size == names.size) colors else null
        }

    val background: RGB? get() = theme["background"]?.let { RGB.fromHex(it) }
    val foreground: RGB? get() = theme["foreground"]?.let { RGB.fromHex(it) }

    /** 8-bit channels (Swift `UInt8`), 0 to 255. */
    data class RGB(val r: Int, val g: Int, val b: Int) {
        companion object {
            /** `#rrggbb` (the style's colours; `rgba(...)` selection colours are not read). */
            fun fromHex(hex: String): RGB? {
                val s = hex.trim { it.isHorizontalSpace() }
                if (s.length != 7 || !s.startsWith("#")) return null
                var digits = s.substring(1)
                if (digits.startsWith("+")) digits = digits.substring(1) // Swift's UInt32(_, radix:) takes a leading plus
                if (digits.isEmpty() || !digits.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) return null
                val v = digits.toLong(16)
                return RGB(((v shr 16) and 0xFF).toInt(), ((v shr 8) and 0xFF).toInt(), (v and 0xFF).toInt())
            }
        }
    }
}

internal object TerminalStyleSerializer : ObjectReader<TerminalStyle>("TerminalStyle") {
    override fun read(o: JsonObject) = TerminalStyle(
        o.lenient("theme", MapSerializer(String.serializer(), String.serializer())) ?: emptyMap(),
    )
}

/** One event of a terminal's stream (`GET /terminals/:id/stream`). */
sealed class TerminalEvent {
    /** The screen as it is (escape sequences that draw it), at the size it has. */
    data class Snapshot(override val seq: Long, val cols: Int, val rows: Int, val data: String) : TerminalEvent()
    data class Output(override val seq: Long, val data: String) : TerminalEvent()
    data class Status(val status: TerminalStatus) : TerminalEvent()
    data class Name(val name: String) : TerminalEvent()

    /**
     * The size, and the screen that owns it (this phone's, another's, or null when none does: its owner left). Sent on
     * every connect too.
     */
    data class Resize(val cols: Int, val rows: Int, val by: String?) : TerminalEvent()
    data class Permission(val permission: TerminalPermission) : TerminalEvent()
    data class PermissionResolved(val id: String) : TerminalEvent()

    /**
     * Every request waiting, sent on each (re)connect: the screen's list becomes this (one answered elsewhere while
     * the phone was away goes).
     */
    data class Permissions(val permissions: List<TerminalPermission>) : TerminalEvent()
    data class Exit(val code: Int?) : TerminalEvent()

    /** The terminal was closed: screens leave it. */
    data object Removed : TerminalEvent()

    /** What it is doing now changed: the tool and its sub-agents (a stream that follows the record, simple-view-v0 §4). */
    data class Activity(val activity: TerminalActivity?, val subagents: List<TerminalSubagent>) : TerminalEvent()

    /** How far the turn has come changed, as the agent's own screen counts it (null: it says nothing now). */
    data class Progress(val progress: TurnProgress?) : TerminalEvent()

    /** The replies sent and not yet in the record changed. */
    data class Sent(val replies: List<SentReply>) : TerminalEvent()

    /** The list its own screen shows to choose from changed (null: none now). */
    data class Choices(val choices: ScreenChoices?) : TerminalEvent()

    /** What its screen said to commands sent from a screen, the latest last. */
    data class Notices(val notices: List<ScreenNotice>) : TerminalEvent()

    /**
     * Its session's record changed (`rev`, its file's version), or the terminal went to `session`, which has no file
     * yet (`rev` empty). `session`: null from an older Mac, which does not say.
     */
    data class Record(val rev: String, val session: String?) : TerminalEvent()

    /** The agent is on another model now. */
    data class Model(val model: String) : TerminalEvent()

    /** What it offers as your next message changed (null: it offers none now). */
    data class Suggestion(val text: String?) : TerminalEvent()

    /** Codex's Daybreak switch stands otherwise now. */
    data class Daybreak(val on: Boolean) : TerminalEvent()

    /** What it is writing now (docs/simple-view-v0.md §5.14; null: nothing is). */
    data class Writing(val writing: AgentWriting?) : TerminalEvent()

    /** The seq output events carry: the stream resumes after the last one it delivered. */
    open val seq: Long? get() = null

    companion object {
        // What Swift's `as? NSNumber` / `as? Int` / `as? Bool` read out of a JSONSerialization object: a JSON number (a
        // JSON boolean is an NSNumber too, as 1 and 0).
        private fun JsonElement?.numberValue(): Double? {
            val p = this as? JsonPrimitive ?: return null
            if (p is JsonNull || p.isString) return null
            return when (p.content) {
                "true" -> 1.0
                "false" -> 0.0
                else -> p.content.toDoubleOrNull()
            }
        }

        /** `(x as? NSNumber)?.int64Value`: truncated toward zero. */
        private fun JsonElement?.int64Value(): Long? {
            val p = this as? JsonPrimitive ?: return null
            if (p is JsonNull || p.isString) return null
            p.content.toLongOrNull()?.let { return it }
            return numberValue()?.toLong()
        }

        /** `x as? Int`: a whole number. */
        private fun JsonElement?.exactInt(): Int? {
            val d = numberValue() ?: return null
            if (d != Math.rint(d) || Math.abs(d) >= 9.2e18) return null
            return d.toLong().coerceIn(Int.MIN_VALUE.toLong(), Int.MAX_VALUE.toLong()).toInt()
        }

        private fun JsonElement?.stringValue(): String? = (this as? JsonPrimitive)?.takeIf { it !is JsonNull && it.isString }?.content

        private fun <T> decodeOrNull(element: JsonElement?, serializer: KSerializer<T>): T? {
            if (element == null || element is JsonNull) return null
            return try {
                KitJson.decodeFromJsonElement(serializer, element)
            } catch (_: SerializationException) {
                null
            } catch (_: IllegalArgumentException) {
                null
            }
        }

        /** The SSE frame: the event name, the JSON data. Anything unknown or broken is skipped (null), not fatal. */
        fun parse(event: String, data: String): TerminalEvent? {
            val obj = try {
                KitJson.parseToJsonElement(data) as? JsonObject
            } catch (_: SerializationException) {
                null
            } catch (_: IllegalArgumentException) {
                null
            } ?: return null
            fun int(k: String): Int? = obj[k].int64Value()?.coerceIn(Int.MIN_VALUE.toLong(), Int.MAX_VALUE.toLong())?.toInt()
            fun seq(): Long? = obj["seq"].int64Value()
            return when (event) {
                "writing" -> Writing(AgentWriting.decode(data))
                "snapshot" -> {
                    val s = seq() ?: return null
                    val cols = int("cols") ?: return null
                    val rows = int("rows") ?: return null
                    val d = obj["data"].stringValue() ?: return null
                    Snapshot(s, cols, rows, d)
                }
                "output" -> {
                    val s = seq() ?: return null
                    val d = obj["data"].stringValue() ?: return null
                    Output(s, d)
                }
                "status" -> obj["status"].stringValue()?.let { Status(TerminalStatus(it)) }
                "name" -> obj["name"].stringValue()?.let { Name(it) }
                "resize" -> {
                    val cols = int("cols") ?: return null
                    val rows = int("rows") ?: return null
                    Resize(cols, rows, obj["by"].stringValue())
                }
                "permission" -> decodeOrNull(obj["request"], TerminalPermission.serializer())?.let { Permission(it) }
                "permission_resolved" -> obj["id"].stringValue()?.let { PermissionResolved(it) }
                "permissions" -> decodeOrNull(obj["requests"], ListSerializer(TerminalPermission.serializer()))?.let { Permissions(it) }
                "exit" -> Exit(int("code"))
                "removed" -> Removed
                "activity" -> {
                    val activity = decodeOrNull(obj["activity"], TerminalActivity.serializer())
                    val subagents = decodeOrNull(obj["subagents"], ListSerializer(TerminalSubagent.serializer())) ?: emptyList()
                    Activity(activity, subagents)
                }
                "progress" -> {
                    val p = obj["progress"] as? JsonObject
                    val tokens = p?.get("tokens").exactInt()
                    Progress(if (p != null && tokens != null) TurnProgress(tokens = tokens, way = p["way"].stringValue() ?: "down") else null)
                }
                "sent" -> {
                    // `obj["replies"] as? [[String: Any]] ?? []`: one element that is not an object voids the list.
                    val list = obj["replies"] as? JsonArray
                    val objects = list?.map { it as? JsonObject }
                    val replies = if (objects == null || objects.any { it == null }) emptyList() else objects.mapNotNull { r ->
                        r!!
                        val id = r["id"].stringValue()
                        val text = r["text"].stringValue()
                        if (id == null || text == null) null else SentReply(id = id, text = text, at = r["at"].int64Value() ?: 0, files = r["files"].exactInt() ?: 0)
                    }
                    Sent(replies)
                }
                "choices" -> Choices(decodeOrNull(obj["choices"], ScreenChoices.serializer()))
                "notices" -> Notices(decodeOrNull(obj["notices"], ListSerializer(ScreenNotice.serializer())) ?: emptyList())
                "record" -> obj["rev"].stringValue()?.let { Record(rev = it, session = obj["session"].stringValue()) }
                "model" -> obj["model"].stringValue()?.let { Model(it) }
                "suggestion" -> Suggestion(obj["text"].stringValue()?.takeIf { it.isNotEmpty() })
                "daybreak" -> obj["on"].let { v ->
                    val p = v as? JsonPrimitive
                    when {
                        p == null || p is JsonNull || p.isString -> null
                        p.content == "true" -> true
                        p.content == "false" -> false
                        p.content == "1" -> true
                        p.content == "0" -> false
                        else -> null
                    }?.let { Daybreak(it) }
                }
                else -> null
            }
        }
    }
}

/** A folder's git at a glance (docs/terminal-v0.md §1 文件夹行的 git 状态): after its name in the tree, `main ±5 ↑2 ↓4`. */
@Serializable
data class GitSummary(
    /** The branch, or the commit's short id when detached. */
    val branch: String,
    /** Files changed, staged or not, untracked included. */
    val changed: Int = 0,
    val ahead: Int = 0,
    val behind: Int = 0,
) {
    /** As the tree shows it; what is 0 is left out. */
    val said: String
        get() = listOf(branch, if (changed > 0) "±$changed" else "", if (ahead > 0) "↑$ahead" else "", if (behind > 0) "↓$behind" else "")
            .filter { it.isNotEmpty() }.joinToString(" ")
}

@Serializable
internal data class FolderGitList(val folders: Map<String, GitSummary>)

/** A terminal's sub-agent at work (Claude Code's SubagentStart … SubagentStop): under its terminal in the tree. */
@Serializable(with = TerminalSubagentSerializer::class)
data class TerminalSubagent(
    val id: String,
    /** Its kind (Explore, code-reviewer, general-purpose…). */
    val type: String,
    /** What it was sent to do, else its kind. */
    val name: String,
    /** What it is doing now, in words (`运行 git diff`); "" before its first tool call. */
    val doing: String = "",
)

internal object TerminalSubagentSerializer : ObjectReader<TerminalSubagent>("TerminalSubagent") {
    override fun read(o: JsonObject): TerminalSubagent {
        val type = o.lenientString("type") ?: ""
        return TerminalSubagent(
            id = o.requireString("id"),
            type = type,
            name = o.lenientString("name") ?: type,
            doing = o.lenientString("doing") ?: "",
        )
    }
}

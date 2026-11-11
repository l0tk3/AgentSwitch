package com.agentswitch.kit.api

import com.agentswitch.kit.support.KitJson
import java.io.File
import java.time.Instant
import java.time.ZoneId
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// The Mac's files as the Files tab and `+` › Files on Mac show them (docs/files-v0.md §5, §7): one folder's level, one
// entry's details, the start of a text file. Read only; what the phone gives an agent is a path on the Mac
// (`TerminalAttachmentRef.path`), never a copy.

/** A whole number from a JSON number that may be written with a fraction (Swift decodes these as `Double`): rounded toward zero. */
internal fun JsonObject.lenientWhole(key: String): Long? = lenientDouble(key)?.takeIf { it.isFinite() }?.toLong()

/** A field Swift reads with `try c.decodeIfPresent(String.self…)`: missing or null is absent, the wrong type fails. */
internal fun JsonObject.strictStringOrNull(key: String): String? {
    val v = this[key] ?: return null
    if (v is JsonNull) return null
    return (v as? JsonPrimitive)?.takeIf { it.isString }?.content ?: throw SerializationException("$key is not a string")
}

/** `NSString.pathExtension` of the last component: `""` for `.env` and for a name without a dot. */
internal fun nsPathExtension(path: String): String {
    val last = path.trimEnd('/').substringAfterLast('/')
    val dot = last.lastIndexOf('.')
    return if (dot <= 0) "" else last.substring(dot + 1)
}

/** One entry of a folder (`GET /files`). */
@Serializable(with = MacFileEntrySerializer::class)
data class MacFileEntry(
    val name: String,
    val kind: Kind,
    /** Bytes; a folder's is 0. */
    val size: Long = 0,
    /** Last modified, ms since the epoch (Swift holds a `Double`). */
    val mtime: Long = 0,
    val hidden: Boolean = name.startsWith("."),
    /** What tools keep (`.git`, `node_modules`): a step fainter. */
    val dim: Boolean = false,
    /** One of AgentSwitch's own credential places: its name only, it cannot be opened. */
    val locked: Boolean = false,
    /**
     * Not renamed or moved to the Trash from here (docs/files-v0.md §12.2): it holds AgentSwitch's places (the home
     * folder), or it is right under `/`. A locked one is never changed either.
     */
    val fixed: Boolean = false,
    val link: Link? = null,
) {
    @Serializable
    enum class Kind(val rawValue: String) {
        @SerialName("dir") Dir("dir"),
        @SerialName("file") File("file"),
        @SerialName("link") Link("link"),
        @SerialName("other") Other("other"),
    }

    /** A symbolic link: where it points and what is there (`dir`, `file`, `other`, `missing`). */
    @Serializable
    data class Link(val target: String, val kind: String)

    val id: String get() = name

    /** May be renamed and moved to the Trash from the phone. */
    val changeable: Boolean get() = !locked && !fixed

    /** A folder, or a link to one: it opens as a folder. */
    val isFolder: Boolean get() = kind == Kind.Dir || (kind == Kind.Link && link?.kind == "dir")
}

internal fun macKindOf(raw: String?): MacFileEntry.Kind = MacFileEntry.Kind.entries.firstOrNull { it.rawValue == raw } ?: MacFileEntry.Kind.Other

internal object MacFileEntrySerializer : ObjectReader<MacFileEntry>("MacFileEntry") {
    override fun read(o: JsonObject): MacFileEntry {
        val name = o.requireString("name")
        return MacFileEntry(
            name = name,
            kind = macKindOf(o.lenientString("kind")),
            size = o.lenientLong("size") ?: 0,
            mtime = o.lenientWhole("mtime") ?: 0,
            hidden = o.lenientBool("hidden") ?: name.startsWith("."),
            dim = o.lenientBool("dim") ?: false,
            locked = o.lenientBool("locked") ?: false,
            fixed = o.lenientBool("fixed") ?: false,
            link = o.lenient("link", MacFileEntry.Link.serializer()),
        )
    }
}

/** One folder's level. */
@Serializable(with = MacFolderSerializer::class)
data class MacFolder(
    val path: String,
    val parent: String?,
    /** The Mac user's home folder. */
    val home: String,
    val entries: List<MacFileEntry>,
    /** How many more there are than the Mac listed. */
    val more: Int = 0,
    /** Hidden entries left out (asked without them). */
    val hiddenCount: Int = 0,
    /** Only what leads into this device's scope is listed here (docs/files-v0.md §7.5). */
    val scoped: Boolean = false,
) {
    /** The same level with its entries in another order. */
    fun with(entries: List<MacFileEntry>): MacFolder = copy(entries = entries)
}

internal object MacFolderSerializer : ObjectReader<MacFolder>("MacFolder") {
    override fun read(o: JsonObject): MacFolder {
        val list = o["entries"] ?: throw SerializationException("entries missing")
        return MacFolder(
            path = o.requireString("path"),
            parent = o.strictStringOrNull("parent"),
            home = o.lenientString("home") ?: "/",
            entries = KitJson.decodeFromJsonElement(ListSerializer(MacFileEntry.serializer()), list),
            more = o.lenientInt("more") ?: 0,
            hiddenCount = o.lenientInt("hiddenCount") ?: 0,
            scoped = o.lenientBool("scoped") ?: false,
        )
    }
}

/** What kind of file (`GET /files/stat`'s `type`). */
@Serializable
enum class MacFileType(val rawValue: String) {
    @SerialName("text") Text("text"),
    @SerialName("image") Image("image"),
    @SerialName("pdf") Pdf("pdf"),
    @SerialName("audio") Audio("audio"),
    @SerialName("video") Video("video"),
    @SerialName("archive") Archive("archive"),
    @SerialName("binary") Binary("binary"),
}

/** One entry's details (`GET /files/stat`). */
@Serializable(with = MacFileDetailsSerializer::class)
data class MacFileDetails(
    val name: String,
    val kind: MacFileEntry.Kind,
    val size: Long,
    /** Ms since the epoch. */
    val mtime: Long,
    val path: String,
    val type: MacFileType? = null,
    /** A text file's lines, when it is small enough for the Mac to count. */
    val lines: Int? = null,
    /** A folder's entries. */
    val items: Int? = null,
    /** Why it may hold a password or a key (`ssh`, `env`, `login`, `key`, …); null when it is not thought to. */
    val sensitive: String? = null,
    val link: MacFileEntry.Link? = null,
    /** Not renamed or moved from here ([MacFileEntry.fixed]). */
    val fixed: Boolean = false,
) {
    val isFolder: Boolean get() = items != null || kind == MacFileEntry.Kind.Dir
}

internal object MacFileDetailsSerializer : ObjectReader<MacFileDetails>("MacFileDetails") {
    override fun read(o: JsonObject): MacFileDetails =
        MacFileDetails(
            name = o.requireString("name"),
            kind = macKindOf(o.lenientString("kind")),
            size = o.lenientLong("size") ?: 0,
            mtime = o.lenientWhole("mtime") ?: 0,
            path = o.requireString("path"),
            type = o.lenient("type", MacFileType.serializer()),
            lines = o.lenientInt("lines"),
            items = o.lenientInt("items"),
            sensitive = (o["sensitive"] as? JsonObject)?.lenientString("reason"),
            link = o.lenient("link", MacFileEntry.Link.serializer()),
            fixed = o.lenientBool("fixed") ?: false,
        )
}

/** The start of a text file (`GET /files/preview`): up to 64 KB, cut at a whole character. */
@Serializable
data class MacFilePreview(
    val text: String,
    val truncated: Boolean,
    val lines: Int? = null,
    val size: Long,
)

/** Why the Mac did not give what was asked (`{error: <code>}`, docs/files-v0.md §7.1). */
enum class FileRefusal(val rawValue: String) {
    @SerialName("bad-path") BadPath("bad-path"),
    @SerialName("not-folder") NotFolder("not-folder"),
    @SerialName("folder") Folder("folder"),
    @SerialName("not-found") NotFound("not-found"),
    @SerialName("locked") Locked("locked"),
    @SerialName("scope") Scope("scope"),
    @SerialName("permission") Permission("permission"),
    @SerialName("files-off") FilesOff("files-off"),
    @SerialName("too-large") TooLarge("too-large"),
    @SerialName("not-text") NotText("not-text"),
    @SerialName("no-thumbnail") NoThumbnail("no-thumbnail"),

    // Changing files (files-v0 §12.5).
    @SerialName("exists") Exists("exists"),
    @SerialName("bad-name") BadName("bad-name"),
    @SerialName("no-trash") NoTrash("no-trash"),
    @SerialName("in-use") InUse("in-use"),
    @SerialName("changes-off") ChangesOff("changes-off"),
    @SerialName("not-trash") NotTrash("not-trash"),

    /** The Mac has no Files routes (an AgentSwitch from before them). */
    @SerialName("unsupported") Unsupported("unsupported");

    /** What the phone says, in a sentence (files-v0 §3.3, §7.5); `mac` is the Mac's name. */
    fun sentence(mac: String): String = when (this) {
        FilesOff -> "$mac 不允许配对的设备读取文件。可在 $mac 的“设置 › Nodes”中打开。"
        Scope -> "此文件夹不在 $mac 给这台设备的授权范围内。"
        Permission -> "$mac 上的 AgentSwitch 无权访问此文件夹。可在 $mac 的“系统设置 › 隐私与安全性 › 文件与文件夹”中允许。"
        Locked -> "此处存放 AgentSwitch 的凭据，无法在此打开。"
        NotFound -> "此文件夹已不存在。"
        NotFolder, Folder, BadPath -> "无法打开此位置。"
        TooLarge -> "文件超过 25 MB，未下载。"
        NotText -> "无法预览此类文件。"
        NoThumbnail -> "无法生成预览图。"
        Unsupported -> "$mac 上的 AgentSwitch 版本不支持浏览文件，请先更新。"
        Exists -> "此位置已有同名的项目。请换一个名称。"
        BadName -> "此名称不能使用。"
        NoTrash -> "无法移到废纸篓。"
        InUse -> "有终端正在此文件夹中运行。"
        ChangesOff -> "$mac 不允许配对的设备修改文件。可在 $mac 的“设置 › Nodes”中打开。"
        NotTrash -> "此项目不在废纸篓中。"
    }

    companion object {
        /** The refusal an error stands for; null for any other failure (the network, the pairing). */
        fun of(error: Throwable): FileRefusal? {
            if (error !is APIError.Http) return null
            entries.firstOrNull { it.rawValue == error.detail }?.let { return it }
            // The remote listener's own 404 for a route it does not list.
            return if (error.status == 404) Unsupported else null
        }
    }
}

/** Paths on the Mac as the phone takes them apart (they are the Mac's: always `/`, never this phone's file system). */
object MacPath {
    /** One level of a path: its name and its path. */
    data class Level(val name: String, val path: String)

    /** The levels from `/` to `path`: each one's name and its path (`/` itself is named `/`). */
    fun levels(path: String): List<Level> {
        val out = mutableListOf(Level("/", "/"))
        var at = ""
        for (part in path.split("/").filter { it.isNotEmpty() }) {
            at += "/$part"
            out.add(Level(part, at))
        }
        return out
    }

    fun join(folder: String, name: String): String = if (folder == "/") "/$name" else "$folder/$name"

    fun name(path: String): String = if (path == "/") "/" else path.split("/").lastOrNull { it.isNotEmpty() } ?: "/"

    fun parent(path: String): String? {
        if (path == "/") return null
        // `NSString.deletingLastPathComponent`.
        val trimmed = path.trimEnd('/')
        val slash = trimmed.lastIndexOf('/')
        val up = when {
            slash < 0 -> ""
            slash == 0 -> "/"
            else -> trimmed.substring(0, slash).trimEnd('/')
        }
        return up.ifEmpty { "/" }
    }

    /** `path` with the home folder as `~` (lists and titles; the path row keeps the whole of it, files-v0 §3.2). */
    fun short(path: String, home: String): String =
        if (path == home) "~" else if (path.startsWith("$home/")) "~" + path.substring(home.length) else path

    /** `~/x` for a path under a user's home on the Mac, when the Mac's home is not known (the paths carry it). */
    fun tilde(path: String): String {
        // `/Users/Shared` is no one's home.
        if (!path.startsWith("/Users/") || path == "/Users/Shared" || path.startsWith("/Users/Shared/")) return path
        val rest = path.substring("/Users/".length)
        val slash = rest.indexOf('/')
        if (slash < 0) return "~"
        return "~" + rest.substring(slash)
    }
}

/** `⋯` › Sort By: folders first in every order (as the Mac lists them). */
enum class FileSort(val rawValue: String) {
    Name("name"), Modified("modified"), Size("size"), Kind("kind");

    val title: String
        get() = when (this) {
            Name -> "Name"
            Modified -> "Date Modified"
            Size -> "Size"
            Kind -> "Kind"
        }

    fun sorted(entries: List<MacFileEntry>): List<MacFileEntry> {
        if (this == Name) return entries
        // The Mac's order (by name) breaks ties.
        val index = HashMap<String, Int>()
        entries.forEachIndexed { i, e -> index[e.name] = i }
        val sort = this
        return entries.sortedWith(Comparator { a, b ->
            if (a.isFolder != b.isFolder) return@Comparator if (a.isFolder) -1 else 1
            when {
                sort == Modified && a.mtime != b.mtime -> return@Comparator if (a.mtime > b.mtime) -1 else 1
                sort == Size && a.size != b.size -> return@Comparator if (a.size > b.size) -1 else 1
                sort == Kind -> {
                    val ea = nsPathExtension(a.name).lowercase()
                    val eb = nsPathExtension(b.name).lowercase()
                    if (ea != eb) return@Comparator compareScalars(ea, eb)
                }
            }
            (index[a.name] ?: 0).compareTo(index[b.name] ?: 0)
        })
    }
}

/** Swift's `String <`: by Unicode scalars. */
internal fun compareScalars(a: String, b: String): Int {
    var i = 0
    var j = 0
    while (i < a.length && j < b.length) {
        val x = a.codePointAt(i)
        val y = b.codePointAt(j)
        if (x != y) return x.compareTo(y)
        i += Character.charCount(x)
        j += Character.charCount(y)
    }
    return (a.length - i).compareTo(b.length - j)
}

/**
 * A file or folder of the Mac picked for a reply: its path goes to the agent (`TerminalAttachmentRef.path`).
 *
 * Swift's `sensitive` is a `var`; here a `val` (use `copy(sensitive = …)`).
 */
data class MacPick(
    val path: String,
    val isFolder: Boolean,
    /** The Mac thinks it may hold a password (`MacFileDetails.sensitive`): asked about before it lands, marked after. */
    val sensitive: Boolean = false,
) {
    val id: String get() = path
    val name: String get() = MacPath.name(path)
}

/** The question asked before a file that may hold a password goes to an agent (files-v0 §4, §5). */
object SensitiveWarning {
    const val title = "Add to Reply?"

    fun message(names: List<String>): String {
        val after = "交给 agent 后，它能读到其中的内容，并可能发给模型的服务商。"
        if (names.size == 1) return "${names[0]} 可能含有密码或密钥。$after"
        return "这 ${names.size} 个文件可能含有密码或密钥：${names.joinToString("、")}。$after"
    }
}

/**
 * How big a file is, short and in the units the Mac writes (`240 B`, `2.1 KB`, `48 MB`): a number and its unit as they
 * are (docs/ui-v0.md §7.2.7), whatever the phone's language.
 */
object FileSize {
    fun short(bytes: Long): String {
        val b = bytes.toDouble()
        if (bytes < 1024) return "$bytes B"
        if (b < 1024 * 1024) return if (b < 10 * 1024) "${(b / 1024).cFixed(1)} KB" else "${roundAway(b / 1024)} KB"
        if (b < 1024.0 * 1024 * 1024) return if (b < 10.0 * 1024 * 1024) "${(b / 1048576).cFixed(1)} MB" else "${roundAway(b / 1048576)} MB"
        return "${(b / 1073741824).cFixed(1)} GB"
    }
}

/** Swift's `Double.rounded()`: half away from zero. */
internal fun roundAway(x: Double): Long = if (x >= 0) Math.floor(x + 0.5).toLong() else -Math.floor(-x + 0.5).toLong()

/** When a file was last changed, short: `Today 13:02`, `Yesterday`, `10/14`, or `2025/10/14` for another year. */
object FileTime {
    /** `ms` and `now` are milliseconds since 1970; `zone` is Swift's `calendar.timeZone`. */
    fun short(ms: Long, now: Long = System.currentTimeMillis(), zone: ZoneId = ZoneId.systemDefault()): String {
        if (ms <= 0) return ""
        val date = Instant.ofEpochMilli(ms).atZone(zone)
        val day = date.toLocalDate()
        val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
        if (day == today) return "Today %02d:%02d".format(date.hour, date.minute)
        if (day == today.minusDays(1)) return "Yesterday"
        return if (day.year == today.year) "${day.monthValue}/${day.dayOfMonth}" else "${day.year}/${day.monthValue}/${day.dayOfMonth}"
    }
}

/** The Mac's files to a screen: the API, or a made-up disk in the demo screens. */
interface MacFileSource {
    /** One level; `etag` the version the screen has: null back when it has not changed. */
    suspend fun folder(path: String?, hidden: Boolean, etag: String?): VersionedFolder?

    suspend fun fileDetails(path: String): MacFileDetails
    suspend fun filePreview(path: String): MacFilePreview
    suspend fun fileThumbnail(path: String): ByteArray

    /** The bytes into `file`; `progress` from 0 to 1 as they come. */
    suspend fun downloadFile(path: String, to: File, progress: (Double) -> Unit)

    // Changing files (docs/files-v0.md §12.5, §12.8). A refusal is a `FileChangeError`.

    /** A new folder at `path` (and the folders on the way). */
    suspend fun newFolder(path: String): MacMade

    /** A new empty file at `path` (and the folders on the way). */
    suspend fun newFile(path: String): MacMade

    /** `path` given another name in its folder; `force` once a terminal running in it has been asked about. */
    suspend fun rename(path: String, to: String, force: Boolean): String

    /** To the Mac's Trash; `permanent` only after the Trash would not take them. */
    suspend fun trash(paths: List<String>, force: Boolean, permanent: Boolean): List<MacMoved>

    /** The bytes of `file` (on this phone) into `path` on the Mac; `progress` from 0 to 1 as they go. */
    suspend fun upload(file: File, to: String, conflict: UploadConflict, progress: (Double) -> Unit): MacUploaded
}

/** A level and the version the Mac gave it (Swift's `(folder:, etag:)`). */
data class VersionedFolder(val folder: MacFolder, val etag: String?)

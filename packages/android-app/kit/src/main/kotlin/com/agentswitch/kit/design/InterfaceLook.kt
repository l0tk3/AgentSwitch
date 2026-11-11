package com.agentswitch.kit.design

/**
 * The interface's look (docs/ui-v0.md §8, 2026-10-04; user: 设置里应该加入一版“经典设计”的图标和ui，就是那种像经典app一样的
 * 平滑ui、设计和提示，对不喜欢这种geek风格的比较友好): `Pixel`, the visual language of §7 and the default, or `Classic`, a
 * standard app's — the system font, round corners, line icons, standard buttons, dots for status. Only how things are
 * drawn changes: the tabs, the pages, a terminal's own screen and every confirmation stay as they are. Each device keeps
 * its own (the user: 设置各记各的; the Mac app has the same type); the concept page is docs/design/concepts/classic.html.
 *
 * Swift's `InterfaceLook.current` (reads UserDefaults) is not ported: the app holds the setting and passes the look in.
 * `entries` is Swift's `allCases`.
 */
enum class InterfaceLook(val rawValue: String) {
    Pixel("pixel"), Classic("classic");

    /** The setting's two words. */
    val label: String
        get() = when (this) {
            Pixel -> "Pixel"
            Classic -> "Classic"
        }

    val isClassic: Boolean get() = this == Classic

    companion object {
        /** Where the look is kept (the app's own settings store; the app decides how). */
        const val key = "appearance"

        /** The look kept under `key`: what is not one of the two is the default. */
        fun load(raw: String?): InterfaceLook = entries.firstOrNull { it.rawValue == raw } ?: Pixel
    }
}

/**
 * The classic look's short words where they are not the pixel look's (§8, the user: 英文 — the concept page's
 * "经典 · English" column). Everything else is the same word in both looks, without `[ ]` and `//`.
 */
object ClassicWords {
    internal val table: Map<String, String> = mapOf(
        "Busy" to "Working", "Waiting" to "Needs You", "Idle" to "Ready", "Exited" to "Ended",
        "[!] Approval" to "Approval Needed", "[?] Question" to "Question", "? Question" to "Question", "On Mac" to "On This Mac",
        "bypass" to "Bypass", "auto" to "Auto", "plan" to "Plan", "ask" to "Ask", "edits" to "Edits",
        // The phone's card headings (`Approve`, `Answer`): the classic look names the card as the Mac's does.
        "Approve" to "Approval Needed", "Answer" to "Question",
    )

    /**
     * `word` as `look` writes it. A count of things waiting (`2 Waiting`) is `2 Need You` in the classic look, one
     * `1 Needs You`.
     */
    fun word(word: String, look: InterfaceLook): String {
        if (!look.isClassic) return word
        table[word]?.let { return it }
        val parts = word.split(" ").filter { it.isNotEmpty() }
        if (parts.size == 2 && parts[1] == "Waiting") {
            val count = parts[0].toIntOrNull()
            if (count != null) return if (count == 1) "1 Needs You" else "$count Need You"
        }
        return word
    }

    /** A line of short words joined by ` · ` (`Waiting · Run Command`), each as `look` writes it. */
    fun phrase(phrase: String, look: InterfaceLook): String {
        if (!look.isClassic) return phrase
        return phrase.split(" · ").joinToString(" · ") { word(it, look) }
    }

    /** An age as a unit (`3h`) says `3h ago` in the classic look; `Now`, a date and one that says so already stay. */
    fun age(age: String, look: InterfaceLook): String {
        if (!look.isClassic || age.isEmpty()) return age
        val unit = age.last()
        val digits = age.dropLast(1)
        if (unit !in "mhd" || digits.isEmpty() || !digits.all { isNumber(it) }) return age
        return "$age ago"
    }

    /** Swift's `Character.isNumber`: any numeric character (decimal digits, letter numbers, other numbers). */
    private fun isNumber(c: Char): Boolean = when (Character.getType(c).toByte()) {
        Character.DECIMAL_DIGIT_NUMBER, Character.LETTER_NUMBER, Character.OTHER_NUMBER -> true
        else -> false
    }

    /** A button's word: `[ Allow ]` in the pixel look, the word alone in the classic one (its `+` is an icon's job). */
    fun button(word: String, look: InterfaceLook): String {
        if (!look.isClassic) return "[ $word ]"
        return if (word.startsWith("+ ")) word.drop(2) else word
    }

    /** A group's label: `// Status` in the pixel look, `Status` in the classic one. */
    fun label(text: String, look: InterfaceLook): String = if (look.isClassic) text else "// $text"
}

/** One row of the symbol table: a sprite's rows and the SF Symbol name that stands for it. */
data class SymbolEntry(val rows: List<String>, val name: String)

private val symbolTable: List<SymbolEntry> = listOf(
    SymbolEntry(PixelArt.square, "circle.fill"), SymbolEntry(PixelArt.hollow, "circle"), SymbolEntry(PixelArt.lock, "lock"),
    SymbolEntry(PixelArt.picture, "photo"), SymbolEntry(PixelArt.terminalWindow, "terminal"), SymbolEntry(PixelArt.globe, "globe"),
)

/**
 * The system symbols that stand for the pixel marks in the classic look (§8: line icons, SF Symbols natively; only the
 * app's own mark and the agents' are drawn by hand). The names are SF Symbols' own: the Android app maps them to its icons.
 */
val PixelArt.symbols: List<SymbolEntry> get() = symbolTable

/** The symbol for a sprite, by its rows; null for one the classic look draws itself or has no symbol for. */
fun PixelArt.symbol(rows: List<String>): String? = symbolTable.firstOrNull { it.rows == rows }?.name

package com.agentswitch.kit.feed

import com.agentswitch.kit.support.unicodePattern
import kotlinx.serialization.Serializable
import java.util.regex.Pattern

/**
 * Whether a reply about to go to a terminal as typed looks like it holds a password or token (terminal-v0 §1, second
 * round): then the phone offers the sealed send instead. A guess on the phone, with no model — it only has to catch
 * the usual shapes: known token prefixes, a private key, "密码：…" and the like, a long random-looking word. Text
 * already sealed (`enc:v1:…`, `enc:ref:…`) does not count.
 */
object SecretHint {
    private val patterns: List<Pattern> = listOf(
        "sk-[A-Za-z0-9_-]{20,}",                                  // OpenAI, Anthropic
        "gh[pousr]_[A-Za-z0-9]{30,}", "github_pat_[A-Za-z0-9_]{30,}",
        "xox[abpr]-[A-Za-z0-9-]{10,}",                             // Slack
        "AKIA[0-9A-Z]{16}",                                        // AWS
        "AIza[0-9A-Za-z_-]{35}",                                   // Google
        "eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}",   // a JWT
        "-----BEGIN [A-Z ]*PRIVATE KEY-----",
        "(?i)(password|passwd|pwd|passcode|secret|token|api[ _-]?key|密码|口令|验证码|令牌|密钥)\\s*(?:[:：=]|是|为)\\s*\\S{4,}",
    ).map { unicodePattern(it) }
    private val sealed: Pattern = unicodePattern("enc:(?:v1|ref):\\S+")

    fun looksSecret(text: String): Boolean {
        val plain = sealed.matcher(text).replaceAll(" ")
        if (patterns.any { it.matcher(plain).find() }) return true
        return plain.split(Regex("\\s+")).filter { it.isNotEmpty() }.any { randomLooking(it) }
    }

    /** 24 characters or more, upper and lower case and digits, many different ones, and not a path or an address. */
    internal fun randomLooking(word: String): Boolean {
        val points = word.codePoints().toArray()
        if (points.size < 24 || word.contains("/") || word.contains(".") || word.contains("@")) return false
        val hasUpper = points.any { Character.isUpperCase(it) }
        val hasLower = points.any { Character.isLowerCase(it) }
        val hasDigit = points.any { Character.isDigit(it) || Character.getType(it).toByte().let { t -> t == Character.LETTER_NUMBER || t == Character.OTHER_NUMBER } }
        return hasUpper && hasLower && hasDigit && points.toSet().size >= 14
    }
}

/**
 * A slash command the terminal's agent takes (`GET /terminals/:id/commands`): its own, or one of yours (a command
 * file or skill in your home or the project).
 */
@Serializable
data class SlashCommand(
    /** Without the slash: "compact", "frontend:lint". */
    val name: String,
    val description: String,
    /** builtin · user · project */
    val source: String = "builtin",
) {
    val id: String get() = name

    companion object {
        const val shown = 6

        /**
         * The commands `text` may be the start of: while it is a slash and no space yet, names that start with what
         * follows the slash first, then names with a word that does (`/lint` finds `frontend:lint`); at most `shown`.
         */
        fun matching(text: String, commands: List<SlashCommand>): List<SlashCommand> {
            if (!text.startsWith("/") || text.any { it.isWhitespace() }) return emptyList()
            val typed = text.drop(1).lowercase()
            val starts = commands.filter { it.name.lowercase().startsWith(typed) }
            val inside = if (typed.isEmpty()) emptyList() else commands.filter { c ->
                !c.name.lowercase().startsWith(typed) &&
                    c.name.lowercase().split(':', '-', '_').filter { it.isNotEmpty() }.any { it.startsWith(typed) }
            }
            val found = starts + inside
            // A complete name alone needs no list.
            if (found.size == 1 && found[0].name.lowercase() == typed) return emptyList()
            return found.take(shown)
        }
    }
}

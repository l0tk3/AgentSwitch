package com.agentswitch.kit.feed

import com.agentswitch.kit.support.unicodePattern
import java.util.regex.Pattern

/**
 * What a voice reads (app-v0 §5 朗读): the daemon already asks for text written for the ear and cleans it
 * (threads-v0 §3); this is the phone's own pass before speaking — ciphertexts, links, Markdown markers, @ and _ in
 * handles (not in e-mail addresses), long random-looking strings, long runs of digits (ids nobody wants read out) and
 * the daemon's removal marker never reach the synthesizer. `\b` is not used: next to Chinese it does not match.
 */
object Speech {
    private val rules: List<Pair<Pattern, String>> = listOf(
        "(?<![A-Za-z0-9_])enc:(?:v1|ref):[A-Za-z0-9_=-]{8,}" to " ",
        "(?<![A-Za-z0-9_])https?://\\S+" to " ",
        "\\s*\\[removed: not a secret-gate token\\]" to "",
        "(?<![A-Za-z0-9_+/=-])(?=[A-Za-z0-9_+/=-]*[A-Za-z])(?=[A-Za-z0-9_+/=-]*[0-9])[A-Za-z0-9_+/=-]{16,}(?![A-Za-z0-9_+/=-])" to " ",
        "(?m)^\\s*(?:#{1,6}\\s+|[-*+]\\s+|\\d{1,3}[.)]\\s+|>\\s*)" to "",
        "\\*\\*|__|~~|`+" to "",
        "\\|" to " ",
        "(?<![A-Za-z0-9._%+-])@([A-Za-z0-9_]{1,30})" to "$1",
        "(?<=[A-Za-z0-9])_(?=[A-Za-z0-9])" to " ",
        "\\d{8,}" to " ",
        "\\s+" to " ",
        "\\s+([，。！？、；：,.!?;:）」』】])" to "$1",
        "([，。！？、；：（「『【])\\s+" to "$1",
    ).map { unicodePattern(it.first) to it.second }

    fun speakable(text: String): String {
        var out = text
        for ((pattern, template) in rules) out = pattern.matcher(out).replaceAll(template)
        return out.trim()
    }
}

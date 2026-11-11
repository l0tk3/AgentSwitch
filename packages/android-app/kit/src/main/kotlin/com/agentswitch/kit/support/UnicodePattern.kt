package com.agentswitch.kit.support

import java.util.regex.Pattern

/**
 * A pattern whose `\\s`, `\\d`, `\\w` and `\\b` are Unicode's, as the iPhone's (ICU) are. The desktop JVM needs a flag
 * for that; Android's regular expressions are ICU's own — always Unicode — and refuse the flag with an
 * `IllegalArgumentException` (2026-11-11: the Markdown parser loaded on the JVM's tests and crashed the app on the
 * phone). So: with the flag where it is taken, without it where it is not.
 */
fun unicodePattern(regex: String, flags: Int = 0): Pattern =
    try {
        Pattern.compile(regex, flags or Pattern.UNICODE_CHARACTER_CLASS)
    } catch (_: IllegalArgumentException) {
        Pattern.compile(regex, flags)
    }

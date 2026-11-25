package com.agentswitch.kit.support

/** Swift's `CharacterSet.whitespaces`: Unicode category Zs and the tab. */
internal fun isSwiftWhitespace(c: Char): Boolean = c == '\t' || Character.getType(c) == Character.SPACE_SEPARATOR.toInt()

/** Swift's `CharacterSet.whitespacesAndNewlines`: the above, U+000A–U+000D, U+0085, U+2028, U+2029. */
internal fun isSwiftWhitespaceOrNewline(c: Char): Boolean =
    isSwiftWhitespace(c) || c in '\n'..'\r' || c == '\u0085' || c == '\u2028' || c == '\u2029'

/** Swift's `trimmingCharacters(in: .whitespacesAndNewlines)`. */
internal fun String.trimmingWhitespacesAndNewlines(): String = trim(::isSwiftWhitespaceOrNewline)

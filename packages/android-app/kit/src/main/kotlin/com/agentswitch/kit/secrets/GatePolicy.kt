package com.agentswitch.kit.secrets

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
enum class SecretKind(val rawValue: String) {
    @SerialName("secret") Secret("secret"),
    @SerialName("totp") Totp("totp");

    val title: String
        get() = when (this) {
            Secret -> "密码 / token"
            Totp -> "2FA 密钥 (TOTP)"
        }
}

/** Ordered by `rawValue`, as Swift's `Comparable` (the declaration order is the same). */
@Serializable
enum class SecretUse(val rawValue: String) {
    @SerialName("exec") Exec("exec"),
    @SerialName("fill") Fill("fill"),
    @SerialName("http") Http("http"),
    @SerialName("otp") Otp("otp");

    val title: String
        get() = when (this) {
            Http -> "http（代理替换）"
            Otp -> "otp（获取验证码）"
            Exec -> "exec（本地命令模板）"
            Fill -> "fill（仅填写浏览器表单）"
        }
}

sealed class GatePolicyError(message: String) : Exception(message) {
    data object EmptyValue : GatePolicyError("值不可为空")
    data class InvalidLabel(val label: String) :
        GatePolicyError("label 无效：$label（须以字母或数字开头，仅含字母、数字和 . _ / -，最长 64 个字符）")
    data class InvalidHost(val host: String) : GatePolicyError("host 无效：$host")
    data object EmptyUses : GatePolicyError("请至少选择一种用途")
    data object TotpNotBase32 : GatePolicyError("TOTP 密钥须为 base32 格式")
    data object SeedImportNeedsTotp : GatePolicyError("种子导入授权仅适用于 TOTP")
    data class SeedImportNotAllowed(val host: String) : GatePolicyError("种子导入目标须为 host 已允许的确切地址：$host")
}

/**
 * Client-side mirror of `secret_gate/policy.py` and `constants.py`. The gate re-validates when it decrypts, so this
 * only has to be at least as strict; where Python is looser by accident (a trailing newline passing `$`, non-ASCII
 * digits in a port) this rejects.
 */
object GatePolicy {
    const val labelMaxLength = 64

    /** `^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$` */
    fun isValidLabel(label: String): Boolean {
        val scalars = label.codePoints().toArray()
        if (scalars.size !in 1..labelMaxLength || !isAlnum(scalars[0])) return false
        return scalars.drop(1).all { isAlnum(it) || it == '.'.code || it == '_'.code || it == '/'.code || it == '-'.code }
    }

    /**
     * policy.normalize_host: trim, lowercase, split an optional `:port` (1-65535), strip trailing dots from the name,
     * then the name must be `(*.)?label(.label)*` with DNS-style labels. Returns `name` or `name:port`.
     */
    fun normalizeHost(host: String): String {
        val text = host.trimmingWhitespacesAndNewlines().lowercase()
        var (name, port) = splitHostPort(text, original = host)
        name = name.trimEnd('.')
        if (!isValidHostPattern(name)) throw GatePolicyError.InvalidHost(host)
        return if (port != null) "$name:$port" else name
    }

    /** policy.host_matches: exact name or `*.suffix` (not the apex); a pattern port must equal the host's port. */
    fun hostMatches(pattern: String, host: String): Boolean {
        val (pName, pPort) = try { splitHostPort(pattern, original = pattern) } catch (_: GatePolicyError) { return false }
        val (hName, hPort) = try { splitHostPort(host, original = host) } catch (_: GatePolicyError) { return false }
        if (pPort != null && pPort != hPort) return false
        if (pName.startsWith("*.")) {
            val suffix = pName.drop(1)  // ".example.com"
            return hName.endsWith(suffix) && hName.length > suffix.length
        }
        return pName == hName
    }

    /**
     * policy._validate_base32: uppercase, drop spaces, pad to a multiple of 8, then Python's b32decode rules
     * (A-Z2-7 only, padding length one of 0, 1, 3, 4, 6).
     */
    fun isBase32(value: String): Boolean {
        var s = value.uppercase().replace(" ", "")
        val count = s.codePointCount(0, s.length)
        s += "=".repeat((8 - count % 8) % 8)
        val total = s.codePointCount(0, s.length)
        s = s.trimEnd('=')
        val padding = total - s.codePointCount(0, s.length)
        if (!s.codePoints().allMatch { it in 'A'.code..'Z'.code || it in '2'.code..'7'.code }) return false
        return total % 8 == 0 && padding in listOf(0, 1, 3, 4, 6)
    }

    // MARK: - helpers

    internal fun splitHostPort(text: String, original: String): Pair<String, Int?> {
        val colon = text.lastIndexOf(':')
        if (colon < 0) return text to null
        val name = text.substring(0, colon)
        val portText = text.substring(colon + 1)
        val port = if (portText.isNotEmpty() && portText.all { it in '0'..'9' }) portText.toIntOrNull() else null
        if (name.isEmpty() || name.contains(':') || port == null || port !in 1..65535) {
            throw GatePolicyError.InvalidHost(original)
        }
        return name to port
    }

    /** `^(\*\.)?(?:LABEL\.)*LABEL$` with LABEL = `[a-z0-9](?:[a-z0-9-]*[a-z0-9])?` */
    internal fun isValidHostPattern(name: String): Boolean {
        val rest = name.removePrefix("*.")
        val labels = rest.split(".")
        return labels.isNotEmpty() && labels.all(::isValidDNSLabel)
    }

    private fun isValidDNSLabel(label: String): Boolean {
        if (label.isEmpty()) return false
        val lowerAlnum = { c: Char -> c in 'a'..'z' || c in '0'..'9' }
        return lowerAlnum(label.first()) && lowerAlnum(label.last()) && label.all { lowerAlnum(it) || it == '-' }
    }

    private fun isAlnum(s: Int): Boolean = s in 'A'.code..'Z'.code || s in 'a'.code..'z'.code || s in '0'.code..'9'.code
}

/** Swift's `CharacterSet.whitespaces`: Unicode category Zs and the tab. */
internal fun isSwiftWhitespace(c: Char): Boolean = c == '\t' || Character.getType(c) == Character.SPACE_SEPARATOR.toInt()

/** Swift's `CharacterSet.whitespacesAndNewlines`: the above, U+000A–U+000D, U+0085, U+2028, U+2029. */
internal fun isSwiftWhitespaceOrNewline(c: Char): Boolean =
    isSwiftWhitespace(c) || c in '\n'..'\r' || c == '\u0085' || c == '\u2028' || c == '\u2029'

/** Swift's `trimmingCharacters(in: .whitespacesAndNewlines)`. */
internal fun String.trimmingWhitespacesAndNewlines(): String = trim(::isSwiftWhitespaceOrNewline)

/** Swift's `Character.isWhitespace` (the Unicode White_Space property). */
internal fun isUnicodeWhiteSpace(c: Char): Boolean =
    c in '\t'..'\r' || c == ' ' || c == '\u0085' || c == '\u00A0' || c == '\u1680' || c in '\u2000'..'\u200A' ||
        c == '\u2028' || c == '\u2029' || c == '\u202F' || c == '\u205F' || c == '\u3000'

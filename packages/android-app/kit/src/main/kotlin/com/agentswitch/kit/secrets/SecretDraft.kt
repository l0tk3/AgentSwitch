package com.agentswitch.kit.secrets

/**
 * What the mint form holds (a value type the form binds to). `value` is plaintext and lives only in memory; the form
 * clears it after minting.
 */
data class SecretDraft(
    var label: String = "",
    /** comma / space / | / ; separated; bare host[:port], *.example.com, or a URL */
    var sites: String = "",
    var kind: SecretKind = SecretKind.Secret,
    var uses: Set<SecretUse> = websiteUses,
    var value: String = "",
    var note: String = "",
) {
    /** The sites as typed, one per entry. */
    val siteList: List<String>
        get() {
            // Swift splits on Characters, where "\r\n" is one Character and no separator.
            val parts = mutableListOf<String>()
            val current = StringBuilder()
            for ((i, c) in sites.withIndex()) {
                val crlf = c == '\n' && i > 0 && sites[i - 1] == '\r'
                if (!crlf && (c == ',' || c == ' ' || c == '|' || c == ';' || c == '\n' || c == '，')) {
                    parts.add(current.toString())
                    current.setLength(0)
                } else {
                    current.append(c)
                }
            }
            parts.add(current.toString())
            return parts.map { it.trim(::isSwiftWhitespace) }.filter { it.isNotEmpty() }
        }

    /** What the gate binds to: `host[:port]` of each site, deduplicated in order. */
    val hostList: List<String>
        get() = siteList.map(::hostOf).distinct()

    /**
     * Usability checks on top of the gate's rules (same as secret-gate-ui): a token the gate would accept but that
     * could never be used is refused here.
     */
    val problem: String?
        get() {
            if (label.isEmpty()) return "缺少 label"
            if (value.isEmpty()) return "缺少值"
            if (uses.isEmpty()) return "请至少选择一种用途"
            if ((SecretUse.Http in uses || SecretUse.Fill in uses) && hostList.isEmpty()) return "http / fill 用途须填写站点"
            if (SecretUse.Otp in uses && kind != SecretKind.Totp) return "otp 用途仅适用于 TOTP"
            try { payload() } catch (e: GatePolicyError) { return e.message }
            return null
        }

    fun payload(): SecretPayload = SecretPayload.make(value = value, hosts = hostList, uses = uses, label = label, kind = kind)

    /** The note saved with the token: what the user typed, else `label → hosts` so the list stays readable. */
    val effectiveNote: String
        get() {
            val trimmed = note.trimmingWhitespacesAndNewlines()
            if (trimmed.isNotEmpty()) return trimmed
            return if (hostList.isEmpty()) label else "$label → ${hostList.joinToString(", ")}"
        }

    companion object {
        /**
         * A website password: replaced in requests and typed into the page. With the gate running as its own service
         * account (docs/gate-service-v0.md §1) a value without `.fill` is never typed into the browser; API keys can
         * drop it.
         */
        val websiteUses: Set<SecretUse> = setOf(SecretUse.Http, SecretUse.Fill)

        /** `https://user@core.example:8600/login?x` → `core.example:8600`; a bare host passes through. */
        fun hostOf(site: String): String {
            var s = site
            val scheme = s.indexOf("://")
            if (scheme >= 0) s = s.substring(scheme + 3)
            val end = s.indexOfFirst { it == '/' || it == '?' || it == '#' }
            if (end >= 0) s = s.substring(0, end)
            val at = s.lastIndexOf('@')
            if (at >= 0) s = s.substring(at + 1)
            return s
        }
    }
}

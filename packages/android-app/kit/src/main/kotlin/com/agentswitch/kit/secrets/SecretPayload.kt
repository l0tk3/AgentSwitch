package com.agentswitch.kit.secrets

/**
 * Plaintext + policy, validated like `SecretPayload.create` in policy.py. Only [SecretPayload.make] builds one, so a
 * value of this type always passed the gate's rules.
 */
@ConsistentCopyVisibility
data class SecretPayload private constructor(
    val value: String,
    val hosts: List<String>,
    /** Sorted, as Python's `sorted(self.uses)`. */
    val uses: List<SecretUse>,
    val label: String,
    val kind: SecretKind,
    val seedImportHosts: List<String>,
) {
    /** Byte-identical to `SecretPayload.to_json()`: fixed key order, `separators=(",", ":")`, `ensure_ascii=True`. */
    val jsonText: String
        get() {
            val list = { items: List<String> -> "[" + items.joinToString(",") { PythonJSON.string(it) } + "]" }
            return "{\"v\":${PythonJSON.string(value)},\"host\":${list(hosts)},\"use\":${list(uses.map { it.rawValue })}," +
                "\"label\":${PythonJSON.string(label)},\"kind\":${PythonJSON.string(kind.rawValue)}," +
                "\"seed_import_hosts\":${list(seedImportHosts)}}"
        }

    val jsonData: ByteArray get() = jsonText.toByteArray(Charsets.UTF_8)

    companion object {
        fun make(
            value: String,
            hosts: List<String>,
            uses: Set<SecretUse>,
            label: String,
            kind: SecretKind = SecretKind.Secret,
            seedImportHosts: List<String> = emptyList(),
        ): SecretPayload {
            if (value.isEmpty()) throw GatePolicyError.EmptyValue
            if (!GatePolicy.isValidLabel(label)) throw GatePolicyError.InvalidLabel(label)
            if (uses.isEmpty()) throw GatePolicyError.EmptyUses
            val normalized = hosts.map(GatePolicy::normalizeHost)
            if (kind == SecretKind.Totp && !GatePolicy.isBase32(value)) throw GatePolicyError.TotpNotBase32
            val grants = mutableListOf<String>()
            for (host in seedImportHosts.map(GatePolicy::normalizeHost)) if (host !in grants) grants.add(host)
            if (grants.isNotEmpty() && kind != SecretKind.Totp) throw GatePolicyError.SeedImportNeedsTotp
            for (grant in grants) {
                if (grant.contains("*") || normalized.none { GatePolicy.hostMatches(pattern = it, host = grant) }) {
                    throw GatePolicyError.SeedImportNotAllowed(grant)
                }
            }
            return SecretPayload(value, normalized, uses.sortedBy { it.rawValue }, label, kind, grants)
        }
    }
}

/**
 * Python's `json.dumps` string encoding with `ensure_ascii=True`: printable ASCII passes through except `"` and `\`,
 * the usual short escapes, everything else (DEL included) as lowercase `\uXXXX`, astral code points as surrogate pairs.
 */
internal object PythonJSON {
    fun string(s: String): String {
        val out = StringBuilder("\"")
        var i = 0
        while (i < s.length) {
            val scalar = s.codePointAt(i)
            val width = Character.charCount(scalar)
            when {
                scalar == '"'.code -> out.append("\\\"")
                scalar == '\\'.code -> out.append("\\\\")
                scalar == '\n'.code -> out.append("\\n")
                scalar == '\r'.code -> out.append("\\r")
                scalar == '\t'.code -> out.append("\\t")
                scalar == 0x08 -> out.append("\\b")
                scalar == 0x0C -> out.append("\\f")
                scalar in 0x20..0x7E -> out.appendCodePoint(scalar)
                else -> for (unit in s.substring(i, i + width)) out.append("\\u").append("%04x".format(unit.code))
            }
            i += width
        }
        return out.append('"').toString()
    }
}

package com.agentswitch.kit.feed

/**
 * How a stored text reads on the phone: the sealer's legend (router-v0 §9, meant for the agent) is cut off and each
 * ciphertext kept from before shows as a lock.
 */
object MessageDisplay {
    const val tokenMark = "🔒密文"

    /** The start of the daemon's LEGEND_HEADER after the blank line `legend()` puts before it (daemon src/secrets/sealer.ts). */
    internal const val legendStart = "\n\n[AgentSwitch sealed the credentials"
    private val token = Regex("enc:v1:[A-Za-z0-9_-]{16,}={0,2}")

    fun readable(text: String): String {
        val cut = text.indexOf(legendStart)
        val body = if (cut >= 0) text.substring(0, cut) else text
        return token.replace(body, tokenMark)
    }
}

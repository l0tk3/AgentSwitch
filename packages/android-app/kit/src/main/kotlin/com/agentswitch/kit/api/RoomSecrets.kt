package com.agentswitch.kit.api

import kotlinx.serialization.Serializable

// A room's secrets (the service's `rooms/secrets.ts`): ciphertexts sealed by the Mac's gate, never values. The phone
// sees and removes them; adding one needs the gate, so it is done on the Mac.

@Serializable
data class RoomSecret(
    val id: String,
    val name: String = "",
    /** `site` (a login), `api` (a key), `exec` (for a command's environment). */
    val kind: String = "",
    val url: String? = null,
    val account: String? = null,
    val env: String? = null,
    /** The ciphertext (`enc:v1:…`). */
    val token: String = "",
    val addedAt: Long = 0,
) {
    /** The kind's word: 网站登录, API Key, 命令用. */
    val kindWord: String
        get() = when (kind) {
            "site" -> "网站登录"
            "api" -> "API Key"
            "exec" -> "命令用"
            else -> kind
        }

    /** Where and as whom: `url · account · env`, what of it there is. */
    val details: String get() = listOfNotNull(url, account, env).filter { it.isNotBlank() }.joinToString(" · ")

    /** The token cut to `most` characters with `…`. */
    fun shortToken(most: Int = 28): String = if (token.length <= most) token else token.take(most - 1) + "…"
}

@Serializable
data class RoomSecrets(val secrets: List<RoomSecret> = emptyList())

@Serializable private class SecretsDone(val ok: Boolean? = null)

/** The room's secrets, as the Mac keeps them (ciphertexts only). */
suspend fun AgentSwitchAPI.roomSecrets(room: String): List<RoomSecret> = get(listOf("rooms", room, "secrets"), RoomSecrets.serializer()).secrets

/** A secret taken out of the room. */
suspend fun AgentSwitchAPI.deleteRoomSecret(room: String, id: String) {
    perform("DELETE", listOf("rooms", room, "secrets", id), emptyList(), null, SecretsDone.serializer())
}

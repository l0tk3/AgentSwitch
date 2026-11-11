package com.agentswitch.kit.storage

import java.util.concurrent.ConcurrentHashMap

/**
 * What a vault fails with. On the iPhone the vault is the Keychain and the first case carries its `OSStatus`; on
 * Android the vault is the app's (the Android Keystore), so the first case carries the platform's own text.
 */
sealed class VaultError(message: String) : Exception(message) {
    data class Keystore(val detail: String) : VaultError("密钥库错误 $detail")
    data object Corrupt : VaultError("密钥库中的令牌已损坏")
}

/**
 * Where the device token lives. One token per paired Mac, keyed by its certificate fingerprint. The phone's own vault
 * (readable only while the device is unlocked, never backed up or moved to another device) is the app's, over the
 * Android Keystore; the kit has only this interface and the in-memory one.
 */
interface TokenVault {
    fun save(token: String, account: String)
    fun load(account: String): String?
    fun delete(account: String)
}

/** In-memory vault for tests and previews. */
class MemoryTokenVault : TokenVault {
    private val items = ConcurrentHashMap<String, String>()

    override fun save(token: String, account: String) { items[account] = token }
    override fun load(account: String): String? = items[account]
    override fun delete(account: String) { items.remove(account) }
}

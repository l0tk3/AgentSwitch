package com.agentswitch.android.platform

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.agentswitch.kit.storage.TokenVault
import com.agentswitch.kit.storage.VaultError
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Where the device tokens live on this phone (the iPhone's Keychain vault): each token sealed with an AES-256-GCM key
 * that the Android Keystore made and keeps — the key never leaves the phone's secure hardware and cannot be exported —
 * and the sealed bytes in a preferences file of the app's own, which is left out of backups and device transfers
 * (the manifest's `allowBackup="false"` and data extraction rules). One token per paired Mac, by its certificate's
 * fingerprint.
 */
class KeystoreTokenVault(context: Context, private val alias: String = DEFAULT_ALIAS) : TokenVault {
    private val prefs = context.applicationContext.getSharedPreferences("device-tokens", Context.MODE_PRIVATE)

    override fun save(token: String, account: String) {
        try {
            val cipher = Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, key()) }
            val sealed = cipher.doFinal(token.toByteArray(Charsets.UTF_8))
            // The nonce the Keystore chose (12 bytes), then the sealed token with its tag.
            val stored = Base64.encodeToString(cipher.iv + sealed, Base64.NO_WRAP)
            if (!prefs.edit().putString(account, stored).commit()) throw VaultError.Keystore("无法写入")
        } catch (e: VaultError) {
            throw e
        } catch (e: Exception) {
            throw VaultError.Keystore(e.javaClass.simpleName)
        }
    }

    override fun load(account: String): String? {
        val stored = prefs.getString(account, null) ?: return null
        try {
            val bytes = Base64.decode(stored, Base64.NO_WRAP)
            if (bytes.size <= NONCE_BYTES) throw VaultError.Corrupt
            val cipher = Cipher.getInstance(TRANSFORMATION).apply {
                init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, bytes, 0, NONCE_BYTES))
            }
            return String(cipher.doFinal(bytes, NONCE_BYTES, bytes.size - NONCE_BYTES), Charsets.UTF_8)
        } catch (e: VaultError) {
            throw e
        } catch (e: javax.crypto.AEADBadTagException) {
            // Sealed with a key this phone no longer has (the app's data was restored without its Keystore key).
            throw VaultError.Corrupt
        } catch (e: IllegalArgumentException) {
            throw VaultError.Corrupt
        } catch (e: Exception) {
            throw VaultError.Keystore(e.javaClass.simpleName)
        }
    }

    override fun delete(account: String) {
        prefs.edit().remove(account).commit()
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build()
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE).apply { init(spec) }.generateKey()
    }

    companion object {
        const val DEFAULT_ALIAS = "com.agentswitch.android.device-token"
        private const val KEYSTORE = "AndroidKeyStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val NONCE_BYTES = 12
        private const val TAG_BITS = 128
    }
}

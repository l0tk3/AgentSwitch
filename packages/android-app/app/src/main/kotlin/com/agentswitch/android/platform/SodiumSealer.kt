package com.agentswitch.android.platform

import com.agentswitch.kit.secrets.BoxSealer
import com.goterl.lazysodium.LazySodiumAndroid
import com.goterl.lazysodium.SodiumAndroid
import com.goterl.lazysodium.interfaces.Box

/**
 * libsodium on the phone (lazysodium over JNA, the library's own build for Android): the `crypto_box_seal` the kit's
 * `TokenMinter` asks for when a ciphertext is made here (docs/app-v0.md §3). It is the same primitive the gate opens
 * with on the Mac; nothing cryptographic is hand-written in the app.
 */
object SodiumSealer : BoxSealer {
    private val sodium: LazySodiumAndroid by lazy { LazySodiumAndroid(SodiumAndroid()) }

    override fun seal(message: ByteArray, recipientPublicKey: ByteArray): ByteArray {
        val sealed = ByteArray(message.size + Box.SEALBYTES)
        check(sodium.cryptoBoxSeal(sealed, message, message.size.toLong(), recipientPublicKey)) { "crypto_box_seal failed" }
        return sealed
    }

    /**
     * A round trip through libsodium on this device, for the debug self-check: a keypair made here, a message sealed
     * to it and opened again. True when what comes out is what went in.
     */
    fun selfCheck(): Boolean {
        val publicKey = ByteArray(Box.PUBLICKEYBYTES)
        val secretKey = ByteArray(Box.SECRETKEYBYTES)
        if (!sodium.cryptoBoxKeypair(publicKey, secretKey)) return false
        val message = "enc:v1 自检 ✓".toByteArray(Charsets.UTF_8)
        val sealed = seal(message, publicKey)
        val opened = ByteArray(message.size)
        return sodium.cryptoBoxSealOpen(opened, sealed, sealed.size.toLong(), publicKey, secretKey) && opened.contentEquals(message)
    }
}

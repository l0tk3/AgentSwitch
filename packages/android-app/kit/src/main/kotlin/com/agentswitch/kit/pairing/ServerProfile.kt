package com.agentswitch.kit.pairing

import com.agentswitch.kit.api.MacAddresses
import kotlinx.serialization.Serializable

/**
 * Where a paired Mac can be reached: what endpoint selection needs, from either a fresh pairing payload or a saved
 * profile.
 */
interface ServerAddressBook {
    val port: Int
    val fingerprint: String
    val lan: List<String>
    val tailnet: List<String>
    val bonjour: String
}

/** Swift's `extension PairingPayload: ServerAddressBook`: a payload's `fp` is its fingerprint. */
val PairingPayload.fingerprint: String get() = fp

/**
 * The payload as an address book. Swift makes `PairingPayload` itself conform; a Kotlin class cannot be given an
 * interface from outside its declaration, so a payload is handed to selection through this view.
 */
val PairingPayload.addressBook: ServerAddressBook
    get() = PayloadAddressBook(this)

private data class PayloadAddressBook(val payload: PairingPayload) : ServerAddressBook {
    override val port: Int get() = payload.port
    override val fingerprint: String get() = payload.fp
    override val lan: List<String> get() = payload.lan
    override val tailnet: List<String> get() = payload.tailnet
    override val bonjour: String get() = payload.bonjour
}

/** The paired Mac, saved on the phone. Holds no secret: the device token lives in the token vault, keyed by `fingerprint`. */
@Serializable
data class ServerProfile(
    val name: String,
    override val port: Int,
    /** SHA-256 of the server certificate's DER, lowercase hex: the only certificate the phone accepts. */
    override val fingerprint: String,
    override val lan: List<String>,
    override val tailnet: List<String>,
    override val bonjour: String,
    val gate: GateKey?,
    val deviceId: String,
    /** Milliseconds since 1970. */
    val pairedAt: Long,
) : ServerAddressBook {
    constructor(payload: PairingPayload, deviceId: String, gate: GateKey?, pairedAt: Long = System.currentTimeMillis()) : this(
        name = payload.name, port = payload.port, fingerprint = payload.fp, lan = payload.lan, tailnet = payload.tailnet,
        bonjour = payload.bonjour, gate = gate ?: payload.gate, deviceId = deviceId, pairedAt = pairedAt,
    )

    /** A copy with a new gate key (the user switched keypairs on the Mac). */
    fun with(gate: GateKey?): ServerProfile = copy(gate = gate)

    /**
     * A copy with the Mac's current addresses, or null when nothing changes. A kind the Mac reports empty (Tailscale
     * off for a moment, no network) keeps the saved ones; malformed entries are dropped (2026-09-26: a phone paired
     * before the Mac found its Tailscale address never learned it and could not connect off the LAN).
     *
     * The LAN addresses it has now go first and the ones it had before stay behind them, up to `rememberedLAN`
     * (2026-10-07: a Mac that moves between two networks got a new address on each move, and the phone, holding only
     * the last one, needed Bonjour or Tailscale every time to be told again). The certificate is pinned, so an old
     * address that now belongs to something else is refused like any other stranger.
     */
    fun updated(with: MacAddresses): ServerProfile? {
        val current = with.lan.filter(HostAddress::isValid)
        val tailnet = with.tailnet.filter(HostAddress::isValid)
        val seen = HashSet<String>()
        val lan = (current + this.lan).filter { seen.add(it) }.take(rememberedLAN)
        val nextLan = if (current.isEmpty()) this.lan else lan
        val nextTailnet = if (tailnet.isEmpty()) this.tailnet else tailnet
        if (nextLan == this.lan && nextTailnet == this.tailnet) return null
        return copy(lan = nextLan, tailnet = nextTailnet)
    }

    /** Token vault account for this server's device token. */
    val tokenAccount: String get() = fingerprint

    companion object {
        /** How many LAN addresses are kept: the Mac's current ones and the ones it had on networks it was on before. */
        const val rememberedLAN = 8

        /** `ab12 cd34 …` for showing the fingerprint to a human. */
        fun grouped(fingerprint: String): String = fingerprint.chunked(4).joinToString(" ")
    }
}

package com.agentswitch.kit.pairing

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder

/**
 * Every Mac this phone is paired with and the one it talks to now (app-v0 §5 多台 Mac). Macs are told apart by their
 * certificate fingerprint, which also keys each one's device token in the token vault.
 */
@Serializable(with = PairedMacsSerializer::class)
class PairedMacs(servers: List<ServerProfile> = emptyList(), active: String? = null) {
    val servers: List<ServerProfile> = servers

    /** Fingerprint of the current Mac; null only when there is none. */
    val active: String? = active?.takeIf { fp -> servers.any { it.fingerprint == fp } } ?: servers.firstOrNull()?.fingerprint

    val current: ServerProfile? get() = active?.let(::server)
    val isEmpty: Boolean get() = servers.isEmpty()

    fun server(fingerprint: String): ServerProfile? = servers.firstOrNull { it.fingerprint == fingerprint }

    /**
     * A fresh pairing: replaces the Mac with the same fingerprint in place, or adds it at the end; either way it
     * becomes the current one.
     */
    fun adding(profile: ServerProfile): PairedMacs {
        val next = servers.toMutableList()
        val i = next.indexOfFirst { it.fingerprint == profile.fingerprint }
        if (i >= 0) next[i] = profile else next.add(profile)
        return PairedMacs(servers = next, active = profile.fingerprint)
    }

    /** A saved Mac with new details (addresses, gate key); unknown fingerprints change nothing. */
    fun updating(profile: ServerProfile): PairedMacs {
        val i = servers.indexOfFirst { it.fingerprint == profile.fingerprint }
        if (i < 0) return this
        val next = servers.toMutableList()
        next[i] = profile
        return PairedMacs(servers = next, active = active)
    }

    /** Drops a Mac; when it was the current one, the first that is left takes over. */
    fun removing(fingerprint: String): PairedMacs =
        PairedMacs(servers = servers.filter { it.fingerprint != fingerprint }, active = if (active == fingerprint) null else active)

    /** Another saved Mac as the current one; unknown fingerprints change nothing. */
    fun activating(fingerprint: String): PairedMacs {
        if (server(fingerprint) == null) return this
        return PairedMacs(servers = servers, active = fingerprint)
    }

    override fun equals(other: Any?): Boolean = other is PairedMacs && other.servers == servers && other.active == active
    override fun hashCode(): Int = 31 * servers.hashCode() + (active?.hashCode() ?: 0)
    override fun toString(): String = "PairedMacs(servers=$servers, active=$active)"
}

@Serializable
private class PairedMacsWire(val servers: List<ServerProfile>, val active: String? = null)

object PairedMacsSerializer : KSerializer<PairedMacs> {
    override val descriptor: SerialDescriptor = PairedMacsWire.serializer().descriptor
    override fun deserialize(decoder: Decoder): PairedMacs {
        val w = PairedMacsWire.serializer().deserialize(decoder)
        return PairedMacs(w.servers, w.active)
    }
    override fun serialize(encoder: Encoder, value: PairedMacs) =
        PairedMacsWire.serializer().serialize(encoder, PairedMacsWire(value.servers, value.active))
}

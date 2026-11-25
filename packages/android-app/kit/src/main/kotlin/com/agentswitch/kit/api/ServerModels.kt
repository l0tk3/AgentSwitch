package com.agentswitch.kit.api

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder

/** `GET /healthz`. The remote listener answers only `{ok:true}`; the local one adds version and counts. */
@Serializable
data class Health(
    val ok: Boolean,
    val version: String? = null,
)

/** `POST /pair` response. */
@Serializable
data class PairResult(
    val deviceId: String,
    val token: String,
)

/** `GET /addresses`: where the Mac can be reached now. */
@Serializable
data class MacAddresses(
    val lan: List<String>,
    val tailnet: List<String>,
)

/** `GET /me`. app-v0 does not fix the shape yet; every field is optional and `id`/`deviceId` both count. */
@Serializable(with = MeSerializer::class)
data class Me(
    val deviceId: String?,
    val name: String?,
    val platform: String?,
    val createdAt: Long?,
    val lastSeenAt: Long?,
)

@Serializable
private class MeWire(
    val deviceId: String? = null,
    val id: String? = null,
    val name: String? = null,
    val platform: String? = null,
    val createdAt: Long? = null,
    val lastSeenAt: Long? = null,
)

object MeSerializer : KSerializer<Me> {
    override val descriptor: SerialDescriptor = MeWire.serializer().descriptor

    override fun deserialize(decoder: Decoder): Me {
        val w = MeWire.serializer().deserialize(decoder)
        return Me(w.deviceId ?: w.id, w.name, w.platform, w.createdAt, w.lastSeenAt)
    }

    override fun serialize(encoder: Encoder, value: Me) =
        MeWire.serializer().serialize(encoder, MeWire(value.deviceId, null, value.name, value.platform, value.createdAt, value.lastSeenAt))
}

// MARK: - request bodies

@Serializable
data class PairRequest(
    val code: String,
    val name: String,
    val platform: String,
)

@Serializable
class EmptyBody

/** `{ok:true}` replies. */
@Serializable
data class OKReply(val ok: Boolean? = null)

@Serializable
data class ErrorReply(val error: String)

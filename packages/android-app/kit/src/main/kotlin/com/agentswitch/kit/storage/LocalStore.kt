package com.agentswitch.kit.storage

import com.agentswitch.kit.pairing.PairedMacs
import com.agentswitch.kit.pairing.ServerProfile
import com.agentswitch.kit.support.KitJson
import java.io.File
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.UUID
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** A UUID as its string (Swift's `UUID` Codable form; Swift writes it upper-case, this lower-case; both read back). */
object UUIDSerializer : KSerializer<UUID> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("java.util.UUID", PrimitiveKind.STRING)
    override fun deserialize(decoder: Decoder): UUID = UUID.fromString(decoder.decodeString())
    override fun serialize(encoder: Encoder, value: UUID) = encoder.encodeString(value.toString())
}

/**
 * A token saved on the phone: the ciphertext and the user's note, nothing else. It is not a secret (only the Mac's
 * gate can open it), but it is still kept out of logs and the shared clipboard.
 */
@Serializable
data class SavedCiphertext(
    @Serializable(with = UUIDSerializer::class) val id: UUID = UUID.randomUUID(),
    val token: String,
    val note: String,
    /** Milliseconds since 1970. */
    val createdAt: Long = System.currentTimeMillis(),
    /**
     * Fingerprint of the Mac whose gate key sealed it: only that Mac can open it. Null for tokens saved before the
     * phone knew several Macs.
     */
    val mac: String? = null,
) {
    /**
     * Worth offering while `current` is the Mac in use: made for it, untagged, or made for a Mac no longer paired
     * (a Mac set up again after a reinstall comes back with a new fingerprint and most likely the same gate).
     */
    fun usable(current: String?, paired: List<String>): Boolean {
        val mac = mac ?: return true
        return mac == current || !paired.contains(mac)
    }

    /** `enc:v1:AbCd…wXyZ`, enough to tell tokens apart. */
    val shortToken: String
        get() {
            if (token.codePointCount(0, token.length) <= 24) return token
            return "${token.take(15)}…${token.takeLast(6)}"
        }
}

sealed class StoreError(message: String) : Exception(message) {
    /** [detail] is the cause; [message] adds "本地存储失败：". */
    class Io(detail: String) : StoreError("本地存储失败：$detail") {
        val detail: String = detail
        override fun equals(other: Any?): Boolean = other is Io && other.detail == detail
        override fun hashCode(): Int = detail.hashCode()
        override fun toString(): String = "Io(message=$detail)"
    }
}

/**
 * JSON files in the directory the app hands over (its own files directory): the paired Macs and the saved
 * ciphertexts. No plaintext secret and no device token ever goes here (the token is in the token vault). Each write
 * goes to a temporary file in the same directory that then replaces the old one, so a file is never half-written.
 * Swift's `LocalStore.standard()` (Application Support) is the app's to choose here.
 */
class LocalStore(val directory: File) {
    private val macsFile: File get() = File(directory, "macs.json")

    /** The one Mac of the versions before 2026-09-27, moved into `macs.json` on first load. */
    private val legacyProfileFile: File get() = File(directory, "server.json")
    private val ciphertextsFile: File get() = File(directory, "ciphertexts.json")

    fun loadMacs(): PairedMacs {
        read(PairedMacs.serializer(), macsFile)?.let { return PairedMacs(servers = it.servers, active = it.active) }
        val legacy = read(ServerProfile.serializer(), legacyProfileFile) ?: return PairedMacs()
        val macs = PairedMacs(servers = listOf(legacy))
        saveMacs(macs)
        remove(legacyProfileFile)
        return macs
    }

    fun saveMacs(macs: PairedMacs) = write(PairedMacs.serializer(), macs, macsFile)

    fun loadCiphertexts(): List<SavedCiphertext> = read(ListSerializer(SavedCiphertext.serializer()), ciphertextsFile) ?: emptyList()
    fun saveCiphertexts(items: List<SavedCiphertext>) = write(ListSerializer(SavedCiphertext.serializer()), items, ciphertextsFile)

    // MARK: - files

    private fun <T> read(serializer: KSerializer<T>, file: File): T? {
        if (!file.exists()) return null
        try {
            return KitJson.decodeFromString(serializer, file.readText(Charsets.UTF_8))
        } catch (e: Exception) {
            throw StoreError.Io("${file.name}: ${e.message ?: e}")
        }
    }

    private fun <T> write(serializer: KSerializer<T>, value: T, file: File) {
        try {
            directory.mkdirs()
            if (!directory.isDirectory) throw java.io.IOException("cannot create ${directory.path}")
            val text = pretty.encodeToString(JsonElement.serializer(), sortedKeys(KitJson.encodeToJsonElement(serializer, value)))
            val temp = File.createTempFile(".${file.name}", ".tmp", directory)
            try {
                temp.writeText(text, Charsets.UTF_8)
                try {
                    Files.move(temp.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
                } catch (e: AtomicMoveNotSupportedException) {
                    Files.move(temp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING)
                }
            } finally {
                temp.delete()
            }
        } catch (e: StoreError) {
            throw e
        } catch (e: Exception) {
            throw StoreError.Io("${file.name}: ${e.message ?: e}")
        }
    }

    private fun remove(file: File) {
        if (!file.exists()) return
        if (!file.delete()) throw StoreError.Io("cannot remove ${file.name}")
    }

    private companion object {
        val pretty = Json(from = KitJson) { prettyPrint = true }

        /** As Swift's `.sortedKeys`. */
        fun sortedKeys(element: JsonElement): JsonElement = when (element) {
            is JsonObject -> JsonObject(element.entries.sortedBy { it.key }.associate { it.key to sortedKeys(it.value) })
            is JsonArray -> JsonArray(element.map(::sortedKeys))
            else -> element
        }
    }
}

package com.agentswitch.kit.storage

import com.agentswitch.kit.pairing.PairedMacs
import com.agentswitch.kit.pairing.ServerProfile
import com.agentswitch.kit.support.KitJson
import java.io.File
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

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
 * JSON files in the directory the app hands over (its own files directory): the paired Macs. No plaintext secret and no device token ever goes here (the token is in the token vault). Each write
 * goes to a temporary file in the same directory that then replaces the old one, so a file is never half-written.
 * Swift's `LocalStore.standard()` (Application Support) is the app's to choose here.
 */
class LocalStore(val directory: File) {
    private val macsFile: File get() = File(directory, "macs.json")

    /** The one Mac of the versions before 2026-09-27, moved into `macs.json` on first load. */
    private val legacyProfileFile: File get() = File(directory, "server.json")

    fun loadMacs(): PairedMacs {
        read(PairedMacs.serializer(), macsFile)?.let { return PairedMacs(servers = it.servers, active = it.active) }
        val legacy = read(ServerProfile.serializer(), legacyProfileFile) ?: return PairedMacs()
        val macs = PairedMacs(servers = listOf(legacy))
        saveMacs(macs)
        remove(legacyProfileFile)
        return macs
    }

    fun saveMacs(macs: PairedMacs) = write(PairedMacs.serializer(), macs, macsFile)

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

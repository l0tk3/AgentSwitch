package com.agentswitch.kit

import java.io.File
import java.nio.file.Files
import kotlin.concurrent.thread

/** Runs a local helper process (the Python gate) for the opt-in integration tests. */
class ProcessResult(val status: Int, val stdout: String, val stderr: String)

object Proc {
    fun run(executable: String, args: List<String>, env: Map<String, String> = emptyMap(), stdin: ByteArray? = null): ProcessResult {
        val builder = ProcessBuilder(listOf(executable) + args)
        builder.environment().putAll(env)
        val p = builder.start()
        var err = ByteArray(0)
        val errReader = thread { err = p.errorStream.readBytes() }
        p.outputStream.use { if (stdin != null) it.write(stdin) }
        val out = p.inputStream.readBytes()
        errReader.join()
        val status = p.waitFor()
        return ProcessResult(status, out.decodeToString(), err.decodeToString())
    }

    fun temporaryDirectory(prefix: String): File = Files.createTempDirectory("$prefix-").toFile()

    /**
     * The repository's `packages/` folder: Swift finds it from its own source path; here it is the environment's
     * `AGENTSWITCH_PACKAGES`, or null when that is not set.
     */
    val packagesRoot: File? get() = System.getenv("AGENTSWITCH_PACKAGES")?.let(::File)
}

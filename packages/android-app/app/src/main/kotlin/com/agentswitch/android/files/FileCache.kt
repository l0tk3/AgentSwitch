package com.agentswitch.android.files

import android.content.Context
import java.io.File

/**
 * Downloads live under `cacheDir/agentswitch-files` (the only folder the `FileProvider` exposes), emptied the first
 * time anything asks for it in a process — which is when the app starts, before any file was downloaded.
 */
object FileCache {
    private var cleared = false

    fun root(context: Context): File {
        val root = File(context.cacheDir, "agentswitch-files")
        if (!cleared) { cleared = true; root.deleteRecursively() }
        return root
    }
}

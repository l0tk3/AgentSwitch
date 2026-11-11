package com.agentswitch.kit.api

import kotlinx.serialization.Serializable

/**
 * A newer AgentSwitch.app waiting on the Mac, and how the last switch went (assistant-v0 §5). Build times are the ISO
 * strings of the Mac's build script.
 */
@Serializable
data class AppUpdateInfo(
    val running: String? = null,
    val staged: String? = null,
    val last: UpdateOutcome? = null,
) {
    val canInstall: Boolean get() = staged != null
}

@Serializable
data class UpdateOutcome(
    val ok: Boolean,
    val reverted: Boolean,
    val from: String,
    val to: String,
    val reason: String,
)

@Serializable
data class InstallRequested(val requested: Boolean)

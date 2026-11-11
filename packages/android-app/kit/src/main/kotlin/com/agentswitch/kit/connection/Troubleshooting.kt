package com.agentswitch.kit.connection

import com.agentswitch.kit.api.EndpointKind
import com.agentswitch.kit.pairing.ServerAddressBook

/**
 * 设置 › Mac › 排障 (control-v0 §5): what the last route choice found, line by line, and the usual reasons a phone
 * cannot reach its Mac. Next to 「上次选择线路」, which has the raw per-address detail.
 */
object Troubleshooting {
    data class Check(
        val title: String,
        /** null: not known (not tried, or not needed because a better line answered first). */
        val ok: Boolean?,
        val detail: String,
    ) {
        val id: String get() = title
    }

    fun checks(state: ConnectionState, reports: List<ProbeReport>?, book: ServerAddressBook): List<Check> =
        listOf(macCheck(state)) + listOf(
            lineCheck("LAN", kinds = setOf(EndpointKind.Bonjour, EndpointKind.Lan), hasAddresses = book.lan.isNotEmpty(), reports = reports,
                missing = "无局域网地址（Mac 可能在配对后更换了网络）。"),
            lineCheck("Tailscale", kinds = setOf(EndpointKind.Tailnet), hasAddresses = book.tailnet.isNotEmpty(), reports = reports,
                missing = "Mac 无 Tailscale 地址。在 Mac 上登录 Tailscale 后，离开当前 Wi-Fi 时也可连接。"),
        )

    internal fun macCheck(state: ConnectionState): Check = when (state) {
        is ConnectionState.Connected -> Check(title = "Mac", ok = true, detail = "已通过 ${state.value.kind.title} 连接")
        ConnectionState.Selecting, ConnectionState.Idle -> Check(title = "Mac", ok = null, detail = "正在选择线路")
        ConnectionState.Unreachable -> Check(title = "Mac", ok = false, detail = "所有线路均无响应")
        ConnectionState.Unauthorized -> Check(title = "Mac", ok = false, detail = "配对已失效，请重新配对。")
        is ConnectionState.PinMismatch -> Check(title = "Mac", ok = false, detail = "服务器证书与配对时不一致")
    }

    internal fun lineCheck(title: String, kinds: Set<EndpointKind>, hasAddresses: Boolean, reports: List<ProbeReport>?, missing: String): Check {
        val mine = (reports ?: emptyList()).filter { it.endpoint.kind in kinds }
        if (mine.isEmpty()) {
            if (!hasAddresses) return Check(title = title, ok = false, detail = missing)
            return Check(title = title, ok = null, detail = "未尝试")
        }
        if (mine.any { it.outcome == ProbeOutcome.Ok }) return Check(title = title, ok = true, detail = "OK")
        val reasons = mine.mapNotNull { report ->
            when (val outcome = report.outcome) {
                is ProbeOutcome.Unreachable -> outcome.reason
                is ProbeOutcome.PinMismatch -> "证书不一致"
                ProbeOutcome.Unauthorized -> "配对已失效"
                ProbeOutcome.Ok, null -> null
            }
        }
        val reason = reasons.firstOrNull() ?: return Check(title = title, ok = null, detail = "Unused · 已通过其他线路连接")
        return Check(title = title, ok = false, detail = "无法连接：$reason")
    }

    /** The usual reasons, most common first. */
    val causes: List<String> = listOf(
        "Mac 处于睡眠状态，或 AgentSwitch 未运行。",
        "手机与 Mac 不在同一 Wi-Fi，且手机上的 Tailscale 未开启。",
        "Mac 更换了网络，而当前 Wi-Fi 不允许设备相互发现。开启 Tailscale 连接一次，或用手机重新扫描 Mac 上的配对二维码，手机即记下新地址。",
        "其他 VPN 应用正在使用 VPN 通道，Tailscale 未连接（Android 同一时间只允许一个 VPN）。",
        "Mac 上的 AgentSwitch 重装或重置后证书已更换。请重新配对。",
    )
}

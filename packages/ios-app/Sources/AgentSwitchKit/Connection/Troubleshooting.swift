import Foundation

/// 设置 › Mac › 排障 (control-v0 §5): what the last route choice found, line by line, and the usual reasons a phone
/// cannot reach its Mac. Next to 「上次选择线路」, which has the raw per-address detail.
public enum Troubleshooting {
    public struct Check: Sendable, Hashable, Identifiable {
        public let title: String
        /// nil: not known (not tried, or not needed because a better line answered first).
        public let ok: Bool?
        public let detail: String

        public init(title: String, ok: Bool?, detail: String) {
            self.title = title
            self.ok = ok
            self.detail = detail
        }

        public var id: String { title }
    }

    public static func checks(state: ConnectionState, reports: [ProbeReport]?, book: any ServerAddressBook) -> [Check] {
        [macCheck(state)] + [
            lineCheck("LAN", kinds: [.bonjour, .lan], hasAddresses: !book.lan.isEmpty, reports: reports,
                      missing: "无局域网地址（Mac 可能在配对后更换了网络）。"),
            lineCheck("Tailscale", kinds: [.tailnet], hasAddresses: !book.tailnet.isEmpty, reports: reports,
                      missing: "Mac 无 Tailscale 地址。在 Mac 上登录 Tailscale 后，离开当前 Wi-Fi 时也可连接。"),
        ]
    }

    static func macCheck(_ state: ConnectionState) -> Check {
        switch state {
        case .connected(let endpoint): return Check(title: "Mac", ok: true, detail: "已通过 \(endpoint.kind.title) 连接")
        case .selecting, .idle: return Check(title: "Mac", ok: nil, detail: "正在选择线路")
        case .unreachable: return Check(title: "Mac", ok: false, detail: "所有线路均无响应")
        case .unauthorized: return Check(title: "Mac", ok: false, detail: "配对已失效，请重新配对。")
        case .pinMismatch: return Check(title: "Mac", ok: false, detail: "服务器证书与配对时不一致")
        }
    }

    static func lineCheck(_ title: String, kinds: Set<EndpointKind>, hasAddresses: Bool, reports: [ProbeReport]?, missing: String) -> Check {
        let mine = (reports ?? []).filter { kinds.contains($0.endpoint.kind) }
        if mine.isEmpty {
            if !hasAddresses { return Check(title: title, ok: false, detail: missing) }
            return Check(title: title, ok: nil, detail: "未尝试")
        }
        if mine.contains(where: { $0.outcome == .ok }) { return Check(title: title, ok: true, detail: "OK") }
        let reasons = mine.compactMap { report -> String? in
            switch report.outcome {
            case .unreachable(let reason)?: return reason
            case .pinMismatch?: return "证书不一致"
            case .unauthorized?: return "配对已失效"
            case .ok?, nil: return nil
            }
        }
        guard let reason = reasons.first else { return Check(title: title, ok: nil, detail: "Unused · 已通过其他线路连接") }
        return Check(title: title, ok: false, detail: "无法连接：\(reason)")
    }

    /// The usual reasons, most common first.
    public static let causes: [String] = [
        "Mac 处于睡眠状态，或 AgentSwitch 未运行。",
        "iPhone 与 Mac 不在同一 Wi-Fi，且 iPhone 上的 Tailscale 未开启。",
        "其他 VPN 应用正在使用 VPN 通道，Tailscale 未连接（iOS 同一时间只允许一个 VPN）。",
        "Mac 上的 AgentSwitch 重装或重置后证书已更换。请重新配对。",
    ]
}

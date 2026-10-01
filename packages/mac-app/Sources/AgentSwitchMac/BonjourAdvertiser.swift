import AgentSwitchMacCore
import Foundation

/// Publishes `_agentswitch._tcp` for the daemon's remote port (the daemon owns the socket, so this is a plain
/// registration, not a listener). Re-registers only when name, port or TXT change.
@MainActor
final class BonjourAdvertiser: NSObject, NetServiceDelegate {
    private var service: NetService?
    private var current: BonjourRecord.Advertisement?
    private var published = false
    private var watchdog: Task<Void, Never>?
    var onStatus: (@MainActor (StatusLine) -> Void)?
    /// A registration that neither succeeds nor fails this long is almost always macOS's Local Network privacy
    /// holding it (a pending prompt or a denied switch for this app).
    static let publishTimeout: Duration = .seconds(10)

    func update(_ next: BonjourRecord.Advertisement?) {
        guard next != current else { return }
        watchdog?.cancel()
        service?.stop()
        service = nil
        published = false
        current = next
        guard let next else {
            onStatus?(StatusLine("Off", .off))
            return
        }
        let s = NetService(domain: BonjourRecord.domain, type: BonjourRecord.serviceType, name: next.name, port: Int32(next.port))
        s.delegate = self
        s.setTXTRecord(NetService.data(fromTXTRecord: next.txt))
        s.publish()
        service = s
        onStatus?(StatusLine("Publishing", .busy))
        watchdog = Task { [weak self] in
            try? await Task.sleep(for: BonjourAdvertiser.publishTimeout)
            guard let self, !Task.isCancelled, !self.published, self.service === s else { return }
            self.onStatus?(StatusLine("Blocked：请在“系统设置 › 隐私与安全性 › 本地网络”中允许 AgentSwitch。", .warning))
        }
    }

    nonisolated func netServiceDidPublish(_ sender: NetService) {
        let port = sender.port
        MainActor.assumeIsolated {
            published = true
            onStatus?(StatusLine("Published · Port \(port)", .ok))
        }
    }

    nonisolated func netService(_ sender: NetService, didNotPublish errorDict: [String: NSNumber]) {
        let code = errorDict[NetService.errorCode]?.intValue ?? 0
        MainActor.assumeIsolated { onStatus?(StatusLine("发布失败（NetService 错误 \(code)）", .warning)) }
    }
}

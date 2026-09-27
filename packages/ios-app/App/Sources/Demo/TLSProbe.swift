#if DEBUG
import AgentSwitchKit
import Foundation

/// Debug builds, `-tlsProbe host1,host2 -tlsProbePin <fp>`: one pinned GET /healthz per host through the app's own
/// transport, results (with the underlying stream error) in Documents/tlsprobe.txt. For "why does iOS refuse this
/// address" without a paired Mac (2026-09-27: Tailscale addresses failed with a TLS error in 0.1 s).
enum TLSProbe {
    static func run(hosts: [String], pin: String) {
        Task.detached {
            let delegate = PinnedTrustDelegate(fingerprint: pin)
            let session = URLSession(configuration: PinnedSessionTransport.defaultConfiguration(), delegate: delegate, delegateQueue: nil)
            var lines: [String] = []
            for host in hosts {
                var request = URLRequest(url: URL(string: "https://\(host):4713/healthz")!)
                request.timeoutInterval = 6
                let start = Date()
                do {
                    let (data, _) = try await session.data(for: request)
                    lines.append("\(host) OK \(String(decoding: data, as: UTF8.self)) \(Date().timeIntervalSince(start))")
                } catch let error as NSError {
                    let stream = error.userInfo["_kCFStreamErrorCodeKey"].map { "\($0)" } ?? "-"
                    let under = (error.userInfo[NSUnderlyingErrorKey] as? NSError).map { "\($0.domain) \($0.code)" } ?? "-"
                    lines.append("\(host) FAIL \(Date().timeIntervalSince(start)) code=\(error.code) stream=\(stream) under=\(under) mismatch=\(delegate.takeMismatch(host: host) ?? "none")")
                }
            }
            let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("tlsprobe.txt")
            try? lines.joined(separator: "\n").write(to: url, atomically: true, encoding: .utf8)
        }
    }
}
#endif

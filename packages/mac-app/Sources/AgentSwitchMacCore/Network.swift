import Darwin
import Foundation

/// Tailscale presence through its CLI (app-v0 §4: without it the phone only works on the same LAN).
public struct TailscaleStatus: Sendable, Equatable {
    public enum State: String, Sendable { case notInstalled, stopped, running }

    public let state: State
    public let binary: String?
    public let backendState: String?
    public let dnsName: String?
    public let ipv4: [String]

    public static let notInstalled = TailscaleStatus(state: .notInstalled, binary: nil, backendState: nil, dnsName: nil, ipv4: [])

    public init(state: State, binary: String?, backendState: String?, dnsName: String?, ipv4: [String]) {
        self.state = state
        self.binary = binary
        self.backendState = backendState
        self.dnsName = dnsName
        self.ipv4 = ipv4
    }

    public var summary: String {
        switch state {
        case .notInstalled: return "没装 Tailscale：手机只能在同一局域网里使用"
        case .stopped: return "Tailscale 已安装但没有连接（\(backendState ?? "未知")）：打开 Tailscale 登录后，手机在外也能连"
        case .running: return "Tailscale 已连接：" + (ipv4 + [dnsName].compactMap { $0 }).joined(separator: " · ")
        }
    }
}

public enum Tailscale {
    public static let appBinary = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
    /// Without it (or a TERM) the app bundle's binary tries to launch the GUI instead of answering as the CLI.
    public static let cliModeVariable = "TAILSCALE_BE_CLI"

    /// Pure: `tailscale status --json` → backend state, MagicDNS name without the trailing dot, IPv4s.
    public static func parse(statusJSON data: Data) -> (backendState: String?, dnsName: String?, ipv4: [String]) {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return (nil, nil, []) }
        let backend = object["BackendState"] as? String
        let me = object["Self"] as? [String: Any]
        let dns = (me?["DNSName"] as? String).map { $0.hasSuffix(".") ? String($0.dropLast()) : $0 }
        let ips = ((object["TailscaleIPs"] as? [String]) ?? (me?["TailscaleIPs"] as? [String]) ?? [])
            .filter { NetworkAddresses.isIPv4($0) }
        return (backend, dns?.isEmpty == true ? nil : dns, ips)
    }

    public static func detect(path: String, environment: [String: String] = [:]) async -> TailscaleStatus {
        guard let binary = ExecutableLookup.find("tailscale", path: path, extra: [appBinary]) else { return .notInstalled }
        var env = environment
        env["PATH"] = path
        env[cliModeVariable] = "1"
        guard let result = try? await ProcessRunner.run(URL(fileURLWithPath: binary), ["status", "--json"], environment: env, timeout: 5),
              !result.stdout.isEmpty else {
            return TailscaleStatus(state: .stopped, binary: binary, backendState: nil, dnsName: nil, ipv4: [])
        }
        let parsed = parse(statusJSON: result.stdout)
        let running = parsed.backendState == "Running"
        return TailscaleStatus(state: running ? .running : .stopped, binary: binary, backendState: parsed.backendState,
                               dnsName: running ? parsed.dnsName : nil, ipv4: running ? parsed.ipv4 : [])
    }
}

public enum NetworkAddresses {
    public static func octets(_ address: String) -> [Int]? {
        let parts = address.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return nil }
        let values = parts.compactMap { Int($0) }.filter { (0...255).contains($0) }
        return values.count == 4 ? values : nil
    }

    public static func isIPv4(_ address: String) -> Bool { octets(address) != nil }

    /// RFC 1918: what the pairing payload's `lan` carries.
    public static func isPrivateIPv4(_ address: String) -> Bool {
        guard let o = octets(address) else { return false }
        return o[0] == 10 || (o[0] == 172 && (16...31).contains(o[1])) || (o[0] == 192 && o[1] == 168)
    }

    /// 100.64.0.0/10, Tailscale's CGNAT range.
    public static func isTailnetIPv4(_ address: String) -> Bool {
        guard let o = octets(address) else { return false }
        return o[0] == 100 && (64...127).contains(o[1])
    }

    /// Private IPv4 addresses of interfaces that are up, sorted and de-duplicated.
    public static func lanIPv4() -> [String] {
        var head: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&head) == 0, let first = head else { return [] }
        defer { freeifaddrs(head) }
        var found = Set<String>()
        for entry in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let flags = Int32(entry.pointee.ifa_flags)
            guard (flags & IFF_UP) != 0, (flags & IFF_LOOPBACK) == 0,
                  let addr = entry.pointee.ifa_addr, addr.pointee.sa_family == sa_family_t(AF_INET) else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard getnameinfo(addr, socklen_t(addr.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 else { continue }
            let text = String(decoding: host.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
            if isPrivateIPv4(text) { found.insert(text) }
        }
        return found.sorted()
    }
}

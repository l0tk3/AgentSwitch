import Foundation

/// A proxy as the Mac's service tells it (docs/profiles-v0.md §4, docs/browser-v0.md §7.2 第 5 条): where it is, who
/// asks, and whether it has a password — the password itself is never told.
public struct ProxySetting: Decodable, Sendable, Hashable {
    public let server: String
    public let username: String?
    public let sealed: Bool

    public init(server: String, username: String? = nil, sealed: Bool = false) {
        self.server = server
        self.username = username
        self.sealed = sealed
    }

    private enum CodingKeys: String, CodingKey { case server, username, sealed }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        server = try c.decode(String.self, forKey: .server)
        username = (try? c.decodeIfPresent(String.self, forKey: .username)).flatMap { $0 }.flatMap { $0.isEmpty ? nil : $0 }
        sealed = (try? c.decodeIfPresent(Bool.self, forKey: .sealed)) ?? false
    }
}

/// Where a proxy lets traffic out, as last found.
public struct ProxyExit: Decodable, Sendable, Hashable {
    public let ip: String
    public let place: String?

    public init(ip: String, place: String? = nil) {
        self.ip = ip
        self.place = place
    }

    /// `Tokyo 203.0.113.9`.
    public var text: String { [place, ip].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ") }
}

/// A proxy to set: `password` is a ciphertext for the proxy's own `host:port`, made on this phone (the service takes
/// no other); `keepPassword`: none is sent because the one stored stays.
public struct ProxyRequest: Encodable, Sendable, Equatable {
    public let server: String
    public let username: String?
    public let password: String?
    public let keepPassword: Bool?

    public init(server: String, username: String? = nil, password: String? = nil, keepPassword: Bool? = nil) {
        self.server = server
        self.username = username
        self.password = password
        self.keepPassword = keepPassword
    }
}

/// The proxy form as typed (the Mac's `BrowserProxyDraft`): the same rules, the same taking apart of a proxy written
/// whole in one field.
public struct ProxyDraft: Sendable, Equatable {
    public var server: String
    public var username: String
    /// As typed; sealed on this phone before anything is sent.
    public var password: String

    public init(server: String = "", username: String = "", password: String = "") {
        self.server = server
        self.username = username
        self.password = password
    }

    /// The fields as the proxy in force has them (the password is never sent back: its field starts empty).
    public init(_ proxy: ProxySetting?) {
        self.init(server: proxy?.server ?? "", username: proxy?.username ?? "")
    }

    var user: String { username.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// The proxy's own `host:port`: what its password is sealed for.
    public var site: String? { ProxyText.site(server) }

    /// What stands in the way of `Apply`, once something has been typed.
    public var problem: String? {
        if server.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return nil }
        if site == nil { return "代理地址须写作 scheme://host:port（http、https、socks4、socks5）。" }
        if !password.isEmpty, user.isEmpty { return "带密码的代理需要用户名。" }
        return nil
    }

    public var canApply: Bool { site != nil && problem == nil }

    /// No password was typed and the proxy in force has one under the same user: it stays.
    public func keepsPassword(of current: ProxySetting?) -> Bool {
        password.isEmpty && !user.isEmpty && current?.sealed == true
    }

    /// The same with a proxy written whole in the server field taken apart: `http://user:pass@host:port` — the name
    /// and the password go to their own fields and the server keeps `http://host:port`. Also taken: the same without
    /// a scheme (`http` is meant), `host:port` alone, and the `host:port:user:pass` that proxy sellers hand out. A
    /// name or a password written with `%` escapes is read as what it stands for. Anything else is left as it is.
    public func split() -> ProxyDraft {
        var text = server.trimmingCharacters(in: .whitespacesAndNewlines)
        while text.hasSuffix("/") { text.removeLast() }
        let place = /(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.\-]+):(\d{1,5})/
        if let sold = text.wholeMatch(of: /(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.\-]+):(\d{1,5}):([^:\s]+):(\S+)/) {
            return ProxyDraft(server: "http://\(sold.1):\(sold.2)", username: String(sold.3), password: String(sold.4))
        }
        var scheme = "http", rest = Substring(text)
        if let named = text.prefixMatch(of: /(?i)(https?|socks4|socks5):\/\//) {
            scheme = named.1.lowercased()
            rest = text[named.range.upperBound...]
        } else if text.contains("://") { return self }
        // What stands before the last `@` is who asks; the first `:` in it parts the name from the password.
        var name: String?, word: String?
        if let at = rest.lastIndex(of: "@") {
            let who = rest[..<at]
            let colon = who.firstIndex(of: ":")
            name = String(who[..<(colon ?? who.endIndex)])
            word = colon.map { String(who[who.index(after: $0)...]) }
            rest = rest[rest.index(after: at)...]
        }
        guard rest.wholeMatch(of: place) != nil else { return self }
        let plain = { (s: String?) -> String? in s.flatMap { $0.isEmpty ? nil : ($0.removingPercentEncoding ?? $0) } }
        return ProxyDraft(server: "\(scheme)://\(rest)", username: plain(name) ?? username, password: plain(word) ?? password)
    }

    /// The request, with `ciphertext` for a typed password (nil: none was typed).
    public func request(ciphertext: String?, current: ProxySetting?) -> ProxyRequest {
        ProxyRequest(server: server.trimmingCharacters(in: .whitespacesAndNewlines), username: user.isEmpty ? nil : user, password: ciphertext,
                     keepPassword: ciphertext == nil && keepsPassword(of: current) ? true : nil)
    }

    /// A typed password as the gate is to have it: for the proxy's own `host:port` and nowhere else, to be put into
    /// requests and typed (the uses the Mac seals it with). Nil: no password was typed. Throws what the gate's rules
    /// say no to (a host it does not take).
    public func sealing(label: String) throws -> SecretPayload? {
        guard !password.isEmpty, let site else { return nil }
        return try SecretPayload.make(value: password, hosts: [site], uses: [.http, .fill], label: label)
    }
}

/// Whose proxy a form sets.
public enum ProxyOwner: Sendable, Hashable {
    /// The browser everything shares.
    case browser
    /// One of an agent's profiles.
    case profile(agent: String, id: String)

    /// The name its password is sealed under (the Mac's).
    public var sealLabel: String {
        switch self {
        case .browser: return "browser/proxy"
        case .profile: return "profile/proxy"
        }
    }
}

public enum ProxyText {
    /// `host:port` of a `scheme://host:port`; nil for anything else.
    public static func site(_ server: String) -> String? {
        let text = server.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let match = text.wholeMatch(of: /(http|https|socks4|socks5):\/\/(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.\-]+):(\d{1,5})/),
              let port = Int(match.3), port > 0, port < 65_536 else { return nil }
        return "\(match.2):\(port)"
    }

    /// A proxy in a few words: where it lets traffic out once that is known, else the proxy's own place.
    public static func way(_ proxy: ProxySetting?, exit: ProxyExit?, none: String) -> String {
        guard let proxy else { return none }
        if let text = exit?.text, !text.isEmpty { return text }
        return site(proxy.server) ?? proxy.server
    }

    public static let passwordHint = "密码在这台 iPhone 上封成密文再发给 Mac，只能用于这个代理自己的地址；使用时由 Mac 的凭据网关解密。"
    public static let browserHint = "更换代理立即生效，无需重新启动浏览器。"
    public static let profileHint = "这个配置名下的终端和它自己的浏览器都从这个代理出去；已经开着的终端要重新开才换。"
    /// The exit's time zone differs from the one the running browser was started in.
    public static let restartHint = "时区随代理出口变化，将在浏览器下次启动时生效。"
}

/// The shared browser's way out, as a phone is told it (`GET /browser/identity`): the fingerprint in a line (its text
/// stays on the Mac), the proxy, where the proxy lets traffic out.
public struct BrowserProxyState: Decodable, Sendable, Equatable {
    public enum Exit: Sendable, Equatable {
        case found(ProxyExit)
        case problem(String)
    }

    /// `macOS · Firefox 156`.
    public let fingerprint: String?
    public let proxy: ProxySetting?
    public let exit: Exit?
    /// The running browser was started with another time zone than it would be given now.
    public let restartNeeded: Bool

    public init(fingerprint: String? = nil, proxy: ProxySetting? = nil, exit: Exit? = nil, restartNeeded: Bool = false) {
        self.fingerprint = fingerprint
        self.proxy = proxy
        self.exit = exit
        self.restartNeeded = restartNeeded
    }

    private enum Key: String, CodingKey { case fingerprint, proxy, exit, restartNeeded }
    private enum Print: String, CodingKey { case summary }
    private enum Summary: String, CodingKey { case system, browser }
    private enum ExitKey: String, CodingKey { case ip, place, problem }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        let summary = try? c.nestedContainer(keyedBy: Print.self, forKey: .fingerprint).nestedContainer(keyedBy: Summary.self, forKey: .summary)
        let words = [try? summary?.decode(String.self, forKey: .system), try? summary?.decode(String.self, forKey: .browser)].compactMap { $0 }
        fingerprint = words.isEmpty ? nil : words.joined(separator: " · ")
        proxy = (try? c.decodeIfPresent(ProxySetting.self, forKey: .proxy)).flatMap { $0 }
        if let e = try? c.nestedContainer(keyedBy: ExitKey.self, forKey: .exit) {
            if let ip = try? e.decode(String.self, forKey: .ip) {
                exit = .found(ProxyExit(ip: ip, place: (try? e.decodeIfPresent(String.self, forKey: .place)).flatMap { $0 }))
            } else if let problem = try? e.decode(String.self, forKey: .problem) {
                exit = .problem(problem)
            } else { exit = nil }
        } else { exit = nil }
        restartNeeded = (try? c.decodeIfPresent(Bool.self, forKey: .restartNeeded)) ?? false
    }

    /// `Direct`, or where the proxy lets traffic out (the proxy's own place till that is known).
    public var way: String {
        if case .found(let found)? = exit { return ProxyText.way(proxy, exit: found, none: "Direct") }
        return ProxyText.way(proxy, exit: nil, none: "Direct")
    }
}

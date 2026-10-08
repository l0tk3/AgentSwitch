import Foundation

/// The browser's identity as the service has it (docs/browser-v0.md §7.2 第 5 条; `GET /browser/identity`): the
/// fingerprint Camoufox is started with, in a few words, and the proxy its traffic leaves through.
public struct BrowserIdentity: Sendable, Equatable, Decodable {
    public struct Fingerprint: Sendable, Equatable, Decodable {
        public let system: String
        public let browser: String
        public let cores: Int?
        public let language: String?
        public let timezone: String?
        /// The time zone is the proxy's exit's, not one the fingerprint names.
        public let timezoneFollowsExit: Bool
        public let since: Date
        /// `generated` here, or `imported`.
        public let source: String

        public init(system: String, browser: String, cores: Int? = nil, language: String? = nil, timezone: String? = nil, timezoneFollowsExit: Bool = false,
                    since: Date = Date(timeIntervalSince1970: 0), source: String = "generated") {
            self.system = system
            self.browser = browser
            self.cores = cores
            self.language = language
            self.timezone = timezone
            self.timezoneFollowsExit = timezoneFollowsExit
            self.since = since
            self.source = source
        }

        private enum Key: String, CodingKey { case summary, since, source }
        private enum Summary: String, CodingKey { case system, browser, cores, language, timezone, timezoneFrom }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Key.self)
            let s = try c.nestedContainer(keyedBy: Summary.self, forKey: .summary)
            system = (try? s.decode(String.self, forKey: .system)) ?? "—"
            browser = (try? s.decode(String.self, forKey: .browser)) ?? "—"
            cores = try? s.decodeIfPresent(Int.self, forKey: .cores)
            language = try? s.decodeIfPresent(String.self, forKey: .language)
            timezone = try? s.decodeIfPresent(String.self, forKey: .timezone)
            timezoneFollowsExit = (try? s.decodeIfPresent(String.self, forKey: .timezoneFrom)) == "exit"
            since = Date(timeIntervalSince1970: ((try? c.decode(Double.self, forKey: .since)) ?? 0) / 1000)
            source = (try? c.decode(String.self, forKey: .source)) ?? "generated"
        }
    }

    /// Where the proxy lets traffic out, as looked up; or why that is not known.
    public enum Exit: Sendable, Equatable {
        case found(ip: String, place: String?)
        case problem(String)
    }

    public let fingerprint: Fingerprint
    public let proxy: BrowserProxy?
    public let exit: Exit?
    /// The running browser was started with another configuration than it would be given now (the exit's time zone).
    public let restartNeeded: Bool

    public init(fingerprint: Fingerprint, proxy: BrowserProxy?, exit: Exit? = nil, restartNeeded: Bool = false) {
        self.fingerprint = fingerprint
        self.proxy = proxy
        self.exit = exit
        self.restartNeeded = restartNeeded
    }

    private enum Key: String, CodingKey { case fingerprint, proxy, exit, restartNeeded }
    private enum ExitKey: String, CodingKey { case ip, place, problem }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        fingerprint = try c.decode(Fingerprint.self, forKey: .fingerprint)
        proxy = try? c.decodeIfPresent(BrowserProxy.self, forKey: .proxy)
        restartNeeded = (try? c.decodeIfPresent(Bool.self, forKey: .restartNeeded)) ?? false
        if let e = try? c.nestedContainer(keyedBy: ExitKey.self, forKey: .exit) {
            if let ip = try? e.decode(String.self, forKey: .ip) {
                exit = .found(ip: ip, place: try? e.decodeIfPresent(String.self, forKey: .place))
            } else if let problem = try? e.decode(String.self, forKey: .problem) {
                exit = .problem(problem)
            } else {
                exit = nil
            }
        } else {
            exit = nil
        }
    }
}

/// The proxy as shown: its password is never sent back, only that there is one.
public struct BrowserProxy: Sendable, Equatable, Decodable {
    public let server: String
    public let username: String?
    public let sealed: Bool

    public init(server: String, username: String? = nil, sealed: Bool = false) {
        self.server = server
        self.username = username
        self.sealed = sealed
    }
}

/// A proxy to set: `password` is a ciphertext for the proxy's own host (the gate turns it into the value);
/// `keepPassword`: none is sent because the one the service has stays.
public struct BrowserProxyRequest: Sendable, Equatable, Encodable {
    public let server: String
    public let username: String?
    public let password: String?
    public let keepPassword: Bool?

    public init(server: String, username: String? = nil, password: String? = nil, keepPassword: Bool = false) {
        self.server = server.trimmingCharacters(in: .whitespacesAndNewlines)
        self.username = username?.isEmpty == true ? nil : username
        self.password = password?.isEmpty == true ? nil : password
        self.keepPassword = keepPassword ? true : nil
    }
}

/// What the proxy's fields hold, and what `Apply` does with them.
public struct BrowserProxyDraft: Sendable, Equatable {
    public var server: String
    public var username: String
    /// As typed; sealed by this Mac's gate before anything is sent.
    public var password: String

    public init(server: String = "", username: String = "", password: String = "") {
        self.server = server
        self.username = username
        self.password = password
    }

    /// The fields as the proxy in force has them (the password is never sent back: its field starts empty).
    public init(_ proxy: BrowserProxy?) {
        self.init(server: proxy?.server ?? "", username: proxy?.username ?? "")
    }

    var user: String { username.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// What stands in the way of `Apply`, once something has been typed.
    public var problem: String? {
        if server.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return nil }
        if BrowserIdentityText.proxySite(server) == nil { return "代理地址须写作 scheme://host:port（http、https、socks4、socks5）。" }
        if !password.isEmpty, user.isEmpty { return "带密码的代理需要用户名。" }
        return nil
    }

    public var canApply: Bool { BrowserIdentityText.proxySite(server) != nil && problem == nil }

    /// No password was typed and the proxy in force has one under the same user: it stays.
    public func keepsPassword(of current: BrowserProxy?) -> Bool {
        password.isEmpty && !user.isEmpty && current?.sealed == true
    }

    /// The same with a proxy written whole in the server field taken apart (user, 2026-10-09: 这个代理要支持直接输入一个
    /// http代理（http 开头 带用户名密码 服务器的那种）): `http://user:pass@host:port` — the name and the password go
    /// to their own fields and the server keeps `http://host:port`. Also taken: the same without a scheme (`http` is
    /// meant), `host:port` alone, and the `host:port:user:pass` that proxy sellers hand out. A name or a password
    /// written with `%` escapes is read as what it stands for. Anything else is left as it is.
    public func split() -> BrowserProxyDraft {
        var text = server.trimmingCharacters(in: .whitespacesAndNewlines)
        while text.hasSuffix("/") { text.removeLast() }
        let place = /(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.\-]+):(\d{1,5})/
        if let sold = text.wholeMatch(of: /(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.\-]+):(\d{1,5}):([^:\s]+):(\S+)/) {
            return BrowserProxyDraft(server: "http://\(sold.1):\(sold.2)", username: String(sold.3), password: String(sold.4))
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
        return BrowserProxyDraft(server: "\(scheme)://\(rest)", username: plain(name) ?? username, password: plain(word) ?? password)
    }

    /// The request, with `ciphertext` for a typed password (nil: none was typed).
    public func request(ciphertext: String?, current: BrowserProxy?) -> BrowserProxyRequest {
        BrowserProxyRequest(server: server, username: user, password: ciphertext, keepPassword: ciphertext == nil && keepsPassword(of: current))
    }
}

public enum BrowserIdentityText {
    /// The status bar's right end on the Browser page: `macOS · Firefox 156 · direct`, `… · socks5 proxy.example.net`.
    public static func status(_ identity: BrowserIdentity?, engine: String) -> String {
        if engine != "camoufox" { return "Chrome · No Identity" }
        guard let identity else { return "Identity" }
        return "\(identity.fingerprint.system) · \(identity.fingerprint.browser) · \(route(identity.proxy, exit: identity.exit))"
    }

    /// `direct`, or the proxy's kind and the place it leaves at (its host until that is known).
    public static func route(_ proxy: BrowserProxy?, exit: BrowserIdentity.Exit? = nil) -> String {
        guard let proxy, let parts = parts(proxy.server) else { return "direct" }
        if case .found(_, let place?)? = exit { return "\(parts.scheme) \(place)" }
        return "\(parts.scheme) \(parts.host)"
    }

    /// The box's `exit` row: the address and the place, or why they are not known.
    public static func exit(_ exit: BrowserIdentity.Exit?) -> String {
        switch exit {
        case .found(let ip, let place)?: return place.map { "\(ip) · \($0)" } ?? ip
        case .problem(let text)?: return text
        case nil: return "—"
        }
    }

    /// The fingerprint's rows in the box: a word and its value (`System` where the Mac's own setting shows through).
    public static func rows(_ f: BrowserIdentity.Fingerprint) -> [(String, String)] {
        let day = DateFormatter()
        day.dateFormat = "yyyy-MM-dd"
        return [("system", f.system), ("browser", f.browser), ("cores", f.cores.map(String.init) ?? "System"),
                ("language", f.language ?? "System"),
                ("time zone", f.timezone.map { f.timezoneFollowsExit ? "\($0)（随代理出口）" : $0 } ?? "System"), ("since", day.string(from: f.since))]
    }

    /// `host:port` of a proxy written `scheme://host:port`: the site its password's ciphertext is made for. Nil when it
    /// is not written so.
    public static func proxySite(_ server: String) -> String? {
        parts(server).map { "\($0.host):\($0.port)" }
    }

    private static func parts(_ server: String) -> (scheme: String, host: String, port: Int)? {
        let text = server.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let match = text.wholeMatch(of: /(http|https|socks4|socks5):\/\/(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.\-]+):(\d{1,5})/),
              let port = Int(match.3), port > 0, port < 65_536 else { return nil }
        return (String(match.1), String(match.2), port)
    }

    public static let fingerprintHint = "更换指纹将重新启动浏览器，已打开的标签按网址恢复，页面内未保存的内容会丢失。指纹与配置绑定，不随每次启动变化。"
    public static let proxyHint = "更换代理立即生效，无需重新启动浏览器。代理密码以密文保存；使用时由凭据网关解密，明文只在服务的内存中。"
    /// The exit's time zone differs from the one the running browser was started in.
    public static let restartHint = "时区随代理出口变化，将在浏览器下次启动时生效。"
    public static let sealedWord = "password sealed"
    /// The name a proxy's password is sealed under.
    public static let proxyLabel = "browser/proxy"
}

/// The browser engine as the service has it (docs/browser-v0.md §7.2 第 6 条; `GET /browser/engine`).
public struct BrowserEngine: Sendable, Equatable, Decodable {
    public struct Offer: Sendable, Equatable {
        public let version: String
        public let bytes: Int64
        public let prerelease: Bool
    }

    /// The installed Camoufox's version; nil: none.
    public let camoufox: String?
    public let ready: Bool
    /// The Playwright in use, and whether it is the one that came with the app.
    public let playwright: String
    public let bundled: Bool
    public let update: BrowserEngineUpdate
    /// A newer build for the Firefox in use, since the last check.
    public let available: Offer?
    public let problem: String?

    private enum Key: String, CodingKey { case camoufox, playwright, update, available }
    private enum Fox: String, CodingKey { case installed, ready }
    private enum Installed: String, CodingKey { case version }
    private enum Play: String, CodingKey { case version, active }
    private enum Available: String, CodingKey { case camoufox, problem }
    private enum OfferKey: String, CodingKey { case version, bytes, prerelease }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        let fox = try? c.nestedContainer(keyedBy: Fox.self, forKey: .camoufox)
        camoufox = try? fox?.nestedContainer(keyedBy: Installed.self, forKey: .installed).decode(String.self, forKey: .version)
        ready = (try? fox?.decode(Bool.self, forKey: .ready)) ?? false
        let play = try? c.nestedContainer(keyedBy: Play.self, forKey: .playwright)
        playwright = (try? play?.decode(String.self, forKey: .version)) ?? ""
        bundled = ((try? play?.decode(String.self, forKey: .active)) ?? "bundled") == "bundled"
        update = (try? c.decode(BrowserEngineUpdate.self, forKey: .update)) ?? BrowserEngineUpdate(running: false)
        let a = try? c.nestedContainer(keyedBy: Available.self, forKey: .available)
        if let o = try? a?.nestedContainer(keyedBy: OfferKey.self, forKey: .camoufox), let version = try? o.decode(String.self, forKey: .version) {
            available = Offer(version: version, bytes: (try? o.decode(Int64.self, forKey: .bytes)) ?? 0, prerelease: (try? o.decode(Bool.self, forKey: .prerelease)) ?? false)
        } else {
            available = nil
        }
        problem = try? a?.decodeIfPresent(String.self, forKey: .problem)
    }
}

public struct BrowserEngineUpdate: Sendable, Equatable, Decodable {
    public let running: Bool
    public let phase: String?
    public let part: String?
    public let received: Int64?
    public let total: Int64?
    public let ok: Bool?
    public let error: String?
    /// The versions it is to install, by part (`camoufox`, `playwright`).
    public let to: [String: String]?

    public init(running: Bool, phase: String? = nil, part: String? = nil, received: Int64? = nil, total: Int64? = nil, ok: Bool? = nil, error: String? = nil,
                to: [String: String]? = nil) {
        self.to = to
        self.running = running
        self.phase = phase
        self.part = part
        self.received = received
        self.total = total
        self.ok = ok
        self.error = error
    }
}

public enum BrowserEngineText {
    public enum StepState: Sendable, Equatable { case done, now, waiting }

    /// The update's steps in order, as the box lists them.
    static let order: [(phase: String, word: String)] = [("download", "download"), ("verify", "checksum matches the release"),
                                                            ("unpack", "unpack"), ("check", "self-check: launch · resize · frames · tools"),
                                                            ("switch", "switch over, remove the old copy")]

    public static func steps(_ update: BrowserEngineUpdate) -> [(word: String, state: StepState)] {
        let at = order.firstIndex { $0.phase == update.phase } ?? 0
        return order.enumerated().map { index, step in (step.word, index < at ? .done : (index == at ? .now : .waiting)) }
    }

    /// A download's share, 0…1; nil outside one.
    public static func fraction(_ update: BrowserEngineUpdate) -> Double? {
        guard update.running, update.phase == "download", let received = update.received, let total = update.total, total > 0 else { return nil }
        return min(1, Double(received) / Double(total))
    }

    /// The status bar's word while an update runs: `download 62%`, `checksum`, `unpack`, `self-check`, `switching`.
    public static func progress(_ update: BrowserEngineUpdate) -> String? {
        guard update.running else { return nil }
        switch update.phase {
        case "download": return fraction(update).map { "download \(Int(($0 * 100).rounded(.down)))%" } ?? "download"
        case "verify": return "checksum"
        case "unpack": return "unpack"
        case "check": return "self-check"
        case "switch": return "switching"
        default: return "starting"
        }
    }

    /// What a check found: `156.0.1-beta.36 · 1.29 GB`; nil: nothing newer.
    public static func offer(_ engine: BrowserEngine) -> String? {
        engine.available.map { "\($0.version) · \(size($0.bytes))" }
    }

    /// The box's `camoufox` row: the version installed, or `Not Installed`.
    public static func camoufox(_ engine: BrowserEngine) -> String {
        engine.camoufox ?? "Not Installed"
    }

    /// The version an update under way is installing (the row under it, `to`); nil outside one or before it is known.
    public static func target(_ engine: BrowserEngine) -> String? {
        guard engine.update.running, let next = engine.update.to?["camoufox"], next != engine.camoufox, next != "latest" else { return nil }
        return next
    }

    public static func playwright(_ engine: BrowserEngine) -> String {
        engine.bundled ? "\(short(engine.playwright)) (bundled)" : short(engine.playwright)
    }

    /// A version without a build's stamp after it: `1.64.0-alpha-1759292000` → `1.64.0-alpha`.
    public static func short(_ version: String) -> String {
        guard let match = version.firstMatch(of: /^(\d+\.\d+\.\d+(?:-[A-Za-z]+(?:\.\d+)?)?)-\d/) else { return version }
        return String(match.1)
    }

    /// The status bar's word about the engine, in amber: an update under way, or Camoufox not there yet.
    public static func status(_ engine: BrowserEngine?) -> String? {
        guard let engine else { return nil }
        if let progress = progress(engine.update) { return "engine: \(progress)" }
        return engine.camoufox == nil ? "Camoufox Not Installed" : nil
    }

    /// The settings' Environment page's line about the engine.
    public static func environment(_ engine: BrowserEngine?) -> StatusLine {
        guard let engine else { return StatusLine("Unknown", .busy) }
        if let progress = progress(engine.update) { return StatusLine("Updating: \(progress)", .busy) }
        guard let camoufox = engine.camoufox else { return StatusLine("Camoufox Not Installed · Chrome in Use", .warning) }
        return StatusLine("Camoufox \(camoufox) · Playwright \(short(engine.playwright))", .ok)
    }

    public static let environmentHint = "共享浏览器的引擎。在主窗口 Browser 页状态栏右端下载或更新；未安装时使用本机的 Google Chrome。"

    public static func size(_ bytes: Int64) -> String {
        bytes >= 1_000_000_000 ? String(format: "%.2f GB", Double(bytes) / 1e9) : String(format: "%.0f MB", Double(bytes) / 1e6)
    }

    public static let hint = "两者成对更新。自检未通过时不切换，继续使用原版本并说明原因。切换成功后立即删除旧版本，磁盘上只保留一份。"
    public static let missingHint = "下载完成前使用本机的 Chrome（无指纹与代理设置，页面以画面显示在此页）。下载后的文件按官方公布的校验值核对。"
}

extension DaemonClient {
    /// `GET /browser/identity`.
    public func browserIdentity() async throws -> BrowserIdentity {
        try decode(BrowserIdentity.self, try await dispatchCall("GET", "/browser/identity", timeout: BrowserTimeouts.request))
    }

    /// `PUT /browser/identity {fingerprint: "new"}`: another fingerprint; the browser starts again with its tabs.
    public func newFingerprint() async throws -> BrowserIdentity {
        try decode(BrowserIdentity.self, try await dispatchCall("PUT", "/browser/identity", json: ["fingerprint": "new"], timeout: BrowserTimeouts.open))
    }

    /// `PUT /browser/identity {fingerprint: {config}}`: a fingerprint brought from elsewhere (a JSON object of Camoufox's
    /// properties); the browser starts again with its tabs.
    public func importFingerprint(json: Data) async throws -> BrowserIdentity {
        guard let config = (try? JSONSerialization.jsonObject(with: json)) as? [String: Any],
              let body = try? JSONSerialization.data(withJSONObject: ["fingerprint": ["config": config]]) else {
            throw DaemonError.decoding("所选文件不是一组 Camoufox 的属性（JSON 对象）。")
        }
        return try decode(BrowserIdentity.self, try await dispatchCall("PUT", "/browser/identity", body: body, timeout: BrowserTimeouts.open))
    }

    /// `PUT /browser/identity {proxy}`: in force at once; nil: straight out.
    public func setProxy(_ proxy: BrowserProxyRequest?) async throws -> BrowserIdentity {
        struct Body: Encodable {
            let proxy: BrowserProxyRequest?
            func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: Key.self)
                if let proxy { try c.encode(proxy, forKey: .proxy) } else { try c.encodeNil(forKey: .proxy) }
            }
            enum Key: String, CodingKey { case proxy }
        }
        return try decode(BrowserIdentity.self, try await dispatchCall("PUT", "/browser/identity", json: Body(proxy: proxy), timeout: BrowserTimeouts.fill))
    }

    /// `GET /browser/engine` (`check`: asks what could be installed first).
    public func browserEngine(check: Bool = false) async throws -> BrowserEngine {
        try decode(BrowserEngine.self, try await dispatchCall("GET", "/browser/engine" + (check ? "?check=1" : ""), timeout: BrowserTimeouts.open))
    }

    /// `POST /browser/engine/update`: starts it; its progress is in `browserEngine().update`.
    public func updateEngine(camoufox: String) async throws {
        _ = try await dispatchCall("POST", "/browser/engine/update", json: ["camoufox": camoufox], timeout: BrowserTimeouts.open)
    }

    public func cancelEngineUpdate() async throws {
        _ = try await dispatchCall("POST", "/browser/engine/cancel", json: [String: String](), timeout: BrowserTimeouts.request)
    }

    /// `POST /browser/identity/restart`: the browser again with what it would be given now; its tabs come back.
    public func restartBrowser() async throws -> BrowserIdentity {
        try decode(BrowserIdentity.self, try await dispatchCall("POST", "/browser/identity/restart", json: [String: String](), timeout: BrowserTimeouts.open))
    }
}

/// What the identity and engine box asks of the service; `DaemonClient` conforms, the design preview has a made-up one.
public protocol BrowserIdentityService: Sendable {
    func browserIdentity() async throws -> BrowserIdentity
    func newFingerprint() async throws -> BrowserIdentity
    func importFingerprint(json: Data) async throws -> BrowserIdentity
    func setProxy(_ proxy: BrowserProxyRequest?) async throws -> BrowserIdentity
    func browserEngine(check: Bool) async throws -> BrowserEngine
    func updateEngine(camoufox: String) async throws
    func cancelEngineUpdate() async throws
    func restartBrowser() async throws -> BrowserIdentity
}

extension DaemonClient: BrowserIdentityService {}

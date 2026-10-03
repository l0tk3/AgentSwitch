import Foundation

// A person's Fill Ciphertext on the Browser page (docs/browser-v0.md §1, §6; packages/secret-gate/BOUNDARY.md, the
// person-fill row): a whole `enc:v1:` ciphertext sent as `POST /browser/tabs/:id/fill {token, screen}`. The daemon finds
// the page's focused input field, the gate checks the ciphertext against that field's frame and every frame above it,
// and the value is typed into the page. The value never reaches the app: the answer names the ciphertext's label and the
// page's host:port. References (`enc:ref:`) belong to one task's run; the daemon and the gate refuse them here.

/// `{tab, filled: {label, host}}`: what was filled and where, never the value.
public struct BrowserFillResult: Sendable, Equatable, Decodable {
    /// The tab after the fill; nil when the answer leaves it out (closed meanwhile).
    public let tab: BrowserTab?
    /// The ciphertext's label (`portal/pass`).
    public let label: String
    /// The page's `host:port` the gate checked (`portal.example.com:443`).
    public let host: String

    public init(tab: BrowserTab? = nil, label: String, host: String) {
        self.tab = tab
        self.label = label
        self.host = host
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        tab = c.first(BrowserTab.self, "tab")
        let filled = try c.require(Filled.self, "filled")
        label = filled.label
        host = filled.host
    }

    private struct Filled: Decodable {
        let label: String
        let host: String

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: AnyKey.self)
            label = c.first(String.self, "label") ?? ""
            host = c.first(String.self, "host") ?? ""
        }
    }
}

/// What Fill Ciphertext checks and says. Short words in English, sentences in formal Chinese (ui-v0 §4.1).
public enum BrowserFillText {
    /// A whole ciphertext, as the daemon checks it (packages/daemon/src/browser/fill.ts `CIPHERTEXT`).
    public static let pattern = #"^enc:v1:[A-Za-z0-9_=-]{16,}$"#
    /// The daemon's limit on `token` (api/browser.ts `FillBody`).
    public static let maxLength = 64 * 1024

    /// Fill Ciphertext is offered on an http(s) page only (the daemon refuses any other frame).
    public static func offered(on url: String) -> Bool {
        guard let scheme = URLComponents(string: url)?.scheme?.lowercased() else { return false }
        return scheme == "http" || scheme == "https"
    }

    /// And on a person's own tab only: an agent's tab is refused (409) even while held, since the agent sees the page
    /// again after the hand-back (docs/browser-v0.md §6).
    public static func offered(on tab: BrowserTab) -> Bool { tab.owner.kind == .you && offered(on: tab.url) }

    /// Why `token` (as pasted; surrounding spaces and line breaks are dropped before it is sent) cannot be sent; nil
    /// when it can.
    public static func problem(_ token: String) -> String? {
        let token = token.trimmingCharacters(in: .whitespacesAndNewlines)
        if token.isEmpty { return "请粘贴一条 enc:v1: 密文。" }
        if token.hasPrefix("enc:ref:") { return "引用（enc:ref:）仅在登记它的任务中有效。此处只接受完整的 enc:v1: 密文。" }
        if token.utf8.count > maxLength || token.range(of: pattern, options: .regularExpression) == nil {
            return "不是完整的 enc:v1: 密文。"
        }
        return nil
    }

    /// The footer's note after a fill: `Filled portal/pass · portal.example.com:443`.
    public static func done(_ result: BrowserFillResult) -> String {
        let what = result.label.isEmpty ? "Filled" : "Filled \(result.label)"
        return result.host.isEmpty ? what : "\(what) · \(result.host)"
    }

    /// A fill that did not happen, in the person's words: the daemon's sentence where it gives one, the gate's reason
    /// as it is (403), and a formal sentence where the answer carries only a code (`not found`, a bad body, an older
    /// service without the route).
    public static func reason(_ error: Error) -> String {
        guard let error = error as? DaemonError else { return error.localizedDescription }
        switch error {
        case .http(400, let message):
            return sentence(message) ?? "请求无效，未填入。请粘贴一条完整的 enc:v1: 密文。"
        case .http(403, let message):
            return given(message) ?? "凭据网关拒绝了此密文，未填入。"
        case .http(404, _):
            return "此标签已关闭。"
        case .http(409, let message):
            return sentence(message) ?? "此标签已由其他屏幕接手，或输入焦点已改变，未填入。"
        case .http(503, let message):
            return sentence(message) ?? "凭据网关不可用，无法填入密文。"
        case .http(let status, let message):
            return sentence(message) ?? "服务返回 \(status)，未填入。"
        case .notSupported:
            return "当前服务不支持填入密文，请更新 AgentSwitch。"
        case .unreachable, .decoding:
            return error.errorDescription ?? ""
        }
    }

    /// The daemon's words when they are a sentence for people: it writes those in Chinese; its bare codes
    /// (`not found`, `give a ciphertext (token)`) are English.
    static func sentence(_ message: String) -> String? {
        given(message).flatMap { text in text.unicodeScalars.contains(where: { (0x4E00...0x9FFF).contains($0.value) }) ? text : nil }
    }

    /// The gate's reason, in whatever words it gives; nil for an empty answer (`DaemonClient.errorMessage`'s stand-in).
    static func given(_ message: String) -> String? {
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty || text == DaemonClient.emptyErrorMessage ? nil : text
    }
}

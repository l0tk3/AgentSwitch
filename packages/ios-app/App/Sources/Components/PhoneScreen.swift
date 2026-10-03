import Foundation

/// This phone as a screen of the Mac's terminals and browser tabs: one id, kept across pages and launches (2026-09-30,
/// user: 返回重新进入提示我另一个 iPhone 在使用 — a new id per page made the page just left, still holding the size for a few
/// seconds, "another iPhone"). What it holds and the sizes it sets are its own (terminal-v0 §1 尺寸有主, browser-v0 §1).
enum PhoneScreen {
    static let id: String = {
        let key = "terminal.screenId"
        if let saved = UserDefaults.standard.string(forKey: key), saved.hasPrefix("phone-") { return saved }
        let made = "phone-" + UUID().uuidString.prefix(8).lowercased()
        UserDefaults.standard.set(made, forKey: key)
        return made
    }()
}

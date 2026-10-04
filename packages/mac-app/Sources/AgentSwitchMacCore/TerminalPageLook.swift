import Foundation

/// What the Mac window tells its terminal page of the look (docs/ui-v0.md §8): the page is the daemon's
/// (`ui/terminal.js`), drawn in the pixel look unless the window says `classic`, and its accent is the system's (the
/// user: 蓝色 — the system's accent, blue unless changed in System Settings). Told at the document's start, so the page
/// is never drawn in the other look first, and again whenever the setting or the accent changes.
public enum TerminalPageLook {
    /// `#rrggbb` of sRGB components in 0…1 (what is outside is clamped).
    public static func hex(red: Double, green: Double, blue: Double) -> String {
        let byte = { (value: Double) -> Int in Int((min(max(value.isFinite ? value : 0, 0), 1) * 255).rounded()) }
        return String(format: "#%02x%02x%02x", byte(red), byte(green), byte(blue))
    }

    /// `accent` when it is a six-digit colour, as the page takes it; anything else is left out.
    static func accentLiteral(_ accent: String?) -> String {
        guard let accent, accent.count == 7, accent.hasPrefix("#"),
              accent.dropFirst().allSatisfy({ $0.isHexDigit && $0.isASCII }) else { return "undefined" }
        return "\"\(accent.lowercased())\""
    }

    /// At the document's start: the look and the accent as the page reads them, and the root's class at once.
    public static func startScript(look: InterfaceLook, accent: String?) -> String {
        "window.agentswitchLook = \"\(look.rawValue)\"; window.agentswitchAccent = \(accentLiteral(accent)); "
            + "document.documentElement?.classList.toggle(\"classic\", \(look.isClassic));"
    }

    /// The setting or the accent changed while the page is open: the page draws itself again in the look. A page still
    /// starting (it takes calls only once it has read its lists) finds what was said when it is ready.
    public static func changeScript(look: InterfaceLook, accent: String?) -> String {
        let accent = accentLiteral(accent)
        return "window.agentswitchLook = \"\(look.rawValue)\"; window.agentswitchAccent = \(accent); "
            + "window.agentswitch?.look?.(\"\(look.rawValue)\", \(accent))"
    }
}

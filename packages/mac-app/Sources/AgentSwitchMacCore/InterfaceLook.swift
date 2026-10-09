import Foundation

/// The interface's look (docs/ui-v0.md §8, 2026-10-04; user: 设置里应该加入一版“经典设计”的图标和ui，就是那种像经典app一样的
/// 平滑ui、设计和提示，对不喜欢这种geek风格的比较友好): `pixel`, the visual language of §7 and the default, or `classic`, a
/// standard app's — the system font, round corners, line icons, standard buttons, dots for status. Only how things are
/// drawn changes: the layout, the keys, a terminal's own screen and every confirmation stay as they are. Each device keeps
/// its own (the user: 设置各记各的); the concept page is docs/design/concepts/classic.html.
public enum InterfaceLook: String, CaseIterable, Sendable {
    case pixel, classic

    /// Where the look is kept (UserDefaults; `-appearance classic` on the command line sets it for one run).
    public static let key = "appearance"

    /// The look kept under `key`: what is not one of the two is the default.
    public static func load(_ raw: String?) -> InterfaceLook { raw.flatMap(InterfaceLook.init(rawValue:)) ?? .pixel }

    /// The look in force now, read where it is kept: the colours ask at every draw, off the main thread too.
    public static var current: InterfaceLook { load(UserDefaults.standard.string(forKey: key)) }

    /// The setting's two words.
    public var label: String {
        switch self {
        case .pixel: return "Pixel"
        case .classic: return "Classic"
        }
    }

    public var isClassic: Bool { self == .classic }
}

/// The classic look's short words where they are not the pixel look's (§8, the user: 英文 — the concept page's
/// "经典 · English" column). Everything else is the same word in both looks, without `[ ]` and `//`.
public enum ClassicWords {
    static let table: [String: String] = [
        "Busy": "Working", "Waiting": "Needs You", "Idle": "Ready", "Exited": "Ended",
        "[!] Approval": "Approval Needed", "? Question": "Question", "Gateway": "Gateway OK", "On Mac": "On This Mac",
        "bypass": "Bypass", "auto": "Auto", "manual": "Ask Each", "plan": "Plan", "ask": "Ask", "edits": "Edits",
        "OK": "Running", "Remote": "Remote Access", "Open Dispatch": "Open AgentSwitch",
    ]

    /// `word` as `look` writes it. A count of things waiting (`2 Waiting`) is `2 Need You` in the classic look, one
    /// `1 Needs You`.
    public static func word(_ word: String, in look: InterfaceLook) -> String {
        guard look.isClassic else { return word }
        if let known = table[word] { return known }
        let parts = word.split(separator: " ")
        if parts.count == 2, parts[1] == "Waiting", let count = Int(parts[0]) { return count == 1 ? "1 Needs You" : "\(count) Need You" }
        return word
    }

    /// A line of short words joined by ` · ` (`Waiting · Run Command`, `On Mac · 139×46`), each as `look` writes it.
    public static func phrase(_ phrase: String, in look: InterfaceLook) -> String {
        guard look.isClassic else { return phrase }
        return phrase.components(separatedBy: " · ").map { word($0, in: look) }.joined(separator: " · ")
    }

    /// A control's help as `look` writes it. The pixel look says a name and its key (`List ⌘B`); the classic one a short
    /// sentence with the key in brackets (`Show or hide the list (⌘B)`), as a standard app's tooltips do. A help that
    /// is a sentence already (it has a full stop or a colon) stays as it is.
    public static func help(_ help: String, in look: InterfaceLook) -> String {
        guard look.isClassic else { return help }
        if let said = sentences[help] { return said }
        guard !help.contains("。"), !help.contains("："), let space = help.lastIndex(of: " ") else { return help }
        let key = help[help.index(after: space)...]
        guard let first = key.unicodeScalars.first, "⌘⌃⌥⇧↩⌫".unicodeScalars.contains(first) || key == "esc" else { return help }
        return "\(help[..<space]) (\(key))"
    }

    static let sentences: [String: String] = [
        "List ⌘B": "Show or hide the list (⌘B)",
        "No List on This Page": "This page has no list",
    ]
}

/// The system symbols that stand for the pixel marks in the classic look (§8: line icons, SF Symbols natively; only
/// the app's own mark and the agents' are drawn by hand).
public extension PixelArt {
    /// The symbol for a sprite, by its rows; nil for one the classic look draws itself or has no symbol for.
    static func symbol(for rows: [String]) -> String? {
        symbols.first { $0.rows == rows }?.name
    }

    internal static let symbols: [(rows: [String], name: String)] = [
        (square, "circle.fill"), (hollow, "circle"), (lock, "lock"),
        (terminalWindow, "terminal"), (railTerminals, "terminal"), (railBrowser, "globe"),
        (toolbarList, "sidebar.left"), (toolbarNew, "plus"), (toolbarSettings, "slider.horizontal.3"), (toolbarRecord, "text.alignleft"),
        // The window with the half a split adds filled in, as the system's own tiling icons are drawn (2026-10-04,
        // user, of a box with a line through it: 太违和了，感觉还是按照像素的逻辑画的……画的更加现代一些).
        (toolbarSplitRight, "rectangle.righthalf.inset.filled"), (toolbarSplitDown, "rectangle.bottomhalf.inset.filled"),
        (menuPair, "qrcode"), (menuRestart, "arrow.triangle.2.circlepath"), (menuQuit, "power"),
    ]
}

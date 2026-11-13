import Foundation

// Choosing a folder on another node (docs/terminal-v0.md §1 “名单”, 2026-11-13): the system's panel shows this Mac's
// folders only, so a node's are read level by level through its Files routes (docs/files-v0.md §7.1) — under that
// node's switch and the scope it gives this Mac.

public enum NodeFolders {
    /// The folders of a level, as the node lists them: folders and links to folders, never one of AgentSwitch's own
    /// credential places.
    public static func folders(of level: FileLevel) -> [FileEntry] {
        level.entries.filter { $0.isFolder && !$0.locked }
    }

    /// The path of `name` within `folder`.
    public static func path(of name: String, in folder: String) -> String {
        folder.hasSuffix("/") ? folder + name : folder + "/" + name
    }

    /// Where the picker starts from what the field holds: an absolute path as it is, `~` and `~/x` once the node's
    /// home is known, nothing for anything else (the node's own start).
    public static func start(typed: String, home: String?) -> String? {
        let text = typed.trimmingCharacters(in: .whitespaces)
        if text.hasPrefix("/") { return text }
        guard let home, !home.isEmpty else { return nil }
        if text == "~" { return home }
        if text.hasPrefix("~/") { return path(of: String(text.dropFirst(2)), in: home) }
        return nil
    }

    /// A path as it is shown: the node's home as `~`.
    public static func shown(_ path: String, home: String) -> String {
        guard !home.isEmpty, home != "/" else { return path }
        if path == home { return "~" }
        return path.hasPrefix(home + "/") ? "~" + path.dropFirst(home.count) : path
    }
}

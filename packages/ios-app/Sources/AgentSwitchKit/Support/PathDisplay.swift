import Foundation

/// Paths as people read them (docs/ui-v0.md §1.5): the Mac user's home folder as `~`.
public enum PathDisplay {
    /// `/Users/me/Projects/AgentSwitch` → `~/Projects/AgentSwitch`; `/Users/me` → `~`; anything else unchanged.
    public static func short(_ path: String) -> String {
        let parts = path.split(separator: "/", omittingEmptySubsequences: false)
        // "", "Users", "<name>", rest…
        guard parts.count >= 3, parts[0].isEmpty, parts[1] == "Users", !parts[2].isEmpty, parts[2] != "Shared" else { return path }
        let rest = parts.dropFirst(3).joined(separator: "/")
        return rest.isEmpty ? "~" : "~/" + rest
    }

    /// The last folder name, for a compact label.
    public static func name(_ path: String) -> String {
        let short = short(path)
        return short.split(separator: "/").last.map(String.init) ?? short
    }
}

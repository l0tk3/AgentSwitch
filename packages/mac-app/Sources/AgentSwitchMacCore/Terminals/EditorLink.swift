import Foundation

/// The code editor a terminal's folder opens in (docs/terminal-v0.md §1 Mac "在编辑器中打开", 2026-10-15; user: 当 mac 也
/// 能通过 ssh 连接到远程工作站时，app 端加一个按钮，直接调用 vscode remote 跳到当前工作目录). Each is Visual Studio Code or one
/// of its forks: they take the same `<scheme>://file/<path>` and `<scheme>://vscode-remote/ssh-remote+<host>/<path>`
/// links, the second with their own Remote - SSH.
public enum CodeEditor: String, CaseIterable, Sendable {
    case vscode, cursor, windsurf, vscodium

    /// Where the choice is kept (this Mac's own defaults).
    public static let key = "terminal.editor"

    public var label: String {
        switch self {
        case .vscode: "Visual Studio Code"
        case .cursor: "Cursor"
        case .windsurf: "Windsurf"
        case .vscodium: "VSCodium"
        }
    }

    /// The name on the button and in the menu.
    public var short: String { self == .vscode ? "VS Code" : label }

    var scheme: String { rawValue }

    /// The editor chosen, Visual Studio Code until another is.
    public static func load(_ defaults: UserDefaults) -> CodeEditor {
        defaults.string(forKey: key).flatMap(CodeEditor.init(rawValue:)) ?? .vscode
    }
}

/// Where the editor is sent for a terminal's folder. A folder on this Mac opens as it is; one on another node opens
/// over SSH, by the Host this Mac's `~/.ssh/config` (or ssh itself) knows that node by — kept on this Mac alone, by node,
/// since it means nothing anywhere else.
public enum EditorLink {
    /// The SSH Host of node `node`, in this Mac's own defaults.
    public static func sshHostKey(node: String) -> String { "node.sshHost.\(node)" }

    /// A Host as ssh takes it: an alias of `~/.ssh/config`, a name or an address, `user@` before it allowed. Nothing a
    /// link or a shell would read otherwise (spaces, `/`, `+`, `?`, `#`, `%`).
    public static func validHost(_ host: String) -> Bool {
        !host.isEmpty && host.count <= 255
            && host.range(of: #"^([A-Za-z0-9._-]+@)?[A-Za-z0-9._-]+$"#, options: .regularExpression) != nil
            && !host.hasPrefix("-")
    }

    /// The link that opens `path` in `editor`: on this Mac when `remote` is false, else over SSH to `sshHost`. Nil when
    /// the path is not absolute, or the folder is on another node and no valid Host was given for it.
    public static func url(editor: CodeEditor, path: String, remote: Bool, sshHost: String?) -> URL? {
        guard path.hasPrefix("/"), let encoded = path.addingPercentEncoding(withAllowedCharacters: pathAllowed) else { return nil }
        guard remote else { return URL(string: "\(editor.scheme)://file\(encoded)") }
        guard let host = sshHost?.trimmingCharacters(in: .whitespaces), validHost(host) else { return nil }
        return URL(string: "\(editor.scheme)://vscode-remote/ssh-remote+\(host)\(encoded)")
    }

    /// A path's characters kept as they are in the link; the rest (spaces, `#`, `?`, `%`, other scripts) escaped.
    private static let pathAllowed: CharacterSet = {
        var set = CharacterSet.urlPathAllowed
        set.remove(charactersIn: "#?%;")
        return set
    }()
}
